# Web console container — build from repo root.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/cxtrust-core/package.json packages/cxtrust-core/
RUN corepack enable && pnpm install --frozen-lockfile
COPY apps/web ./apps/web
COPY packages ./packages
RUN pnpm --filter web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
USER node
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "-p", "3000"]
