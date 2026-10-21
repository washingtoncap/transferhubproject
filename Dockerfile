FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000 4000
# Override per service. Inject environment through the host, never copy a .env.
CMD ["node", "dist/apps/api/src/main.js"]
