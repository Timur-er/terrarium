# Terrarium

A region of several domes on an alien planet: in each one, forty-odd colonists with character, memory,
relationships and rumors live on their own, suppliers and settlers travel between domes, and the player watches,
throws in events and whispers goals. Architecture and intent are in `terrarium-architecture.md`.

## Language

Everything is in English: game text, UI, model state, System Two prompts, scenarios, reports, colonist and dome
names, and these READMEs. Jev is trained mainly on English and answers more precisely in it.

## Parts

| folder | what | how to run |
|---|---|---|
| `client/` | UI (Vite + React + three.js) with the world engine built in | `cd client && npm install && npm run dev` → http://localhost:5173 |
| `server/` | region server on Node: the same engine, WebSocket, persistence, System Two | `cd server && npm install && cd .. && npx --prefix server tsx server/index.ts` → ws://localhost:8787 |
| `brain/` | System One brain service in Python: dice, Claude, local model; 20 scenarios | `python3 -m venv brain/.venv && brain/.venv/bin/pip install -r brain/requirements.txt && BRAIN_BACKEND=random brain/.venv/bin/uvicorn brain.server:app --port 8765` |

The client works on its own: the world runs in the tab. The "world: local" button in the top bar connects
it to the server; the world then lives on the server and the tab becomes a viewer and a remote. The "brain"
button switches who makes decisions: the engine heuristic, dice or the brain service.

## How it works

```
client (browser)  ──WebSocket: snapshot + deltas──▶  world server (Node, TS engine)
      │                                                    │            │
      │ commands: speed, card, whisper,                    │            ▼
      │ observe, ask                                       │     System Two (LLM, not in the hot path):
      │                                                    │     diaries, chronicle of the day, "why?"
      ▼                                                    ▼
   3D scene, panels                     System One brain: decide(state, questions)
                                        ── heuristic | random | remote ──▶ brain/ (Python)
```

- **Engine** (`client/src/sim/`): tick = one game minute, needs, A*, perception, triggers, action menu
  with preconditions, sampling, three-layer memory, rumors with distortion, character drift, construction, weddings.
- **System One**: the state is assembled in words (`state.ts`), questions are two-stage plus internal ones
  (`brain.ts`), answers come back as distributions. The protocol is shared by the client and the service.
- **System Two** (`server/reflect.ts`): once per game day per character, a diary and edits to goals, relationships,
  traits, beliefs; once per day per world, a chronicle from the log; on request, an answer in the character's voice. Needs
  `ANTHROPIC_API_KEY` in the server environment, otherwise this part is off and diaries stay templated.

## Running with Jev (System One by TypeSafe)

The System One brain in the game is built for Jev: the character's state in words plus typed questions
`choice` / `score` / `noul`, an answer with probabilities and confidence. The `jev` backend in `brain/backends.py` sends this to
`POST https://api.typesafe.ai/v1/systemone` almost without translation: options become the choice `criteria`, the score
range turns into levels, internal questions go as `noul`.

**1. Key.** Copy `.env.example` to `.env` in the project root and fill in `TYPESAFE_API_KEY=…` (the key from
console.typesafe.ai/keys). Both the brain service and the run script read this file; it is not committed to git.

**2. Brain service** (once: `python3 -m venv brain/.venv && brain/.venv/bin/pip install -r brain/requirements.txt`):

```bash
BRAIN_BACKEND=jev brain/.venv/bin/uvicorn brain.server:app --port 8765
```

`GET http://localhost:8765/health` shows the backend, the number of decisions, latency and tokens spent;
`GET /log?limit=50` shows the latest calls: state, questions and Jev's answers.

**3. Scenario check** (20 situations with expected behavior, no game needed):

```bash
brain/.venv/bin/python -m brain.eval --backend jev --verbose
```

**4. Run the world for a few sols** with a report (in a second terminal; the brain service must be running):

```bash
npx --prefix server tsx server/run.ts --sols 3 --domes 1 --brain remote --out report/jev
```

