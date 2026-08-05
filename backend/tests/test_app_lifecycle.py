"""App startup/shutdown, static serving, and the catch-all error handler."""

import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db import transaction
from app.errors import ApiError, register_exception_handlers
from app.main import create_app
from app.state import state
from app.utils import utc_now_iso


@pytest.fixture
def fast_intervals(monkeypatch):
    """Keep the real lifespan's background tasks from slowing the test down."""
    monkeypatch.setenv("MARKET_TICK_SECONDS", "0.05")
    monkeypatch.setenv("SNAPSHOT_INTERVAL_SECONDS", "60")


class TestLifespan:
    def test_startup_initializes_db_and_starts_market_data(self, temp_db, fast_intervals):
        with TestClient(create_app()) as client:
            assert client.get("/api/health").json()["status"] == "ok"
            assert state.market_source is not None
            assert len(state.market_source.get_tickers()) == 10
            assert client.get("/api/watchlist").json()["watchlist"]

    def test_startup_tracks_held_tickers_that_are_not_watchlisted(
        self, temp_db, fast_intervals
    ):
        """§6: the startup tracking set is the union of watchlist and open
        positions. Computing it from the watchlist alone would silently stop
        quoting a held position across a container restart."""
        with transaction() as conn:
            conn.execute("DELETE FROM watchlist WHERE ticker = 'AAPL'")
            conn.execute(
                "INSERT INTO positions (id, user_id, ticker, quantity, avg_cost, updated_at)"
                " VALUES (?, 'default', 'AAPL', 5, 100.0, ?)",
                (str(uuid.uuid4()), utc_now_iso()),
            )

        with TestClient(create_app()):
            tracked = state.market_source.get_tickers()

        assert "AAPL" in tracked

    def test_shutdown_stops_the_market_source(self, temp_db, fast_intervals):
        with TestClient(create_app()):
            pass

        assert state.market_source is None
        assert state.db_ready is False

    def test_prices_stream_into_the_cache(self, temp_db, fast_intervals):
        """The simulator seeds the cache on start, so quotes exist immediately."""
        with TestClient(create_app()):
            assert state.price_cache.get_price("AAPL") is not None

    def test_startup_failure_aborts_rather_than_serving(
        self, temp_db, fast_intervals, monkeypatch
    ):
        """§7: a schema failure must not produce a half-initialized, serving app."""
        monkeypatch.setattr(
            "app.main.init_db", lambda: (_ for _ in ()).throw(RuntimeError("disk failure"))
        )

        with pytest.raises(RuntimeError, match="disk failure"):
            with TestClient(create_app()):
                pass


class TestStaticServing:
    @pytest.fixture
    def static_site(self, tmp_path, monkeypatch):
        root = tmp_path / "static"
        (root / "_next").mkdir(parents=True)
        (root / "index.html").write_text("<html>FinAlly</html>", encoding="utf-8")
        (root / "_next" / "app.js").write_text("console.log(1)", encoding="utf-8")
        monkeypatch.setenv("STATIC_DIR", str(root))
        return root

    def test_serves_index_at_root(self, client, static_site):
        response = client.get("/")

        assert response.status_code == 200
        assert "FinAlly" in response.text

    def test_serves_nested_assets_by_path(self, client, static_site):
        response = client.get("/_next/app.js")

        assert response.status_code == 200
        assert "console.log" in response.text

    def test_unknown_path_falls_back_to_index_for_client_routing(self, client, static_site):
        response = client.get("/some/spa/route")

        assert response.status_code == 200
        assert "FinAlly" in response.text

    def test_api_paths_never_fall_through_to_index(self, client, static_site):
        """Route precedence (§11): /api must stay JSON even with a static export."""
        response = client.get("/api/does-not-exist")

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"

    def test_real_api_routes_still_win(self, client, static_site):
        assert client.get("/api/health").json()["status"] == "ok"

    def test_path_traversal_is_not_served(self, client, static_site):
        """A '..' escape must fall back to index, never read outside the root."""
        response = client.get("/../conftest.py")

        assert "def " not in response.text


class TestAssetContentTypes:
    """A Next.js export's assets must be served with correct content types.

    mimetypes consults the Windows registry, which maps .mjs to text/plain and
    has no entry for .woff2 — and browsers refuse to execute an ES module served
    as text/plain, so this would break the app on some hosts but not others.
    """

    @pytest.fixture
    def asset_site(self, tmp_path, monkeypatch):
        root = tmp_path / "static"
        root.mkdir()
        (root / "index.html").write_text("<html></html>", encoding="utf-8")
        for name in ("app.js", "app.mjs", "app.css", "font.woff2", "icon.svg"):
            (root / name).write_bytes(b"x")
        monkeypatch.setenv("STATIC_DIR", str(root))
        return root

    @pytest.mark.parametrize(
        ("filename", "expected"),
        [
            ("app.js", "text/javascript"),
            ("app.mjs", "text/javascript"),
            ("app.css", "text/css"),
            ("font.woff2", "font/woff2"),
            ("icon.svg", "image/svg+xml"),
        ],
    )
    def test_asset_content_types(self, client, asset_site, filename, expected):
        response = client.get(f"/{filename}")

        assert response.status_code == 200
        assert response.headers["content-type"].split(";")[0] == expected


class TestErrorEnvelope:
    @pytest.fixture
    def failing_app(self):
        app = FastAPI()
        register_exception_handlers(app)

        @app.get("/boom")
        async def boom():
            raise RuntimeError("something broke")

        @app.get("/known")
        async def known():
            raise ApiError("insufficient_cash")

        return app

    def test_unhandled_exception_becomes_a_500_envelope(self, failing_app):
        """Never a bare framework error page (§8 internal_error)."""
        client = TestClient(failing_app, raise_server_exceptions=False)

        response = client.get("/boom")

        assert response.status_code == 500
        assert response.json()["error"]["code"] == "internal_error"

    def test_internal_error_does_not_leak_the_exception_text(self, failing_app):
        client = TestClient(failing_app, raise_server_exceptions=False)

        assert "something broke" not in client.get("/boom").text

    def test_api_error_uses_its_catalog_status_and_message(self, failing_app):
        client = TestClient(failing_app, raise_server_exceptions=False)

        response = client.get("/known")

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "insufficient_cash"
        assert response.json()["error"]["message"]

    def test_custom_message_overrides_the_catalog_default(self):
        error = ApiError("insufficient_cash", "You need $50 more.")

        assert error.message == "You need $50 more."
        assert error.status_code == 400

    def test_unknown_code_falls_back_to_400(self):
        error = ApiError("something_unmapped")

        assert error.status_code == 400
