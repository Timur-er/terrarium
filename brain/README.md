# Террариум — сервис мозга System One

Отдельный Python-сервис, который принимает состояние персонажа словами и вопросы, а отдаёт распределения.
Клиент (`client/src/sim/brain.ts`, `RemoteBrain`) шлёт сюда `POST /decide` и смешивает ответ с приором движка.

## Протокол

```
POST /decide
{ "state": "Ты — Пётр, 41, механик...", "questions": [
    { "id": "strategy", "type": "choice", "text": "Что ты сейчас сделаешь?", "options": ["поесть", "работать"] },
    { "id": "desperate", "type": "score", "text": "Насколько ты отчаялся?", "range": [0, 3] },
    { "id": "important", "type": "noul", "text": "Это важный момент в твоей жизни?" } ] }

→ { "answers": [
    { "id": "strategy", "probabilities": [0.7, 0.3], "confidence": 0.8 },
    { "id": "desperate", "score": 1, "confidence": 0.6 },
    { "id": "important", "value": 0.2, "confidence": 0.6 } ], "backend": "claude:claude-opus-5" }
```

`GET /health` — бэкенд, число решений, латентность. `GET /log?n=20` — последние запросы и ответы.

## Запуск

```bash
python3 -m venv brain/.venv && brain/.venv/bin/pip install -r brain/requirements.txt

BRAIN_BACKEND=random brain/.venv/bin/uvicorn brain.server:app --port 8765
BRAIN_BACKEND=claude BRAIN_MODEL=claude-opus-5 brain/.venv/bin/uvicorn brain.server:app --port 8765
BRAIN_BACKEND=local LLM_BASE_URL=http://localhost:8000/v1 LLM_MODEL=Qwen/Qwen3-30B-A3B brain/.venv/bin/uvicorn brain.server:app --port 8765
```

Запускать из корня репозитория (`brain` — пакет). В клиенте переключить мозг в верхней панели на «сервис»;
адрес по умолчанию `http://localhost:8765/decide`, другой можно положить в `localStorage.brainUrl`.

## Бэкенды

| бэкенд | что это | когда |
|---|---|---|
| `random` | кости | отладка движка без мозга |
| `claude` | Claude через официальный SDK, `claude-opus-5` по умолчанию, effort `low`, системный промпт кэшируется | лучшее качество из коробки; ключ из `ANTHROPIC_API_KEY` или профиля `ant auth login` |
| `local` | любая модель за OpenAI-совместимым `/chat/completions` (vLLM, Ollama, so1) | локально и бесплатно, качество зависит от модели |

Ответ модели парсится терпимо: JSON внутри текста или в блоке кода, пропущенные вопросы и кривые
распределения заменяются равномерными. На отказ или лимит сервис отвечает равномерно, а не падает.

## Сценарии

`brain/scenarios.py` — двадцать фиксированных ситуаций из плана (§14): голод с деньгами и без, честный
и нечестный, патрульный рядом, ночь, рабочий день, одиночество, должник рядом, голодный друг, враг рядом
у вспыльчивого и у робкого, слух от недоверяемого и от друга, шёпот «отомстить» без повода и с поводом,
пожар у соседа для смелого и для труса, стройка друга, отказ при всех. У каждой мягкие ожидания:
«вероятность выше порога» или «вариант А вероятнее варианта Б», а не единственно правильный ответ.

```bash
brain/.venv/bin/python -m brain.eval --backend random
brain/.venv/bin/python -m brain.eval --backend claude --backend random --verbose
brain/.venv/bin/python -m brain.eval --url http://localhost:8765/decide --json out.json
```

Печатает таблицу по сценариям, долю пройденных проверок и латентность. Кости дают около 30–50%,
это нижняя планка; осмысленный мозг должен уходить за 80%.

## Jev (TypeSafe)

`BRAIN_BACKEND=jev`, ключ `TYPESAFE_API_KEY` (из `.env` в корне проекта или окружения), модель `JEV_MODEL`
(по умолчанию `jev-latest`). Вопросы протокола отображаются в примитивы TypeSafe один к одному:
choice → choice с `criteria` {o0: вариант, …}, score → score с уровнями из диапазона, noul → noul.
Ответы: вероятности по вариантам в порядке протокола, `confidence` от модели (для noul считается из
удалённости от 0.5). На 429/529 повтор с задержкой. `GET /health` показывает токены, `GET /log` — журнал.
