# Terrarium — a living colony on System One models

Architecture document. Draft, 2026-09-25.

---

## 1. What we are building

A browser simulation game: a small colony of 30–60 inhabitants who live on their own. Each has a personality, needs, memory and relationships. They work, steal, gossip, quarrel, make up, take revenge, help each other — and are changed by what happens to them.

The player does not control the characters. They watch, throw in events, whisper goals to a single ward and run experiments. The appeal is in stories that grow on their own and cannot be predicted.

The key idea: the characters **do not talk in text**. They act. Their decisions are made by a fast decision model (System One — Jev or an equivalent), and the rare "reflections" by an ordinary LLM (System Two). This makes the world cheap, fast and alive at the same time.

### How this differs from what exists

- **Sims / RimWorld / Dwarf Fortress** — scripted behavior; after 10 hours the seams show.
- **AI Town and LLM agents** — characters chat, it is expensive and slow, and within an hour everything collapses into small talk about the weather.
- **Us** — characters understand context at LLM level but act instead of talking; a decision costs milliseconds and fractions of a cent, so the world can be large and continuous.

---

## 2. Principles of humanity

People are unpredictable not because they are random, but because they carry a lot of hidden state that changes, and they act from probabilities. Hence:

1. **Sampling, not argmax.** The model outputs a distribution, the engine rolls the dice. A hot-tempered character hits 70% of the time and holds back 30%.
2. **Hidden state.** Mood, accumulated resentment, fear, secret goals. The player sees only behavior.
3. **Memory is imperfect.** It forgets, distorts, and remembers the emotion more than the fact. A rumor passed through three people is a different rumor.
4. **Information is local.** Everyone knows only what they saw or were told. Conflicts grow from differing views.
5. **Feedback.** Decisions change personality, personality changes decisions.

None of these principles requires a "smart" brain. They require properly structured state. The brain only reads it.

---

## 3. Overall architecture

```
┌──────────────────────── Client (browser) ────────────────────────┐
│  Scene (PixiJS) │  Panels (React) │  Chronicle │  Events/whisper │
└──────────────────────────────▲───────────────────────────────────┘
                    WebSocket  │  snapshot + deltas
┌──────────────────────────────┴───────────────────────────────────┐
│                      World server (Python)                       │
│                                                                  │
│  World loop → Perception → Triggers → Decision queue → Executor  │
│      │            │                        │              │      │
│  Needs/Time    Memory       ┌──────────────▼──────┐  Effects/Log │
│  Pathfinding   Rumors       │  Brain (System One) │              │
│  Economy       Relations    │ abstraction, see §7 │              │
│                             └─────────────────────┘              │
│                                                                  │
│  Reflection worker (System Two, LLM) ◄── log, memory             │
│  Chronicle worker (LLM)                                          │
└──────────────────────────────────────────────────────────────────┘
              Postgres (world, characters, log)   Redis (queues, pub/sub)
```

The server is one asynchronous process per world. LLM workers are separate processes, never in the hot path.

---

## 4. Data model

### Character

```
identity    id, name, age, role, module, family
traits      6 axes, float -1..1: trust, generosity, temper,
            honesty, sociability, courage. Drift slowly.
mood        4 axes, float -1..1: joy, anger, fear, shame.
            Change fast, decay toward the baseline within hours.
needs       hunger, sleep, credits, safety, company, recognition — 0..1
resources   credits, food, tools, parts
goals       [{text, priority, deadline, source: self | LLM | player}]
relations   {char_id: {trust, affection, fear, debt, last_contact}}
memory      see below
beliefs     [{claim, confidence}]  — "Ivan is a thief", 0.7
plan        current action + path
```

The numbers are never shown to the player. They see behavior and "thoughts" — short phrases generated from the numbers through a deterministic dictionary with thresholds.

### Memory — three layers

| layer | what | size | how it gets there |
|---|---|---|---|
| episodic | events involving them or in their presence | last 30 | automatically from perception |
| long-term | important events, kept forever | 10–15 | emotional weight above a threshold |
| semantic | beliefs and relationships | — | the result of experience, updated by the brain and by reflection |

Each event: `{what, who, where, when, weight, source: saw | was told}`.

