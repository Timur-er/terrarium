"""Brain service: POST /decide {state, questions} -> {answers}.

Run:  BRAIN_BACKEND=random uvicorn brain.server:app --port 8765
      BRAIN_BACKEND=claude BRAIN_MODEL=claude-opus-5 uvicorn brain.server:app --port 8765
      BRAIN_BACKEND=local LLM_BASE_URL=http://localhost:8000/v1 LLM_MODEL=... uvicorn brain.server:app --port 8765
"""

from __future__ import annotations

import os
import statistics
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .env import load_env

load_env()

from .backends import Question, TimedBackend, make_backend

app = FastAPI(title="Terrarium brain")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# without an explicit choice: Jev when its key is present, dice otherwise
backend = TimedBackend(make_backend(os.environ.get("BRAIN_BACKEND") or ("jev" if os.environ.get("TYPESAFE_API_KEY") else "random")))
log: list[dict[str, Any]] = []


class QuestionIn(BaseModel):
    id: str
    type: str
    text: str = ""
    options: list[str] | None = None
    range: list[float] | None = None


class DecideIn(BaseModel):
    state: str
    questions: list[QuestionIn]


@app.get("/health")
def health() -> dict[str, Any]:
    lat = backend.latencies[-200:]
    return {
        "backend": backend.name,
        "decisions": len(backend.latencies),
        "usage": getattr(backend.inner, "usage", None),
        "latency_ms": {"p50": round(statistics.median(lat) * 1000) if lat else None, "max": round(max(lat) * 1000) if lat else None},
    }


@app.post("/decide")
def decide(body: DecideIn) -> dict[str, Any]:
    questions = [Question(id=q.id, type=q.type, text=q.text, options=q.options, range=tuple(q.range) if q.range else None) for q in body.questions]
    try:
        answers = backend.decide(body.state, questions)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    log.append({"state": body.state, "questions": [q.model_dump() for q in body.questions], "answers": [a.to_dict() for a in answers]})
    if len(log) > 6000:
        del log[:1000]
    return {"answers": [a.to_dict() for a in answers], "backend": backend.name}


@app.get("/log")
def get_log(limit: int = 6000) -> list[dict[str, Any]]:
    return log[-limit:]
