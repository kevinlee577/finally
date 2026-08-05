"""The ticker tracking set (PLAN.md §6).

The set of tickers a MarketDataSource actively tracks is always the union of the
`watchlist` rows and any `positions` row with quantity > 0. Computing it from the
watchlist alone would silently drop quotes for a held position whose ticker was
un-watchlisted before a restart.
"""

from __future__ import annotations

import sqlite3

from ..config import DEFAULT_USER_ID
from ..db import read_connection


def tracked_tickers(
    conn: sqlite3.Connection | None = None,
    user_id: str = DEFAULT_USER_ID,
) -> list[str]:
    """Union of watchlisted tickers and tickers with an open position.

    Pass an existing connection to read inside a caller's transaction; omit it
    to open a short-lived read connection.
    """
    if conn is not None:
        return _query(conn, user_id)
    with read_connection() as own_conn:
        return _query(own_conn, user_id)


def is_tracked(
    ticker: str,
    conn: sqlite3.Connection | None = None,
    user_id: str = DEFAULT_USER_ID,
) -> bool:
    """Whether `ticker` is watchlisted or held — i.e. already in the tracking set."""
    return ticker in set(tracked_tickers(conn, user_id))


def _query(conn: sqlite3.Connection, user_id: str) -> list[str]:
    rows = conn.execute(
        """
        SELECT ticker FROM watchlist WHERE user_id = ?
        UNION
        SELECT ticker FROM positions WHERE user_id = ? AND quantity > 0
        ORDER BY ticker
        """,
        (user_id, user_id),
    ).fetchall()
    return [row["ticker"] for row in rows]
