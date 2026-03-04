FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache git bash

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV DEVFLOW_CONFIG_FILE=/data/devflow-config.json
ENV CLAUDE_BIN=claude

EXPOSE 3000

CMD ["node", "server.js"]