Distortion in retelling: details are lost, the weight grows, the source becomes "heard". With a probability that depends on the teller's honesty and the number of retellings, details change — up to and including who is to blame.

### World

```
map       tiles, passability, buildings with a type and an owner
places    points of interest with a schedule (depot 8–18, Orbit Bar 17–02)
time      game minutes, sol, season
economy   prices, quartermasters' stock, debts
events    active ones (fire, celebration, drought) with duration and effects
log       append-only journal of every action and every brain decision
```

---

## 5. World loop

Tick = 1 game minute ≈ 0.5 s of real time.

1. **Time and needs.** Hunger up, fatigue up, mood decays, events apply their effects.
2. **Movement.** Whoever has a plan takes a step along the path (A* on the grid).
3. **Perception.** Whatever falls within the field of view goes into episodic memory.
4. **Triggers.** Who needs a decision (see §6).
5. **Decision queue.** Batch → brain. Does not block the loop: the character is "thinking it over" for 1–2 ticks.
6. **Execution.** Answer → action → effects → memory of participants and witnesses → log.
7. **Delta to the client.**

### Triggers

A decision is needed when:

- a need crossed a threshold (hunger > 0.6, credits < 0.1);
- the character reached the goal of the plan;
- a character with unfinished business is nearby (debt, conflict, affection);
- an action with weight above the threshold happened within range;
- they received a rumor;
- mood crossed a threshold (anger > 0.7 — looking for someone to take it out on);
- the player whispered a goal;
- 30 game minutes without a decision.

Expected load: 3–8 decisions per character per game hour → 50 characters ≈ 200–400 calls/hour, 4–8 questions in each.

---

## 6. The System One brain: how questions are asked

### State

Assembled automatically, but only from what the character **could know and could be thinking about right now**. Numbers are turned into words.

```
You are Pyotr, 41, mechanic. By nature: hot-tempered, honest, proud, withdrawn.
Right now: very hungry, a little tired, no credits. Mood: angry, slightly ashamed.
Time: evening, the depot is closing, the Orbit Bar is open.
Nearby: Ivan's module (door open, Ivan is not there). A patrol officer in the plaza.
Relations: Ivan — owes you, you don't trust him. Maria — resentment after a quarrel.
           Semyon — a friend, you trust him.
You remember: yesterday you asked Maria for a loan, she refused in front of people (it stung).
         Ivan hasn't repaid his debt for the third sol. You saw Maria talking to the patrol officer.
You believe: Ivan is dishonest (certain). The patrol officer takes bribes (heard).
Goals: get the debt back from Ivan. Eat.
```

### Questions — two stages

**Stage 1, strategy** (Choice):
`get it dishonestly / ask / earn / sell something / endure`

**Stage 2, specifics** (Choice, depends on the strategy):
`whom to ask: Semyon / Maria / patrol officer`

**In parallel — internal state** (Score / Noul):
`how desperate are you 0–3`, `do you consider taking from Ivan theft`, `are you afraid of the consequences`, `is this an important moment in your life?`

Score/Noul answers do not choose the action — they update mood and beliefs. This is an inner monologue without text.

### Action library

~40 actions with preconditions. The engine assembles the menu for each decision from the context — so different characters in the same situation get different menus.

| action | precondition |
|---|---|
| take without asking | target nearby, owner absent or not looking |
| ask | target nearby, not an enemy |
| accuse publicly | ≥ 2 witnesses |
| spread a rumor | has a rumor, the listener does not know it |
| threaten | courage > target's fear |
| report to the patrol officer | patrol officer nearby, holds a belief about someone's guilt |
| help | someone nearby is in trouble |
| stay silent / walk away | always |
| … | … |

Each action has effects: resources, both sides' relations, mood, witnesses' memory. The table is static and grows without touching the brain.

**The menu must include bad, shameful and passive options.** Without them the world is sterile. Starving to death is not a choice but the consequence of a chain of "endure" out of pride.

### Choosing from the answer

Sampling with temperature. The temperature depends on mood: angry and desperate means more random. Under stress people are less predictable.

---

## 7. Where Jev will run — an open question

This is the main unresolved point. The brain has a single interface:

```python
decide(state: str | dict, questions: dict) -> answers
```

The request and response format follows the TypeSafe API (`choice / score / noul`, `probabilities`, `confidence`). Every option below implements it, so the backend is swapped with one line in the config.

