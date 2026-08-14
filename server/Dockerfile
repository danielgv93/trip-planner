FROM node:22-alpine

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/migrations ./migrations
COPY server/src ./src
COPY js/core /app/js/core

USER node

EXPOSE 8787

CMD ["node", "src/server.js"]
