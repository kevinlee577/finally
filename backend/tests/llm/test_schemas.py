"""Structured-output parsing: valid schemas and malformed responses (PLAN.md §9, §12)."""

import pytest
from pydantic import ValidationError

from app.llm.schemas import ActionResult, ChatProposal, ChatResponse


class TestChatProposalParsing:
    def test_parses_full_schema_from_plan(self):
        """The exact example from PLAN.md §9 "Structured Output Schema"."""
        raw = """
        {
          "message": "Your conversational response to the user",
          "trades": [{"ticker": "AAPL", "side": "buy", "quantity": 10}],
          "watchlist_changes": [{"ticker": "PYPL", "action": "add"}]
        }
        """
        proposal = ChatProposal.model_validate_json(raw)

        assert proposal.message == "Your conversational response to the user"
        assert len(proposal.trades) == 1
        assert proposal.trades[0].ticker == "AAPL"
        assert proposal.trades[0].side.value == "buy"
        assert proposal.trades[0].quantity == 10
        assert proposal.watchlist_changes[0].action.value == "add"

    def test_trades_and_watchlist_changes_are_optional(self):
        """§9 marks both arrays optional; they default to empty, never None."""
        proposal = ChatProposal.model_validate_json('{"message": "Just chatting."}')

        assert proposal.trades == []
        assert proposal.watchlist_changes == []

    def test_accepts_fractional_quantity(self):
        proposal = ChatProposal.model_validate_json(
            '{"message": "ok", "trades": [{"ticker": "AAPL", "side": "buy", "quantity": 0.5}]}'
        )
        assert proposal.trades[0].quantity == 0.5

    def test_accepts_sell_and_remove(self):
        proposal = ChatProposal.model_validate_json(
            '{"message": "ok",'
            ' "trades": [{"ticker": "TSLA", "side": "sell", "quantity": 3}],'
            ' "watchlist_changes": [{"ticker": "NFLX", "action": "remove"}]}'
        )
        assert proposal.trades[0].side.value == "sell"
        assert proposal.watchlist_changes[0].action.value == "remove"

    @pytest.mark.parametrize(
        "raw,reason",
        [
            ("{ not json at all", "unparseable text"),
            ("", "empty body"),
            ('{"trades": []}', "missing required message field"),
            ('{"message": "x", "trades": [{"ticker": "AAPL", "side": "hodl", "quantity": 1}]}',
             "invalid side enum"),
            ('{"message": "x", "watchlist_changes": [{"ticker": "AAPL", "action": "star"}]}',
             "invalid watchlist action enum"),
            ('{"message": "x", "trades": [{"ticker": "AAPL", "side": "buy"}]}',
             "trade missing quantity"),
            ('{"message": "x", "trades": [{"ticker": "AAPL", "side": "buy", "quantity": "ten"}]}',
             "non-numeric quantity"),
        ],
    )
    def test_malformed_output_raises(self, raw, reason):
        """Every one of these must fail parsing so §9's fallback path engages."""
        with pytest.raises((ValidationError, ValueError)):
            ChatProposal.model_validate_json(raw)


class TestResponseEnvelope:
    def test_executed_trade_action_shape(self):
        """§9's envelope: executed trades carry fill_price and no error key."""
        action = ActionResult(
            type="trade", ticker="AAPL", side="buy", quantity=10,
            status="executed", fill_price=191.20,
        )
        assert action.to_dict() == {
            "type": "trade", "ticker": "AAPL", "side": "buy",
            "quantity": 10.0, "status": "executed", "fill_price": 191.20,
        }

    def test_failed_trade_action_shape(self):
        action = ActionResult(
            type="trade", ticker="TSLA", side="buy", quantity=5,
            status="failed", error="insufficient cash",
        )
        result = action.to_dict()
        assert result["status"] == "failed"
        assert result["error"] == "insufficient cash"
        assert "fill_price" not in result, "failed trades must not report a fill price"

    def test_watchlist_action_omits_trade_only_fields(self):
        action = ActionResult(type="watchlist_add", ticker="PYPL", status="executed")
        assert action.to_dict() == {
            "type": "watchlist_add", "ticker": "PYPL", "status": "executed",
        }

    def test_full_envelope_matches_plan_example(self):
        """Reproduces the §9 "Response Envelope" example verbatim."""
        response = ChatResponse(
            message="On it — buying 10 AAPL, buying 5 TSLA, and adding PYPL to your watchlist.",
            actions=[
                ActionResult(type="trade", ticker="AAPL", side="buy", quantity=10,
                             status="executed", fill_price=191.20),
                ActionResult(type="trade", ticker="TSLA", side="buy", quantity=5,
                             status="failed", error="insufficient cash"),
                ActionResult(type="watchlist_add", ticker="PYPL", status="executed"),
            ],
        )
        payload = response.to_dict()

        assert set(payload) == {"message", "actions"}
        assert [a["status"] for a in payload["actions"]] == ["executed", "failed", "executed"]
        assert payload["actions"][2] == {
            "type": "watchlist_add", "ticker": "PYPL", "status": "executed",
        }

    def test_envelope_with_no_actions(self):
        assert ChatResponse(message="Hello.").to_dict() == {"message": "Hello.", "actions": []}
