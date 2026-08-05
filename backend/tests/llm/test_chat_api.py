"""POST /api/chat endpoint behavior (PLAN.md §5, §8, §9).

`chat_unavailable` (503) is the *only* chat failure that is an HTTP error;
everything downstream degrades in-band as a normal 200 turn.
"""

import pytest


@pytest.fixture
def mock_chat(monkeypatch):
    """Enable LLM_MOCK so the endpoint serves the deterministic fixture table."""
    monkeypatch.setenv("LLM_MOCK", "true")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)


@pytest.fixture
def chat_disabled(monkeypatch):
    monkeypatch.delenv("LLM_MOCK", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)


class TestChatUnavailable:
    def test_returns_503_in_the_error_envelope(self, client, chat_disabled):
        response = client.post("/api/chat", json={"message": "hello"})

        assert response.status_code == 503
        assert response.json() == {
            "error": {
                "code": "chat_unavailable",
                "message": (
                    "AI chat is not configured — set OPENROUTER_API_KEY to enable it."
                ),
            }
        }

    def test_health_reports_chat_disabled(self, client, chat_disabled):
        assert client.get("/api/health").json()["chat_enabled"] is False

    def test_health_reports_chat_enabled_under_mock(self, client, mock_chat):
        body = client.get("/api/health").json()
        assert body["chat_enabled"] is True
        assert body["status"] == "ok"


class TestChatRequestValidation:
    def test_missing_message_field_is_validation_error(self, client, mock_chat):
        response = client.post("/api/chat", json={})

        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"

    def test_empty_message_is_validation_error(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": ""})

        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"

    def test_wrong_typed_message_is_validation_error(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": 42})

        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"


class TestMockedChatTurns:
    def test_plain_message_returns_envelope_with_no_actions(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": "how am I doing?"})

        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"message", "actions"}
        assert body["actions"] == []
        assert body["message"]

    def test_buy_trigger_executes_a_trade(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": "buy 10 aapl"})

        assert response.status_code == 200
        actions = response.json()["actions"]
        assert len(actions) == 1
        assert actions[0]["type"] == "trade"
        assert actions[0]["ticker"] == "AAPL"
        assert actions[0]["side"] == "buy"
        assert actions[0]["quantity"] == 10
        assert actions[0]["status"] == "executed"
        assert "fill_price" in actions[0]

        portfolio = client.get("/api/portfolio").json()
        assert portfolio["cash_balance"] < 10000.0
        assert any(p["ticker"] == "AAPL" for p in portfolio["positions"])

    def test_unaffordable_buy_trigger_reports_failed_action_with_200(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": "buy 1000000 aapl"})

        assert response.status_code == 200, "a failed trade is not an HTTP error"
        action = response.json()["actions"][0]
        assert action["status"] == "failed"
        assert action["error"]
        assert "fill_price" not in action
        assert client.get("/api/portfolio").json()["cash_balance"] == 10000.0

    def test_watchlist_add_trigger(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": "add pypl"})

        assert response.json()["actions"][0] == {
            "type": "watchlist_add", "ticker": "PYPL", "status": "executed",
        }
        tickers = [w["ticker"] for w in client.get("/api/watchlist").json()["watchlist"]]
        assert "PYPL" in tickers

    def test_watchlist_remove_trigger(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": "remove nflx"})

        assert response.json()["actions"][0] == {
            "type": "watchlist_remove", "ticker": "NFLX", "status": "executed",
        }
        tickers = [w["ticker"] for w in client.get("/api/watchlist").json()["watchlist"]]
        assert "NFLX" not in tickers

    def test_malformed_trigger_returns_generic_message_and_no_actions(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": "break the parser"})

        assert response.status_code == 200, "malformed model output is not an HTTP error"
        body = response.json()
        assert body["actions"] == []
        assert "trouble" in body["message"].lower()

    def test_mixed_batch_reports_per_action_outcomes(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": "mixed batch"})

        statuses = [a["status"] for a in response.json()["actions"]]
        assert statuses == ["executed", "failed", "executed"]

    def test_rebalance_orders_trades_before_watchlist_changes(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": "rebalance my portfolio"})

        types = [a["type"] for a in response.json()["actions"]]
        assert types == ["trade", "trade", "watchlist_add"]

    def test_fractional_quantity_trade(self, client, mock_chat):
        response = client.post("/api/chat", json={"message": "fractional"})

        action = response.json()["actions"][0]
        assert action["status"] == "executed"
        assert action["quantity"] == 0.5
