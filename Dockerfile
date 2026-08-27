FROM node:24-alpine AS builder
WORKDIR /app

# Public Vite values must be declared as build arguments for Railway Docker builds.
ARG VITE_DISCORD_CLIENT_ID
ARG VITE_DISCORD_INSTALL_URL
ENV VITE_DISCORD_CLIENT_ID=$VITE_DISCORD_CLIENT_ID
ENV VITE_DISCORD_INSTALL_URL=$VITE_DISCORD_INSTALL_URL

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/game/dictionary.txt ./dist/server/dictionary.txt

CMD ["node", "dist/server/index.mjs"]
