FROM node:22-bookworm-slim

# System tools required for cloning bot repositories, Python bots, media processing, and native builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    ffmpeg \
    python3 \
    python-is-python3 \
    python3-pip \
    python3-venv \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create Hugging Face Spaces compatible non-root user (uid 1000).
# node base image already ships a "node" user with uid 1000, so remove it first.
RUN userdel -r node && useradd -m -u 1000 user

WORKDIR /app

# Copy manifests first for layer caching
COPY --chown=user:user package.json bun.lock* package-lock.json* ./

RUN npm install --legacy-peer-deps

# Copy application source
COPY --chown=user:user . .

# Build frontend production bundle into dist/
RUN npm run build

# Ensure runtime directories exist and are writable by uid 1000
RUN mkdir -p /app/data/backups /app/bot_instances /app/workspace && \
    chown -R user:user /app/data /app/bot_instances /app/workspace

USER user
ENV HOME=/home/user
ENV NODE_ENV=production
ENV PORT=7860

EXPOSE 7860
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD sh -c "curl -fsS http://127.0.0.1:${PORT:-7860}/api/health || exit 1"

CMD ["node", "server.ts"]
