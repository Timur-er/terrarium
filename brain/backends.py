"""System One brain backends.

Every backend answers the same protocol the client speaks:
    decide(state: str, questions: list[Question]) -> list[Answer]
Question types: choice (probabilities over options), score (number in range), noul (probability of "yes").
"""

from __future__ import annotations

import json
import os
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from .prompt import SYSTEM_PROMPT, render_questions


@dataclass
class Question:
    id: str
    type: str  # choice | score | noul
    text: str
    options: list[str] | None = None
    range: tuple[float, float] | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Question":
        rng = d.get("range")
        return cls(id=d["id"], type=d["type"], text=d.get("text", ""), options=d.get("options"), range=tuple(rng) if rng else None)


@dataclass
class Answer:
    id: str
    probabilities: list[float] | None = None
    score: float | None = None
    value: float | None = None
    confidence: float = 0.5
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "confidence": self.confidence}
        if self.probabilities is not None:
            d["probabilities"] = self.probabilities
        if self.score is not None:
            d["score"] = self.score
        if self.value is not None:
            d["value"] = self.value
        return d


def _norm(xs: list[float]) -> list[float]:
    xs = [max(0.0, float(x)) for x in xs]
    s = sum(xs)
    if s <= 0:
        return [1.0 / len(xs)] * len(xs) if xs else []
    return [x / s for x in xs]


def uniform_answer(q: Question) -> Answer:
    if q.type == "choice":
        n = len(q.options or [])
        return Answer(id=q.id, probabilities=[1.0 / n] * n if n else [], confidence=0.1)
    if q.type == "score":
        lo, hi = q.range or (0, 3)
        return Answer(id=q.id, score=(lo + hi) / 2, confidence=0.1)
    return Answer(id=q.id, value=0.5, confidence=0.1)


class Backend(Protocol):
    name: str

    def decide(self, state: str, questions: list[Question]) -> list[Answer]: ...


class RandomBackend:
    """Dice. Useful to see what the engine does with no brain at all."""

    name = "random"

    def __init__(self, seed: int | None = None) -> None:
        self.rng = random.Random(seed)

    def decide(self, state: str, questions: list[Question]) -> list[Answer]:
        out = []
        for q in questions:
            if q.type == "choice":
                out.append(Answer(id=q.id, probabilities=_norm([0.2 + self.rng.random() for _ in q.options or []]), confidence=0.2))
            elif q.type == "score":
                lo, hi = q.range or (0, 3)
                out.append(Answer(id=q.id, score=self.rng.randint(int(lo), int(hi)), confidence=0.2))
            else:
                out.append(Answer(id=q.id, value=self.rng.random(), confidence=0.2))
        return out


# ───────────────────────── JSON parsing shared by LLM backends ─────────────────────────

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def parse_answers(text: str, questions: list[Question]) -> list[Answer]:
    """Parse a model reply into answers; anything missing or malformed falls back to uniform."""
    m = _FENCE.search(text)
    if m:
        text = m.group(1)
    start, end = text.find("{"), text.rfind("}")
    data: dict[str, Any] = {}
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            data = {}
    raw = data.get("answers") if isinstance(data, dict) else None
    by_id: dict[str, dict[str, Any]] = {}
    if isinstance(raw, list):
        for a in raw:
            if isinstance(a, dict) and "id" in a:
                by_id[str(a["id"])] = a
    elif isinstance(raw, dict):
        by_id = {str(k): (v if isinstance(v, dict) else {"value": v}) for k, v in raw.items()}
    out: list[Answer] = []
    for q in questions:
        a = by_id.get(q.id)
        if not a:
            out.append(uniform_answer(q))
            continue
        conf = float(a.get("confidence", 0.6) or 0.6)
        try:
            if q.type == "choice":
                probs = a.get("probabilities")
                n = len(q.options or [])
                if isinstance(probs, dict):
                    probs = [float(probs.get(o, 0)) for o in q.options or []]
                if not isinstance(probs, list) or len(probs) != n:
                    raise ValueError("bad probabilities")
                out.append(Answer(id=q.id, probabilities=_norm(probs), confidence=conf, raw=a))
            elif q.type == "score":
                lo, hi = q.range or (0, 3)
                s = float(a.get("score", a.get("value", (lo + hi) / 2)))
                out.append(Answer(id=q.id, score=max(lo, min(hi, s)), confidence=conf, raw=a))
            else:
                v = float(a.get("value", a.get("probability", 0.5)))
                out.append(Answer(id=q.id, value=max(0.0, min(1.0, v)), confidence=conf, raw=a))
        except (TypeError, ValueError):
            out.append(uniform_answer(q))
    return out


