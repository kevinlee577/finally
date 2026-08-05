"""FastAPI application factory and process lifecycle.

Serves the REST API, the SSE price stream, and the Next.js static export on a
single port (PLAN.md §3, §11). Route precedence is fixed: the /api routers are
registered first, so an unmatched /api path returns a JSON 404 in the §8 error
envelope rather than falling through to index.html.

Run with:  uvicorn app.main:app --host 0.0.0.0 --port 8000
Single process, no --workers — required by §7's concurrency model.
"""

from __future__ import annotations

import logging
import mimetypes
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse

from . import config
from .api import chat, health, portfolio, watchlist
from .db import init_db
from .errors import ApiError, register_exception_handlers
from .market import create_market_data_source, create_stream_router
from .services.snapshots import start_snapshot_task, stop_snapshot_task
from .services.tracking import tracked_tickers
from .state import state

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Pin the content types for the assets a Next.js export emits. Python's
# mimetypes falls back to the Windows registry, which maps .mjs to text/plain
# and knows nothing about .woff2 — and a browser refuses to execute an ES module
# served as text/plain. Registering explicitly makes this identical on every
# platform instead of depending on the host's registry.
for _mime, _extension in (
    ("text/javascript", ".js"),
    ("text/javascript", ".mjs"),
    ("text/css", ".css"),
    ("application/json", ".json"),
    ("font/woff", ".woff"),
    ("font/woff2", ".woff2"),
    ("image/svg+xml", ".svg"),
    ("application/manifest+json", ".webmanifest"),
):
    mimetypes.add_type(_mime, _extension)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Start-up and shut-down sequence.

    Order matters (§7): the database is created and seeded *before* the market
    data source and snapshot task start, because both read watchlist/positions
    on their first pass. A schema failure propagates and aborts startup — the
    container must not serve against a half-initialized database.
    """
    init_db()
    state.db_ready = True

    tickers = tracked_tickers()
    source = create_market_data_source(
        state.price_cache,
        tick_seconds=config.market_tick_seconds(),
    )
    await source.start(tickers)
    state.market_source = source
    logger.info("Market data source tracking %d tickers", len(tickers))

    await start_snapshot_task()

    try:
        yield
    finally:
        await stop_snapshot_task()
        if state.market_source is not None:
            await state.market_source.stop()
            state.market_source = None
        state.db_ready = False
        logger.info("Shutdown complete")


def create_app() -> FastAPI:
    """Build the application. Kept separate from the module-level `app` so tests
    can construct isolated instances."""
    app = FastAPI(
        title="FinAlly",
        description="AI Trading Workstation",
        version="0.1.0",
        lifespan=lifespan,
    )

    register_exception_handlers(app)

    # --- /api routers, registered before the static catch-all ------------------
    app.include_router(health.router)
    app.include_router(portfolio.router)
    app.include_router(watchlist.router)
    # The stream's poll interval tracks the producer tick, so the wire rate is
    # not capped below the cache update rate (§12).
    app.include_router(
        create_stream_router(state.price_cache, interval=config.market_tick_seconds())
    )

    app.include_router(chat.router)

    _register_static_routes(app)
    return app


def _register_static_routes(app: FastAPI) -> None:
    """Serve the Next.js static export, with SPA fallback to index.html.

    Registered last so every /api route wins. Anything under /api that reached
    this point is genuinely unrouted and gets a §8-shaped 404 instead of HTML.
    """

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend(full_path: str) -> FileResponse:
        if full_path == "api" or full_path.startswith("api/"):
            raise ApiError("not_found", f"No API route matches /{full_path}.")

        # Resolved per request rather than captured at app construction, so
        # STATIC_DIR behaves like every other value in config.py.
        static_root = config.static_dir()
        if not static_root.is_dir():
            raise ApiError(
                "not_found",
                "Frontend assets are not present in this deployment.",
            )

        candidate = (static_root / full_path).resolve() if full_path else None
        if (
            candidate is not None
            and candidate.is_file()
            and candidate.is_relative_to(static_root.resolve())
        ):
            return FileResponse(candidate)

        # SPA fallback: unknown paths are client-side routes.
        index = static_root / "index.html"
        if index.is_file():
            return FileResponse(index)

        raise ApiError("not_found", "Frontend index.html is missing.")


app = create_app()
