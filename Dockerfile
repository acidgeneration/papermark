# Этап сборки (build)
FROM node:18 AS builder
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build --verbose


# Финальный образ
FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
