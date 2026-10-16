import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import {
  AURA_IDS,
  AVATAR_MAX_LEN,
  GUEST_ID_PREFIX,
  LEADERBOARD_QUERY_LIMIT,
  LEADERBOARD_REFRESH_MS,
  LEADERBOARD_ROWS,
  NAME_MAX,
  POSE_MAX,
  WORLDS,
  RECONNECT_SECONDS,
  ROOM_MAX_CLIENTS,
  VACUUM_IDS,
  WORLD_BOUNDS,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress, resolveTutorialStep, resolveControlsDone } from "../sanitize.js";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function sanitizeAvatar(raw: unknown): string {
  return typeof raw === "string" && raw.length <= AVATAR_MAX_LEN ? raw : "";
}

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

// One board per stat, matching the three boards in the hub (client props.js: Power, Rebirths,
// Leaves Cleaned, Level).
const LEADERBOARD_STATS = ["power", "rebirths", "leaves", "level"] as const;
type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
// `avatar` (Bloxity avatar JSON) is only set on a board's #1 row.
type LeaderboardRow = { id: string; name: string; value: number; avatar?: string };
type LeaderboardPayload = Record<LeaderboardStat, LeaderboardRow[]>;
type OnlineRow = { sessionId: string; userId: string | null; username: string; avatar: string } & Record<LeaderboardStat, number>;

