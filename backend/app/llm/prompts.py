"""System prompt and prompt assembly for the chat turn (PLAN.md §9).

`build_messages` produces the exact message list handed to LiteLLM: a system
message, a portfolio-context message, the recent conversation history (with each
past assistant turn's executed `actions` folded in), and the user's new message.
"""

from __future__ import annotations

import json

SYSTEM_PROMPT = """You are FinAlly, an AI trading assistant embedded in a simulated \
trading workstation. The user trades a virtual portfolio that starts at $10,000 in cash. \
There are no fees, all orders are market orders that fill instantly, and fractional \
shares are supported.

Your job:
- Analyze portfolio composition, risk concentration, and P&L.
- Suggest trades with clear, data-driven reasoning.
- Execute trades when the user asks for them or agrees to your suggestion.
- Manage the watchlist proactively — add tickers you are discussing, remove ones \
that are no longer relevant.
- Be concise. Prefer specific numbers from the portfolio context over vague commentary.

Rules:
- Always respond with valid JSON matching the required schema.
- `message` is your conversational reply to the user. Keep it short and specific.
- Put a trade in `trades` ONLY when you actually intend to execute it right now. \
If you are merely suggesting an idea and waiting for the user to agree, leave \
`trades` empty and ask in `message`.
- `quantity` must be a positive number. `side` is "buy" or "sell". `action` is \
"add" or "remove".
- Use plain ticker symbols in upper case, e.g. "AAPL".
- Trades you propose are executed automatically after you reply, and each one is \
validated independently — a trade can still fail (for example, insufficient cash). \
You will not know the outcome until the next turn, so do not claim in `message` \
that a trade has definitely succeeded."""


def format_portfolio_context(
    cash_balance: float,
    total_value: float,
    unrealized_pnl: float,
    positions: list[dict],
    watchlist: list[dict],
) -> str:
    """Render the user's live portfolio state as a compact context block.

    `positions` entries follow the §8 `GET /api/portfolio` shape; `watchlist`
    entries follow the §8 `GET /api/watchlist` shape.
    """
    lines = [
        "CURRENT PORTFOLIO STATE",
        f"Cash balance: ${cash_balance:,.2f}",
        f"Total portfolio value: ${total_value:,.2f}",
        f"Aggregate unrealized P&L: ${unrealized_pnl:,.2f}",
        "",
    ]

    if positions:
        lines.append("POSITIONS (ticker, qty, avg cost, current price, unrealized P&L, % chg):")
        for p in positions:
            price = p.get("current_price")
            price_str = f"${price:,.2f}" if price is not None else "n/a"
            lines.append(
                f"  {p['ticker']}: {p['quantity']:g} @ ${p['avg_cost']:,.2f} avg, "
                f"now {price_str}, P&L ${p.get('unrealized_pnl', 0.0):,.2f} "
                f"({p.get('change_percent', 0.0):+.2f}%)"
            )
    else:
        lines.append("POSITIONS: none — the portfolio is entirely in cash.")

    lines.append("")
    if watchlist:
        lines.append("WATCHLIST (ticker, latest price):")
        for w in watchlist:
            price = w.get("price")
            price_str = f"${price:,.2f}" if price is not None else "no quote yet"
            lines.append(f"  {w['ticker']}: {price_str}")
    else:
        lines.append("WATCHLIST: empty.")

    return "\n".join(lines)


def format_history_entry(role: str, content: str, actions: list | None) -> dict:
    """Turn one persisted `chat_messages` row into a LiteLLM message.

    Per §9 step 3, an assistant turn's executed `actions` are serialized into the
    history entry so the model can see the real outcomes of its own prior
    proposals — including failures it narrated as successes.
    """
    if role == "assistant" and actions:
        content = f"{content}\n\n[Executed action results: {json.dumps(actions)}]"
    return {"role": role, "content": content}


def build_messages(
    portfolio_context: str,
    history: list[dict],
    user_message: str,
) -> list[dict]:
    """Assemble the full message list for the LLM call (§9 step 4).

    `history` is already-formatted messages, oldest-first, excluding the user
    message just persisted for this turn.
    """
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "system", "content": portfolio_context},
        *history,
        {"role": "user", "content": user_message},
    ]
