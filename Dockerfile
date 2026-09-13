FROM node:20-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# The web app controls game containers by shelling out to the Docker CLI
# against the mounted /var/run/docker.sock, so it needs the client installed
# and must run as root to access the socket.
#
# docker-cli-compose is the `docker compose` plugin, and it is REQUIRED: the
# routes that change a container's configuration (memory, MC version, 7DTD
# update) recreate it through compose. Without the plugin those commands fail,
# and the temptation is to hand-build `docker run` instead — which produces a
# container with no compose labels that a later `docker compose up` can't adopt.
RUN apk add --no-cache docker-cli docker-cli-compose
RUN mkdir -p /app/data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=root:root /app/.next/standalone ./
COPY --from=builder --chown=root:root /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/generated ./src/generated
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/@libsql ./node_modules/@libsql

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