### Options

| option | what it is | pros | cons |
|---|---|---|---|
| **TypeSafe API directly** | `api.typesafe.ai/v1/systemone`, `jev-1.13.0` | best zero-shot quality, real calibration, 32k context, up to 255 options | closed, US-based, 100–500 ms, data leaves the machine, limits fluctuate |
| **Through a gateway** | OpenRouter (`typesafe/jev-1.13`), Vercel AI Gateway | same quality, no waiting for a key | the same Jev, plus a middleman |
| **so1 + our own Qwen** | `open-alternative-jev` on top of vLLM with Qwen3-30B-A3B, logits over the options | nothing to download, quality from a large model, free, local | 100–600 ms, calibration is on us, the package is young |
| **Kev** | Qwen3.5 0.8B/4B/9B + LoRA + pointer head, a server with the TypeSafe API | closest to Jev, fine-tunable, drop-in by URL | calibration worse than Jev, weaker knowledge |
| **Laya** | ModernBERT/mmBERT 300–400M, Apache 2.0 | 10–40 ms, CPU-friendly, fine-tunes in hours | zero-shot near random, 512–1024 context, needs our own dataset |
| **random** | a stub | debugging the engine without a brain | — |

### Selection criteria

- **Behavior quality** — does it understand "my neighbor cheated me yesterday" → does not go to help. Checked on 20 fixed scenarios.
- **Latency** — the tick is 0.5 s, a decision may take 1–2 ticks. Anything under 1 s is acceptable.
- **Cost** — at 300 calls/hour × 2k tokens: Jev ≈ $0.03/hour per world. Locally — electricity.
- **Where the data lives** — not critical for the game; for multiplayer with real users it is a question.
- **Where we host** — a local machine with a GPU, a virtual server without a GPU (then API only), or a server with a GPU.

### Preliminary plan

1. Develop with `random` and `so1 + Qwen` — free, available right away.
2. In parallel, get a TypeSafe key, run the same 20 scenarios on Jev, compare.
3. Decide based on the result. A hybrid is possible: develop locally, run production on Jev, or the other way around.
4. The log of all decisions accumulates from day one — it is the dataset for distilling into Kev/Laya if we ever need our own fast brain.

### What needs to be found out

- [ ] Does so1 work with our vLLM and Qwen3-30B-A3B, and what is the real latency.
- [ ] The TypeSafe key — how long is the wait, what limits do they give.
- [ ] Russian vs English in the state — which one the brain decides better on. Possibly the state is in English internally, with the interface in any language.
- [ ] Where production will be: a GPU server or API-only.

---

## 8. Rumors and information

- An event with weight > threshold → a "story" `{gist, participants, witnesses}`.
- On "talk" — a Noul "should I tell": a gossip will, a withdrawn character won't.
- On retelling — distortion (§4).
- The listener — a Noul "do I believe it", taking trust in the teller into account. If believed → beliefs and relations update.

From this come reputations, unjust accusations, factions. The player can start a rumor themselves.

---

## 9. Personality drift

Once per sol — statistics: how many times they were cheated, helped, cheated someone themselves, were rejected. Traits shift by a small amount toward the experience. A mood that stayed in "anger" for a week pulls temper up.

After a week of play the character is different, and you can see why.

---

## 9a. Life cycle: marriages, children, death, newcomers

This is not a version-two feature but the answer to "the world burns out". The world burns out not from deaths but from a fixed cast: relationships have settled, conflicts have been played out. An inflow of new people brings novelty and long-range stories: "the grandson of the mechanic who was accused of theft became a patrol officer".

Almost all of it is built from mechanisms that already exist.

### Courtship and marriage

- The "affection" axis already exists in relations. Trigger: someone they feel strong affection for is nearby.
- Menu: strike up a conversation, a gift, invite to the Orbit Bar, do nothing, be jealous of a third party.
- A Noul "propose marriage" appears once affection and trust have been above the threshold for N sols. A refusal is a high-weight event that goes into long-term memory.
- Marriage is an event: a shared module, shared resources, a "family" axis in relations, a celebration, witnesses.
- Family changes decisions through the state: "your children are hungry" → "take without asking" is more likely than for someone single.
- Rivalry, jealousy, a marriage of convenience over debts — all grow out of the existing axes.

