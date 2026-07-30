FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY migrations ./migrations
COPY src ./src

ENV NODE_ENV=production
ENV SERVER_HOST=0.0.0.0

USER node
EXPOSE 18787

CMD ["node", "src/server.mjs"]
