"""Persistence for the `chat_messages` table (PLAN.md §7, §9).

The chat flow writes two rows per turn: the user's message *before* the LLM call
(§9 step 1, so the message survives any downstream failure), and the assistant's
message after execution (§9 step 9, carrying the executed-outcome envelope).
"""

from __future__ import annotations

import json
import logging
import sqlite3
import uuid

from ..config import DEFAULT_USER_ID
from ..db import read_connection, transaction
from ..utils import utc_now_iso

logger = logging.getLogger(__name__)

# §9 step 3: the last 20 messages (10 user/assistant turns).
HISTORY_LIMIT = 20


def insert_message(
    role: str,
    content: str,
    actions: list[dict] | None = None,
    user_id: str = DEFAULT_USER_ID,
) -> str:
    """Append one chat_messages row. Returns its id.

    `actions` is the §9 executed-outcome envelope for assistant turns, stored as
    JSON; it is always NULL for user messages.
    """
    message_id = str(uuid.uuid4())
    with transaction() as conn:
        conn.execute(
            "INSERT INTO chat_messages (id, user_id, role, content, actions, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                message_id,
                user_id,
                role,
                content,
                json.dumps(actions) if actions else None,
                utc_now_iso(),
            ),
        )
    return message_id


def recent_messages(
    exclude_id: str | None = None,
    limit: int = HISTORY_LIMIT,
    user_id: str = DEFAULT_USER_ID,
) -> list[dict]:
    """The most recent `limit` messages, oldest-first (§9 step 3).

    `exclude_id` drops the user row just inserted for the current turn, which is
    appended separately as the live user message rather than as history.
    """
    with read_connection() as conn:
        rows = conn.execute(
            "SELECT id, role, content, actions FROM chat_messages"
            " WHERE user_id = ? AND (? IS NULL OR id != ?)"
            " ORDER BY created_at DESC, rowid DESC"
            " LIMIT ?",
            (user_id, exclude_id, exclude_id, limit),
        ).fetchall()

    # Query is newest-first so LIMIT keeps the *latest* N; flip to oldest-first.
    return [_row_to_entry(row) for row in reversed(rows)]


def _row_to_entry(row: sqlite3.Row) -> dict:
    return {
        "role": row["role"],
        "content": row["content"],
        "actions": _decode_actions(row["actions"]),
    }


def _decode_actions(raw: str | None) -> list | None:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # A corrupt actions blob must not break the whole chat turn.
        logger.warning("Ignoring unparseable chat_messages.actions JSON: %r", raw[:200])
        return None
