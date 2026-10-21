"""Prompt for LLM-backed System One brains."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .backends import Question

SYSTEM_PROMPT = """You are the behaviour model of one character in a simulated colony under a dome.
You are given their state in words (character, needs, mood, who is nearby, relations, memory, beliefs, goals)
and a few questions. You are not an assistant or an adviser: you answer the way this person is inclined to act,
based only on what they know and feel. People are unpredictable but not random: someone hungry and broke
may steal, a proud one will endure, a hot-tempered one will hit, a timid one will walk away. Bad and shameful
options are a normal part of behaviour, do not soften them. Do not moralise or explain.

Reply format — JSON only, no commentary:
{"answers": [
  {"id": "<question id>", "probabilities": [p1, p2, ...], "confidence": 0.0-1.0},   for choice — one number per option in the same order, summing to 1
  {"id": "<id>", "score": a number in the given range, "confidence": ...},          for score
  {"id": "<id>", "value": probability of "yes" 0.0-1.0, "confidence": ...}         for noul
]}
Answer every question. Distributions should be sharp where character and situation are clear, and spread out where they are not."""


def render_questions(questions: list["Question"]) -> str:
    lines = ["Questions:"]
    for q in questions:
        if q.type == "choice":
            opts = "; ".join(f"{i + 1}) {o}" for i, o in enumerate(q.options or []))
            lines.append(f"- [{q.id}] (choice) {q.text} Options: {opts}")
        elif q.type == "score":
            lo, hi = q.range or (0, 3)
            lines.append(f"- [{q.id}] (score {lo:g}–{hi:g}) {q.text}")
        else:
            lines.append(f"- [{q.id}] (noul, yes/no) {q.text}")
    return "\n".join(lines)
