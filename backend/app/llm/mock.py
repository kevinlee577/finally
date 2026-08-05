"""Deterministic mock LLM responses for `LLM_MOCK=true` (PLAN.md §9, §12).

The fixture table maps a lowercase trigger substring in the user's message to a
canned `ChatProposal`. Backend unit tests and the Playwright E2E suite both
import from here so "AI chat (mocked)" scenarios are reproducible rather than
freeform.

Matching rules — deliberately simple and documented so tests can rely on them:

* The incoming message is lowercased and whitespace-collapsed before matching.
* Fixtures are tried **in table order** and the *first* trigger found as a
  substring wins. Order therefore matters: more specific triggers are listed
  before more general ones (e.g. "buy 1000000 aapl" before "buy 10 aapl").
* If nothing matches, `DEFAULT_FIXTURE` is returned — a portfolio-analysis reply
  with no actions.

Note that the mock deliberately includes fixtures that produce *failing*
actions and one that produces malformed output, because the §9 failure paths
(per-action `status: "failed"`, and the generic malformed-output fallback) need
to be exercised end to end just as much as the happy path.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from .schemas import ChatProposal, ProposedTrade, ProposedWatchlistChange

logger = logging.getLogger(__name__)

# Sentinel: this fixture makes the "LLM" emit unparseable output, exercising the
# §9 "Malformed LLM Output" path (no actions executed, generic error message).
MALFORMED_OUTPUT = "__malformed__"


@dataclass(frozen=True)
class MockFixture:
    """One canned response. `proposal` is None only for the malformed fixture."""

    trigger: str
    description: str
    proposal: ChatProposal | None


MOCK_FIXTURES: tuple[MockFixture, ...] = (
    # --- Failure-path fixtures first: their triggers are supersets of the
    # happy-path ones, so they must be matched before the shorter triggers. ---
    MockFixture(
        trigger="buy 1000000 aapl",
        description="Buy far beyond the $10k cash balance -> insufficient_cash failure",
        proposal=ChatProposal(
            message="Buying 1000000 shares of AAPL for you now.",
            trades=[ProposedTrade(ticker="AAPL", side="buy", quantity=1000000)],
        ),
    ),
    MockFixture(
        trigger="sell 9999 tsla",
        description="Sell more than held -> insufficient_shares / no_position failure",
        proposal=ChatProposal(
            message="Selling 9999 shares of TSLA.",
            trades=[ProposedTrade(ticker="TSLA", side="sell", quantity=9999)],
        ),
    ),
    MockFixture(
        trigger="break the parser",
        description="Emits invalid structured output -> generic fallback message, no actions",
        proposal=None,
    ),
    # --- Happy-path single-action fixtures ---
    MockFixture(
        trigger="buy 10 aapl",
        description="Single buy of 10 AAPL",
        proposal=ChatProposal(
            message="On it — buying 10 shares of AAPL.",
            trades=[ProposedTrade(ticker="AAPL", side="buy", quantity=10)],
        ),
    ),
    MockFixture(
        trigger="buy 5 msft",
        description="Single buy of 5 MSFT",
        proposal=ChatProposal(
            message="Buying 5 shares of MSFT for you.",
            trades=[ProposedTrade(ticker="MSFT", side="buy", quantity=5)],
        ),
    ),
    MockFixture(
        trigger="sell 5 aapl",
        description="Single sell of 5 AAPL",
        proposal=ChatProposal(
            message="Selling 5 shares of AAPL.",
            trades=[ProposedTrade(ticker="AAPL", side="sell", quantity=5)],
        ),
    ),
    MockFixture(
        trigger="add pypl",
        description="Single watchlist add of PYPL",
        proposal=ChatProposal(
            message="Added PYPL to your watchlist.",
            watchlist_changes=[ProposedWatchlistChange(ticker="PYPL", action="add")],
        ),
    ),
    MockFixture(
        trigger="remove nflx",
        description="Single watchlist remove of NFLX",
        proposal=ChatProposal(
            message="Removed NFLX from your watchlist.",
            watchlist_changes=[ProposedWatchlistChange(ticker="NFLX", action="remove")],
        ),
    ),
    # --- Multi-action fixtures: exercise ordering + independent failure ---
    MockFixture(
        trigger="rebalance my portfolio",
        description=(
            "Two trades then one watchlist add — verifies trades execute before "
            "watchlist changes, each in array order (§9 step 7)"
        ),
        proposal=ChatProposal(
            message=(
                "Rebalancing — buying 2 AAPL and 1 NVDA, and adding PYPL to your watchlist."
            ),
            trades=[
                ProposedTrade(ticker="AAPL", side="buy", quantity=2),
                ProposedTrade(ticker="NVDA", side="buy", quantity=1),
            ],
            watchlist_changes=[ProposedWatchlistChange(ticker="PYPL", action="add")],
        ),
    ),
    MockFixture(
        trigger="mixed batch",
        description=(
            "A valid buy, then an over-budget buy that fails, then another valid "
            "buy — proves a failure does not abort the rest of the batch (§7)"
        ),
        proposal=ChatProposal(
            message="Buying 1 AAPL, 999999 GOOGL, and 1 MSFT.",
            trades=[
                ProposedTrade(ticker="AAPL", side="buy", quantity=1),
                ProposedTrade(ticker="GOOGL", side="buy", quantity=999999),
                ProposedTrade(ticker="MSFT", side="buy", quantity=1),
            ],
        ),
    ),
    MockFixture(
        trigger="fractional",
        description="Fractional-share buy — quantity precision path (§7)",
        proposal=ChatProposal(
            message="Buying 0.5 shares of AAPL.",
            trades=[ProposedTrade(ticker="AAPL", side="buy", quantity=0.5)],
        ),
    ),
)

DEFAULT_FIXTURE = MockFixture(
    trigger="",
    description="Fallback: conversational analysis reply with no actions",
    proposal=ChatProposal(
        message=(
            "Your portfolio is currently concentrated in cash. I'd suggest "
            "diversifying across a few of the tickers on your watchlist. Ask me to "
            "buy or sell anything and I'll execute it for you."
        ),
    ),
)

# Convenience export for the integration-tester / E2E suite.
MOCK_TRIGGER_PHRASES: tuple[str, ...] = tuple(f.trigger for f in MOCK_FIXTURES)

_WHITESPACE_RE = re.compile(r"\s+")

# Words that suggest the author *meant* to trigger an action fixture. Used only
# to warn about near-misses (see `match_fixture`), never to match.
_ACTION_WORDS = ("buy", "sell", "add", "remove")


def _normalize(message: str) -> str:
    return _WHITESPACE_RE.sub(" ", message.strip().lower())


def match_fixture(message: str) -> MockFixture:
    """Return the first fixture whose trigger appears in `message`, else the default.

    Substring matching makes exact trigger text load-bearing in a way that fails
    *silently*: a near-miss like "buy 100000 aapl" matches neither
    "buy 1000000 aapl" nor "buy 10 aapl" (the characters after "buy 10" are
    "0000 aapl", not " aapl"), so it quietly falls through to the default fixture
    and executes nothing. A test written against it would assert on a no-op turn
    and pass for the wrong reason.

    We can't disambiguate intent, but we can refuse to be quiet about it: an
    unmatched message that still looks like an action request is logged at
    WARNING with the available triggers, so the near-miss shows up in the test
    container's logs instead of vanishing.
    """
    normalized = _normalize(message)
    for fixture in MOCK_FIXTURES:
        if fixture.trigger in normalized:
            return fixture

    if any(word in normalized for word in _ACTION_WORDS):
        logger.warning(
            "LLM_MOCK: message %r looks like an action request but matched no "
            "fixture — falling back to the no-action default. Available triggers: %s",
            message,
            ", ".join(MOCK_TRIGGER_PHRASES),
        )

    return DEFAULT_FIXTURE


def mock_completion(message: str) -> str:
    """Return the raw JSON string a mocked LLM would emit for `message`.

    Returns deliberately-invalid JSON for the malformed fixture so the caller
    exercises the same parse-failure path it would with a real bad response.
    """
    fixture = match_fixture(message)
    if fixture.proposal is None:
        return "{ this is not valid json at all "
    return fixture.proposal.model_dump_json()
