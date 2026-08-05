"""Database layer: schema init, connections, and the write-serialization lock.

Public API:
    init_db()          - Create schema + seed defaults (call once at startup)
    connect()          - Raw connection with project pragmas
    read_connection()  - Context manager for reads
    transaction()      - Context manager wrapping BEGIN IMMEDIATE / COMMIT
    write_lock()       - The process-wide asyncio.Lock guarding portfolio writes
"""

from .connection import connect, read_connection, transaction, write_lock
from .init import init_db

__all__ = [
    "init_db",
    "connect",
    "read_connection",
    "transaction",
    "write_lock",
]
