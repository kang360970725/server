#!/bin/sh
set -e

echo "[entrypoint] Starting app..."
echo "[entrypoint] NODE_ENV=${NODE_ENV:-}"

# ----------------------------
# Prisma migrate (production)
# ----------------------------
# 默认开启：PRISMA_MIGRATE_DEPLOY=1
# 如需跳过（例如多副本并发迁移、紧急回滚）：设置 PRISMA_MIGRATE_DEPLOY=0
if [ "${PRISMA_MIGRATE_DEPLOY:-1}" = "1" ]; then
  echo "[entrypoint] prisma migrate deploy..."
  npx prisma migrate deploy
  echo "[entrypoint] prisma migrate deploy done"
else
  echo "[entrypoint] prisma migrate deploy skipped (PRISMA_MIGRATE_DEPLOY!=1)"
fi

# ----------------------------
# Start NestJS
# ----------------------------
# 兼容你现有 dist 输出路径（dist/main.js 或 dist/src/main.js）
if [ -f "/app/dist/main.js" ]; then
  npm run start:prod
elif [ -f "/app/dist/src/main.js" ]; then
  npm run start:prod
else
  echo "❌ Cannot find entry file. Printing dist tree:"
  ls -al /app || true
  ls -al /app/dist || true
  ls -al /app/dist/src || true
  exit 1
fi
