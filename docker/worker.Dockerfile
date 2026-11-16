# Meeting worker: Node plus Chromium. The base image tag must match the playwright-core version
# in package.json, because each Playwright release is tied to one browser build.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json tsconfig.page.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json && node src/worker/build-page.mjs

FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER pwuser
CMD ["node", "dist/worker/main.js"]
