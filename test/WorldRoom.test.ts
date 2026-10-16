import assert from "assert";
import type { Collection } from "mongodb";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { SPAWN, WORLD_BOUNDS } from "../src/constants.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";

// waitForNextPatch() resolves on the server's tick, which can be before a
// connected client has decoded it; poll the client's view instead.
async function until(check: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

// Hand-rolled fake `players` collection implementing only the subset WorldRoom.ts calls:
// find().sort().limit().toArray(), updateOne() (upsert, $set), findOne().
function fakePlayersCollection(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  const fake = {
    docs,
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return { modifiedCount: 0 };
      const base = existing ?? ({ _id: filter._id, ...(update.$setOnInsert ?? {}) } as PlayerDoc);
      const next: any = { ...base, ...(update.$set ?? {}) };
      for (const [k, v] of Object.entries<number>(update.$max ?? {})) next[k] = Math.max(next[k] ?? -Infinity, v);
      docs.set(filter._id, next as PlayerDoc);
      return { modifiedCount: 1 };
    },
    find(_filter: any) {
      let sortField: string | null = null;
      let limitN = Infinity;
      const cursor = {
        sort(spec: Record<string, number>) {
          sortField = Object.keys(spec)[0];
          return cursor;
        },
        limit(n: number) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let arr = Array.from(docs.values());
          if (sortField) {
            const field = sortField;
            arr = arr.slice().sort((a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0));
          }
          return arr.slice(0, limitN);
        },
      };
      return cursor;
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc> };
}

