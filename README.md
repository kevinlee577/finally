# FinAlly — AI Trading Workstation

A visually stunning AI-powered trading workstation that streams live market data, lets users trade a simulated portfolio, and integrates an LLM chat assistant that can analyze positions and execute trades on the user's behalf. Built entirely by AI coding agents as the capstone project for an agentic AI coding course.

## Status

Early development. The market data subsystem (`backend/app/market/`) is complete — see [`planning/MARKET_DATA_SUMMARY.md`](planning/MARKET_DATA_SUMMARY.md). The rest of the platform (API routes, database, frontend, AI chat, Docker packaging) is still being built. There is no runnable app yet.

## Planned Architecture

A single Docker container, one port (8000):

- **Frontend**: Next.js (TypeScript), static export, served by the backend
- **Backend**: FastAPI (Python, managed with `uv`)
- **Database**: SQLite, volume-mounted for persistence
- **Real-time data**: Server-Sent Events (`/api/stream/prices`)
- **Market data**: Built-in GBM simulator by default, or the Massive (Polygon.io) API if `MASSIVE_API_KEY` is set
- **AI chat**: LiteLLM → OpenRouter (Cerebras inference), structured outputs, auto-executed trades

Full spec, API contracts, schema, and rationale live in [`planning/PLAN.md`](planning/PLAN.md).

## Repository Layout

```
finally/
├── frontend/     # Next.js static export (not yet created)
├── backend/      # FastAPI uv project
│   └── app/market/  # Market data subsystem (complete)
├── planning/     # Project spec and agent documentation
├── db/           # SQLite volume mount (runtime)
├── scripts/      # Start/stop helpers (not yet created)
└── Dockerfile    # Multi-stage build (not yet created)
```

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | No | Enables the AI chat assistant. App runs fully without it — chat degrades gracefully. |
| `MASSIVE_API_KEY` | No | Real market data via Massive (Polygon.io); omit to use the built-in simulator. |
| `LLM_MOCK` | No | Set `true` for deterministic mock LLM responses (used in tests). |

## Backend Development

```bash
cd backend
uv sync --dev
uv run pytest
```

See [`backend/README.md`](backend/README.md) for details.

## License

See [LICENSE](LICENSE).
