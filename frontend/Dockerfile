# Frontend production image

FROM node:22.23.0-alpine3.23 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm build

FROM caddy:2.11.4-alpine AS runtime
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/build/client /srv

EXPOSE 80 443
