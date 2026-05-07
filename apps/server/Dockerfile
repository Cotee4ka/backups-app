# --- Stage 1: build shared + server ---
FROM node:20-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.7.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile=false --filter @backups-app/shared --filter @backups-app/server

COPY packages/shared packages/shared
COPY apps/server apps/server

RUN pnpm --filter @backups-app/shared build && pnpm --filter @backups-app/server build

RUN pnpm deploy --filter @backups-app/server --prod /out

# --- Stage 2: runtime ---
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out /app

ENV NODE_ENV=production
ENV BACKUPS_DATA_DIR=/data
ENV BACKUPS_PORT=8443
ENV BACKUPS_TLS=true

VOLUME ["/data"]
EXPOSE 8443

CMD ["node", "dist/index.js"]
