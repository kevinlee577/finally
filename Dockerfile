# syntax=docker/dockerfile:1
#
# FinAlly — AI Trading Workstation
# Multi-stage build per planning/PLAN.md §11.
#
# Build from the repo root so the context contains both frontend/ and backend/:
#   docker build -t finally .
#
# .env is NEVER copied into the image (it holds secrets); it is supplied at
# run time with `docker run --env-file .env`.

# ---------------------------------------------------------------------------
# Stage 1 — build the Next.js static export (output: 'export' -> frontend/out)
# ---------------------------------------------------------------------------
# node:20-slim tracks the latest 20.x, which satisfies next@16's declared
# `engines: {"node": ">=20.9.0"}`. That floor leaves little headroom — if the
# frontend ever moves to a Next release requiring Node 22+, bump this tag.
FROM node:20-slim AS frontend-builder

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /build

# Manifests first so dependency installation caches independently of source edits.
# The `*` on the lockfile keeps this working before a lockfile is committed.
COPY frontend/package.json frontend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY frontend/ ./
RUN npm run build

# Fail the build loudly here rather than shipping an image that 404s on every
# page: `output: 'export'` must have produced /build/out/index.html.
RUN test -f /build/out/index.html \
    || (echo "ERROR: frontend build produced no out/index.html — is next.config set to output: 'export'?" && exit 1)

# ---------------------------------------------------------------------------
# Stage 2 — Python runtime (FastAPI serves the API and the static export)
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

# uv, copied from its official distroless image (no curl/installer script needed).
# Pinned to the 0.11 series: backend/uv.lock is `revision = 3`, which older uv
# releases cannot read, and --frozen must not fail on a lockfile-format mismatch.
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /uvx /bin/

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:$PATH"

# --- dependency layer -------------------------------------------------------
# Sync third-party deps alone first so this layer is reused whenever only
# application source changes. --frozen fails if uv.lock is stale (reproducible
# builds); --no-dev keeps pytest/ruff out of the production image.
COPY backend/pyproject.toml backend/uv.lock backend/README.md ./
RUN uv sync --frozen --no-dev --no-install-project

# --- application layer ------------------------------------------------------
COPY backend/ ./
RUN uv sync --frozen --no-dev

# Static export from stage 1, served by FastAPI at /app/static.
COPY --from=frontend-builder /build/out ./static

# Bind-mount target for the SQLite file (docker run -v "$(pwd)/db:/app/db").
# Created here so the container still starts if run without the mount.
RUN mkdir -p /app/db

ENV DB_PATH=/app/db/finally.db

EXPOSE 8000

# Single process — no --workers. PLAN §7 "Transactions & Concurrency" requires
# one process because trade serialization relies on an in-process asyncio.Lock.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
