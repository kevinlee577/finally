"""Trade execution and portfolio metrics (PLAN.md §7 precision/atomicity, §8 formulas)."""

import asyncio

import pytest

from app.db import read_connection
from app.errors import ApiError
from app.services.portfolio import execute_trade, get_portfolio


async def buy(ticker, qty):
    return await execute_trade(ticker, qty, "buy")


async def sell(ticker, qty):
    return await execute_trade(ticker, qty, "sell")


class TestBuy:
    async def test_debits_cash_and_opens_position(self, market):
        market.set_price("AAPL", 190.00)

        result = await buy("AAPL", 10)

        assert result.fill_price == 190.00
        assert result.cash_balance == 8100.00  # 10000 - 1900
        assert result.position["quantity"] == 10
        assert result.position["avg_cost"] == 190.00

    async def test_normalizes_ticker_case_and_whitespace(self, market):
        market.set_price("AAPL", 100.00)

        result = await buy("  aapl  ", 1)

        assert result.ticker == "AAPL"

    async def test_second_buy_uses_weighted_average_cost(self, market):
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 10)
        market.set_price("AAPL", 200.00)

        result = await buy("AAPL", 10)

        # (10*100 + 10*200) / 20
        assert result.position["quantity"] == 20
        assert result.position["avg_cost"] == 150.00
        assert result.cash_balance == 10000.00 - 1000.00 - 2000.00

    async def test_supports_fractional_shares(self, market):
        market.set_price("AAPL", 200.00)

        result = await buy("AAPL", 0.5)

        assert result.position["quantity"] == 0.5
        assert result.cash_balance == 9900.00

    async def test_rejects_buy_exceeding_cash(self, market):
        market.set_price("AAPL", 190.00)

        with pytest.raises(ApiError) as exc:
            await buy("AAPL", 1000)

        assert exc.value.code == "insufficient_cash"
        assert exc.value.status_code == 400

    async def test_failed_buy_leaves_no_partial_state(self, market):
        """A rejected trade must not debit cash, create a position, or log a trade."""
        market.set_price("AAPL", 190.00)

        with pytest.raises(ApiError):
            await buy("AAPL", 1000)

        portfolio = get_portfolio()
        assert portfolio["cash_balance"] == 10000.00
        assert portfolio["positions"] == []
        with read_connection() as conn:
            trades = conn.execute("SELECT COUNT(*) AS n FROM trades").fetchone()["n"]
        assert trades == 0

    async def test_can_spend_entire_balance(self, market):
        """An exact-balance buy must not be rejected by float representation noise."""
        market.set_price("AAPL", 100.00)

        result = await buy("AAPL", 100)

        assert result.cash_balance == 0.00


class TestSell:
    async def test_credits_cash_and_reduces_position(self, market):
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 10)

        market.set_price("AAPL", 120.00)
        result = await sell("AAPL", 4)

        assert result.cash_balance == 9000.00 + 480.00
        assert result.position["quantity"] == 6

    async def test_sell_does_not_change_cost_basis(self, market):
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 10)
        market.set_price("AAPL", 120.00)

        result = await sell("AAPL", 4)

        assert result.position["avg_cost"] == 100.00

    async def test_selling_at_a_loss_reduces_total_value(self, market):
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 10)

        market.set_price("AAPL", 50.00)
        result = await sell("AAPL", 10)

        assert result.cash_balance == 9000.00 + 500.00
        assert result.total_value == 9500.00

    async def test_full_sell_closes_position_and_deletes_row(self, market):
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 10)

        result = await sell("AAPL", 10)

        assert result.position is None
        with read_connection() as conn:
            rows = conn.execute("SELECT COUNT(*) AS n FROM positions").fetchone()["n"]
        assert rows == 0

    async def test_rejects_sell_with_no_position(self, market):
        market.set_price("AAPL", 100.00)

        with pytest.raises(ApiError) as exc:
            await sell("AAPL", 1)

        assert exc.value.code == "no_position"
        assert exc.value.status_code == 404

    async def test_rejects_sell_exceeding_holding(self, market):
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 5)

        with pytest.raises(ApiError) as exc:
            await sell("AAPL", 6)

        assert exc.value.code == "insufficient_shares"
        assert exc.value.status_code == 400


