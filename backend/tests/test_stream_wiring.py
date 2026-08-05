"""SSE stream wiring: interval configurability and router isolation (§6, §12)."""

import asyncio

from app.market import PriceCache, create_stream_router
from app.market.stream import DEFAULT_STREAM_INTERVAL, _generate_events


class FakeRequest:
    """Minimal stand-in for a Starlette Request that never disconnects."""

    def __init__(self, disconnect_after=None):
        self.client = None
        self._remaining = disconnect_after

    async def is_disconnected(self):
        if self._remaining is None:
            return False
        self._remaining -= 1
        return self._remaining < 0


class TestRouterConstruction:
    def test_each_call_returns_an_independent_router(self):
        """A module-level router would stack a duplicate /prices route per app."""
        cache = PriceCache()

        first = create_stream_router(cache)
        second = create_stream_router(cache)

        assert first is not second
        assert len(first.routes) == 1
        assert len(second.routes) == 1

    def test_exposes_the_documented_path(self):
        route = create_stream_router(PriceCache()).routes[0]

        assert route.path == "/api/stream/prices"

    def test_accepts_an_interval_override(self):
        assert create_stream_router(PriceCache(), interval=0.05) is not None

    def test_default_interval_is_500ms(self):
        assert DEFAULT_STREAM_INTERVAL == 0.5


class TestEventGeneration:
    async def test_first_chunk_is_the_retry_directive(self):
        cache = PriceCache()
        gen = _generate_events(cache, FakeRequest(), interval=0.01)

        assert await gen.__anext__() == "retry: 1000\n\n"
        await gen.aclose()

    async def test_emits_full_snapshot_keyed_by_ticker(self):
        cache = PriceCache()
        cache.update("AAPL", 190.50)
        cache.update("GOOGL", 175.00)
        gen = _generate_events(cache, FakeRequest(), interval=0.01)

        await gen.__anext__()  # retry directive
        event = await gen.__anext__()
        await gen.aclose()

        assert event.startswith("data: ")
        assert event.endswith("\n\n")
        assert '"AAPL"' in event and '"GOOGL"' in event
        assert '"direction"' in event

    async def test_interval_governs_the_emit_rate(self):
        """This is the §12 hook: a fast tick must actually reach the wire.

        With the old hardcoded 0.5s poll, a 0.02s interval produced at most one
        event in this window regardless of how fast the cache changed.
        """
        cache = PriceCache()
        cache.update("AAPL", 100.00)
        gen = _generate_events(cache, FakeRequest(), interval=0.02)
        await gen.__anext__()  # retry directive

        events = []

        async def drain():
            async for chunk in gen:
                events.append(chunk)

        task = asyncio.create_task(drain())
        for price in range(101, 121):
            cache.update("AAPL", float(price))
            await asyncio.sleep(0.02)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert len(events) > 2, f"fast interval did not reach the wire: {len(events)} events"

    async def test_stops_when_the_client_disconnects(self):
        cache = PriceCache()
        cache.update("AAPL", 100.00)

        chunks = [
            chunk async for chunk in _generate_events(cache, FakeRequest(2), interval=0.01)
        ]

        assert chunks[0] == "retry: 1000\n\n"

    async def test_no_event_when_the_cache_has_not_changed(self):
        """Events are version-gated, so an idle cache produces no traffic."""
        cache = PriceCache()
        cache.update("AAPL", 100.00)
        gen = _generate_events(cache, FakeRequest(), interval=0.01)
        await gen.__anext__()
        await gen.__anext__()  # the one snapshot for the current version

        # wait_for cancels the generator on timeout; _generate_events catches
        # CancelledError and returns, which surfaces as StopAsyncIteration.
        # Either exception means nothing was emitted within the window.
        try:
            await asyncio.wait_for(gen.__anext__(), timeout=0.1)
            emitted = True
        except (asyncio.TimeoutError, StopAsyncIteration):
            emitted = False
        finally:
            await gen.aclose()

        assert emitted is False