describe("WorldRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => {
    await colyseus.cleanup();
  });
  afterEach(() => __setPlayersForTest(null));

  it("starts a joining player at the spawn, with their name and avatar", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const avatar = JSON.stringify({ equipped: { hatId: "3" }, proportions: { height: 1.2 } });
    const c1 = await colyseus.connectTo(room, { username: "Raker", avatar });
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    const s = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s.username, "Raker");
    assert.strictEqual(s.avatar, avatar);
    assert.strictEqual(s.x, SPAWN.x);
    assert.strictEqual(s.z, SPAWN.z);
  });

  it("relays pose to other players and sanitises it", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    c1.send("pose", { x: -120.5, y: 2, z: -3, yaw: 0.5, speed01: 7, grounded: false, pose: "blow" });
    await room.waitForNextPatch();
    const s = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s.x, -120.5);
    assert.strictEqual(s.y, 2);
    assert.strictEqual(s.z, -3);
    assert.strictEqual(s.yaw, 0.5);
    assert.strictEqual(s.speed01, 1); // clamped to 0..1
    assert.strictEqual(s.grounded, false);
    assert.strictEqual(s.pose, "blow");

    // NaN is ignored, null clears the pose, out-of-world positions are clamped.
    c1.send("pose", { x: NaN, z: 99999, pose: null });
    await room.waitForNextPatch();
    const s2 = c2.state.players.get(c1.sessionId)!;
    assert.strictEqual(s2.x, -120.5);
    assert.strictEqual(s2.z, WORLD_BOUNDS.maxZ);
    assert.strictEqual(s2.pose, "");
  });

  it("relays avatar changes and rejects oversized ones", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room, { avatar: "{}" });
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    c1.send("setAvatar", { avatar: '{"equipped":{"backId":"9"}}' });
    await room.waitForNextPatch();
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.avatar, '{"equipped":{"backId":"9"}}');

    c1.send("setAvatar", { avatar: "x".repeat(3500) });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.avatar, '{"equipped":{"backId":"9"}}'); // ignored

    c1.send("setAvatar", { avatar: "" }); // signing out clears it
    await until(() => c2.state.players.get(c1.sessionId)!.avatar === "");
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.avatar, "");
  });

  it("relays the equipped vacuum and aura, rejecting unknown ids", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();

    c1.send("setVacuum", { vacuum: "turbo" });
    c1.send("setAura", { aura: "static" });
    await until(() => c2.state.players.get(c1.sessionId)!.vacuum === "turbo");
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.vacuum, "turbo");
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.aura, "static");

    c1.send("setVacuum", { vacuum: "laser" });
    c1.send("setAura", { aura: "<script>" });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.vacuum, "turbo"); // ignored
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.aura, "static"); // ignored

    c1.send("setAura", { aura: "" });
    await until(() => c2.state.players.get(c1.sessionId)!.aura === "");
    assert.strictEqual(c2.state.players.get(c1.sessionId)!.aura, "");
  });

  it("removes a player who leaves", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    await room.waitForNextPatch();
    assert.strictEqual(c2.state.players.size, 2);

    await c1.leave();
    await room.waitForNextPatch();
    assert.strictEqual(c2.state.players.size, 1);
    assert.strictEqual(c2.state.players.has(c1.sessionId), false);
  });

  it("saves a signed-in player's progress", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Raker" });

    c.send("saveProgress", {
      cash: 120, power: 33, leaves: 14, rebirths: 1,
      vacuumOwned: ["battery", "gas"], vacuum: "gas", bag: [{ name: "Gem", rarity: "Uncommon", value: 95 }],
    });
    await until(() => fake.docs.has("u1"));
    const doc = fake.docs.get("u1")!;
    assert.strictEqual(doc.cash, 120);
    assert.strictEqual(doc.username, "Raker");
    assert.deepStrictEqual(doc.vacuumOwned, ["battery", "gas"]);
    assert.strictEqual(room.state.players.get(c.sessionId)!.rebirths, 1);
    assert.strictEqual(room.state.players.get(c.sessionId)!.power, 33);
  });

  it("keeps the tutorial for new accounts, hides it from legacy saves and never moves it back", async () => {
    const fake = fakePlayersCollection([
      { _id: "old", username: "Veteran", cash: 5, version: 1, updatedAt: new Date() }, // predates the tutorial
      { _id: "mid", username: "Midway", tutorialStep: 3, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const sent = new Map<string, any>();
    const orig = (room as any).loadProgress.bind(room);
    (room as any).loadProgress = (c: any, userId: string, ...rest: any[]) => {
      const send = c.send.bind(c);
      c.send = (type: string, msg: any) => {
        if (type === "progress" || type === "noProgress") sent.set(userId, { type, msg });
        send(type, msg);
      };
      return orig(c, userId, ...rest);
    };
    await colyseus.connectTo(room, { userId: "old", username: "Veteran" });
    const mid = await colyseus.connectTo(room, { userId: "mid", username: "Midway" });
    const fresh = await colyseus.connectTo(room, { userId: "fresh", username: "Fresh" });
    await until(() => sent.size >= 3);
    assert.strictEqual(sent.get("old").msg.tutorialStep, 9); // finished: never shown
    assert.strictEqual(sent.get("mid").msg.tutorialStep, 3);
    assert.strictEqual(sent.get("fresh").type, "noProgress"); // new account: client starts at 0

    // First save of a new account creates its doc at its step; stale saves cannot go backwards.
    fresh.send("saveProgress", { cash: 1, tutorialStep: 2 });
    await until(() => fake.docs.get("fresh")?.tutorialStep === 2);
    fresh.send("saveProgress", { cash: 2, tutorialStep: 1 });
    await until(() => fake.docs.get("fresh")?.cash === 2);
    assert.strictEqual(fake.docs.get("fresh")!.tutorialStep, 2);
    mid.send("saveProgress", { tutorialStep: 99 });
    await until(() => fake.docs.get("mid")!.tutorialStep === 9);
  });

  it("sends a returning account its saved progress, and noProgress to a new one", async () => {
    const fake = fakePlayersCollection([
      { _id: "u2", username: "Back", cash: 900, power: 40, leaves: 7, level: 3, vacuum: "gas", version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});

    // The reply can land before a client handler is registered, so capture it server-side.
    const sent: [string, any][] = [];
    const orig = (room as any).loadProgress.bind(room);
    (room as any).loadProgress = (c: any, ...rest: any[]) => {
      const send = c.send.bind(c);
      c.send = (type: string, msg: any) => {
        sent.push([type, msg]);
        send(type, msg);
      };
      return orig(c, ...rest);
    };

    const back = await colyseus.connectTo(room, { userId: "u2", username: "Back" });
    await colyseus.connectTo(room, { userId: "u-new", username: "Fresh" });
    await until(() => sent.length >= 2);

    const progress = sent.find(([t]) => t === "progress")![1];
    assert.strictEqual(progress.cash, 900);
    assert.strictEqual(progress.vacuum, "gas");
    assert.ok(sent.some(([t]) => t === "noProgress"));

    const p = room.state.players.get(back.sessionId)!;
    assert.strictEqual(p.power, 40);
    assert.strictEqual(p.leaves, 7);
  });

  it("accepts a save far larger than Colyseus's default 4 KB message cap", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "big", username: "Hoarder" });
    const discovered = Array.from({ length: 800 }, (_, i) => `Item number ${i}`);
    c.send("saveProgress", { cash: 1, discovered });
    await until(() => fake.docs.has("big"), 2000);
    assert.strictEqual(fake.docs.get("big")!.discovered!.length, 800);
  });

  it("never persists guests", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-abc", username: "Guest" });
    c.send("saveProgress", { cash: 5, power: 9 });
    await until(() => room.state.players.get(c.sessionId)?.power === 9);
    assert.strictEqual(fake.docs.size, 0);
    assert.strictEqual(room.state.players.get(c.sessionId)!.power, 9); // still on the live board
  });

  it("broadcasts leaderboards merging saved and online players", async () => {
    const fake = fakePlayersCollection([
      { _id: "old", username: "Veteran", power: 5000, leaves: 10, rebirths: 4, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u3", username: "Newbie" });
    let boards: any = null;
    c.onMessage("leaderboard", (m) => (boards = m));
    c.send("saveProgress", { power: 100, rebirths: 1 });
    await until(() => room.state.players.get(c.sessionId)?.power === 100);
    boards = null;
    await (room as any).refreshLeaderboard();
    await until(() => boards !== null);
    assert.deepStrictEqual(boards.power.map((r: any) => r.name), ["Veteran", "Newbie"]);
    assert.deepStrictEqual(boards.rebirths.map((r: any) => r.value), [4, 1]);
    assert.ok(boards.leaves);
  });
});
