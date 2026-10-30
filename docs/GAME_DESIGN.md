# Game design & balancing

## The Test

- The ship sails **straight ahead on its own** down the last charted channel of the flat Earth, and it keeps getting faster. The player only moves it **sideways**: hold **← / A** to slide to port, **→ / D** to starboard; with both held, the key pressed last wins, so rolling from one key to the other turns the ship at once. Keys typed into a text field (your name) never steer. There is no turning, reverse, brake, throttle, weapon or upgrade.
- Steering is smooth, not twitchy: sideways speed builds to full in 0.12 s while a key is held and eases back to a straight course in 0.09 s when it is released. There is no input delay; the next tick already moves. The ship banks into the slide and the chase camera follows it across the channel, a little behind.
- The channel is 880 units wide. On both sides the sea pours off the **Edge of the World** into the void. Crossing either side ends the run.
- Hazards come in **rows** across the channel, appearing out of the mist at the horizon several seconds before the ship reaches them:
  - scattered rocks (sea stacks, spires, twin crags, mesas, and now and then a great stack half as big again) and **icebergs** calved from the ice wall that rings the world;
  - wide, flat-topped **ice shelves**, with cliffs, caves and penguins;
  - solid **walls** of rock with a single gap, and the Society's **sea gates** — a wall with two pillars and an arch over the gap;
  - the **Colossus**: a bronze giant standing astride the gap, lantern raised; the ship sails between its feet;
  - **slaloms**: three to five walls in a row, hanging alternately from either side;
  - lines of **wreckage**, and great **wrecked galleons** (flying the Globe Lobby's colours) with their wreckage strewn about;
  - **islands**, some with a Society lighthouse or a Globe Lobby fort;
  - knots of **kraken tentacles**, the **leviathan** itself — a kraken's head with glowing eyes, ringed by its tentacles — and **whirlpools**.
- **Score = distance sailed ÷ 20 + 250 per piece of treasure, and 2,500 for a super coin.** At a given moment every ship moves at the same speed (the HUD shows it in knots: one knot is one point per second), so distance is simply a reward for staying alive. Treasure (gold coins; `evidence` in the code) is never needed to survive, and it is scattered all over the channel, not only along the way through: singles, short lines and small clusters across the open water before most rows, and a piece in half the rows — in the main gap, in one of the row's other openings, or (about 40 % of the time) tucked beside a hazard as a risk‑for‑reward choice. No piece is ever a trap: from wherever one lies, a way through the next row is still within reach, with the same safety margin as the course itself.
- **Super coins** are a row's piece that lies away from the main line: 20 % of those tucked beside a hazard and 10 % of those in a side opening are super coins (never one in the main gap). That is roughly one piece in fifty, about one every ten to fifteen seconds of sailing. A super coin is larger, carries a ruby, glows warm and throws turning rays of light, and is worth ten ordinary pieces. Collecting treasure shows the points won (+250, +2,500) rising beneath the score counter, clear of the ship.
- A run ends when the hull touches any hazard, when the ship reaches a whirlpool's core, or when it goes over the Edge. Each has its own animation and Society epitaph.
- **Feedback.** Clearing a hazard by a hair (within 8 units) shows *Close call* as the hull draws clear, with a rush of air; it scores nothing. Passing your best score mid‑voyage shows *New personal best* (free play: your best free‑play score; competitive: this week's best). The weekly rank in the HUD flashes each time it climbs. From the result card, **Space or Enter** sets sail again at once in free play (after a short pause, so a key still held from the voyage never skips the result).
- **The bonus life (ranked only, $5, once per voyage).** When the ship is lost, the explorer may pay to carry on. The ship goes back on the water where it sank, at rest across the channel and at least 80 units inside the Edge. It glows and flickers while it is shielded: hazards and whirlpools cannot sink it for 2.5 s, nor for as long after that as its hull is within 10 units of one (at most 6 s). The Edge is never shielded. The voyage carries on from the same moment, at the same speed, and keeps its score. It is part of the replay: the input log records the tick at which the ship was lost.
- Each stage has its own light: golden dusk in Calm Waters, an amber evening, a red storm sunset in Dangerous Waters, violet twilight with the first aurora at the Outer Rim, and night under the moon at the Edge. Where the light is poor every hazard catches a rim, so rocks stand out from the sea: pale gold in the red storm (a red rim would vanish against the red water), moonlight in the two night stages.
- Everything lies inside the channel's lines: every hazard is wholly within the channel, and nothing stands beyond the Edge.
- Collision uses two circles along the hull, smaller than the drawn ship. Hazards collide on a circle inside their drawn outline.

### Starting values (all in `packages/game-core/src/config.ts`)

| Parameter | Value |
|---|---|
| Forward speed | 480 units/s (24 kn) at launch, climbing steadily to about 980 units/s (49 kn) by the Edge stage; cap 1,100 |
| Sideways speed | 560 units/s, rising to about 840 units/s (cap ≈ 950) — always slower relative to forward speed as the run goes on |
| Sideways ease in / out | 0.12 s / 0.09 s |
| Channel | 880 units wide |
| Hull collision | 2 circles of radius 15, at +22 and −16 along the course |
| Opening stretch | no hazards for the first 800 units (under 2 s) |
| Warm‑up | the first 12 s: rows 1.05 s apart, passages 260 wide, little rock, a third of rows open water, no ice shelves; easing into Calm Waters |
| Passage margin | every row's main gap keeps 80 units of open water to the Edge |
| Bonus life | shield 2.5 s, then until 10 units clear of every hazard (at most 6 s); put back at least 80 units inside the Edge |
| Maximum run | 30 minutes (then "the examination has concluded") |

## Difficulty progression

| Time | Stage | Intensity | What changes |
|---|---|---|---|
| 0:00–0:30 | Calm Waters | 18 % | Rocks and icebergs, islands, the odd wreck; some rows of open water, wide gaps |
| 0:30–1:00 | Uncharted Territory | 35 % | The first walls, sea gates and kraken |
| 1:00–2:00 | Dangerous Waters | 60 % | Whirlpools, wreckage, slaloms, the leviathan and the Colossus; faster seas, rows closer together |
| 2:00–3:00 | The Outer Rim | 82 % | Narrow gaps, crowded rows |
| 3:00+ | The Edge | 100 % | Highest density and speed |
| 5:00+ | (overtime) | +6 %/min, up to 145 % | Speed and density keep climbing |

The first 12 seconds are a warm‑up inside Calm Waters (see the table above), so a first‑time explorer learns the helm before the course asks much of it. Intensity eases into each stage over 6 seconds, so it never jumps, and new kinds of trouble arrive one stage at a time. The ship's speed does not wait for the stages: it climbs steadily from the moment of launch, reaching each stage's speed as that stage begins. Intensity drives:

- the forward and sideways speed;
- the time between rows (0.8 s of sailing in calm water, 0.48 s at the Edge, 0.4 s in deep overtime — plus whatever extra run-up the fairness rules demand);
- the width of each row's main gap (200 units, shrinking to 105 — the ship's collision width is 30);
- how much of each row the rocks fill (26 % → 68 %, with more and more ice mixed in) and how often a row is open water (18 % → 3 %);
- how often walls, gates, the Colossus, slaloms, ice shelves, wreckage, kraken, the leviathan and whirlpools appear.

Each row is sized for the difficulty **at the moment the ship will reach it**, not when it is laid.

## Fairness rules

The course is generated from the seed alone: steering never changes it. Every row must pass these rules (`Simulation.layRow`).

1. **Always a way through.** Every row keeps a main gap at least 105 units wide, clear of every hazard and inside the channel.
2. **Always reachable, from anywhere.** For every position the ship could possibly have left the previous row from, some straight‑through opening of the new row must be within sideways reach — using only 70 % of the ship's sideways speed and allowing for the time the helm takes to answer — across the open water between the two rows. The generator works out where the ship could be with a sweep through each row. If an opening would be too far, the row is moved further down the course until it is not. Openings hugging the Edge or a whirlpool's core do not count.
3. **Nothing in between.** Rows never overlap, and no hazard is ever placed in the open water between them (only treasure — and only where a way through the next row is still in reach from it).
4. **No misleading gaps.** Walls, gates, the Colossus's wall and slaloms are built shoulder to shoulder, so any space in them is either closed or the gap itself. A line of wreckage has no ship‑sized holes in it other than the gap (the water beyond the end of the line is open too).
5. **Seen in time.** Hazards are laid 3,600 units ahead and fade in from the horizon mist, several seconds before they matter.
6. **Never hugging the Edge.** A main gap keeps at least 80 units of open water to the lip. A way through that hugs the Edge asks the helm to stop dead beside a fall, and a moment's overshoot ends the voyage. As the gap wanders across the channel from row to row it bounces off that limit rather than gathering against it. (Before this rule, a fifth of all rows had their gap against the lip, and those rows accounted for over a third of Edge losses.)
7. **Whirlpools are predictable.** Their pull is drawn on the water, grows towards the core and is capped at 45 % of the ship's sideways speed, so steering away always escapes. They are placed well clear of the main gap.
8. **A clean start.** Nothing in the first 800 units (about 2 s), two pieces of treasure to show how collecting works, and a 12‑second warm‑up.

These rules are checked by automated tests over many seeds (`packages/game-core/test/sim.test.ts`). The tests rebuild every row from the hazards actually laid and check the gap, the spacing and the reach rule independently. Three reference navigators must survive six minutes on every seed:

- one that follows each row's main gap, and
- a greedy one that heads for **whichever gap is nearest from wherever it happens to be** — the strategy a person uses;
- one that goes after every piece of treasure it can reach in time before each row, wherever it lies.

A navigator that can only see what is in view must also survive long runs: every run past two minutes, and three in four past three minutes.

## Anti‑farming

Distance is the score and forward speed is set by time alone, so there is nothing to farm. The only way to score more is to stay alive longer and pick up treasure.

- Doing nothing does not work: a hands‑off ship meets a blocked row within two minutes on every tested seed, usually much sooner.
- Holding one key reaches the Edge in about a second.

## Balancing results

From `npm run balance -w @fes/game-core -- 60`: 60 seeds per policy, with runs capped at 10 minutes. `npx tsx scripts/hazard-rate.ts` (in `packages/game-core`) prints how often each kind of navigator is lost per minute in each stretch of the voyage, and from what: a difficulty spike shows up as a jump in the rate.

| Navigator | p10 | median | p90 | Treasure per run (median score) |
|---|---|---|---|---|
| No input | 2 s | 5 s | 13 s | 2.5 (570) |
| Holds one key | 1 s | 1 s | 1 s | 0 (20) |
| Mashes keys at random (ignores hazards) | 2 s | 6 s | 10 s | 2 (417) |
| Novice bot (0.4 s reactions, frequent blunders, looks 1,100 units ahead) | 7 s | 27 s | 66 s | 28, 0.5 super (8,452) |
| Average bot (0.3 s reactions, occasional blunders) | 16 s | 48 s | 120 s | 54, 0.8 super (14,151) |
| Good bot (0.2 s reactions, rare blunders) | 42 s | 102 s | 208 s | 103, 1.6 super (30,620) |
| Expert bot (0.1 s reactions, sees 2,200 units ahead, never blunders) | 156 s | 270 s | 488 s | 253, 3.3 super (77,311) |

The bots that lose mostly hit rocks and icebergs, or go over the Edge in a blunder; the expert is lost to rocks, gates and the Colossus. Since gaps stopped hugging the Edge, the Edge's share of the average bot's losses fell from about half to about a quarter, and the warm‑up roughly halved the losses in the first ten seconds.

The bots perceive every hazard in view perfectly and evaluate their manoeuvres precisely, but they react late (0.1–0.4 s), re‑plan only a few times a second and, below expert, make deliberate mistakes. The specification's targets for people are beginner 30–60 s, average 1–2 min, expert 3–5 min. The current tuning aims for:

- the first 30 seconds being calm and forgiving;
- a clear step up after the first minute;
- skill (reading the rows ahead and precise steering) dominating survival time, rather than luck.

**Before launch, tune with real playtesting.** Every parameter above is a single value in `config.ts`. Changing any of them changes outcomes, so bump `GAME_VERSION`: ranked attempts record the version they were played with, and the server replays them with the matching rules.
