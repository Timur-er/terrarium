"""Run the 20 scenarios against one or more backends and print a comparison.

    python -m brain.eval --backend random
    python -m brain.eval --backend claude --backend random
    python -m brain.eval --url http://localhost:8765/decide      # a running service
    python -m brain.eval --backend claude --verbose               # show full distributions
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from typing import Any

from .env import load_env

load_env()

from .backends import Answer, Backend, Question, TimedBackend, make_backend
from .scenarios import SCENARIOS, run_checks


class HttpBackend:
    def __init__(self, url: str) -> None:
        import httpx

        self.url = url
        self.client = httpx.Client(timeout=60.0)
        self.name = f"http:{url}"

    def decide(self, state: str, questions: list[Question]) -> list[Answer]:
        r = self.client.post(self.url, json={"state": state, "questions": [{"id": q.id, "type": q.type, "text": q.text, "options": q.options, "range": list(q.range) if q.range else None} for q in questions]})
        r.raise_for_status()
        return [Answer(id=a["id"], probabilities=a.get("probabilities"), score=a.get("score"), value=a.get("value"), confidence=a.get("confidence", 0.5)) for a in r.json()["answers"]]


def run(backend: Backend, verbose: bool = False) -> dict[str, Any]:
    timed = TimedBackend(backend)
    rows = []
    passed = total = 0
    for s in SCENARIOS:
        try:
            answers = timed.decide(s.state, s.questions)
        except Exception as e:  # noqa: BLE001 — report and continue
            rows.append({"id": s.id, "error": str(e)})
            total += len(s.checks)
            continue
        checks = run_checks(s, answers)
        ok = sum(1 for _, p, _ in checks if p)
        passed += ok
        total += len(checks)
        top = ""
        first = answers[0]
        q0 = s.questions[0]
        if first.probabilities and q0.options:
            i = max(range(len(first.probabilities)), key=lambda k: first.probabilities[k])
            top = f"{q0.options[i]} ({first.probabilities[i]:.2f})"
        elif first.value is not None:
            top = f"yes: {first.value:.2f}"
        rows.append({"id": s.id, "title": s.title, "top": top, "ok": ok, "n": len(checks), "checks": [(c.describe(), p, v) for c, p, v in checks], "answers": [a.to_dict() for a in answers]})
    lat = timed.latencies
    return {"backend": timed.name, "passed": passed, "total": total, "rows": rows, "latency_ms": {"p50": statistics.median(lat) * 1000 if lat else 0, "max": max(lat) * 1000 if lat else 0}}


def print_report(results: list[dict[str, Any]], verbose: bool) -> None:
    names = [r["backend"] for r in results]
    print("\nSCENARIO".ljust(44) + "".join(n[:24].ljust(26) for n in names))
    for i, s in enumerate(SCENARIOS):
        line = f"{i + 1:2d}. {s.title[:38]}".ljust(44)
        for r in results:
            row = r["rows"][i]
            if "error" in row:
                line += "error".ljust(26)
            else:
                line += f"{row['ok']}/{row['n']}  {row['top'][:18]}".ljust(26)
        print(line)
        if verbose:
            for r in results:
                row = r["rows"][i]
                if "error" in row:
                    print(f"      {r['backend']}: {row['error']}")
                    continue
                for desc, ok, val in row["checks"]:
                    print(f"      {'✓' if ok else '✗'} {desc}  [{val}]")
    print("-" * (44 + 26 * len(names)))
    line = "TOTAL".ljust(44)
    for r in results:
        line += f"{r['passed']}/{r['total']}  ({100 * r['passed'] / max(1, r['total']):.0f}%)".ljust(26)
    print(line)
    line = "latency p50 / max, ms".ljust(44)
    for r in results:
        line += f"{r['latency_ms']['p50']:.0f} / {r['latency_ms']['max']:.0f}".ljust(26)
    print(line)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", action="append", default=[], help="random | claude | local (repeatable)")
    ap.add_argument("--url", action="append", default=[], help="a running brain service (repeatable)")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--json", help="write full results to this file")
    args = ap.parse_args()
    backends: list[Backend] = [make_backend(k) for k in args.backend] + [HttpBackend(u) for u in args.url]
    if not backends:
        backends = [make_backend("random")]
    results = []
    for b in backends:
        t0 = time.time()
        print(f"… {b.name}", file=sys.stderr)
        results.append(run(b, args.verbose))
        print(f"  {time.time() - t0:.1f}s", file=sys.stderr)
    print_report(results, args.verbose)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
