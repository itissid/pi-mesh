# Build context is the repository root; the root .dockerignore allowlists inputs.
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json index.ts server.ts ./
COPY src/ ./src/
COPY test/ ./test/
COPY scripts/sync-version.mjs ./scripts/sync-version.mjs
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --from=build --chown=1000:1000 /app/package.json ./package.json
COPY --chown=1000:1000 deploy/docker/broker-entrypoint.mjs ./broker-entrypoint.mjs
USER 1000:1000
ENTRYPOINT ["node", "/app/broker-entrypoint.mjs"]
