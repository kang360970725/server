# ---------- Build stage ----------
FROM node:20-slim AS builder

WORKDIR /app

# ✅ Prisma 需要 openssl，builder 阶段装一下更稳
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# 先拷贝依赖声明（利用缓存）
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./

# 你之前 npm ci 会失败（没 lockfile），这里用 npm install 更通用
RUN npm install

# 拷贝代码
COPY . .

# Prisma Client 需要 generate
RUN npx prisma generate

# 构建 Nest
RUN npm run build

# ---------- Runtime stage ----------
FROM node:20-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# ✅ runner 阶段必须有 openssl，否则运行时 Prisma 可能出问题
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# 只拷贝生产依赖
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 拷贝构建产物 + prisma（migrations / schema / seed）
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# 启动脚本
COPY ./docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
