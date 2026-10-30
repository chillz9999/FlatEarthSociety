# Fair play: verification, anti‑cheat & the attempt‑restoration policy

## The server never trusts a client score

Every ranked run is **replayed on the server** from:

- the **secret seed**, issued only when the paid attempt is started (128 bits from `crypto.randomBytes`);
- the **game version** recorded at start;
- the player's **input log**: the tick at which steering changed and the new value (−1, 0, +1), and, if the voyage bought its bonus life, the tick at which the ship was lost and put back on the water.

The simulation is deterministic. It uses a fixed 60 Hz timestep and seeded 32‑bit integer RNG streams. Trigonometry is computed with fixed polynomials, because `Math.sin`, `Math.cos` and `**` are implementation‑approximated in ECMAScript and differ between Chrome, Firefox and Safari. A test fails if the simulation modules ever use them. The server's replay is therefore bit‑identical to the browser's, and the score is whatever the server's replay produces.

## Checks on every ranked submission

| Check | Outcome on failure |
|---|---|
| Session token (SIWE) belongs to the attempt's wallet | 404 |
| Attempt was paid (receipt fetched from the chain and the `EntryPurchased` log matched to this player and reference, never a client‑reported hash alone) | cannot start |
| Seed issued once (`paid → started` atomically) | second start refused |
| Input log well‑formed: increasing ticks, valid steer values, no redundant events, ≤ 30 changes in any one‑second window, at most one bonus life | rejected |
| A voyage that carried on after a loss paid for its bonus life onchain (`ExtraLifePurchased` for its entry, by its wallet) | rejected (`bonus_life_not_paid`) |
| Simulated duration ≤ real time since the seed was issued (+5 s) | rejected (`faster_than_real_time`) |
| The replay ends in a loss exactly at the claimed tick | rejected if the ship is still afloat; flagged if it was lost earlier |
| Claimed score / final state hash / checkpoint hashes match the replay | flagged (the score is still the server's) |
| Submitted inputs extend the checkpoints sent during play: earlier events unchanged, new events only after the last checkpoint's tick (history cannot be rewritten) | checkpoint refused / run flagged |
| One ranked run in progress per player (database‑enforced); starts, restorations and supersessions are serialised per player | second start refused |
| More than 90 s of real time unaccounted for (a ranked run cannot be paused; the time spent buying a bonus life, from the loss to the confirmed payment, does not count) | flagged |
| Each payment, start and submission is single‑use | idempotent responses, no double counting |

## The bonus life

A ranked voyage may buy one bonus life when its ship is lost. The client asks the server what it costs (`POST /api/attempts/:id/life`; the server notes when it was offered), the player pays `SocietyEntry.buyExtraLife(entryId, maxFee)`, and the server checks the receipt itself (`POST /api/attempts/:id/life/payment`) before the voyage carries on. The log indexer records bonus lives the browser never reported.

The input log marks the bonus life as a `REVIVE` event at the tick the ship was lost. The server's replay takes it **only if its own simulation lost the ship at exactly that tick**, and puts the ship back on the water exactly as the browser did. A logged bonus life that the replay does not need is ignored and flagged (`revive_unused`). A replay that used a bonus life nobody paid for is rejected. The real time between the loss and the confirmed payment is excused from the clock check; any pause before the loss is not.

## Practice voyages

Practice is free and never counts towards prizes. Every practice voyage still sails a seed issued by the server (`POST /api/practice`, open to guests), so any of them can be recorded on the weekly practice board: a named explorer's at once, a guest's when they add a name on the result card (the voyage is then theirs, and nobody else can submit it). The server replays the submitted input log exactly as for a ranked run; recording requires a signed‑in explorer with a name. Because practice may be paused, the only time check is that the run cannot be faster than the clock (+5 s). Any disagreement between the client's claims and the replay rejects the voyage from the board. Starting a new voyage gives up the previous unfinished one, and voyages never submitted are given up after a day.

## Anomaly detection (automated play)

Replay proves a run is *possible*. It cannot prove a *person* played it: a bot with perfect play produces a valid replay. The server therefore computes heuristics (`packages/game-core/src/analysis.ts`):

- sustained input rate (> 9 changes/s) and bursts (> 20 changes in one second);
- the share of key presses lasting exactly one frame (16.7 ms), which is rare for human fingers;
- metronomic rhythm (very low variation in the gaps between inputs);
- near‑miss rate: threading hazards within a few units, many times a minute, for minutes on end.

A run with a review flag that would place in the **top 10** (`REVIEW_TOP_N`) is held as `flagged`. It stays off the Registry until an administrator approves or rejects it in the admin console.

- The same rule applies to runs that are **never submitted** and are scored at their last checkpoint. The real‑time check is measured at the moment that checkpoint arrived, so pausing or slowing a run and then walking away does not avoid review.
- Weekly settlement cannot finalize while a flagged run could change the top three, **or** while any run in the prize positions carries an anomaly flag that no administrator has reviewed. This covers a run that ranked lower when it was submitted and rose later.
- Flags never change a score.

## Fairness of the sea itself

See [Game design](GAME_DESIGN.md#fairness-rules): every row of hazards keeps a gap, some opening is always within sideways reach of wherever the ship could be, nothing is placed in the open water between rows, and everything appears out of the mist seconds before it matters. The course depends only on the seed, so every explorer sailing a seed meets exactly the same sea. All of this is verified by automated tests across many seeds.

## The attempt‑restoration policy

The specification requires that *an entry is never consumed because of a server failure before the game begins*, and that disconnects, crashes and invalid sessions are handled by an explicit, auditable policy. This is it.

| Situation | What happens |
|---|---|
| **Paid, but the browser never reported the transaction** (closed tab, crash) | The log indexer finds every `EntryPurchased` event and credits the entry anyway. This includes payments made straight to the contract without a reservation. |
| **Paid, server unavailable before the game began** | Nothing is consumed: the entry stays `paid` (an unused credit) until it is started. Credits do not expire and roll into later weeks. |
| **Started, but the server never heard anything back** (the start response was lost, or the browser crashed before the first checkpoint) | The player may **self‑restore once in any 7 days**: the attempt becomes `restored` and a fresh paid attempt is issued. Further restorations need an administrator. |
| **Disconnect or crash mid‑run** | During a ranked run the client sends a checkpoint (inputs so far) every 5 seconds. The finished run is kept in local storage, keyed by attempt, and **resubmitted automatically**: in the background, on reconnect, and after signing in again if the session expired. No new attempt launches until it is delivered. If no submission arrives within the maximum run length plus 10 minutes, the run is **scored as it stood at its last checkpoint** (`abandoned`, which counts on the Registry, subject to the same review rules). Progress is never lost to a disconnect. |
| **A run the Society never heard from at all** | Marked `abandoned` with no score; it does not rank. It is eligible for the self‑service restoration above. |
| **Starting a new attempt while another is marked in progress** | The older one is finalized at its last checkpoint. |
| **The week ends during a run** | Runs started before the end can still be submitted during the close grace period. |
| **A run the Society cannot verify** (rejected), or any other dispute | An administrator may restore the attempt with a written reason. A run that counted toward a week that is already finalized cannot be restored. |

Every payment credit, start, abandonment, restoration, review decision and settlement action is written to `audit_log` with the actor (wallet or `system`) and details. Administrators see it in the admin console.

Self‑service restoration exists for genuine failures, such as a lost start response. It cannot tell those apart from a player who deliberately withholds every checkpoint after seeing the seed. That is why it is limited to one in any 7 days, enforced under a per‑player lock. A re‑roll is therefore rare, and the opening of every seed is calm water anyway.

## What this does not stop

- A sufficiently good bot that plays at human pace with human‑like input. Heuristics plus human review of top scores reduce the risk, but cannot remove it. Treat flagged top scores seriously.
- Multiple wallets per person (Sybil). This only matters for prize concentration. If it becomes a problem, add eligibility checks as part of the compliance work.
