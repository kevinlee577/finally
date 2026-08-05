"""The chat turn orchestration (PLAN.md §9 "How It Works", steps 1-10).

Runs against a real seeded temp database and the FakeMarketSource, with only the
LLM itself stubbed — so trade execution, watchlist changes and chat_messages
persistence are all exercised for real.
"""

import json

import pytest

from app.db import read_connection
from app.errors import ApiError
from app.llm import history, service
from app.llm.client import FALLBACK_MESSAGE
from app.llm.schemas import ChatProposal, ProposedTrade, ProposedWatchlistChange


@pytest.fixture
def stub_llm(monkeypatch):
    """Replace the LLM call with a canned proposal (or None for a failure)."""

    def _install(proposal):
        async def _fake(messages, user_message):
            _install.messages = messages
            return proposal

        _install.messages = None
        monkeypatch.setattr(service, "complete_chat", _fake)
        return _install

    return _install


def _cash(user_id="default"):
    with read_connection() as conn:
        return conn.execute(
            "SELECT cash_balance FROM users_profile WHERE id = ?", (user_id,)
        ).fetchone()["cash_balance"]


def _chat_rows(user_id="default"):
    with read_connection() as conn:
        return conn.execute(
            "SELECT role, content, actions FROM chat_messages"
            " WHERE user_id = ? ORDER BY created_at ASC, rowid ASC",
            (user_id,),
        ).fetchall()


class TestHappyPath:
    async def test_executes_trade_and_returns_envelope(self, market):
        proposal = ChatProposal(
            message="Buying 10 AAPL.",
            trades=[ProposedTrade(ticker="AAPL", side="buy", quantity=10)],
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(proposal))
            response = await service.run_chat_turn("buy 10 aapl")

        assert response.message == "Buying 10 AAPL."
        assert len(response.actions) == 1

        action = response.actions[0].to_dict()
        assert action["type"] == "trade"
        assert action["ticker"] == "AAPL"
        assert action["side"] == "buy"
        assert action["status"] == "executed"
        assert action["fill_price"] == 100.0, "FakeMarketSource seeds every ticker at 100"
        assert _cash() == pytest.approx(10000.0 - 1000.0)

    async def test_executes_watchlist_add(self, market):
        proposal = ChatProposal(
            message="Added PYPL.",
            watchlist_changes=[ProposedWatchlistChange(ticker="PYPL", action="add")],
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(proposal))
            response = await service.run_chat_turn("add pypl")

        assert response.actions[0].to_dict() == {
            "type": "watchlist_add", "ticker": "PYPL", "status": "executed",
        }

    async def test_normalizes_lowercase_ticker_from_the_model(self, market):
        """The service normalizes; the envelope reports the stored symbol."""
        proposal = ChatProposal(
            message="ok", trades=[ProposedTrade(ticker="aapl", side="buy", quantity=1)]
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(proposal))
            response = await service.run_chat_turn("buy aapl")

        assert response.actions[0].ticker == "AAPL"

    async def test_no_actions_when_model_proposes_none(self, market):
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(ChatProposal(message="Just analysis.")))
            response = await service.run_chat_turn("how am I doing?")

        assert response.actions == []
        assert response.message == "Just analysis."


class TestExecutionOrderingAndFailures:
    async def test_trades_execute_before_watchlist_changes(self, market):
        """§9 step 7 fixes the order: all trades first, then all watchlist changes."""
        proposal = ChatProposal(
            message="Rebalancing.",
            trades=[
                ProposedTrade(ticker="AAPL", side="buy", quantity=1),
                ProposedTrade(ticker="NVDA", side="buy", quantity=1),
            ],
            watchlist_changes=[ProposedWatchlistChange(ticker="PYPL", action="add")],
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(proposal))
            response = await service.run_chat_turn("rebalance my portfolio")

        assert [a.type for a in response.actions] == ["trade", "trade", "watchlist_add"]
        assert [a.ticker for a in response.actions] == ["AAPL", "NVDA", "PYPL"]

    async def test_failed_trade_does_not_abort_the_rest_of_the_batch(self, market):
        """§7: every trade is attempted; each independently executed or failed."""
        proposal = ChatProposal(
            message="Buying three things.",
            trades=[
                ProposedTrade(ticker="AAPL", side="buy", quantity=1),
                ProposedTrade(ticker="GOOGL", side="buy", quantity=999999),  # unaffordable
                ProposedTrade(ticker="MSFT", side="buy", quantity=1),
            ],
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(proposal))
            response = await service.run_chat_turn("mixed batch")

        statuses = [a.status for a in response.actions]
        assert statuses == ["executed", "failed", "executed"], (
            "a mid-batch failure must not skip or block later trades"
        )
        assert response.actions[1].error
        assert response.actions[1].fill_price is None
        # The two successful buys committed independently of the failure.
        assert _cash() == pytest.approx(10000.0 - 200.0)

    async def test_failed_watchlist_change_does_not_block_later_ones(self, market):
        proposal = ChatProposal(
            message="Watchlist edits.",
            watchlist_changes=[
                ProposedWatchlistChange(ticker="AAPL", action="add"),  # already seeded -> dup
                ProposedWatchlistChange(ticker="PYPL", action="add"),
            ],
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(proposal))
            response = await service.run_chat_turn("add stuff")

        assert [a.status for a in response.actions] == ["failed", "executed"]
        assert [a.type for a in response.actions] == ["watchlist_add", "watchlist_add"]

    async def test_sell_without_position_is_reported_as_failed_action(self, market):
        proposal = ChatProposal(
            message="Selling TSLA.",
            trades=[ProposedTrade(ticker="TSLA", side="sell", quantity=9999)],
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(proposal))
            response = await service.run_chat_turn("sell 9999 tsla")

        assert response.actions[0].status == "failed"
        assert response.actions[0].error

    async def test_unexpected_service_error_becomes_a_failed_action_not_a_raise(
        self, market, monkeypatch
    ):
        """A non-ApiError must still yield a 200 turn with a failed action."""
        import app.services.portfolio as portfolio_service

        async def _boom(**kwargs):
            raise RuntimeError("database on fire")

        monkeypatch.setattr(portfolio_service, "execute_trade", _boom)
        proposal = ChatProposal(
            message="ok", trades=[ProposedTrade(ticker="AAPL", side="buy", quantity=1)]
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(proposal))
            response = await service.run_chat_turn("buy 10 aapl")

        assert response.actions[0].status == "failed"
        assert response.actions[0].error == "Trade could not be executed."

    async def test_api_error_message_is_surfaced_verbatim(self, market, monkeypatch):
        import app.services.portfolio as portfolio_service

        async def _reject(**kwargs):
            raise ApiError("insufficient_cash", "You need $500 more.")

        monkeypatch.setattr(portfolio_service, "execute_trade", _reject)
        proposal = ChatProposal(
            message="ok", trades=[ProposedTrade(ticker="AAPL", side="buy", quantity=1)]
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(proposal))
            response = await service.run_chat_turn("buy")

        assert response.actions[0].error == "You need $500 more."


