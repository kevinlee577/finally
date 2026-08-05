"""Portfolio value snapshots (PLAN.md §7 "Portfolio Snapshot Semantics").

A snapshot is written (1) once at profile creation by the seeder, (2) inside
every trade's transaction, and (3) every SNAPSHOT_INTERVAL_SECONDS by the
background task started in the app lifespan. The background task does not fire
an extra snapshot on boot — the seed row already covers that.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import uuid

from ..config import DEFAULT_USER_ID, snapshot_interval_seconds
from ..db import read_connection, transaction, write_lock
from ..state import state
from ..utils import round_money, utc_now_iso

logger = logging.getLogger(__name__)

_snapshot_task: asyncio.Task | None = None


def compute_total_value(conn: sqlite3.Connection, user_id: str = DEFAULT_USER_ID) -> float:
    """total_value = cash_balance + Σ(quantity * current_price) over open positions.

    A position whose ticker has no cached price is valued at its avg_cost rather
    than skipped, so one missing quote cannot produce a portfolio-value cliff.
    """
    row = conn.execute(
        "SELECT cash_balance FROM users_profile WHERE id = ?", (user_id,)
    ).fetchone()
    total = float(row["cash_balance"]) if row else 0.0

    positions = conn.execute(
        "SELECT ticker, quantity, avg_cost FROM positions WHERE user_id = ? AND quantity > 0",
        (user_id,),
    ).fetchall()
    for position in positions:
        price = state.price_cache.get_price(position["ticker"])
        unit_value = price if price is not None else float(position["avg_cost"])
        total += float(position["quantity"]) * unit_value

    return round_money(total)


def insert_snapshot(
    conn: sqlite3.Connection,
    total_value: float,
    user_id: str = DEFAULT_USER_ID,
) -> str:
    """Append one portfolio_snapshots row. Returns its recorded_at timestamp.

    Takes an existing connection so trade execution can include it in the same
    transaction as the cash/position/trade writes.
    """
    recorded_at = utc_now_iso()
    conn.execute(
        "INSERT INTO portfolio_snapshots (id, user_id, total_value, recorded_at)"
        " VALUES (?, ?, ?, ?)",
        (str(uuid.uuid4()), user_id, round_money(total_value), recorded_at),
    )
    return recorded_at


async def record_snapshot(user_id: str = DEFAULT_USER_ID) -> float:
    """Take an ad hoc snapshot, serialized behind the shared write lock.

    Used by the background task. Trade execution does *not* call this — it
    inserts its snapshot inside its own already-locked transaction.
    """
    async with write_lock():
        with transaction() as conn:
            total_value = compute_total_value(conn, user_id)
            insert_snapshot(conn, total_value, user_id)
    return total_value


def list_snapshots(user_id: str = DEFAULT_USER_ID) -> list[dict[str, object]]:
    """All snapshots for the user, oldest first (§7 ordering/retention)."""
    with read_connection() as conn:
        rows = conn.execute(
            "SELECT total_value, recorded_at FROM portfolio_snapshots"
            " WHERE user_id = ? ORDER BY recorded_at ASC",
            (user_id,),
        ).fetchall()
    return [
        {"total_value": round_money(float(row["total_value"])), "recorded_at": row["recorded_at"]}
        for row in rows
    ]


async def start_snapshot_task() -> None:
    """Launch the periodic snapshot loop. Called from the lifespan hook."""
    global _snapshot_task
    if _snapshot_task is not None and not _snapshot_task.done():
        return
    _snapshot_task = asyncio.create_task(_snapshot_loop(), name="portfolio-snapshots")
    logger.info("Snapshot task started (every %.1fs)", snapshot_interval_seconds())


async def stop_snapshot_task() -> None:
    """Cancel the snapshot loop. Safe to call when it was never started."""
    global _snapshot_task
    if _snapshot_task is None:
        return
    _snapshot_task.cancel()
    try:
        await _snapshot_task
    except asyncio.CancelledError:
        pass
    _snapshot_task = None
    logger.info("Snapshot task stopped")


async def _snapshot_loop() -> None:
    """Sleep-then-record, so no duplicate snapshot fires at startup."""
    interval = snapshot_interval_seconds()
    while True:
        await asyncio.sleep(interval)
        try:
            await record_snapshot()
        except asyncio.CancelledError:
            raise
        except Exception:
            # A failed snapshot must never kill the loop.
            logger.exception("Portfolio snapshot failed")
