# Standalone image for the SQS worker (worker/index.ts). Build from the repo root:
#   docker build -f worker/Dockerfile .
# Multi-arch friendly (also builds for arm64, e.g. a Raspberry Pi). Prisma generates the engine for
# whatever platform the image is built on.
FROM oven/bun:1-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# bun.lock is deliberately not copied: `--frozen-lockfile` fails here because the extensions/*
# workspace isn't in the image, so dependencies resolve from package.json ranges at build time.
COPY package.json ./
RUN bun install --production

# Only what the worker imports: worker/, shared/, and the DB layer under app/.
COPY prisma ./prisma
COPY shared ./shared
COPY worker ./worker
COPY app/db.server.ts ./app/db.server.ts
COPY app/lib/db ./app/lib/db
COPY app/config ./app/config
RUN bunx prisma generate

USER bun
CMD ["bun", "run", "worker/index.ts"]
