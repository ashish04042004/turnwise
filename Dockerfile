# One image for the API (which also serves the built dashboard), the worker and one-off tasks.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY web web
RUN npm run build -w web

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund && npm cache clean --force
COPY server/src server/src
COPY server/migrations server/migrations
COPY server/fixtures server/fixtures
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:4100/api/health || exit 1
CMD ["node", "server/src/index.js"]