// Collapse online rows that still share a userId (e.g. a leave/join racing the same tick) down
// to one, keeping the higher value for the ranked stat. Guests with no id are never collapsed.
function dedupeOnline(rows: OnlineRow[], stat: LeaderboardStat): OnlineRow[] {
  const byUserId = new Map<string, OnlineRow>();
  const anonymous: OnlineRow[] = [];
  for (const row of rows) {
    if (!row.userId) {
      anonymous.push(row);
      continue;
    }
    const existing = byUserId.get(row.userId);
    if (!existing || row[stat] > existing[stat]) byUserId.set(row.userId, row);
  }
  return [...byUserId.values(), ...anonymous];
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username, avatar })`.
 * Relays each player's pose, Bloxity avatar, vacuum and aura to the others, broadcasts the
 * leaderboards, and saves/loads each signed-in player's progress (MongoDB, see db.ts). The game
 * is client-authoritative: no gameplay rules live here. Full rooms spill into a fresh one
 * automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();

  messages = {
    // Position / gait, throttled client-side.
    pose: (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const b = WORLD_BOUNDS;
      if (finite(msg?.x)) p.x = clamp(msg.x, b.minX, b.maxX);
      if (finite(msg?.y)) p.y = clamp(msg.y, b.minY, b.maxY);
      if (finite(msg?.z)) p.z = clamp(msg.z, b.minZ, b.maxZ);
      if (finite(msg?.yaw)) p.yaw = msg.yaw;
      if (finite(msg?.speed01)) p.speed01 = clamp(msg.speed01, 0, 1);
      if (typeof msg?.grounded === "boolean") p.grounded = msg.grounded;
      if (typeof msg?.world === "string" && WORLDS.includes(msg.world)) p.world = msg.world;
      if (msg?.pose === null) p.pose = "";
      else if (typeof msg?.pose === "string" && msg.pose.length <= POSE_MAX) p.pose = msg.pose;
    },
    // Bloxity avatar JSON; sent on connect and whenever the portal reports a change.
    setAvatar: (client: Client, msg: { avatar?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      // "" = signed out (back to the default look); an oversized or non-string payload is ignored.
      if (typeof msg?.avatar === "string" && msg.avatar.length <= AVATAR_MAX_LEN) p.avatar = msg.avatar;
      this.persistAvatar(client.sessionId, p);
    },
    // Equipped vacuum id ("" = default); only ids the game knows are relayed.
    setVacuum: (client: Client, msg: { vacuum?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof msg?.vacuum !== "string") return;
      if (msg.vacuum === "" || VACUUM_IDS.includes(msg.vacuum)) p.vacuum = msg.vacuum;
    },
    // Equipped aura id ("" = none).
    setAura: (client: Client, msg: { aura?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof msg?.aura !== "string") return;
      if (msg.aura === "" || AURA_IDS.includes(msg.aura)) p.aura = msg.aura;
    },
    // Debounced push of the durable half of the client state (client state.js). Upserts, so a
    // first save creates the document. Also refreshes the live values the leaderboards read.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch) return;
      this.applyLive(p, patch);

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // The tutorial step only ever moves forward ($max), so a stale or replayed save can never
      // bring a finished tutorial back.
      const { tutorialStep, ...rest } = patch;
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", ...(p.avatar ? { avatar: p.avatar } : {}), updatedAt: new Date() },
            ...(tutorialStep !== undefined && { $max: { tutorialStep } }),
            // A brand-new doc still owes the controls guide (a $set of controlsDone would conflict).
            $setOnInsert: { version: 1, ...(rest.controlsDone === undefined && { controlsDone: false }) },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: (client: Client, msg: { username?: string; userId?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.userId === "string") this.setUserId(client, p, msg.userId);
    },
  };

  // Runs once immediately -- a fresh room shouldn't sit on an empty board for a full
  // LEADERBOARD_REFRESH_MS -- then on a timer.
  onCreate() {
    void this.refreshLeaderboard();
    this.clock.setInterval(() => {
      void this.refreshLeaderboard();
    }, LEADERBOARD_REFRESH_MS);
  }

  onJoin(client: Client, options?: { username?: string; userId?: string; avatar?: string }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.avatar = sanitizeAvatar(options?.avatar);
    this.state.players.set(client.sessionId, p);

    this.setUserId(client, p, options?.userId ?? "");
    this.persistAvatar(client.sessionId, p);
    void this.refreshLeaderboard();
  }

  // Remembers a signed-in player's look so their statue survives them logging off. "" (signed
  // out / no avatar) never overwrites a saved one.
  private persistAvatar(sessionId: string, p: PlayerState) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players || !p.avatar) return;
    players
      // A doc born here belongs to a brand-new account: it starts the tutorial at step 0 (a doc with
      // no tutorialStep is a legacy save and reads as finished).
      .updateOne({ _id: userId }, { $set: { avatar: p.avatar, username: p.username || "Player", updatedAt: new Date() }, $setOnInsert: { version: 1, tutorialStep: 0, controlsDone: false } }, { upsert: true })
      .catch((err) => console.warn("[WorldRoom] avatar save failed", err));
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      this.forgetSession(client.sessionId);
    }
  }

  // Mirrors a sanitized save into the live roster entry (what the leaderboards rank).
  private applyLive(p: PlayerState, patch: Partial<PlayerDoc>) {
    if (patch.power !== undefined) p.power = patch.power;
    if (patch.rebirths !== undefined) p.rebirths = patch.rebirths;
    if (patch.leaves !== undefined) p.leaves = patch.leaves;
    if (patch.level !== undefined) p.level = patch.level;
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
  }

  // Client-trusted Bloxity user id (guest ids are dropped, see GUEST_ID_PREFIX). A forged id can
  // only read/overwrite the SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, 128);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never shows
      // as two leaderboard rows / two racing Mongo writers (a crashed tab lingers up to
      // RECONNECT_SECONDS via allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
    void this.refreshLeaderboard();
  }

  // Seeds this player's live roster values and sends the saved doc to just this client so it can
  // hydrate its state ("progress"), or "noProgress" when there is nothing to load (new account,
  // guest, or Mongo unset). A failed read sends "serverError" so the client does not overwrite a
  // save it could not read.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    if (!doc) {
      client.send("noProgress", { serverTime: Date.now() });
      return;
    }
    const live = { ...(sanitizeProgress(doc) ?? {}), tutorialStep: resolveTutorialStep(doc), controlsDone: resolveControlsDone(doc) };
    this.applyLive(p, live);
    // serverTime lets the client judge daily-login days / boost expiry by the server clock.
    client.send("progress", { ...live, serverTime: Date.now() });
  }

  // Builds and broadcasts the merged "all-time saved + currently online" leaderboard. Only the
  // server has both the live roster and the sessionId->userId map needed to tell "this online
  // player already IS a saved account" apart from "this saved account is offline". Private so
  // tests can call and await it directly.
  private async refreshLeaderboard() {
    const onlineRows: OnlineRow[] = [];
    const onlineUserIds = new Set<string>();
    this.state.players.forEach((p, sessionId) => {
      const userId = this.userIds.get(sessionId) ?? null;
      if (userId) onlineUserIds.add(userId);
      onlineRows.push({
        sessionId,
        userId,
        username: p.username || "Player",
        avatar: p.avatar,
        power: p.power,
        rebirths: p.rebirths,
        leaves: p.leaves,
        level: p.level,
      });
    });

    const players = getPlayers();
    const payload = { power: [], rebirths: [], leaves: [], level: [] } as LeaderboardPayload;

    for (const stat of LEADERBOARD_STATS) {
      // Online rows first: a connected player's live value is more current than their last save.
      const merged: LeaderboardRow[] = dedupeOnline(onlineRows, stat).map((row) => ({
        id: row.sessionId,
        name: row.username,
        value: row[stat],
        avatar: row.avatar,
      }));

      // Then everyone who has EVER saved, minus accounts already shown live.
      if (players) {
        try {
          const docs = await players
            .find({}, { projection: { _id: 1, username: 1, avatar: 1, [stat]: 1 } })
            .sort({ [stat]: -1 })
            .limit(LEADERBOARD_QUERY_LIMIT)
            .toArray();

          let offlineIndex = 0;
          for (const doc of docs) {
            if (onlineUserIds.has(doc._id)) continue;
            // Synthetic id -- never broadcast another account's raw user id.
            merged.push({
              id: `offline:${stat}:${offlineIndex++}`,
              name: doc.username || "Player",
              value: (doc[stat] as number | undefined) ?? 0,
              avatar: doc.avatar,
            });
          }
        } catch (err) {
          console.warn(`[WorldRoom] leaderboard query failed for stat=${stat}`, err);
        }
      }

      // Collapse rows sharing a display name (the same account under a different id would
      // otherwise appear twice). Keep the higher value but prefer an online row's id so the
      // client can recognise its own row.
      const byName = new Map<string, LeaderboardRow>();
      for (const row of merged) {
        const key = row.name || "Player";
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, row);
          continue;
        }
        const preferId = existing.id.startsWith("offline:") && !row.id.startsWith("offline:") ? row.id : existing.id;
        byName.set(key, { id: preferId, name: key, value: Math.max(existing.value, row.value), avatar: existing.avatar || row.avatar });
      }
      const deduped = [...byName.values()];

      deduped.sort((a, b) => b.value - a.value);
      // Avatars are big: ship only the #1 row's, not all ten.
      payload[stat] = deduped.slice(0, LEADERBOARD_ROWS).map((row, i) => (i === 0 && row.avatar ? row : { id: row.id, name: row.name, value: row.value }));
    }

    this.broadcast("leaderboard", payload);
  }
}
