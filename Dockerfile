FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_BASE=/
ENV VITE_BASE=$VITE_BASE

RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY server.mjs ./
COPY --from=build /app/dist ./dist

EXPOSE 8080

CMD ["node", "server.mjs"]
