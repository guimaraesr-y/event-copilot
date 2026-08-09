FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

COPY package.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install

ENV NODE_ENV=production

FROM base AS runtime
CMD ["bun", "run", "start:api"]
