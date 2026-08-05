"""The LLM_MOCK fixture table (PLAN.md §9 "LLM Mock Mode", §12).

These tests pin the trigger phrases the E2E suite relies on. If a trigger is
renamed here, the Playwright scenarios that type it must change too.
"""

import pytest

from app.llm.mock import (
    DEFAULT_FIXTURE,
    MOCK_FIXTURES,
    MOCK_TRIGGER_PHRASES,
    match_fixture,
    mock_completion,
)
from app.llm.schemas import ChatProposal


class TestFixtureMatching:
    @pytest.mark.parametrize(
        "message,expected_trigger",
        [
            ("buy 10 aapl", "buy 10 aapl"),
            ("Please buy 10 AAPL for me", "buy 10 aapl"),
            ("BUY 10 AAPL", "buy 10 aapl"),
            ("  buy   10   aapl  ", "buy 10 aapl"),
            ("sell 5 aapl now", "sell 5 aapl"),
            ("add pypl to my list", "add pypl"),
            ("remove nflx please", "remove nflx"),
            ("rebalance my portfolio", "rebalance my portfolio"),
            ("mixed batch", "mixed batch"),
            ("fractional", "fractional"),
        ],
    )
    def test_trigger_is_matched_case_and_whitespace_insensitively(
        self, message, expected_trigger
    ):
        assert match_fixture(message).trigger == expected_trigger

    def test_unmatched_message_falls_back_to_default(self):
        fixture = match_fixture("what do you think of the market today?")
        assert fixture is DEFAULT_FIXTURE
        assert fixture.proposal.trades == []
        assert fixture.proposal.watchlist_changes == []

    def test_more_specific_trigger_wins_over_shorter_one(self):
        """"buy 1000000 aapl" must not be captured by the "buy 10 aapl" fixture."""
        assert match_fixture("buy 1000000 aapl").trigger == "buy 1000000 aapl"
        assert match_fixture("buy 1000000 aapl").proposal.trades[0].quantity == 1000000

    def test_near_miss_trigger_falls_through_and_is_warned_about(self, caplog):
        """The real near-miss that nearly shipped a silently-passing E2E test.

        "buy 100000 aapl" matches neither "buy 1000000 aapl" nor "buy 10 aapl"
        (after "buy 10" come "0000 aapl", not " aapl"), so it falls through to
        the no-action default. We can't guess the intent, but the fallback must
        not be silent.
        """
        with caplog.at_level("WARNING"):
            fixture = match_fixture("buy 100000 aapl")

        assert fixture is DEFAULT_FIXTURE
        assert fixture.proposal.trades == []
        assert "matched no fixture" in caplog.text
        assert "buy 1000000 aapl" in caplog.text, "the warning must list real triggers"

    def test_ordinary_message_does_not_warn(self, caplog):
        with caplog.at_level("WARNING"):
            match_fixture("how is my portfolio doing today?")

        assert caplog.text == ""

    def test_exact_triggers_never_warn(self, caplog):
        with caplog.at_level("WARNING"):
            for trigger in MOCK_TRIGGER_PHRASES:
                match_fixture(trigger)

        assert caplog.text == ""

    def test_failure_fixtures_precede_happy_path_in_table_order(self):
        """Order is contractual: first match wins, so supersets must come first."""
        triggers = list(MOCK_TRIGGER_PHRASES)
        assert triggers.index("buy 1000000 aapl") < triggers.index("buy 10 aapl")
        assert triggers.index("sell 9999 tsla") < triggers.index("sell 5 aapl")


class TestMockCompletion:
    def test_returns_parseable_proposal_for_every_non_malformed_fixture(self):
        for fixture in MOCK_FIXTURES:
            if fixture.proposal is None:
                continue
            raw = mock_completion(fixture.trigger)
            parsed = ChatProposal.model_validate_json(raw)
            assert parsed.message

    def test_malformed_fixture_emits_unparseable_json(self):
        """Exercises §9's malformed-output path with a real parse failure."""
        raw = mock_completion("break the parser")
        with pytest.raises(ValueError):
            ChatProposal.model_validate_json(raw)

    def test_buy_fixture_proposes_the_expected_trade(self):
        parsed = ChatProposal.model_validate_json(mock_completion("buy 10 aapl"))
        assert len(parsed.trades) == 1
        assert parsed.trades[0].ticker == "AAPL"
        assert parsed.trades[0].side.value == "buy"
        assert parsed.trades[0].quantity == 10

    def test_watchlist_fixtures_propose_no_trades(self):
        parsed = ChatProposal.model_validate_json(mock_completion("add pypl"))
        assert parsed.trades == []
        assert parsed.watchlist_changes[0].ticker == "PYPL"
        assert parsed.watchlist_changes[0].action.value == "add"

    def test_rebalance_fixture_has_both_trades_and_watchlist_changes(self):
        """Needed to prove §9 step 7's ordering: trades first, then watchlist."""
        parsed = ChatProposal.model_validate_json(mock_completion("rebalance my portfolio"))
        assert [t.ticker for t in parsed.trades] == ["AAPL", "NVDA"]
        assert [w.ticker for w in parsed.watchlist_changes] == ["PYPL"]

    def test_mixed_batch_has_a_failing_trade_between_two_valid_ones(self):
        """Proves a mid-batch failure does not abort the rest (§7)."""
        parsed = ChatProposal.model_validate_json(mock_completion("mixed batch"))
        assert [t.ticker for t in parsed.trades] == ["AAPL", "GOOGL", "MSFT"]
        assert parsed.trades[1].quantity == 999999, "middle trade must be unaffordable"

    def test_determinism(self):
        """Same input, same output — the whole point of the fixture table."""
        assert mock_completion("buy 10 aapl") == mock_completion("buy 10 aapl")
        assert mock_completion("anything else") == mock_completion("unrelated text")