### Birth

- Once per game month a married couple gets a Noul "do you want a child now", with the state: credits, food, safety, mood, how many children already.
- Both "yes" above the threshold → pregnancy with some probability → birth N sols later. A high-weight event, a celebration.
- A child is a new agent. Traits = the parents' average + noise + a small random shift. Not a copy, but a family resemblance.

### Stages

| stage | age | brain | menu |
|---|---|---|---|
| infant | 0–3 | none | — (a need for the parents: "the baby is crying, need to be home") |
| child | 3–12 | simplified, few triggers | play, follow, watch, tell the parents, take, get into a fight |
| teenager | 12–16 | almost adult | + apprenticeship, crushes, first "adult" actions |
| adult | 16+ | full | everything |
| elderly | 55+ | full | + illnesses, less work, more influence through advice |

A child's memory is fully functional from day one. What they saw in the family goes into long-term memory; personality drift uses the same mechanism (§9).

### Who they become

Nobody decides. Role and goals are the result of three things:

1. **Heredity** — traits from the parents.
2. **What they saw** — memory and drift. Someone who was cheated grows up distrustful.
3. **Where they spent their time** — apprenticeship. A teenager chooses (Choice) whom to go to: the family trade, a family friend with a workshop, someone they have a crush on. Sols in the workshop → the mechanic role. A son with low trust in his father will go to someone else — or join the patrol.

On coming of age — a single LLM reflection call with the full biography: "who do you want to be, what matters to you". It writes long-term goals. The only moment where thinking "decides a fate", and it draws on everything lived through. This is where "I want to leave", "I want revenge", "I want to become administrator so nobody dares treat our family like that again" come from.

### School

Not a system but a **place** with a schedule, like the depot and the Orbit Bar. Children aged 6–12 go there during the day; an adult with the "teacher" role is there. The point is that it is the only place where children from different families cross paths: a childhood friend, a school bully, a first crush.

No nursery is needed — infants make no decisions.

**We do not do:** grades, skills, leveling, "education level". That turns people into RPG stats. School influences only through relationships and memory.

### Aging and death

- Age ticks. Past a threshold the probability of illness grows. Death is an event of maximum weight for family and friends.
- Inheritance: resources and the module pass on. Inheritance disputes are ready-made drama.

### Newcomers

The cheapest inflow of novelty: every few sols, an outsider with an LLM-generated biography. Nobody knows them, trust is low, there are no grudges. The player can bring one in themselves.

### Population regulator

Soft and invisible: population below the minimum → higher probability of births and newcomers; above the maximum → newcomers less often, illnesses more often. Keeps the colony at 30–60 forever.

### Load and time

- Children call the brain less often and with short menus. Plan for 50 adults + 30 children.
- The speed of time sets the rhythm: with "one sol = one real day" there is a wedding every couple of weeks and a child takes a year to grow up. Accelerated, generations pass in a week and the interest shifts to family history. Speed is a world setting; test which one is sticky.

---

## 10. System Two: the LLM worker

A separate process, a queue in Redis, never in the hot path. Any model — Claude, GPT, a local Qwen. Budget: 60–100 calls per sol per world.

### Reflection — once per sol per character

Input: personality, memory, the sol's log, goals. Output — strictly structured:

```json
{
  "diary": "2–3 sentences in the first person",
  "goal_updates": [{"add": "leave the colony", "priority": 0.8}, {"drop": "..."}],
  "relation_updates": [{"who": "maria", "trust": -0.2, "why": "..."}],
  "trait_nudges": [{"trait": "pride", "delta": -0.05}],
  "belief_updates": [{"claim": "...", "confidence": 0.6}]
}
```

The diary is for the player. Everything else is written into the state and changes what System One decides from tomorrow. This is where goals that were never in the menu appear.

### Turning points

On every decision System One answers the Noul "is this an important moment in your life?". If > 0.85, the decision goes to the LLM with full context. The LLM may pick an action outside the usual menu (within the library) and add a goal.

### Chronicle — once per sol per world

From the log, a narrative with 3–5 storylines. A format made for sharing.

### Answering the player — on request

"Why did you do that?" — the LLM speaks as the character, based on their memory and recent decisions.

