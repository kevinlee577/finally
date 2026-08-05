"""Schema creation and seeding (PLAN.md §7)."""

from app.config import DEFAULT_USER_ID, DEFAULT_WATCHLIST, STARTING_CASH
from app.db import init_db, read_connection

EXPECTED_TABLES = {
    "users_profile",
    "watchlist",
    "positions",
    "trades",
    "portfolio_snapshots",
    "chat_messages",
}


class TestSchema:
    def test_creates_all_tables(self, temp_db):
        with read_connection() as conn:
            rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        assert EXPECTED_TABLES <= {row["name"] for row in rows}

    def test_creates_db_file_and_parent_directory(self, temp_db):
        assert temp_db.exists()

    def test_init_is_idempotent(self, temp_db):
        init_db()
        init_db()
        with read_connection() as conn:
            profiles = conn.execute("SELECT COUNT(*) AS n FROM users_profile").fetchone()["n"]
            watched = conn.execute("SELECT COUNT(*) AS n FROM watchlist").fetchone()["n"]
        assert profiles == 1
        assert watched == len(DEFAULT_WATCHLIST)


class TestSeedData:
    def test_seeds_single_profile_with_starting_cash(self, temp_db):
        with read_connection() as conn:
            row = conn.execute(
                "SELECT id, cash_balance, created_at FROM users_profile"
            ).fetchone()
        assert row["id"] == DEFAULT_USER_ID
        assert row["cash_balance"] == STARTING_CASH
        assert row["created_at"].endswith("Z")

    def test_seeds_ten_default_tickers(self, temp_db):
        with read_connection() as conn:
            rows = conn.execute("SELECT ticker FROM watchlist").fetchall()
        assert sorted(row["ticker"] for row in rows) == sorted(DEFAULT_WATCHLIST)

    def test_seeds_baseline_snapshot_matching_profile_creation(self, temp_db):
        """The P&L chart needs a baseline point immediately, not after 30s."""
        with read_connection() as conn:
            created_at = conn.execute("SELECT created_at FROM users_profile").fetchone()[
                "created_at"
            ]
            snapshots = conn.execute(
                "SELECT total_value, recorded_at FROM portfolio_snapshots"
            ).fetchall()
        assert len(snapshots) == 1
        assert snapshots[0]["total_value"] == STARTING_CASH
        assert snapshots[0]["recorded_at"] == created_at

    def test_does_not_reseed_a_watchlist_the_user_emptied(self, temp_db):
        """Seeding keys off the profile row, so an intentionally empty watchlist
        must survive a restart rather than silently repopulating."""
        from app.db import transaction

        with transaction() as conn:
            conn.execute("DELETE FROM watchlist")

        init_db()

        with read_connection() as conn:
            remaining = conn.execute("SELECT COUNT(*) AS n FROM watchlist").fetchone()["n"]
        assert remaining == 0

    def test_starts_with_no_positions_or_trades(self, temp_db):
        with read_connection() as conn:
            positions = conn.execute("SELECT COUNT(*) AS n FROM positions").fetchone()["n"]
            trades = conn.execute("SELECT COUNT(*) AS n FROM trades").fetchone()["n"]
        assert positions == 0
        assert trades == 0
