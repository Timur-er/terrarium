# Terrarium — System One brain service

A separate Python service that takes a character's state in words plus questions, and returns distributions.
The client (`client/src/sim/brain.ts`, `RemoteBrain`) sends `POST /decide` here and blends the answer with the engine prior.

## Protocol

```
POST /decide
{ "state": "You are Peter, 41, a mechanic...", "questions": [
    { "id": "strategy", "type": "choice", "text": "What will you do now?", "options": ["eat", "work"] },
    { "id": "desperate", "type": "score", "text": "How desperate are you?", "range": [0, 3] },
    { "id": "important", "type": "noul", "text": "Is this an important moment in your life?" } ] }

→ { "answers": [
    { "id": "strategy", "probabilities": [0.7, 0.3], "confidence": 0.8 },
    { "id": "desperate", "score": 1, "confidence": 0.6 },
    { "id": "important", "value": 0.2, "confidence": 0.6 } ], "backend": "claude:claude-opus-5" }
```

`GET /health` — backend, number of decisions, latency. `GET /log?n=20` — the latest requests and answers.

## Running

```bash
python3 -m venv brain/.venv && brain/.venv/bin/pip install -r brain/requirements.txt

BRAIN_BACKEND=random brain/.venv/bin/uvicorn brain.server:app --port 8765
BRAIN_BACKEND=claude BRAIN_MODEL=claude-opus-5 brain/.venv/bin/uvicorn brain.server:app --port 8765
BRAIN_BACKEND=local LLM_BASE_URL=http://localhost:8000/v1 LLM_MODEL=Qwen/Qwen3-30B-A3B brain/.venv/bin/uvicorn brain.server:app --port 8765
```

Run from the repository root (`brain` is a package). In the client, switch the brain in the top bar to "service";
the default address is `http://localhost:8765/decide`, another one can be put into `localStorage.brainUrl`.

## Backends

| backend | what it is | when |
|---|---|---|
| `random` | dice | debugging the engine without a brain |
| `claude` | Claude through the official SDK, `claude-opus-5` by default, effort `low`, the system prompt is cached | best quality out of the box; the key comes from `ANTHROPIC_API_KEY` or the `ant auth login` profile |
| `local` | any model behind an OpenAI-compatible `/chat/completions` (vLLM, Ollama, so1) | local and free, quality depends on the model |

The model's answer is parsed leniently: JSON inside text or in a code block; skipped questions and malformed
distributions are replaced with uniform ones. On a refusal or a rate limit the service answers uniformly rather than failing.

## Scenarios

`brain/scenarios.py` — twenty fixed situations from the plan (§14): hunger with and without money, honest
and dishonest, a patrol officer nearby, night, a working day, loneliness, a debtor nearby, a hungry friend, an enemy nearby
for a hot-tempered and for a timid character, a rumor from someone untrusted and from a friend, the whisper "take revenge" with and without a reason,
a fire at a neighbor's for a brave and for a cowardly character, a friend's construction, a refusal in front of everyone. Each has soft expectations:
"probability above a threshold" or "option A more likely than option B", not a single correct answer.

```bash
brain/.venv/bin/python -m brain.eval --backend random
brain/.venv/bin/python -m brain.eval --backend claude --backend random --verbose
brain/.venv/bin/python -m brain.eval --url http://localhost:8765/decide --json out.json
```

Prints a table by scenario, the share of checks passed and latency. Dice give about 30–50%,
that is the floor; a meaningful brain should go past 80%.

## Jev (TypeSafe)

`BRAIN_BACKEND=jev`, the `TYPESAFE_API_KEY` key (from `.env` in the project root or the environment), the `JEV_MODEL` model
(`jev-latest` by default). Protocol questions map to TypeSafe primitives one to one:
choice → choice with `criteria` {o0: option, …}, score → score with levels from the range, noul → noul.
Answers: probabilities per option in protocol order, `confidence` from the model (for noul computed from
the distance from 0.5). On 429/529, retry with a delay. `GET /health` shows tokens, `GET /log` the log.
