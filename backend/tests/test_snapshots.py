"""Portfolio snapshots: valuation, ordering, and the background task (§7)."""

import asyncio

from app.config import snapshot_interval_seconds
from app.db import read_connection
from app.services.portfolio import execute_trade
from app.services.snapshots import (
    compute_total_value,
    list_snapshots,
    record_snapshot,
    start_snapshot_task,
    stop_snapshot_task,
)


class TestValuation:
    async def test_all_cash_portfolio_values_at_cash(self, market):
        with read_connection() as conn:
            assert compute_total_value(conn) == 10000.00

    async def test_includes_positions_at_live_prices(self, market):
        market.set_price("AAPL", 100.00)
        await execute_trade("AAPL", 10, "buy")
        market.set_price("AAPL", 150.00)

        with read_connection() as conn:
            # 9000 cash + 10 shares @ 150
            assert compute_total_value(conn) == 10500.00

    async def test_unpriced_position_falls_back_to_avg_cost(self, market):
        """One missing quote must not create a visible portfolio-value cliff."""
        market.set_price("AAPL", 100.00)
        await execute_trade("AAPL", 10, "buy")
        market._cache.remove("AAPL")

        with read_connection() as conn:
            assert compute_total_value(conn) == 10000.00


class TestHistory:
    async def test_seed_baseline_is_present_immediately(self, market):
        snapshots = list_snapshots()

        assert len(snapshots) == 1
        assert snapshots[0]["total_value"] == 10000.00

    async def test_returns_oldest_first(self, market):
        market.set_price("AAPL", 100.00)
        await execute_trade("AAPL", 1, "buy")
        await execute_trade("AAPL", 1, "buy")

        snapshots = list_snapshots()
        timestamps = [s["recorded_at"] for s in snapshots]

        assert len(snapshots) == 3
        assert timestamps == sorted(timestamps)

    async def test_timestamps_are_utc_rfc3339(self, market):
        assert list_snapshots()[0]["recorded_at"].endswith("Z")

    async def test_ad_hoc_snapshot_appends_a_row(self, market):
        market.set_price("AAPL", 100.00)
        await execute_trade("AAPL", 10, "buy")
        market.set_price("AAPL", 120.00)

        total = await record_snapshot()

        assert total == 10200.00
        assert list_snapshots()[-1]["total_value"] == 10200.00


class TestBackgroundTask:
    async def test_records_on_interval_without_firing_at_startup(self, market, monkeypatch):
        """The seed row already covers boot, so the loop sleeps before its first write."""
        monkeypatch.setenv("SNAPSHOT_INTERVAL_SECONDS", "0.1")
        assert snapshot_interval_seconds() == 0.1

        await start_snapshot_task()
        try:
            await asyncio.sleep(0.05)
            assert len(list_snapshots()) == 1  # nothing extra yet

            await asyncio.sleep(0.2)
            assert len(list_snapshots()) >= 2
        finally:
            await stop_snapshot_task()

    async def test_stop_is_safe_when_never_started(self, market):
        await stop_snapshot_task()

    async def test_loop_survives_a_failing_snapshot(self, market, monkeypatch):
        """A transient failure must not kill the task for the life of the process."""
        monkeypatch.setenv("SNAPSHOT_INTERVAL_SECONDS", "0.05")
        calls = {"n": 0}
        real = compute_total_value

        def flaky(conn, user_id="default"):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("transient failure")
            return real(conn, user_id)

        monkeypatch.setattr("app.services.snapshots.compute_total_value", flaky)

        await start_snapshot_task()
        try:
            await asyncio.sleep(0.3)
        finally:
            await stop_snapshot_task()

        assert calls["n"] >= 2
        assert len(list_snapshots()) >= 2
