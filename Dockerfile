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

# 构建期校验源码文件
RUN test -f src/mini/mini.module.ts \
 && test -f src/member/member.module.ts \
 && test -f src/miniapp-protocols/miniapp-protocols.module.ts \
 && test -f src/common/common-upload.controller.ts \
 || (echo "ERROR: required source file missing in build context" && \
     ls -la src/mini src/member src/miniapp-protocols src/common && exit 1)

# 构建期校验prisma迁移
RUN test -d "prisma/migrations/${PRISMA_REQUIRED_MIGRATION}" \
 || (echo "ERROR: required migration missing: ${PRISMA_REQUIRED_MIGRATION}" && ls -la prisma/migrations && exit 1)
RUN echo "Prisma migrations in build context:" && ls -la prisma/migrations

RUN npx prisma generate
RUN npm run build

# ✅【关键】构建阶段：剥离dev依赖，提前生成纯净生产node_modules，避免runner重新npm install
RUN npm install --omit=dev


# ---------- Runtime stage ----------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV DEBIAN_FRONTEND=noninteractive
ARG PRISMA_REQUIRED_MIGRATION=20260413080000_add_weekdays_mask_for_cs_duty_schedule
ENV PRISMA_REQUIRED_MIGRATION=${PRISMA_REQUIRED_MIGRATION}

RUN apt-get update -y \
 && apt-get install -y openssl ca-certificates tzdata \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

# ✅直接从builder拷贝【已经去掉dev依赖】的node_modules，不再重新npm install！
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts

COPY ./docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]