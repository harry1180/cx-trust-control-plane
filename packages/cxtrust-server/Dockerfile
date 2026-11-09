# Governance API container — build from repo root:
#   docker build -f packages/cxtrust-server/Dockerfile .
# Runs the TypeScript sources directly (Node 22 type-stripping), no compile step.
FROM node:22-alpine AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json pnpm-workspace.yaml ./
# Whole workspace: the server imports @cxtrust/* packages as TS source and each
# brings its own runtime deps. No pnpm-lock.yaml in this repo state, so resolve
# fresh from the registry (same approach as apps/web/Dockerfile).
COPY packages ./packages
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate && pnpm install

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Copy the whole tree from deps: pnpm's isolated layout puts direct deps in
# packages/*/node_modules (symlinks into /app/node_modules/.pnpm) — copying
# only root node_modules would break `import 'ws'` resolution at runtime.
COPY --from=deps /app ./
# SQLite lives in the cxtrust-data volume mounted at /data; pre-create it
# node-owned so a fresh volume initializes with the right ownership.
RUN mkdir -p /data && chown -R node:node /data
EXPOSE 8787
# /healthz sits behind the API-key check, so always send the first configured
# key (empty CXTRUST_API_KEYS -> empty header, auth is off -> still 200).
# NB: single $ only — Dockerfile HEALTHCHECK is NOT compose, no $$ escaping.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- --header="X-API-Key: ${CXTRUST_API_KEYS%%,*}" http://127.0.0.1:8787/healthz || exit 1
USER node
CMD ["node", "packages/cxtrust-server/src/index.ts"]
