# Snow Shoveling Adventure — server

Colyseus server for the `Snow-shoveling-adventure` client: progress saving, multiplayer presence
(poses, Bloxity avatars, vacuums, auras) and leaderboards. Same stack and Bloxity Legion deploy
flow as `Chop-trees-for-treasure-backend`.

```
npm install
npm start        # tsx watch, ws://localhost:2567 (playground + /monitor in dev), GET /health
npm test         # mocha integration tests with an in-memory fake Mongo collection
npm run build    # -> build/, run with `node build/index.js` (see Dockerfile)
```

Config (all optional locally, see `.env.example`): `MONGODB_URI` (without it nothing persists),
`CLIENT_ORIGIN`, `PORT`.

## Protocol

Room: `world` (`joinOrCreate("world", { userId, username, avatar })`), up to 50 players per room;
extra players get a new room. `userId` is the Bloxity id; ids starting `guest-` are never saved.

| Client → server | Purpose |
| --- | --- |
| `pose` | `x y z yaw speed01 grounded pose` (~15 Hz) |
| `setAvatar` | Bloxity avatar JSON |
| `setVacuum` / `setAura` | equipped vacuum id / aura id (`""` = none) |
| `saveProgress` | the persisted `state.js` keys, debounced (sanitized, upserted in Mongo) |
| `identify` | `{ userId, username }` after a sign-in / sign-out; answered with `progress` / `noProgress` |

| Server → client | Purpose |
| --- | --- |
| `progress` | the saved document (hydrates `state`) |
| `noProgress` | new account, guest, or no Mongo — keep the local state (and push it) |
| `serverError` | the saved document could not be read; the client must not overwrite it |
| `leaderboard` | `{ power, rebirths, leaves, level }`, rows `{ id, name, value }`, top 10 (#1 row also carries `avatar`) |

Persisted keys (`src/sanitize.ts`): `cash power leaves level xp xpNext rebirths bag sellLocked
discovered vacuumOwned vacuum playSeconds giftClaimed auraOwned aura upgrades`. Room state (`WorldState.players`) syncs
pose, vacuum, aura, avatar, name and the leaderboard stats (`power rebirths leaves level`).

The game is client-authoritative: the server only enforces shape and bounds on saves. The id lists
and caps in `src/constants.ts` (`VACUUM_IDS`, `AURA_IDS`, `UPGRADE_MAX`, `RARITIES`, `SPAWN`,
`WORLD_BOUNDS`) must be kept in step with the client's `src/config.js` / `src/data/loot.js` by hand.

The client does not talk to this server yet (`src/net.js` is still to be written).

## Deploy

`.github/workflows/deploy.yml`: pull requests run build + tests; pushes to `dev` deploy the dev
channel and `main` the prod channel on Bloxity Legion (image pushed to GHCR). Needs the repo
variable `LEGION_GAME_ID` (= the client's `GAME_SLUG`, `snow-shoveling-adventure`) and the secret
`LEGION_DEPLOY_TOKEN`.
