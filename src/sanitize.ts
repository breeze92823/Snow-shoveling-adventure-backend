import {
  CURRENCY_MAX, REBIRTH_MAX, LEVEL_MAX, BAG_SAVE_MAX, DISCOVERED_MAX, LOCKED_MAX, ITEM_VALUE_MAX, TEXT_MAX,
  RARITIES, UPGRADE_MAX, PLAY_SECONDS_MAX, VACUUM_IDS, AURA_IDS,
  DAILY_DAY_MAX, BOOST_IDS, BOOST_MAX_AHEAD_MS, CLOCK_SLACK_MS, TUTORIAL_DONE_STEP,
} from "./constants.js";
import type { LootDoc, PlayerDoc } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function text(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= TEXT_MAX ? v : null;
}

// Carried loot { name, rarity, value }.
export function sanitizeBag(raw: unknown): LootDoc[] {
  if (!Array.isArray(raw)) return [];
  const out: LootDoc[] = [];
  for (const it of raw.slice(0, BAG_SAVE_MAX)) {
    if (!isObject(it)) continue;
    const name = text(it.name);
    if (!name || typeof it.rarity !== "string" || !RARITIES.includes(it.rarity) || !finite(it.value)) continue;
    out.push({ name, rarity: it.rarity, value: clampNum(it.value, ITEM_VALUE_MAX) });
  }
  return out;
}

// Loot names (Index entries, locked items): short strings, no duplicates, capped.
export function sanitizeNames(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(text).filter((n): n is string => n !== null))].slice(0, max);
}

// Known ids only, no duplicates (owned vacuums / auras).
export function sanitizeIds(raw: unknown, known: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === "string" && known.includes(id)))];
}

// { range: 3, ... } -> known upgrade ids with integer levels, capped at each upgrade's max.
function sanitizeUpgrades(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  for (const [id, max] of Object.entries(UPGRADE_MAX)) if (finite(raw[id])) out[id] = clampInt(raw[id] as number, max);
  return out;
}

// { power: 1.7e12, ... } -> known boost ids with an integer expiry, never further ahead than BOOST_MAX_AHEAD_MS.
function sanitizeBoosts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  for (const id of BOOST_IDS) if (finite(raw[id])) out[id] = clampInt(raw[id] as number, Date.now() + BOOST_MAX_AHEAD_MS);
  return out;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save and their leaderboard rows.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  for (const key of ["cash", "power", "leaves", "xp", "xpNext"] as const) {
    if (finite(raw[key])) out[key] = clampNum(raw[key] as number, CURRENCY_MAX);
  }
  if (finite(raw.level)) out.level = clampInt(raw.level, LEVEL_MAX, 1);
  if (finite(raw.rebirths)) out.rebirths = clampInt(raw.rebirths, REBIRTH_MAX);
  if (raw.bag !== undefined) out.bag = sanitizeBag(raw.bag);
  if (raw.sellLocked !== undefined) out.sellLocked = sanitizeNames(raw.sellLocked, LOCKED_MAX);
  if (raw.discovered !== undefined) out.discovered = sanitizeNames(raw.discovered, DISCOVERED_MAX);
  if (raw.vacuumOwned !== undefined) out.vacuumOwned = sanitizeIds(raw.vacuumOwned, VACUUM_IDS);
  if (typeof raw.vacuum === "string" && VACUUM_IDS.includes(raw.vacuum)) out.vacuum = raw.vacuum;
  if (finite(raw.playSeconds)) out.playSeconds = clampInt(raw.playSeconds, PLAY_SECONDS_MAX);
  if (typeof raw.giftClaimed === "boolean") out.giftClaimed = raw.giftClaimed;
  if (raw.auraOwned !== undefined) out.auraOwned = sanitizeIds(raw.auraOwned, AURA_IDS);
  if (raw.aura === null) out.aura = null;
  else if (typeof raw.aura === "string" && AURA_IDS.includes(raw.aura)) out.aura = raw.aura;
  if (raw.upgrades !== undefined) out.upgrades = sanitizeUpgrades(raw.upgrades);
  if (finite(raw.dailyDay)) out.dailyDay = clampInt(raw.dailyDay, DAILY_DAY_MAX);
  if (finite(raw.dailyClaimedAt)) out.dailyClaimedAt = clampInt(raw.dailyClaimedAt, Date.now() + CLOCK_SLACK_MS);
  if (raw.boosts !== undefined) out.boosts = sanitizeBoosts(raw.boosts);
  if (finite(raw.tutorialStep)) out.tutorialStep = clampInt(raw.tutorialStep, TUTORIAL_DONE_STEP);
  if (raw.controlsDone === true) out.controlsDone = true; // only ever moves forward
  return out;
}

// What loadProgress sends down as tutorialStep: a doc that predates the tutorial belongs to a
// player who was never shown it, so it reads as finished. New accounts get a doc with an explicit
// step (WorldRoom.ts persistAvatar / saveProgress) or no doc at all (noProgress -> client starts at 0).
export function resolveTutorialStep(doc: Partial<PlayerDoc>): number {
  return finite(doc.tutorialStep) ? clampInt(doc.tutorialStep, TUTORIAL_DONE_STEP) : TUTORIAL_DONE_STEP;
}

// What loadProgress sends down as controlsDone: only a doc explicitly created as "not done yet"
// shows the controls guide; older docs read as done.
export function resolveControlsDone(doc: Partial<PlayerDoc>): boolean {
  return typeof doc.controlsDone === "boolean" ? doc.controlsDone : true;
}
