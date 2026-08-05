"""Shared helpers: timestamps, ticker normalization, numeric rounding.

The rounding helpers exist so that every writer in the codebase applies the
same precision rules from PLAN.md §7 "Money & Quantity Precision".
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

# PLAN.md §8: a normalized ticker is non-empty and contains only A-Z, '.', '-'
_TICKER_RE = re.compile(r"^[A-Z.\-]+$")

MONEY_DECIMALS = 2
QUANTITY_DECIMALS = 6


def utc_now_iso() -> str:
    """Current UTC time as RFC 3339 with milliseconds, e.g. 2026-08-01T22:15:30.123Z."""
    now = datetime.now(UTC)
    return f"{now.strftime('%Y-%m-%dT%H:%M:%S')}.{now.microsecond // 1000:03d}Z"


def normalize_ticker(raw: object) -> str | None:
    """Upper-case and trim a ticker input. Returns None if it is syntactically invalid.

    Callers should translate a None result into an `invalid_ticker` error (§8).
    """
    if not isinstance(raw, str):
        return None
    ticker = raw.strip().upper()
    if not ticker or not _TICKER_RE.match(ticker):
        return None
    return ticker


def round_money(value: float) -> float:
    """Round cash / average cost / prices to 2 decimals (§7).

    Always returns a float — round(0, 2) would otherwise hand back an int and
    leak `0` instead of `0.0` into JSON responses.
    """
    return float(round(float(value), MONEY_DECIMALS))


def round_quantity(value: float) -> float:
    """Round share quantities to 6 decimals (§7)."""
    return float(round(float(value), QUANTITY_DECIMALS))
