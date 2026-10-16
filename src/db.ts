import { MongoClient, type Collection } from "mongodb";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

export interface LootDoc {
  name: string;
  rarity: string;
  value: number;
}

// Mirrors the persisted half of the client's src/state.js.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  // Display name as of the last save, so an offline leaderboard row still has something to show.
  username?: string;
  // Bloxity avatar JSON as last reported, so a board's top row can still be dressed offline.
  avatar?: string;
  cash?: number;
  power?: number; // trained power
  leaves?: number; // lifetime leaves cleaned
  level?: number;
  xp?: number;
  xpNext?: number;
  rebirths?: number;
  bag?: LootDoc[];
  sellLocked?: string[];
  discovered?: string[];
  vacuumOwned?: string[];
  vacuum?: string;
  playSeconds?: number; // total time played; unlocks the free gift vacuum
  giftClaimed?: boolean;
  auraOwned?: string[];
  aura?: string | null;
  upgrades?: Record<string, number>;
  dailyDay?: number; // last claimed day of the 7-day daily login streak (0 = none yet)
  dailyClaimedAt?: number; // epoch ms of that claim
  boosts?: Record<string, number>; // timed boosts: id -> epoch ms they expire
  // Onboarding progress (constants.ts TUTORIAL_DONE_STEP = finished). Only ever moves forward
  // ($max in WorldRoom.ts saveProgress). A doc without the field predates the tutorial and
  // reads as finished (sanitize.ts resolveTutorialStep), so existing players never see it.
  tutorialStep?: number;
  // The controls guide (WASD/Space/mouse...) was completed. New docs start false (WorldRoom.ts
  // persistAvatar); a doc without the field belongs to an existing player and reads as done.
  controlsDone?: boolean;
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");

    // refreshLeaderboard() sorts by each of these; createIndex is idempotent. A failure only
    // means those queries stay unindexed, never blocks startup.
    try {
      await players.createIndex({ power: -1 });
      await players.createIndex({ rebirths: -1 });
      await players.createIndex({ leaves: -1 });
      await players.createIndex({ level: -1 });
    } catch (err) {
      console.warn("[db] failed to create leaderboard indexes:", err);
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the leaderboard/save logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
