FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libssl-dev pkg-config ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.16.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The web runtime never executes the host-only categorization CLI.
RUN node -e "const fs=require('node:fs'),p=require('./package.json'); delete p.dependencies['@openai/codex']; delete p.devDependencies; fs.writeFileSync('package.json',JSON.stringify(p))" && pnpm install --prod --no-frozen-lockfile

FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts/start-container.ts scripts/stage-health.mjs ./scripts/
ENV NODE_ENV=production MONEYWAVE_PORT=43822
USER 501:1000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "scripts/stage-health.mjs"]
CMD ["node", "--import", "tsx", "scripts/start-container.ts"]
