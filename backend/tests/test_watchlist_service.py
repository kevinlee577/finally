"""Watchlist mutations and the §6 tracking rules."""

import pytest

from app.errors import ApiError
from app.services.portfolio import execute_trade
from app.services.tracking import is_tracked, tracked_tickers
from app.services.watchlist import add_ticker, get_watchlist, remove_ticker


class TestRead:
    async def test_returns_seeded_tickers_with_prices(self, market):
        entries = get_watchlist()

        assert len(entries) == 10
        assert {e["ticker"] for e in entries} >= {"AAPL", "NVDA"}
        assert all(e["price"] is not None for e in entries)
        assert all(e["added_at"].endswith("Z") for e in entries)

    async def test_price_is_null_when_ticker_has_no_quote(self, market):
        await add_ticker("PYPL")
        market._cache.remove("PYPL")

        entry = next(e for e in get_watchlist() if e["ticker"] == "PYPL")

        assert entry["price"] is None


class TestAdd:
    async def test_adds_and_subscribes_new_ticker(self, market):
        entry = await add_ticker("pypl")

        assert entry["ticker"] == "PYPL"
        assert "PYPL" in market.added
        assert "PYPL" in [e["ticker"] for e in get_watchlist()]

    async def test_rejects_duplicate(self, market):
        with pytest.raises(ApiError) as exc:
            await add_ticker("AAPL")

        assert exc.value.code == "duplicate_ticker"
        assert exc.value.status_code == 409

    async def test_duplicate_check_is_case_insensitive(self, market):
        with pytest.raises(ApiError) as exc:
            await add_ticker("aapl")

        assert exc.value.code == "duplicate_ticker"

    @pytest.mark.parametrize("ticker", ["", "  ", "123", "AA PL", "💸"])
    async def test_rejects_invalid_ticker(self, market, ticker):
        with pytest.raises(ApiError) as exc:
            await add_ticker(ticker)

        assert exc.value.code == "invalid_ticker"

    async def test_readding_a_held_ticker_does_not_double_subscribe(self, market):
        """A position keeps the ticker tracked, so add_ticker() is a no-op there."""
        await execute_trade("AAPL", 1, "buy")
        await remove_ticker("AAPL")
        market.added.clear()

        await add_ticker("AAPL")

        assert market.added == []
        assert "AAPL" in market.get_tickers()


class TestRemove:
    async def test_removes_and_unsubscribes_when_no_position(self, market):
        await remove_ticker("NFLX")

        assert "NFLX" in market.removed
        assert "NFLX" not in [e["ticker"] for e in get_watchlist()]
        assert "NFLX" not in market.get_tickers()

    async def test_keeps_tracking_when_a_position_is_open(self, market):
        """§6: removing a watchlist row must not kill live valuation for a holding."""
        await execute_trade("AAPL", 1, "buy")
        market.removed.clear()

        await remove_ticker("AAPL")

        assert market.removed == []
        assert "AAPL" in market.get_tickers()
        assert market._cache.get_price("AAPL") is not None
        assert "AAPL" not in [e["ticker"] for e in get_watchlist()]

    async def test_rejects_ticker_not_on_list(self, market):
        with pytest.raises(ApiError) as exc:
            await remove_ticker("PYPL")

        assert exc.value.code == "not_watchlisted"
        assert exc.value.status_code == 404

    async def test_rejects_invalid_ticker(self, market):
        with pytest.raises(ApiError) as exc:
            await remove_ticker("99")

        assert exc.value.code == "invalid_ticker"

    async def test_failed_removal_leaves_watchlist_intact(self, market):
        before = [e["ticker"] for e in get_watchlist()]

        with pytest.raises(ApiError):
            await remove_ticker("PYPL")

        assert [e["ticker"] for e in get_watchlist()] == before


class TestTrackingSet:
    async def test_union_of_watchlist_and_open_positions(self, market):
        """The set must survive un-watchlisting a held ticker — this is what a
        restart recomputes from, per §6."""
        await execute_trade("AAPL", 1, "buy")
        await remove_ticker("AAPL")

        tickers = tracked_tickers()

        assert "AAPL" in tickers
        assert len(tickers) == 10  # 9 watchlisted + AAPL held

    async def test_excludes_fully_closed_and_unwatchlisted_tickers(self, market):
        await execute_trade("AAPL", 1, "buy")
        await remove_ticker("AAPL")
        await execute_trade("AAPL", 1, "sell")

        assert "AAPL" not in tracked_tickers()

    async def test_is_tracked_matches_membership(self, market):
        assert is_tracked("AAPL") is True
        assert is_tracked("PYPL") is False
