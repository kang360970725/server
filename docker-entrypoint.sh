#!/bin/sh
set -e

echo "[entrypoint] Starting app..."
echo "[entrypoint] NODE_ENV=${NODE_ENV:-}"

# ----------------------------
# Prisma migration files check
# ----------------------------
if [ -d "/app/prisma/migrations" ]; then
  MIGRATION_DIR_COUNT=$(find /app/prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  echo "[entrypoint] prisma migrations dir count=${MIGRATION_DIR_COUNT}"
else
  echo "[entrypoint] ERROR: /app/prisma/migrations not found"
  exit 1
fi

# 可选：发布时设置 PRISMA_REQUIRED_MIGRATION，确保新迁移目录已打进镜像
# 例如：PRISMA_REQUIRED_MIGRATION=20260413080000_add_weekdays_mask_for_cs_duty_schedule
if [ -n "${PRISMA_REQUIRED_MIGRATION:-}" ]; then
  if [ ! -d "/app/prisma/migrations/${PRISMA_REQUIRED_MIGRATION}" ]; then
    echo "[entrypoint] ERROR: required migration not found: ${PRISMA_REQUIRED_MIGRATION}"
    echo "[entrypoint] Existing migrations:"
    ls -1 /app/prisma/migrations || true
    exit 1
  fi
  echo "[entrypoint] required migration found: ${PRISMA_REQUIRED_MIGRATION}"
fi

# ----------------------------
# Prisma migrate (production)
# ----------------------------
# 默认开启：PRISMA_MIGRATE_DEPLOY=1
# 如需跳过（例如多副本并发迁移、紧急回滚）：设置 PRISMA_MIGRATE_DEPLOY=0
if [ "${PRISMA_MIGRATE_DEPLOY:-1}" = "1" ]; then
  echo "[entrypoint] prisma failed-migration repair precheck..."
  node ./scripts/repair-prisma-failed-migrations.js
  echo "[entrypoint] prisma failed-migration repair precheck done"
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