One sol is roughly 800 decisions, that is 800 calls to Jev; at 100–500 ms per answer a sol takes
2–7 minutes, three sols fit in a quarter of an hour and cost cents. In the report folder: `report.md` (summary, chronicle,
loud events, sample decisions with distributions), `log.txt`, `decisions.jsonl` (every decision with its state),
`brain-calls.json` (call log with Jev's probabilities and confidence), `diaries.md`, `stats.json`.
If `.env` also has `ANTHROPIC_API_KEY`, System Two writes real diaries and the chronicle of the day.

For comparison, the same run can be done with the heuristic (`--brain heuristic`) or dice
(`BRAIN_BACKEND=random` on the service): the difference in colony behavior is the material for conclusions.

## Server environment variables

`PORT` (8787), `SPEED` (0/1/3/10/30), `BRAIN` (heuristic | random | remote), `BRAIN_URL`
(http://localhost:8765/decide), `ANTHROPIC_API_KEY`, `SYSTEM_TWO_MODEL` (claude-opus-5).
The world is saved to `server/data/world.json` once a minute and on shutdown.

## Experiment (fork of the world)

The "[ experiment ]" button in the top bar. The world is copied into two branches on the same dice: branch A
lives without intervention, in branch B you throw in a card and/or a whisper. Both branches are run 1, 3 or
7 sols ahead in a fraction of a second; the main world is untouched. The result: branch statistics, the loud events
of each, and a list of colonists whose fates diverged (left, died, started a family, got rich, made enemies,
new goal). Works both locally and through the server (`client/src/sim/experiment.ts`). In the fork the
heuristic brain decides, because the branches are computed synchronously.

## Multiplayer

The server is authoritative; tabs are viewers and remotes. On connecting you get a name (changed in the
"[ players ]" dialog) and the "influence" currency: 20 at the start, plus one for every game hour of presence.

- **Shared aquarium.** Everyone watches the same world. Cards cost influence (3 to 8), a whisper to someone
  else's colonist costs 2. Who threw in what is visible in everyone's toasts.
- **Wards.** The "[ take as ward ]" button in the colonist card. One ward per player; a colonist already
  taken cannot be claimed. A whisper to your ward is free and sticks harder. The leaderboard scores the ward's standing:
  friends, trust, credits, debtors, the administrator role.
- **Prediction markets.** Every morning at 06:00 the server asks the questions of the day: who gets caught stealing
  first, who throws the first punch, how many rumors will spread. Bets are 1 to 5 influence, odds ×2.5–×3, resolved by
  the world log or at 22:00. Accuracy accumulates in the leaderboard.

- **Audience vote.** Three times a day, at 10:00, 14:00 and 18:00, the dome's viewers are offered three
  random cards from the deck (for cards with a target the server picks the colonist itself) and a "nothing" option. The bar with
  the options hangs over the scene for 75 seconds of real time; you can vote once and change your mind. The winning
  card is played for free, the crowd pays for it; those who voted for the winner get one unit of
  influence each. If nobody voted, no event is played. Only players who have introduced themselves vote; each dome
  votes separately. `VOTE_SECONDS` in the server environment changes the duration.

Players and markets are saved to `server/data/players.json`.

## Region of several domes

The world is a region (`client/src/sim/region.ts`): three to five domes on one planet, each a
full world of the same engine with its own map and residents. The number of domes, their names (from a pool of twelve),
coordinates and road network are derived from the seed: domes are scattered over the plain no closer than 88 and no farther than 132 cells
from each other, roads run to the nearest neighbors, do not cross, do not pass through a third dome and always
keep the region connected; travel hours are computed from distance (usually 6–11). People and module IDs
are prefixed with the dome letter, so they are unique across the region.

- **Roads.** Whoever leaves the colony through the airlock ends up on the road and a few hours later enters
  a neighboring dome, where they try to settle. Every two days at 08:00 the supplier takes goods and drives to the neighbors for a day,
  returning with money and other people's rumors: stories about people nobody here knows
  are retold as tales from another dome, with no consequences for reputation.
- **Ghosts.** Someone who leaves keeps a "ghost" in their home dome marked `left`, so rumors, relationships and
  the chronicle can still name them. On return the ghost is replaced by the living person.
- **Camera.** The "[ dome: … ]" button in the top bar opens the region map: domes, roads, who is on the way.
  Clicking a dome moves the camera; the other domes keep living. In 3D the neighboring domes are visible on the
  horizon with a rough silhouette of buildings, and rovers drive along the roads between them.
- **Server.** The whole region lives on the server (`server/data/region.json`; the `DOMES` variable sets the number
  of domes, without it the seed picks it). Each tab watches one dome and receives its snapshot and deltas plus a compact summary
  of the region. System Two reflects only on domes someone is watching. A ward can live in
  any dome; bets are set per dome and shown for the one you are watching.
- **New domes.** When a dome gets crowded and unhappy (44 or more residents, six discontented or homeless),
  someone sociable and brave gathers a party of 4–7 people: the discontented, the homeless, their own family, friends.
  A scout picks a site near the home dome by the same rules as region generation and
  lays a road to it (and a second one to the nearest neighbor, if it fits). A construction site appears on
  the map, the party travels along the road, and when the first settler arrives a new dome rises: depot,
  canteen, workshop, reactor and three modules; the rest has to be built. The founder becomes
  administrator, families move into modules together, and whoever did not get a place saves up for their own. The home dome
  keeps the memory of those who left and an entry in the chronicle. The same can be whispered to any adult:
  "found a new dome". A region holds at most eight domes.
- **Depots and trade.** Every dome has a depot: rations and parts. Every morning at 06:00 agronomists grow
  rations, mechanics and riggers assemble parts, the canteen and systems repair take their share, and prices follow
  the stock (a ration from 1 to 4, parts from 2 to 5). Purchases in the canteen and the bar spend rations; when the depot is empty,
  food cannot be bought, and hunger pushes people to steal. Construction consumes parts; without them it crawls three times slower.
  Every two days the supplier loads the surplus (rations beyond a two-day stock, parts beyond twenty) and
  drives to a neighbor where they are pricier, hands them to the depot, and brings back what is in surplus there; the supplier
  gets a cut of the turnover. The region dialog shows the depots and prices of all domes and a "[ caravan here ]" button:
  a neighbor with a surplus sends a supplier immediately (on the server this costs 3 influence). Rovers do not
  go out at night. A new dome starts with 24 rations and 10 parts, so for the first days it lives on caravans.
- **The fork of the world** copies only the current dome: roads and neighbors take no part in the experiment.

## Graphics: glTF model kit

Buildings, rocks outside the dome, the rover and the airlock are assembled from Kenney Space Kit models (CC0, `client/public/assets/kenney/space/`,
license alongside). The loader and recipes are in `client/src/scene/kit.ts`: for each building type a list of parts
(the main model is fitted into the plot, the rest are placed beside or on top), Kenney materials are recolored
into the colony palette, the `metalRed` stripe gets the building's color and glows at night. While the kit is loading, buildings
are drawn procedurally, as before; `__renderer.useKit = false` and `refreshBuildings()` bring back the old look.
Next steps: characters with rig and animation (Blender or Mixamo), portraits and card illustrations.

**"Mosaic" mode** (the ▦ button in the corner of the scene, remembered in the browser): a trial style after a reference,
where the world is laid out in fine tiles, color is bleached, at the edge of the dome geometry breaks up into square cells, and
pixels drift off into space. Done as a shader insert into the standard materials (`client/src/scene/mosaic.ts`):
a grid in world coordinates by the dominant normal, dissolve by distance from the center, glowing
things (windows, accent stripes, lamps) keep their color. Grass is hidden in this mode.

## What's next

The plan from the document is fully implemented as a prototype, with the region of several domes on top. Open
directions: a live run of the LLM parts with a key and prompt tuning, treaties and feuds between domes.
