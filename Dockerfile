# ---------- Build stage 完整编译、生成纯净生产依赖 ----------
FROM node:20-slim AS builder
WORKDIR /app
ARG PRISMA_REQUIRED_MIGRATION=20260413080000_add_weekdays_mask_for_cs_duty_schedule

RUN apt-get update -y \
 && apt-get install -y openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 优先拷贝依赖文件，最大化缓存复用
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN npm install

# 拷贝全量源码
COPY . .

# 校验核心源码，防止构建上下文缺失
RUN test -f src/mini/mini.module.ts \
 && test -f src/member/member.module.ts \
 && test -f src/miniapp-protocols/miniapp-protocols.module.ts \
 && test -f src/common/common-upload.controller.ts \
 || (echo "ERROR: required source file missing in build context" && \
     ls -la src/mini src/member src/miniapp-protocols src/common && exit 1)

# 校验指定迁移文件存在
RUN test -d "prisma/migrations/${PRISMA_REQUIRED_MIGRATION}" \
 || (echo "ERROR: required migration missing: ${PRISMA_REQUIRED_MIGRATION}" && ls -la prisma/migrations && exit 1)
RUN echo "Prisma migrations in build context:" && ls -la prisma/migrations

# 生成prisma客户端 + 编译nest产出dist
RUN npx prisma generate
RUN npm run build

# 关键：构建阶段剥离开发依赖，生成纯净node_modules，运行层直接复用
RUN npm install --omit=dev

# ---------- Runtime stage 仅拷贝运行必需文件，无重复安装依赖 ----------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV DEBIAN_FRONTEND=noninteractive
ARG PRISMA_REQUIRED_MIGRATION=20260413080000_add_weekdays_mask_for_cs_duty_schedule
ENV PRISMA_REQUIRED_MIGRATION=${PRISMA_REQUIRED_MIGRATION}

# 时区与基础依赖
RUN apt-get update -y \
 && apt-get install -y openssl ca-certificates tzdata \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

# 直接复用builder已处理好的生产依赖（无重复npm install）
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# 编译产物dist、prisma迁移文件、脚本
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts

# 启动脚本授权
COPY ./docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]