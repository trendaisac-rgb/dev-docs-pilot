# syntax=docker/dockerfile:1.7

# ─── Builder ────────────────────────────────────────────────────────
# Multi-stage build: install deps with uv in the builder, then ship a
# slim runtime. Pins Python to match local dev (3.11) for parity.
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

# uv via the standalone installer — pinned to a known-good version
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/0.11.14/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Copy lock + manifest first so `uv sync` is cached on dep-only changes
COPY pyproject.toml ./

# Install deps into a virtualenv at /app/.venv
RUN uv venv /app/.venv && \
    uv sync --no-dev --no-install-project

# Now copy source + install the project itself
COPY src ./src
COPY eval ./eval
RUN uv sync --no-dev


# ─── Runtime ────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:${PATH}"

# tini for clean signal handling under Fly's init
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Non-root user — Fly recommends it
RUN useradd --create-home --shell /bin/bash app
WORKDIR /app

COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --from=builder --chown=app:app /app/src /app/src
COPY --from=builder --chown=app:app /app/eval /app/eval
COPY --chown=app:app pyproject.toml /app/pyproject.toml

USER app

EXPOSE 8000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "docs_agent.api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
