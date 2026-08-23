# Backend production image

FROM node:22.23.0-bookworm-slim AS dependencies
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

FROM node:22.23.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV TZ=Asia/Kathmandu
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates default-mysql-client gosu openssl tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/khatasathi-entrypoint

RUN chmod 0755 /usr/local/bin/khatasathi-entrypoint \
    && mkdir -p /uploads /document-storage /backups \
    && chown -R node:node /app /uploads /document-storage /backups

EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/khatasathi-entrypoint"]
CMD ["node", "dist/server.js"]
