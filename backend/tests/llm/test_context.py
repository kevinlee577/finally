"""Portfolio context handed to the LLM (PLAN.md §9 step 2).

The context is built from the portfolio/watchlist services rather than its own
SQL, so these tests double as a check that it tracks the REST view exactly.
"""

from app.llm.context import load_portfolio_context
from app.services import portfolio as portfolio_service


class TestPortfolioContext:
    async def test_fresh_account_reports_cash_and_no_positions(self, market):
        context = load_portfolio_context()

        assert "$10,000.00" in context
        assert "POSITIONS: none" in context
        assert "AAPL" in context, "the seeded watchlist should be listed"

    async def test_reflects_an_open_position_after_a_trade(self, market):
        await portfolio_service.execute_trade("AAPL", 10, "buy")
        market.set_price("AAPL", 120.0)

        context = load_portfolio_context()

        assert "AAPL: 10" in context
        assert "$100.00 avg" in context
        assert "$120.00" in context
        assert "$200.00" in context, "unrealized P&L of (120-100)*10"

    async def test_matches_the_portfolio_service_totals(self, market):
        """Guards against the context drifting from what /api/portfolio serves."""
        await portfolio_service.execute_trade("AAPL", 5, "buy")
        market.set_price("AAPL", 150.0)

        portfolio = portfolio_service.get_portfolio()
        context = load_portfolio_context()

        assert f"${portfolio['cash_balance']:,.2f}" in context
        assert f"${portfolio['total_value']:,.2f}" in context

    async def test_unquoted_watchlist_ticker_is_labelled(self, market):
        from app.services import watchlist as watchlist_service

        # add_ticker subscribes via the fake source, which seeds a price; drop it
        # so the ticker is genuinely unquoted.
        await watchlist_service.add_ticker("PYPL")
        from app.state import state

        state.price_cache.remove("PYPL")

        assert "PYPL: no quote yet" in load_portfolio_context()
