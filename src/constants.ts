// Keep in step with the client's src/config.js by hand.
export const ROOM_MAX_CLIENTS = 50;

// Where a player appears for everyone else before their first `pose` arrives (client SPAWN).
export const SPAWN = { x: 0, y: 0.3, z: 0 };

// Walkable bounds (client WORLD_BOUNDS: the hub plus the leaf field west to HUB.fieldEnd = -434),
// with a little slack: a forged pose cannot put a player outside the world for everyone else to see.
export const WORLD_BOUNDS = { minX: -445, maxX: 35, minZ: -35, maxZ: 35, minY: -40, maxY: 200 };

// Worlds a player can be in (client config.js WORLDS).
export const WORLDS = ["autumn", "winter"];

// Longest accepted strings.
export const NAME_MAX = 64;
export const POSE_MAX = 32;
// Bloxity avatar JSON, relayed as-is. Kept under the 4 KB cap of the join request's options.
export const AVATAR_MAX_LEN = 3000;

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// Leaderboards: how often WorldRoom re-queries Mongo for the all-time top players per stat, how
// many rows it fetches per stat before merging with the live roster, and how many it sends.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;
export const LEADERBOARD_ROWS = 10;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot push a bogus number onto the
// leaderboards. Generous ceilings, not game rules.
export const CURRENCY_MAX = 1_000_000_000_000_000_000; // cash, power, leaves, xp
export const REBIRTH_MAX = 1_000_000;
export const LEVEL_MAX = 1_000_000;
export const BAG_SAVE_MAX = 200; // client state.backpackMax is 3 + capacity upgrades
export const DISCOVERED_MAX = 2_000; // Index entries
export const LOCKED_MAX = 200; // names locked against Sell All
export const ITEM_VALUE_MAX = 1_000_000_000_000;
export const TEXT_MAX = 64; // item names

// Client data/loot.js RARITIES (loot in the Bag).
export const RARITIES: readonly string[] = [
  "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic", "Secret", "Celestial", "Divine",
];

// Client config.js ids: UPGRADES (with their max levels), VACUUMS and AURAS.
export const UPGRADE_MAX: Readonly<Record<string, number>> = { range: 20, agility: 20, capacity: 10, walk: 10 };
export const VACUUM_IDS: readonly string[] = [
  "battery", "suburban", "gas", "drum", "wheel", "dual", "turbo", "widemouth", "packgun", "industrial",
  "cyclone", "jet", "doublemotor", "cannon", "quadvent", "rotor", "twin", "triple", "heavy", "fourengine",
  "megaturbo", "tornado", "reactor", "shoulder",
];
export const AURA_IDS: readonly string[] = ["interstellar", "static", "cinderveil", "shardfall", "slipstream", "frostfire"];

// Daily login (client config.js DAILY): a 7-day streak. `dailyClaimedAt` is an epoch-ms stamp that can
// never be in the future (beyond clock slack); timed boosts (client state.boosts) expire at an epoch-ms
// stamp at most BOOST_MAX_AHEAD_MS from now.
export const DAILY_DAY_MAX = 7;
export const BOOST_IDS: readonly string[] = ["power", "cash"];
export const BOOST_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;
export const CLOCK_SLACK_MS = 10 * 60 * 1000;

// Client src/tutorial.js: the onboarding runs steps 0..TUTORIAL_DONE_STEP (9 = finished).
export const TUTORIAL_DONE_STEP = 9;

// Saved play time cap (s): ~1 year, far above the 50 min the free gift needs.
export const PLAY_SECONDS_MAX = 31_536_000;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
