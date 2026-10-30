# Architecture

```
packages/game-core   deterministic simulation (no dependencies) ──┬── apps/web     (renders it, records inputs)
packages/shared      ABIs, week math, chain defs, API types ───────┼── apps/server  (replays it, scores it)
contracts            SocietyEntry, SocietyPrizeVault, converters ──┘
```

## The simulation (`packages/game-core`)

- **Fixed timestep.** 60 ticks per second. The browser accumulates real time and steps the simulation in whole ticks, rendering interpolated poses between them. Input is sampled once per tick.
- **Determinism.** The course comes from a seeded `sfc32` stream derived from the 128‑bit seed, and depends on nothing else: steering never changes it. Only exactly specified IEEE‑754 operations are used (`+ − × ÷`, `Math.sqrt`, `floor`, `round`, `min`, `max`). Exponentiation and `Math.sin/cos/atan2/pow` are banned from the simulation modules (fixed polynomials in `detmath.ts` stand in where needed), and a test enforces this. Rendering is free to use anything, because it never feeds back into the simulation.
- **State per step:** difficulty for this tick → steer (sideways velocity eases towards the helm) → whirlpool drift → move (forward at the current speed, sideways at the steering velocity) → lay rows of hazards and treasure (`evidence` in the code) until the course is charted 3,600 units ahead (each row passes the fairness rules) → drop what is behind the camera → pick up treasure → collisions (the Edge on either side, whirlpool cores, hull circles against hazards) → checkpoint hash (every 600 ticks).
- **Replays** are just the steering changes `[tick, steer]`, delta‑encoded on the wire: a few hundred bytes per minute. A bonus life is one more event, `[tick, REVIVE]`, at the tick the ship was lost; `Simulation.revive()` puts the ship back on the water and the replay takes it only if its own ship was lost at that tick. `verifyRun` validates the log, replays it and compares the result with the client's claims. `analyseRun` computes anomaly heuristics.
- **Performance.** A 6‑minute run replays in well under a second on the server (there is a test for it).

## The web client (`apps/web`)

- `src/game/runner.ts` owns the loop, keyboard input, input recording, the chase camera's sideways follow, pause rules (practice only), and death sequences.
- `src/game/renderer.ts` chooses how the voyage is drawn: in 3D with WebGL 2 where the browser has real graphics hardware, otherwise in Canvas 2D (`?renderer=2d|3d` forces either). If the 3D renderer fails mid-voyage (an error, or a lost WebGL context the browser does not restore within 2 s), the voyage carries on in 2D on a fresh canvas, and the rest of the browser session starts in 2D. The runner also catches any drawing error, so the HUD, the result and the replay never wait on the picture. Both renderers draw only what the simulation and runner hand them (`view.ts`), and nothing feeds back into the simulation.
- `src/game/gl/` is the 3D renderer (three.js), from the same chase camera. `water.ts`: an animated sea with procedural normals, sun glint, fresnel and a planar mirror of the sky and hazards; `sky.ts` and `stage.ts`: a sky dome with clouds, stars, moon and aurora, and the light of each of the five stages; `edge.ts`: the sea pouring over the lip into the void on both sides; `models.ts` and `hazards.ts`: every hazard as a procedural mesh (noise‑displaced rocks and sea stacks, icebergs and ice shelves, islands, wrecks, the sea gate, the bronze Colossus, the leviathan), varied by each obstacle's seed and reused as obstacles come and go; `fx.ts`: the wake, whirlpool funnels, foam rings, glows, animated kraken tentacles and particles; `coins.ts` and `ship.ts`; `post.ts`: multisampling, bloom, tone mapping and the vignette. Where the light is poor (the red storm of Dangerous Waters, and night at the Outer Rim and the Edge) rock, ice, wood, land and kraken catch a rim, set per stage in `stage.ts`, so they stand out from the sea. The share card is `app/opengraph-image.jpg` (a frame of the game at the Edge, composed with the coin and the name); `lib/meta.ts` gives every page its title, description and the card. On its first frame the renderer compiles, in the background, the shaders of a hidden showcase holding one of every hazard (and a whirlpool), and keeps it: no hazard's shaders are compiled, or freed and compiled again, mid‑voyage (each such compile froze the game for a tenth of a second or more). When frames run long it drops a quality tier (mirror, shadows, bloom, resolution) and climbs back when there is headroom.
- `src/game/renderer2d.ts`, `art.ts` and `art3d.ts` are the Canvas‑2D renderer, drawn from the same chase camera: a perspective projection of the channel, with engraved wave marks that stream past to show the speed, a low sun and mist at the horizon, and the sea pouring off the Edge on either side. There are no image assets. Rocks, icebergs, islands, wrecks, wreckage, coins and the ship are painted procedurally: faceted faces lit from the low sun, stone and ice texture, cracks, a wet and weedy waterline, layered surf, and a rippled reflection in the sea. Each is cached as a sprite (built a few per frame, before it comes into view), then drawn upright and sorted by depth; whirlpools are drawn on the water with turning spiral arms and their pull area. Rendering costs about 1–2.5 ms of JavaScript per frame; a sprite takes 1–3 ms to build (an island or ice shelf up to about 10 ms).
- `src/game/audio.ts` synthesises sound with WebAudio: ambient sea, a waterfall roar that rises near the Edge, and sounds for treasure, stage changes, whirlpools, crashes and falls.
- **Explorers** (`components/site/JoinForm.tsx`, `components/test/ExplorerGate.tsx`): name first. The player types a unique name (checked with `GET /api/players/name-available`), then connects a wallet and approves a SIWE signature, and the name is saved. Ranked play needs this before Space will launch; practice does not.
- **Practice flow** (`components/test/PracticeArena.tsx`, `lib/practice.ts`): Space → `POST /api/practice` returns a server seed, for guests too → sail (pausing allowed). A named explorer's voyage is submitted at once; a guest's result card offers to add a name, and the voyage is submitted (claimed) as soon as the name is saved. The server replays the run (it may not be faster than the clock) and records it on the practice board. Unsent voyages are kept in local storage and retried. If the server cannot be reached, practice still runs, unrecorded, on a local seed.
- **Ranked flow** (`components/test/RankedArena.tsx`, `lib/ranked.ts`): connect → SIWE sign‑in → reserve → approve exactly the fee → `enter(attemptRef, maxFee)` → server verifies → Space → `start` returns the seed → checkpoints every 5 s → submit (kept in local storage until acknowledged) → verified result, rank, personal best and points to third place.
- **Bonus life** (`components/test/LifeOffer.tsx`, `GameStage` phase `offer`): when a ranked ship is lost, the offer replaces the result for 20 s. Paying: `POST /api/attempts/:id/life` → approve exactly the fee → `buyExtraLife(entryId, maxFee)` → `POST …/life/payment` until confirmed → `runner.revive()` records the revive, sends a checkpoint and the voyage carries on. Declining ends the voyage as usual.
- Prices are shown in dollars with their $WIF cost today (`lib/prices.ts`), from `/api/config`.
- The game is desktop‑only. Small or touch‑only screens get a polite refusal instead of the site.

