"""Loads KEY=VALUE lines from .env in the repo root into os.environ (existing variables win)."""

from __future__ import annotations

import os
from pathlib import Path


def load_env() -> None:
    root = Path(__file__).resolve().parent.parent
    for p in (root / ".env", root / "brain" / ".env"):
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)
