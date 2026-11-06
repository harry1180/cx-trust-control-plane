# Web console container — build from repo root.
FROM node:22-alpine AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/cxtrust-core/package.json packages/cxtrust-core/
# No pnpm-lock.yaml in this repo state, so a frozen install is impossible:
# resolve fresh from the registry instead.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate && pnpm install
COPY apps/web ./apps/web
COPY packages/cxtrust-core ./packages/cxtrust-core
# Path filter: the workspace root package.json is also named "web".
RUN pnpm --filter ./apps/web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
# `next start` resolves the build relative to the CWD: the production build is
# at /app/apps/web/.next (monorepo layout), so run from the app directory —
# starting at /app fails with "Could not find a production build in .next".
WORKDIR /app/apps/web
EXPOSE 3000
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