class TestValidation:
    @pytest.mark.parametrize("ticker", ["", "   ", "12X", "A B", "🚀", "AAPL1"])
    async def test_rejects_invalid_tickers(self, market, ticker):
        with pytest.raises(ApiError) as exc:
            await buy(ticker, 1)
        assert exc.value.code == "invalid_ticker"

    @pytest.mark.parametrize("ticker", ["BRK.B", "RDS-A"])
    async def test_accepts_dotted_and_hyphenated_tickers(self, market, ticker):
        market.set_price(ticker, 10.00)
        result = await buy(ticker, 1)
        assert result.ticker == ticker

    @pytest.mark.parametrize("side", ["hold", "BUYY", "", "short"])
    async def test_rejects_invalid_side(self, market, side):
        market.set_price("AAPL", 100.00)
        with pytest.raises(ApiError) as exc:
            await execute_trade("AAPL", 1, side)
        assert exc.value.code == "invalid_side"

    @pytest.mark.parametrize("side", ["BUY", "Buy", " buy "])
    async def test_side_is_case_and_whitespace_insensitive(self, market, side):
        market.set_price("AAPL", 100.00)
        result = await execute_trade("AAPL", 1, side)
        assert result.side == "buy"

    @pytest.mark.parametrize("quantity", [0, -5, -0.001])
    async def test_rejects_non_positive_quantity(self, market, quantity):
        market.set_price("AAPL", 100.00)
        with pytest.raises(ApiError) as exc:
            await buy("AAPL", quantity)
        assert exc.value.code == "validation_error"

    async def test_rejects_non_numeric_quantity(self, market):
        market.set_price("AAPL", 100.00)
        with pytest.raises(ApiError) as exc:
            await buy("AAPL", "ten")
        assert exc.value.code == "validation_error"

    async def test_rejects_trade_without_a_quote(self, market):
        """quote_unavailable is distinct from no_position: the symbol is valid,
        it just has no price yet."""
        market._cache.remove("AAPL")
        market._tickers.clear()

        # FakeMarketSource seeds a price on add_ticker, so simulate a source that
        # cannot produce one in order to exercise the rejection path.
        async def add_without_quote(ticker):
            market.added.append(ticker)

        market.add_ticker = add_without_quote

        with pytest.raises(ApiError) as exc:
            await buy("ZZZZ", 1)

        assert exc.value.code == "quote_unavailable"
        assert exc.value.status_code == 409
        assert "ZZZZ" in market.added  # subscribed so a retry can succeed


class TestTrackingSet:
    async def test_buying_an_untracked_symbol_subscribes_it(self, market):
        """§6: a buy for a symbol with no watchlist row must keep it priceable."""
        await market.add_ticker("PYPL")
        await market.remove_ticker("PYPL")
        market.added.clear()
        market.removed.clear()

        await buy("PYPL", 1)

        assert "PYPL" in market.get_tickers()

    async def test_closing_an_unwatchlisted_position_unsubscribes_it(self, market, client):
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 10)
        client.delete("/api/watchlist/AAPL")
        market.removed.clear()

        await sell("AAPL", 10)

        assert "AAPL" in market.removed

    async def test_closing_a_watchlisted_position_keeps_it_tracked(self, market):
        """AAPL stays on the watchlist, so closing the position must not evict it."""
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 10)
        market.removed.clear()

        await sell("AAPL", 10)

        assert "AAPL" not in market.removed
        assert "AAPL" in market.get_tickers()


class TestPortfolioMetrics:
    async def test_empty_portfolio_is_all_cash(self, market):
        portfolio = get_portfolio()

        assert portfolio == {
            "cash_balance": 10000.00,
            "total_value": 10000.00,
            "unrealized_pnl": 0.0,
            "positions": [],
        }

    async def test_position_metrics_use_live_price(self, market):
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 10)
        market.set_price("AAPL", 110.00)

        position = get_portfolio()["positions"][0]

        assert position["current_price"] == 110.00
        assert position["market_value"] == 1100.00
        assert position["unrealized_pnl"] == 100.00
        assert position["change_percent"] == 10.00

    async def test_totals_aggregate_across_positions(self, market):
        market.set_price("AAPL", 100.00)
        market.set_price("MSFT", 200.00)
        await buy("AAPL", 10)  # -1000
        await buy("MSFT", 5)  # -1000
        market.set_price("AAPL", 110.00)  # +100
        market.set_price("MSFT", 180.00)  # -100

        portfolio = get_portfolio()

        assert portfolio["cash_balance"] == 8000.00
        assert portfolio["unrealized_pnl"] == 0.00
        assert portfolio["total_value"] == 10000.00

    async def test_unpriced_position_falls_back_to_cost_basis(self, market):
        """A missing quote must not produce a portfolio-value cliff (§7, §8)."""
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 10)
        market._cache.remove("AAPL")

        position = get_portfolio()["positions"][0]

        assert position["current_price"] == 100.00
        assert position["market_value"] == 1000.00
        assert position["unrealized_pnl"] == 0.00


class TestConcurrency:
    async def test_concurrent_buys_cannot_jointly_overspend(self, market):
        """The write lock must stop two buys validating against the same balance."""
        market.set_price("AAPL", 100.00)

        results = await asyncio.gather(
            buy("AAPL", 60),
            buy("AAPL", 60),
            return_exceptions=True,
        )

        succeeded = [r for r in results if not isinstance(r, Exception)]
        failed = [r for r in results if isinstance(r, ApiError)]
        assert len(succeeded) == 1
        assert len(failed) == 1
        assert failed[0].code == "insufficient_cash"
        assert get_portfolio()["cash_balance"] == 4000.00

    async def test_every_trade_records_a_snapshot(self, market):
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 1)
        await buy("AAPL", 1)

        with read_connection() as conn:
            count = conn.execute("SELECT COUNT(*) AS n FROM portfolio_snapshots").fetchone()["n"]

        assert count == 3  # 1 seeded baseline + 1 per trade

    async def test_trade_log_is_append_only(self, market):
        market.set_price("AAPL", 100.00)
        await buy("AAPL", 2)
        await sell("AAPL", 2)

        with read_connection() as conn:
            rows = conn.execute("SELECT side, quantity, price FROM trades").fetchall()

        assert [(r["side"], r["quantity"]) for r in rows] == [("buy", 2.0), ("sell", 2.0)]
