"""HTTP surface: status codes, response shapes, and the §8 error envelope."""

import pytest


def assert_error(response, code, status):
    """Every non-2xx body must be {"error": {"code", "message"}} — one shape only."""
    assert response.status_code == status
    body = response.json()
    assert set(body) == {"error"}
    assert body["error"]["code"] == code
    assert isinstance(body["error"]["message"], str)
    assert body["error"]["message"]


class TestHealth:
    def test_reports_ok_and_chat_disabled(self, client, monkeypatch):
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("LLM_MOCK", raising=False)

        body = client.get("/api/health").json()

        assert body == {"status": "ok", "chat_enabled": False}

    def test_chat_enabled_with_api_key(self, client, monkeypatch):
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")

        assert client.get("/api/health").json()["chat_enabled"] is True

    def test_chat_enabled_in_mock_mode(self, client, monkeypatch):
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.setenv("LLM_MOCK", "true")

        assert client.get("/api/health").json()["chat_enabled"] is True

    def test_missing_chat_key_does_not_make_app_unhealthy(self, client, monkeypatch):
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

        assert client.get("/api/health").json()["status"] == "ok"


class TestPortfolioRoutes:
    def test_get_portfolio_shape(self, client):
        body = client.get("/api/portfolio").json()

        assert set(body) == {"cash_balance", "total_value", "unrealized_pnl", "positions"}
        assert body["cash_balance"] == 10000.0

    def test_buy_returns_position_and_cash(self, client, market):
        market.set_price("AAPL", 100.00)

        response = client.post(
            "/api/portfolio/trade", json={"ticker": "AAPL", "quantity": 10, "side": "buy"}
        )

        assert response.status_code == 200
        body = response.json()
        assert body["fill_price"] == 100.00
        assert body["cash_balance"] == 9000.00
        assert body["position"]["quantity"] == 10

    def test_position_appears_in_portfolio(self, client, market):
        market.set_price("AAPL", 100.00)
        client.post(
            "/api/portfolio/trade", json={"ticker": "AAPL", "quantity": 10, "side": "buy"}
        )

        positions = client.get("/api/portfolio").json()["positions"]

        assert len(positions) == 1
        assert set(positions[0]) == {
            "ticker",
            "quantity",
            "avg_cost",
            "current_price",
            "market_value",
            "unrealized_pnl",
            "change_percent",
        }

    def test_history_shape_and_ordering(self, client, market):
        market.set_price("AAPL", 100.00)
        client.post("/api/portfolio/trade", json={"ticker": "AAPL", "quantity": 1, "side": "buy"})

        snapshots = client.get("/api/portfolio/history").json()["snapshots"]

        assert len(snapshots) == 2
        assert set(snapshots[0]) == {"total_value", "recorded_at"}
        assert [s["recorded_at"] for s in snapshots] == sorted(
            s["recorded_at"] for s in snapshots
        )

    @pytest.mark.parametrize(
        ("body", "code", "status"),
        [
            ({"ticker": "12X", "quantity": 1, "side": "buy"}, "invalid_ticker", 400),
            ({"ticker": "AAPL", "quantity": 1, "side": "hold"}, "invalid_side", 400),
            ({"ticker": "AAPL", "quantity": 0, "side": "buy"}, "validation_error", 422),
            ({"ticker": "AAPL", "quantity": -1, "side": "buy"}, "validation_error", 422),
            ({"ticker": "AAPL", "quantity": 999999, "side": "buy"}, "insufficient_cash", 400),
            ({"ticker": "AAPL", "quantity": 1, "side": "sell"}, "no_position", 404),
        ],
    )
    def test_trade_errors(self, client, market, body, code, status):
        market.set_price("AAPL", 100.00)

        assert_error(client.post("/api/portfolio/trade", json=body), code, status)

    @pytest.mark.parametrize(
        "body",
        [
            {"ticker": "AAPL", "quantity": 1},
            {"ticker": "AAPL", "side": "buy"},
            {"quantity": 1, "side": "buy"},
            {"ticker": "AAPL", "quantity": "ten", "side": "buy"},
            {},
        ],
    )
    def test_malformed_body_uses_the_same_envelope(self, client, body):
        """FastAPI's own 422 must be rewritten into the §8 shape."""
        assert_error(client.post("/api/portfolio/trade", json=body), "validation_error", 422)


class TestWatchlistRoutes:
    def test_get_returns_seeded_list(self, client):
        body = client.get("/api/watchlist").json()

        assert len(body["watchlist"]) == 10
        assert set(body["watchlist"][0]) == {"ticker", "added_at", "price"}

    def test_add_returns_201_with_normalized_ticker(self, client):
        response = client.post("/api/watchlist", json={"ticker": "pypl"})

        assert response.status_code == 201
        assert response.json()["ticker"] == "PYPL"

    def test_delete_returns_204_with_no_body(self, client):
        response = client.delete("/api/watchlist/NFLX")

        assert response.status_code == 204
        assert response.content == b""

    def test_delete_is_case_insensitive(self, client):
        assert client.delete("/api/watchlist/nflx").status_code == 204

    def test_add_duplicate_conflicts(self, client):
        assert_error(client.post("/api/watchlist", json={"ticker": "AAPL"}), "duplicate_ticker", 409)

    def test_add_invalid_ticker(self, client):
        assert_error(client.post("/api/watchlist", json={"ticker": "1"}), "invalid_ticker", 400)

    def test_add_missing_field(self, client):
        assert_error(client.post("/api/watchlist", json={}), "validation_error", 422)

    def test_delete_unwatchlisted(self, client):
        assert_error(client.delete("/api/watchlist/PYPL"), "not_watchlisted", 404)

    def test_removed_ticker_disappears_from_list(self, client):
        client.delete("/api/watchlist/NFLX")

        tickers = [e["ticker"] for e in client.get("/api/watchlist").json()["watchlist"]]

        assert "NFLX" not in tickers
        assert len(tickers) == 9


class TestRoutePrecedence:
    @pytest.mark.parametrize(
        "path", ["/api/nope", "/api/portfolio/nope", "/api/", "/api/watchlist/AAPL/extra"]
    )
    def test_unmatched_api_paths_return_the_json_envelope(self, client, path):
        """§11: an unrouted /api path must never fall through to index.html."""
        response = client.get(path)

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"

    def test_non_api_path_does_not_produce_an_api_error_code(self, client):
        """Without a static export present this 404s, but as the SPA branch —
        it must not be reported as a missing API route."""
        response = client.get("/dashboard")

        assert "No API route matches" not in response.text
