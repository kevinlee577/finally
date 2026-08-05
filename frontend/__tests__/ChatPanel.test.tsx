import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "@/components/ChatPanel";
import type { ChatTurn } from "@/lib/types";

const DISABLED_COPY = "AI chat is not configured — set OPENROUTER_API_KEY to enable it.";

/** The §9 worked example: narration that is optimistic, outcomes that are not. */
const TURNS: ChatTurn[] = [
  { id: "1", role: "user", content: "Buy 10 AAPL and 5 TSLA, and watch PYPL" },
  {
    id: "2",
    role: "assistant",
    content: "On it — buying 10 AAPL, buying 5 TSLA, and adding PYPL to your watchlist.",
    actions: [
      { type: "trade", ticker: "AAPL", side: "buy", quantity: 10, status: "executed", fill_price: 191.2 },
      { type: "trade", ticker: "TSLA", side: "buy", quantity: 5, status: "failed", error: "insufficient cash" },
      { type: "watchlist_add", ticker: "PYPL", status: "executed" },
    ],
  },
];

function setup(overrides: Partial<Parameters<typeof ChatPanel>[0]> = {}) {
  const props = {
    turns: TURNS,
    pending: false,
    enabled: true,
    disabledMessage: DISABLED_COPY,
    onSend: vi.fn(),
    ...overrides,
  };
  const view = render(<ChatPanel {...props} />);
  return { ...view, props };
}

describe("message rendering", () => {
  it("renders user and assistant turns, tagged by role", () => {
    setup();

    const messages = screen.getAllByTestId("chat-message");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toHaveAttribute("data-role", "user");
    expect(messages[1]).toHaveAttribute("data-role", "assistant");
    expect(messages[0]).toHaveTextContent("Buy 10 AAPL and 5 TSLA");
  });

  it("shows the assistant's narration verbatim", () => {
    setup();
    expect(screen.getByText(/on it — buying 10 aapl/i)).toBeInTheDocument();
  });

  it("renders execution outcomes separately from the narration (§9)", () => {
    setup();

    const actions = screen.getAllByTestId("chat-action");
    expect(actions).toHaveLength(3);

    // The narration claims all three succeeded; only the actions tell the truth.
    expect(actions[0]).toHaveAttribute("data-status", "executed");
    expect(actions[0]).toHaveAttribute("data-ticker", "AAPL");
    expect(actions[0]).toHaveTextContent("Buy 10 AAPL");
    expect(actions[0]).toHaveTextContent("filled @ 191.20");

    expect(actions[1]).toHaveAttribute("data-status", "failed");
    expect(actions[1]).toHaveTextContent("Buy 5 TSLA");
    expect(actions[1]).toHaveTextContent("insufficient cash");

    expect(actions[2]).toHaveAttribute("data-type", "watchlist_add");
    expect(actions[2]).toHaveTextContent("Add PYPL to watchlist");
  });

  it("renders a watchlist removal action", () => {
    setup({
      turns: [
        {
          id: "1",
          role: "assistant",
          content: "Dropping NFLX.",
          actions: [{ type: "watchlist_remove", ticker: "NFLX", status: "executed" }],
        },
      ],
    });
    expect(screen.getByTestId("chat-action")).toHaveTextContent("Remove NFLX from watchlist");
  });

  it("renders an assistant turn with no actions", () => {
    setup({
      turns: [{ id: "1", role: "assistant", content: "You're up 1.2% today.", actions: [] }],
    });

    expect(screen.getByText(/up 1.2% today/i)).toBeInTheDocument();
    expect(screen.queryByTestId("chat-action")).not.toBeInTheDocument();
  });

  it("marks a failed turn so it doesn't read as a normal reply", () => {
    setup({
      turns: [
        {
          id: "1",
          role: "assistant",
          content: "Sorry, I had trouble processing that — please try again.",
          failed: true,
        },
      ],
    });
    const message = screen.getByTestId("chat-message");
    expect(within(message).getByText(/had trouble/i).className).toContain("text-down");
  });
});

describe("loading state", () => {
  it("shows a thinking indicator only while a response is in flight", () => {
    const { rerender, props } = setup();
    expect(screen.queryByTestId("chat-loading")).not.toBeInTheDocument();

    rerender(<ChatPanel {...props} pending />);
    expect(screen.getByTestId("chat-loading")).toBeInTheDocument();
  });

  it("blocks further sends while pending", () => {
    setup({ pending: true });
    expect(screen.getByTestId("chat-input")).toBeDisabled();
    expect(screen.getByTestId("chat-send")).toBeDisabled();
  });
});

describe("sending", () => {
  it("sends the trimmed message and clears the field", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    const input = screen.getByTestId("chat-input");
    await user.type(input, "  how am I doing?  ");
    await user.click(screen.getByTestId("chat-send"));

    expect(props.onSend).toHaveBeenCalledWith("how am I doing?");
    expect(input).toHaveValue("");
  });

  it("keeps send disabled until there is something to send", async () => {
    const user = userEvent.setup();
    setup();

    expect(screen.getByTestId("chat-send")).toBeDisabled();
    await user.type(screen.getByTestId("chat-input"), "hi");
    expect(screen.getByTestId("chat-send")).toBeEnabled();
  });

  it("offers starter prompts on an empty conversation and sends them on click", async () => {
    const user = userEvent.setup();
    const { props } = setup({ turns: [] });

    await user.click(screen.getByRole("button", { name: "Buy 10 shares of NVDA" }));
    expect(props.onSend).toHaveBeenCalledWith("Buy 10 shares of NVDA");
  });
});

describe("unavailable state (§5)", () => {
  it("explains how to enable chat and locks the composer", () => {
    setup({ enabled: false, turns: [] });

    expect(screen.getByTestId("chat-disabled-notice")).toHaveTextContent(DISABLED_COPY);
    expect(screen.getByTestId("chat-input")).toBeDisabled();
    expect(screen.getByTestId("chat-send")).toBeDisabled();
  });

  it("hides the starter prompts, which could not be acted on", () => {
    setup({ enabled: false, turns: [] });
    expect(screen.queryByRole("button", { name: "Buy 10 shares of NVDA" })).not.toBeInTheDocument();
  });

  it("shows no notice while chat is available", () => {
    setup();
    expect(screen.queryByTestId("chat-disabled-notice")).not.toBeInTheDocument();
  });

  it("still shows the conversation so history isn't lost", () => {
    setup({ enabled: false });
    expect(screen.getAllByTestId("chat-message")).toHaveLength(2);
  });
});
