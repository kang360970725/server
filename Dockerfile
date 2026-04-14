# ---------- Build stage ----------
FROM node:20-slim AS builder
WORKDIR /app
ARG PRISMA_REQUIRED_MIGRATION=20260413080000_add_weekdays_mask_for_cs_duty_schedule

RUN apt-get update -y \
 && apt-get install -y openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN npm install

COPY . .

# 构建期校验：若迁移目录不完整，直接失败，避免带病镜像发布
RUN test -d "prisma/migrations/${PRISMA_REQUIRED_MIGRATION}" \
 || (echo "ERROR: required migration missing: ${PRISMA_REQUIRED_MIGRATION}" && ls -la prisma/migrations && exit 1)
RUN echo "Prisma migrations in build context:" && ls -la prisma/migrations

RUN npx prisma generate
RUN npm run build


# ---------- Runtime stage ----------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ARG PRISMA_REQUIRED_MIGRATION=20260413080000_add_weekdays_mask_for_cs_duty_schedule

# ✅ 关键：设置北京时间（避免 tzdata 交互）
ENV TZ=Asia/Shanghai
ENV DEBIAN_FRONTEND=noninteractive
ENV PRISMA_REQUIRED_MIGRATION=${PRISMA_REQUIRED_MIGRATION}
RUN apt-get update -y \
 && apt-get install -y openssl ca-certificates tzdata \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

# ✅ 生产依赖即可（更快更小）
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

COPY ./docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