# ───────────────────────── Claude ─────────────────────────


class ClaudeBackend:
    """Claude via the official Anthropic SDK. Credentials from ANTHROPIC_API_KEY or an `ant auth login` profile."""

    name = "claude"

    def __init__(self, model: str | None = None, effort: str = "low") -> None:
        import anthropic

        self.client = anthropic.Anthropic(timeout=30.0, max_retries=1)
        self.model = model or os.environ.get("BRAIN_MODEL", "claude-opus-5")
        self.effort = effort
        self.name = f"claude:{self.model}"
        self.last_usage: dict[str, Any] = {}

    def decide(self, state: str, questions: list[Question]) -> list[Answer]:
        import anthropic

        user = state + "\n\n" + render_questions(questions)
        try:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=1500,
                system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                output_config={"effort": self.effort},
                messages=[{"role": "user", "content": user}],
            )
        except anthropic.RateLimitError:
            return [uniform_answer(q) for q in questions]
        except anthropic.APIStatusError as e:
            raise RuntimeError(f"claude api error {e.status_code}: {e.message}") from e
        except anthropic.APIConnectionError as e:
            raise RuntimeError("claude: network error") from e
        if response.stop_reason == "refusal":
            return [uniform_answer(q) for q in questions]
        self.last_usage = {"input": response.usage.input_tokens, "output": response.usage.output_tokens, "cache_read": response.usage.cache_read_input_tokens}
        text = "".join(b.text for b in response.content if b.type == "text")
        return parse_answers(text, questions)


# ───────────────────────── local OpenAI-compatible server (vLLM / so1 / Ollama) ─────────────────────────


class LocalBackend:
    """A local model behind an OpenAI-compatible chat endpoint (vLLM, Ollama). Not for Claude."""

    name = "local"

    def __init__(self, base_url: str | None = None, model: str | None = None) -> None:
        import httpx

        self.base_url = (base_url or os.environ.get("LLM_BASE_URL", "http://localhost:8000/v1")).rstrip("/")
        self.model = model or os.environ.get("LLM_MODEL", "Qwen/Qwen3-30B-A3B")
        self.client = httpx.Client(timeout=60.0)
        self.name = f"local:{self.model}"

    def decide(self, state: str, questions: list[Question]) -> list[Answer]:
        body = {
            "model": self.model,
            "temperature": 0.3,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": state + "\n\n" + render_questions(questions)},
            ],
        }
        headers = {}
        key = os.environ.get("LLM_API_KEY")
        if key:
            headers["Authorization"] = f"Bearer {key}"
        r = self.client.post(f"{self.base_url}/chat/completions", json=body, headers=headers)
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"]
        return parse_answers(text, questions)


