"""Schema creation and default seeding, run once during FastAPI startup.

PLAN.md §7: initialization happens in the lifespan hook before the app accepts
any request and before the market-data / snapshot background tasks start. If
schema creation fails, startup fails loudly — the container must not come up
and serve against a partially-initialized database.
"""

from __future__ import annotations

import logging
import sqlite3
import uuid
from pathlib import Path

from ..config import DEFAULT_USER_ID, DEFAULT_WATCHLIST, STARTING_CASH
from ..utils import utc_now_iso
from .connection import connect, resolve_db_path

logger = logging.getLogger(__name__)

SCHEMA_FILE = Path(__file__).parent / "schema.sql"


def init_db() -> None:
    """Create the schema if missing and seed default data on a fresh database.

    Idempotent: safe to run against an already-initialized file. Raises on any
    failure so the caller can abort startup.
    """
    path = resolve_db_path()
    logger.info("Initializing database at %s", path)

    conn = connect()
    try:
        _create_schema(conn)
        _seed_defaults(conn)
    finally:
        conn.close()

    logger.info("Database ready")


def _create_schema(conn: sqlite3.Connection) -> None:
    schema_sql = SCHEMA_FILE.read_text(encoding="utf-8")
    conn.executescript(schema_sql)


def _seed_defaults(conn: sqlite3.Connection) -> None:
    """Insert the default profile, watchlist and baseline snapshot.

    Seeding is keyed off the existence of the user profile row. A database that
    already has a profile is left completely alone — including a watchlist the
    user has since emptied, which must not be silently repopulated.
    """
    existing = conn.execute(
        "SELECT 1 FROM users_profile WHERE id = ?", (DEFAULT_USER_ID,)
    ).fetchone()
    if existing:
        return

    created_at = utc_now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "INSERT INTO users_profile (id, cash_balance, created_at) VALUES (?, ?, ?)",
            (DEFAULT_USER_ID, STARTING_CASH, created_at),
        )
        conn.executemany(
            "INSERT INTO watchlist (id, user_id, ticker, added_at) VALUES (?, ?, ?, ?)",
            [
                (str(uuid.uuid4()), DEFAULT_USER_ID, ticker, created_at)
                for ticker in DEFAULT_WATCHLIST
            ],
        )
        # Baseline point so the P&L chart has data immediately rather than an
        # empty chart for up to the first snapshot interval (§7).
        conn.execute(
            "INSERT INTO portfolio_snapshots (id, user_id, total_value, recorded_at)"
            " VALUES (?, ?, ?, ?)",
            (str(uuid.uuid4()), DEFAULT_USER_ID, STARTING_CASH, created_at),
        )
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")

    logger.info(
        "Seeded fresh database: $%.2f cash, %d watchlist tickers",
        STARTING_CASH,
        len(DEFAULT_WATCHLIST),
    )
