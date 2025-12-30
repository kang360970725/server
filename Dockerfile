# ---------- Build stage ----------
FROM node:20-slim AS builder

WORKDIR /app

# 先拷贝依赖声明（利用缓存）
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./

# 你的 packageManager 是 yarn@1.x，但云上用 npm ci 更通用；你也可以切到 yarn
RUN npm install

# 拷贝代码
COPY . .

# Prisma Client 需要 generate（否则运行时可能找不到 client）
RUN npx prisma generate

# 构建 Nest
RUN npm run build

# ---------- Runtime stage ----------
FROM node:20-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# 只拷贝生产依赖（最小化镜像）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 拷贝构建产物 + prisma（migrations）
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# 启动脚本
COPY ./docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# CloudRun 会注入 PORT；这里只是声明
EXPOSE 3000

CMD ["./docker-entrypoint.sh"]
