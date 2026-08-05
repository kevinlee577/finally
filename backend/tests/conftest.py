"""Pytest configuration and shared fixtures."""

import pytest


@pytest.fixture
def event_loop_policy():
    """Use the default event loop policy for all async tests."""
    import asyncio

    return asyncio.DefaultEventLoopPolicy()


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    """Point DB_PATH at a throwaway file, initialize it, and reset app state.

    Each test therefore gets a freshly seeded database and a clean price cache,
    with no dependence on a developer's local db/finally.db.
    """
    from app.db import init_db
    from app.state import state

    db_file = tmp_path / "test.db"
    monkeypatch.setenv("DB_PATH", str(db_file))
    monkeypatch.delenv("MASSIVE_API_KEY", raising=False)

    state.reset()
    init_db()
    state.db_ready = True

    yield db_file

    state.reset()


class FakeMarketSource:
    """In-memory MarketDataSource stand-in that records tracking calls.

    Lets tests assert the §6 tracking-set rules (which add_ticker/remove_ticker
    calls happen, and when) without running the real simulator's timing loop.
    """

    def __init__(self, cache, seed_price=100.0):
        self._cache = cache
        self._tickers: list[str] = []
        self._seed_price = seed_price
        self.added: list[str] = []
        self.removed: list[str] = []

    async def start(self, tickers):
        for ticker in tickers:
            await self.add_ticker(ticker)

    async def stop(self):
        pass

    async def add_ticker(self, ticker):
        self.added.append(ticker)
        if ticker not in self._tickers:
            self._tickers.append(ticker)
            self._cache.update(ticker=ticker, price=self._seed_price)

    async def remove_ticker(self, ticker):
        self.removed.append(ticker)
        if ticker in self._tickers:
            self._tickers.remove(ticker)
        self._cache.remove(ticker)

    def get_tickers(self):
        return list(self._tickers)

    def set_price(self, ticker, price):
        """Move a ticker's price so P&L assertions have something to bite on."""
        self._cache.update(ticker=ticker, price=price)


@pytest.fixture
async def market(temp_db):
    """A started FakeMarketSource wired into app state, tracking the seeded set."""
    from app.services.tracking import tracked_tickers
    from app.state import state

    source = FakeMarketSource(state.price_cache)
    await source.start(tracked_tickers())
    state.market_source = source
    # Calls made during setup are not what a test is asserting about.
    source.added.clear()
    source.removed.clear()
    return source


@pytest.fixture
def client(market):
    """TestClient over a fresh app, with the fake market source already active.

    Deliberately not used as a context manager: that would run the real lifespan
    and start the live simulator, making price-dependent assertions flaky.
    """
    from fastapi.testclient import TestClient

    from app.main import create_app

    return TestClient(create_app())
