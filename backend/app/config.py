"""Environment-driven configuration for the FinAlly backend.

Every value is read from the environment on each call rather than cached at
import time, so tests can monkeypatch os.environ without reloading modules.
See PLAN.md §5 for the full variable list and defaults.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# Load the project-root .env for local development (`uv run uvicorn app.main:app`).
# override=False means real environment variables always win, so Docker's
# --env-file path (§11) is unaffected and this is a no-op in the container.
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

DEFAULT_USER_ID = "default"
STARTING_CASH = 10000.0

# PLAN.md §7 "Default Seed Data"
DEFAULT_WATCHLIST = [
    "AAPL",
    "GOOGL",
    "MSFT",
    "AMZN",
    "TSLA",
    "NVDA",
    "META",
    "JPM",
    "V",
    "NFLX",
]


def db_path() -> Path:
    """Absolute path to the SQLite file (DB_PATH, default /app/db/finally.db)."""
    return Path(os.environ.get("DB_PATH", "/app/db/finally.db"))


def market_tick_seconds() -> float:
    """Market data update interval in seconds (MARKET_TICK_SECONDS, default 0.5)."""
    return float(os.environ.get("MARKET_TICK_SECONDS", "0.5"))


def snapshot_interval_seconds() -> float:
    """Portfolio snapshot interval in seconds (SNAPSHOT_INTERVAL_SECONDS, default 30)."""
    return float(os.environ.get("SNAPSHOT_INTERVAL_SECONDS", "30"))


def static_dir() -> Path:
    """Directory holding the Next.js static export (STATIC_DIR, default /app/static)."""
    return Path(os.environ.get("STATIC_DIR", "/app/static"))


def llm_mock_enabled() -> bool:
    """True when LLM_MOCK is set to "true" (case-insensitive)."""
    return os.environ.get("LLM_MOCK", "").strip().lower() == "true"


def openrouter_api_key() -> str:
    """The configured OpenRouter API key, or "" when unset."""
    return os.environ.get("OPENROUTER_API_KEY", "").strip()


def chat_enabled() -> bool:
    """Whether POST /api/chat can serve requests (PLAN.md §5, §8 /api/health)."""
    return bool(openrouter_api_key()) or llm_mock_enabled()
