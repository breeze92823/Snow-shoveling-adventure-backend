import { schema, t, type SchemaType } from "@colyseus/schema";
import { SPAWN } from "../../constants.js";

// The live roster: everything other clients need to draw this player. The server stores and
// relays it; the game is client-authoritative. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a character, add a field here and accept it in WorldRoom's
// `pose` / `set*` handlers.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    x: t.float64().default(SPAWN.x),
    y: t.float64().default(SPAWN.y),
    z: t.float64().default(SPAWN.z),
    yaw: t.float64().default(0),
    speed01: t.float64().default(0), // 0..1 gait factor -- purely cosmetic
    grounded: t.boolean().default(true),
    pose: t.string().default(""), // client animation name ("" = none), e.g. "blow"
    // Which world the player is in (client config.js WORLDS); players only see others in their world.
    world: t.string().default("autumn"),
    // Equipped vacuum id (client config.js VACUUMS), "" = default; drawn in the player's hands.
    vacuum: t.string().default(""),
    // Equipped aura id (client config.js AURAS), "" = none.
    aura: t.string().default(""),
    // The player's Bloxity avatar { equipped, proportions } as an opaque JSON string,
    // stored and relayed as-is (length-capped, never parsed here).
    avatar: t.string().default(""),
    // What the leaderboards rank (client state.js): mirrored from saves.
    power: t.float64().default(0),
    rebirths: t.float64().default(0),
    leaves: t.float64().default(0),
    level: t.float64().default(1),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
