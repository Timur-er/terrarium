# Terrarium — client

The UI of the simulation game from `terrarium-architecture.md`. Setting: a colony under a dome on an alien planet
(mechanics, agronomists, patrol officers, a chaplain, a reactor, the Orbit Bar, credits and rations). While there is no server, a
mock engine runs inside the client: the same data model (character, mood, needs, memory, relationships, rumors, goals),
decisions by weighted sampling rather than argmax. When the world server arrives, `src/sim/` is replaced
by snapshot + deltas over WebSocket; the panels and the scene stay.

## Running

```bash
npm install
npm run dev
```

Open http://localhost:5173. Build: `npm run build`.

## Style

The UI is "cassette futurism": amber phosphor on black, scanlines, Rubik Mono One for
headings and IBM Plex Mono for everything else. The player watches the colony from a tracking station; colonists
in the panel are labeled "subject NN". Color and font tokens are in `src/styles/global.css`.

## What's there

- **Scene** (`src/scene/`) — three.js, low-poly, isometric orthographic camera, a colony under a geodesic
  dome. A 52×34 map, a square with a fountain, a canal with a bridge, depot, bar, workshop, chapel, school,
  reactor, 14 modules with solar panels and colored family stripes. Perspective camera, sun with shadows, GTAO, reflections and puddles on the paths, colored light from the neon,
  haze and dust in the air, tilt-shift and color grading with grain. The dome dissolves as you zoom in.
  Day and night cycle, lit windows and streetlights, bloom, fire. All textures are procedural (`src/scene/textures.ts`):
  a ground atlas (slabs, riveted metal, markings, grates, garden beds, water), module walls with panels,
  vents, dirt and markings, roofs; normal maps are computed from height maps. Seeded clutter:
  pipes with valves, air conditioners, antennas, tanks and exhaust hoods on roofs, crates and barrels by the entrances, cables
  between modules, holographic signs, benches, a kiosk and planters on the square, three drones over the streets.
  The ground is dark regolith with gravel and glowing moss, grass is thousands of swaying stalks (vertex shader),
  garden beds in raised troughs with rows of plants and grow lamps, a canal with live water and a glowing edge.
  Three kinds of vegetation: alien flora (stalks, blades, glowing fruit), engineered trees with grow
  lamps, hydroponic towers by the beds. Everything sways in the wind.
  Modules are capsules: a rounded body, a barrel roof with ribs, portholes and round windows with
  an interior behind the glass, an airlock vestibule, a seeded extension (annex, terrace with an awning and laundry, greenhouse, second
  deck), planters, a doormat, a family plate, rusty patches on old modules.
  Industrial buildings each with their own silhouette: a reactor tower with ribs, rings and a core, the bar with a dome,
  a terrace, string lights and neon, a depot hangar with a ramp, a crane and containers, the canteen with a chimney and steam,
  the workshop with a sawtooth roof, a garage and welding, the chapel with a stained-glass tower and a portal, the school with a glass
  facade and a playground, the security post with a watchtower, a floodlight and a barrier.
  Colonists are jointed figures (torso, head, arms, legs) with a walk cycle, breathing at rest and poses by
  activity: talking, working and building, eating, arguing and fighting, praying, playing, stealing, resting on a bench. Wheel to zoom, drag to pan, right button or Shift to rotate,
  click a resident to select.
- **Chronicle** — an event feed with filters (fights, kindness, rumors, heart, player). The event's weight
  sets the size of the entry. With a resident selected, only events involving them are shown.
- **Colonist card** — thoughts in words (numbers are not shown), character, mood, relationships,
  goals, memory (what they saw and what they were told), diary (written at midnight).
- **Event deck** — 11 cards: fire, gold, stranger, rumor, hydroponics failure, festival, infection,
  gathering, storm, harvest, message from Earth. Cards with a target ask you to pick a resident on the map.
- **Whisper** — put a goal into a resident's head. Whether they take it or brush it off depends on character.
- **Relations graph** — d3-force: liking, enmity, family, debts.
- **Live map** — tiles are stored in 8×8 chunks; on change the ground and trees are rebuilt.
  Buildings are added on the fly: `findPlot` finds a free plot by a road, `placeBuilding` places the house
  and lays a path.
- **Construction** — an action with a site and progress. A module is built after a wedding (if the newlyweds have nowhere to live),
  a newcomer builds their own once settled, a burned one is rebuilt. Neighbors, friends and the carpenter come to
  help, and this is remembered. The whisper "build my own module" starts construction manually.

Hotkeys: Space to pause, 1–4 for speed, Esc to deselect.

## System One brain

Character decisions go through the `Brain.decide(state, questions)` interface (`src/sim/brain.ts`); the question format
is the TypeSafe API's: `choice` / `score` / `noul`, answers with probabilities and confidence. The state is assembled
in words in `src/sim/state.ts` (character, needs, mood, time and open places, who is nearby, relationships,
memory, beliefs, goals). The engine builds the action menu with preconditions; questions are two-stage: strategy
(eat / work / be with people / own business / rest), then specifics within the group, plus internal
questions "how desperate are you", "is this an important moment", "do you fear the consequences". The answer is sampled with temperature.

Backends: `HeuristicBrain` (engine weights, the mock's behavior), `RandomBrain` (dice, debugging), `RemoteBrain`
(POST `{state, questions}` to the service, expects `{answers}`; the model's probabilities are blended with the engine prior).
The switch is in the top bar; the "brain" tab in the colonist card shows the state text and the last
decision with probabilities. The decision log accumulates in `world.decisions` (a dataset for distillation).

## Structure

```
src/sim/       engine: map, resident generation, world tick, interactions, cards, whisper; brain.ts and state.ts are the brain
src/scene/     three.js renderer and React wrapper
src/ui/        panels: TopBar, Chronicle, CharacterPanel, EventDeck, WhisperDialog, RelationsGraph
src/store.ts   zustand store and game loop (tick = 1 game minute)
```