## The API (`apps/server`)

Fastify 5, zod validation, rate limits, and CORS restricted to the site origin.

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | chain, contracts, tokens, live entry and bonus‑life fees, their dollar prices and the $WIF price, whether prizes are paid in $WIF, pause state |
| `GET /api/competition/current`, `/api/competition/:week` | entries, bonus lives, $WIF collected / allocated / protocol, prize pool, conversions (second prize token only), top three |
| `GET /api/leaderboard?week=&limit=` | the Registry (best verified score per wallet, tie‑broken by verification time) |
| `GET /api/treasury`, `GET /api/hall`, `GET /api/players/:address` | disclosures, history, past winners, player statistics |
| `POST /api/players/me/name` | choose the explorer name (unique, ignoring case) |
| `POST /api/practice`, `POST /api/practice/:id/submit`, `GET /api/practice/leaderboard` | practice voyages: a server seed, replay on submission, and the weekly practice board |
| `GET /api/events` | server‑sent events (`leaderboard`, `competition`) |
| `GET /api/auth/nonce`, `POST /api/auth/verify`, `GET /api/auth/me` | Sign‑In with Ethereum (EIP‑4361; ERC‑1271/6492 smart wallets supported through the RPC) |
| `POST /api/attempts`, `GET /api/attempts/mine` | reserve a ranked attempt; list credits |
| `POST /api/attempts/:id/payment` | verify an entry payment onchain |
| `POST /api/attempts/:id/start` / `checkpoint` / `submit` / `restore` | ranked session lifecycle |
| `POST /api/attempts/:id/life`, `POST /api/attempts/:id/life/payment` | the bonus life: its price and entry, then its payment verified onchain |
| `/api/admin/*` | overview, review, restore, close / convert / finalize / payout, re‑price now, indexer sync |

**Background jobs:** the payment indexer (follows `EntryPurchased` and `ExtraLifePurchased` to the confirmed head), the price service (keeps the fees at their dollar prices, see [Economy](ECONOMY.md#pricing-in-dollars-paid-in-wif)), week transitions, the abandoned‑run sweep, and optional automatic settlement.

**Data model** (`migrations/`): `players`, `auth_nonces`, `competitions`, `payments` (one row per onchain entry), `extra_lives` (one row per bonus life), `attempts` (the state machine below), `practice_runs`, `settlements` (every conversion, finalization and payout transaction), `price_updates`, `audit_log`, `kv`.

```
awaiting_payment ──(payment verified)──▶ paid ──(start: seed issued)──▶ started ──(submit)──▶ verified │ flagged │ rejected
                                          │                                │
                                          └──────(restore)──▶ restored ◀───┤ (no contact)
                                                                           └──(timeout / new start / week close)──▶ abandoned (scored at last checkpoint)
```

## Contracts

See [`contracts/README.md`](../contracts/README.md) and [Economy](ECONOMY.md).