class JevBackend:
    """TypeSafe's Jev: a System One model. Our protocol is modelled on its API, so the mapping is direct:
    choice -> choice (criteria keyed o0..oN), score -> score (levels built from the range), noul -> noul.
    POST https://api.typesafe.ai/v1/systemone, key in TYPESAFE_API_KEY. Retries on 429/529 with backoff."""

    name = "jev"

    def __init__(self, model: str | None = None, base_url: str | None = None) -> None:
        import httpx

        self.key = os.environ.get("TYPESAFE_API_KEY")
        if not self.key:
            raise RuntimeError("no TYPESAFE_API_KEY: put the key in .env at the repo root or export it in the environment")
        self.model = model or os.environ.get("JEV_MODEL", "jev-latest")
        self.base_url = (base_url or os.environ.get("TYPESAFE_BASE_URL", "https://api.typesafe.ai")).rstrip("/")
        self.client = httpx.Client(timeout=30.0)
        self.name = f"jev:{self.model}"
        self.usage = {"input_tokens": 0, "output_tokens": 0, "calls": 0, "errors": 0}

    @staticmethod
    def to_request(state: str, questions: list[Question], model: str) -> dict[str, Any]:
        qs: dict[str, Any] = {}
        for q in questions:
            if q.type == "choice":
                opts = q.options or []
                qs[q.id] = {"type": "choice", "instructions": q.text, "criteria": {f"o{i}": label for i, label in enumerate(opts)}}
            elif q.type == "score":
                lo, hi = q.range or (0, 3)
                n = max(2, min(10, int(round(hi - lo)) + 1))
                words = ["not at all", "slightly", "noticeably", "strongly", "very strongly", "utterly"]
                levels = [f"{int(lo) + i}: {words[min(i, len(words) - 1)] if n <= len(words) else 'level ' + str(int(lo) + i)}" for i in range(n)]
                qs[q.id] = {"type": "score", "instructions": q.text, "criteria": levels}
            else:
                qs[q.id] = {"type": "noul", "instructions": q.text}
        return {"model": model, "state": state, "questions": qs}

    @staticmethod
    def from_response(data: dict[str, Any], questions: list[Question]) -> list[Answer]:
        answers = data.get("answers", {})
        out: list[Answer] = []
        for q in questions:
            a = answers.get(q.id)
            if not a:
                out.append(uniform_answer(q))
                continue
            conf = a.get("confidence")
            if q.type == "choice":
                probs = a.get("probabilities", {})
                ps = _norm([float(probs.get(f"o{i}", 0.0)) for i in range(len(q.options or []))])
                out.append(Answer(id=q.id, probabilities=ps, confidence=float(conf) if conf is not None else 0.5, raw=a))
            elif q.type == "score":
                lo, hi = q.range or (0, 3)
                sc = float(a.get("score", 0.0)) + lo
                out.append(Answer(id=q.id, score=max(lo, min(hi, sc)), confidence=float(conf) if conf is not None else 0.5, raw=a))
            else:
                v = float(a.get("noul", 0.5))
                out.append(Answer(id=q.id, value=v, confidence=abs(v - 0.5) * 2, raw=a))
        return out

    def decide(self, state: str, questions: list[Question]) -> list[Answer]:
        body = self.to_request(state, questions, self.model)
        headers = {"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        delay = 0.5
        for attempt in range(4):
            r = self.client.post(f"{self.base_url}/v1/systemone", json=body, headers=headers)
            if r.status_code in (429, 529) and attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            if r.status_code >= 400:
                self.usage["errors"] += 1
                raise RuntimeError(f"Jev {r.status_code}: {r.text[:300]}")
            data = r.json()
            u = data.get("usage") or {}
            self.usage["input_tokens"] += int(u.get("input_tokens", 0))
            self.usage["output_tokens"] += int(u.get("output_tokens", 0))
            self.usage["calls"] += 1
            return self.from_response(data, questions)
        raise RuntimeError("Jev: rate limit exceeded, try again later")


def make_backend(kind: str) -> Backend:
    kind = (kind or "random").lower()
    if kind == "random":
        return RandomBackend()
    if kind == "claude":
        return ClaudeBackend()
    if kind == "local":
        return LocalBackend()
    if kind == "jev":
        return JevBackend()
    raise ValueError(f"unknown backend: {kind}")


class TimedBackend:
    """Wraps a backend and records latency."""

    def __init__(self, inner: Backend) -> None:
        self.inner = inner
        self.name = inner.name
        self.latencies: list[float] = []

    def decide(self, state: str, questions: list[Question]) -> list[Answer]:
        t0 = time.perf_counter()
        try:
            return self.inner.decide(state, questions)
        finally:
            self.latencies.append(time.perf_counter() - t0)
