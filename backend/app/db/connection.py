"""SQLite connection handling and the single write-serialization lock.

PLAN.md §7 "Transactions & Concurrency" requires:
  * one process, one Uvicorn worker;
  * every trade in a single `BEGIN IMMEDIATE` transaction;
  * all trade execution and ad hoc snapshot writes serialized behind one
    in-process asyncio.Lock so two concurrent buys can never validate against
    the same stale cash balance.

`write_lock()` returns that lock; `transaction()` provides the BEGIN IMMEDIATE
discipline. Writers must hold the lock *around* the transaction, not inside it:

    async with write_lock():
        with transaction() as conn:
            ...
"""

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from ..config import db_path

BUSY_TIMEOUT_SECONDS = 5.0

# The lock is created lazily per running event loop. Binding one module-level
# asyncio.Lock at import time breaks under pytest-asyncio, which gives each test
# a fresh event loop — asyncio primitives raise if reused across loops.
_write_lock: asyncio.Lock | None = None
_write_lock_loop: asyncio.AbstractEventLoop | None = None


def write_lock() -> asyncio.Lock:
    """The process-wide lock serializing all portfolio writes."""
    global _write_lock, _write_lock_loop
    loop = asyncio.get_running_loop()
    if _write_lock is None or _write_lock_loop is not loop:
        _write_lock = asyncio.Lock()
        _write_lock_loop = loop
    return _write_lock


def resolve_db_path() -> Path:
    """DB file path, with its parent directory created if needed."""
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def connect() -> sqlite3.Connection:
    """Open a connection with the project's standard pragmas.

    `isolation_level=None` turns off the driver's implicit transaction handling
    so `transaction()` can issue BEGIN IMMEDIATE explicitly.
    """
    conn = sqlite3.connect(
        resolve_db_path(),
        timeout=BUSY_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(f"PRAGMA busy_timeout = {int(BUSY_TIMEOUT_SECONDS * 1000)}")
    return conn


@contextmanager
def read_connection() -> Iterator[sqlite3.Connection]:
    """A short-lived read-only connection. No explicit transaction."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """Run a write inside one BEGIN IMMEDIATE transaction.

    Acquires the write lock up front rather than upgrading mid-transaction,
    which is what keeps SQLITE_BUSY races out of the trade path. Commits on
    clean exit, rolls back on any exception.
    """
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except Exception:
            conn.execute("ROLLBACK")
            raise
        else:
            conn.execute("COMMIT")
    finally:
        conn.close()