### World generation — at startup

50 biographies with families, old grudges, secrets, debts. A single call.

### Rule

The LLM **never** makes routine decisions. Otherwise one character becomes the "protagonist" with richer behavior, and the world tilts.

---

## 11. The player

| action | how it works |
|---|---|
| **Observation** | click → "thoughts" (the state in words), diary, relationship graph; an event feed with filters |
| **Events** | a deck of ~15 cards: fire, gold, outsider, rumor, drought, celebration, epidemic, new patrol officer, tax. Effects in the world + memory of those who found out |
| **Whisper** | pick a ward, add a goal. Lands in `goals` with the source "player". The character may lower its priority if it goes against their nature (Noul "are you willing") |
| **Experiment** | a fork of the world — a copy of the state, different events, comparison after N sols |
| **Chronicle** | a sol's screen with a permanent URL |

All of this is REST/WS commands that change the state. No AI on the player's side.

In the first version the player **does not write free text to the characters** — only picks goals and events. Otherwise it all turns into a chat.

---

## 12. Multiplayer

The server is authoritative; clients are spectators and command senders. One architecture, three modes:

- **Shared aquarium** — one world, N spectators, events by vote or for currency.
- **Wards** — each player guides one inhabitant, a shared goal ("become administrator"), influence only through whispers. Everyone gets in each other's way through the one world.
- **Predictions** — before a major event, bets on "who wins / who betrays". Currency for accuracy. A reason to come back.

Redis pub/sub, rooms per world, deltas instead of snapshots, a snapshot on connect. The cost of a world does not depend on the number of spectators.

---

## 13. Technology

| layer | choice | why |
|---|---|---|
| world server | Python 3.12, asyncio | all ML clients are in Python; so1, vLLM |
| API / WS | FastAPI + WebSocket | already in use |
| queues | Redis | decisions, LLM tasks, pub/sub |
| database | PostgreSQL | world snapshots, characters, log |
| System One brain | a `Brain` abstraction with backends: TypeSafe / so1+vLLM / Kev / Laya / random | see §7 |
| System Two LLM | a `Reflector` abstraction: Claude API / OpenAI / local Qwen via vLLM | not in the hot path, anything works |
| pathfinding | A* on a grid, our own implementation | simple map |
| client — scene | PixiJS | 2D, top-down view, sprites, interpolation |
| client — panels | React + Vite | already in use |
| relationship graph | d3-force | |
| deployment | Docker Compose: world, llm-worker, redis, postgres, web | locally or on a VPS |

The view is flat, top-down. Not 3D: the whole colony is readable at once, emoji states, development speed. Isometric is a possible upgrade without rewriting the logic.

---

## 14. How to test for "humanity"

- **Consistency** — the same character in the same situation gives similar distributions; different personalities give different ones. Run on fixed scenarios.
- **Diversity** — the entropy of actions across the colony does not fall over time. A metric on the log.
- **External validity** — compare reactions to standard dilemmas (repay a debt, inform, the dictator game) with social psychology data. Not for accuracy, but against the "everyone is a saint" / "everyone is a thief" skews.
- **Test on people** — show 10 chronicles, ask "is that how it would have gone?". Fewer than half saying yes means the problem is in the state or the menu, not the model.

---

## 15. Build order

1. **Engine without a brain.** Map, needs, movement, actions, memory, rumors, log. Brain = random. Shows whether the world lives mechanically.
2. **System One brain** via so1 / Jev. The first "wow" or the first disappointment — it shows whether the state is rich enough. This is also where backends are compared on the 20 scenarios.
3. **Client** with observation and events.
4. **Reflection and chronicle.**
5. **Whisper and fork of the world.**
6. **Multiplayer.**

Steps 1–2 are the prototype that decides whether there is a game here. The criterion: after 15 minutes of watching, you want to throw in one more event and see what happens.

---

## 16. Open questions

- Where System One runs — see §7.
- The language of the state — Russian or English internally.
- Colony size for the prototype — 20 or 50.
- Whether the player will ever need free text to the characters.
- Economy: how detailed — credits and food, or full-blown trade.
- Speed of time: one real day = one sol, accelerated, or slowing down when nobody is watching (see §9a).
- The life cycle (§9a) — in the prototype, or after the basic world works.
