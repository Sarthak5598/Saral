# Multi-stage build: compile with dev dependencies present, ship without them.
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY commands ./commands

RUN pnpm build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

COPY --from=builder /app/dist ./dist
# Migration SQL is read at runtime. migrate.ts resolves it relative to __dirname,
# which is dist/src/database once compiled - hence this target, not ./src.
COPY src/database/migrations ./dist/src/database/migrations

EXPOSE 3000

CMD ["node", "dist/src/app.js"]