class TestMalformedOutput:
    async def test_returns_generic_fallback_and_executes_nothing(self, market):
        """§9 step 6: parse failure -> generic reply, no actions, still a 200 turn."""
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(None))
            response = await service.run_chat_turn("break the parser")

        assert response.message == FALLBACK_MESSAGE
        assert response.actions == []
        assert _cash() == 10000.0, "no trade may execute on a malformed response"

    async def test_persists_assistant_turn_with_null_actions(self, market):
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(None))
            await service.run_chat_turn("break the parser")

        rows = _chat_rows()
        assert [r["role"] for r in rows] == ["user", "assistant"]
        assert rows[1]["actions"] is None


class TestPersistence:
    async def test_user_message_persisted_before_llm_call(self, market, monkeypatch):
        """§9 step 1: the user's message survives even a total LLM failure."""

        async def _explode(messages, user_message):
            # Assert the row already exists at the moment the LLM is invoked.
            assert [r["role"] for r in _chat_rows()] == ["user"]
            return None

        monkeypatch.setattr(service, "complete_chat", _explode)
        await service.run_chat_turn("hello there")

        rows = _chat_rows()
        assert rows[0]["role"] == "user"
        assert rows[0]["content"] == "hello there"
        assert rows[0]["actions"] is None

    async def test_assistant_turn_persists_executed_outcome_envelope(self, market):
        """§9 step 9 / §7: chat_messages.actions holds real outcomes, not proposals."""
        proposal = ChatProposal(
            message="Buying 10 AAPL.",
            trades=[ProposedTrade(ticker="AAPL", side="buy", quantity=10)],
        )
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(service, "complete_chat", _const(proposal))
            await service.run_chat_turn("buy 10 aapl")

        rows = _chat_rows()
        assert [r["role"] for r in rows] == ["user", "assistant"]

        stored = json.loads(rows[1]["actions"])
        assert stored[0]["status"] == "executed"
        assert stored[0]["fill_price"] == 100.0

    async def test_history_excludes_current_turn_and_is_oldest_first(self, market, stub_llm):
        """§9 step 3: history omits the just-inserted user row, oldest-first."""
        installed = stub_llm(ChatProposal(message="first reply"))
        await service.run_chat_turn("first question")

        installed = stub_llm(ChatProposal(message="second reply"))
        await service.run_chat_turn("second question")

        contents = [m["content"] for m in installed.messages]
        # System prompt + context, then history, then the live user message.
        assert contents[-1] == "second question"
        assert "first question" in contents
        assert "second question" not in contents[:-1], (
            "the current turn's user row must not also appear as history"
        )
        assert contents.index("first question") < len(contents) - 1

    async def test_prior_actions_are_serialized_into_history(self, market, stub_llm):
        """§9 step 3: the model sees real outcomes of its own prior proposals."""
        stub_llm(
            ChatProposal(
                message="Buying 10 AAPL.",
                trades=[ProposedTrade(ticker="AAPL", side="buy", quantity=10)],
            )
        )
        await service.run_chat_turn("buy 10 aapl")

        installed = stub_llm(ChatProposal(message="ok"))
        await service.run_chat_turn("how did that go?")

        assistant_entries = [
            m["content"] for m in installed.messages if "Executed action results" in m["content"]
        ]
        assert assistant_entries, "prior assistant turn must carry its actions into history"
        assert "executed" in assistant_entries[0]
        assert "fill_price" in assistant_entries[0]

    async def test_history_is_capped(self, market, stub_llm):
        installed = stub_llm(ChatProposal(message="ok"))
        for i in range(15):
            installed = stub_llm(ChatProposal(message=f"reply {i}"))
            await service.run_chat_turn(f"question {i}")

        history_entries = [
            m for m in installed.messages if m["role"] in ("user", "assistant")
        ]
        # HISTORY_LIMIT past messages + the current user message.
        assert len(history_entries) <= history.HISTORY_LIMIT + 1


def _const(value):
    """Build a stub `complete_chat` that always returns `value`."""

    async def _fake(messages, user_message):
        return value

    return _fake
