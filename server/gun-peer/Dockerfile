# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app

# Non-root runtime user
RUN addgroup -S gun && adduser -S -G gun gun \
  && mkdir -p /app/.gun-data \
  && chown -R gun:gun /app

COPY --from=deps --chown=gun:gun /app/node_modules ./node_modules
COPY --chown=gun:gun package.json index.ts ./

USER gun

ENV GUN_PEER_HOST=0.0.0.0
ENV GUN_PEER_PORT=8765
ENV NODE_ENV=production

EXPOSE 8765

VOLUME ["/app/.gun-data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8765/healthz || exit 1

CMD ["node", "--import", "tsx", "index.ts"]
