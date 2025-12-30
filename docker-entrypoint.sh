#!/bin/sh
set -e

echo "Starting with NODE_ENV=$NODE_ENV"

# 生产环境：先跑迁移（安全做法）
# 要求你 repo 有 prisma/migrations（如果你目前是 db push 没 migrations，需要告诉我）
echo "Running prisma migrate deploy..."
npx prisma migrate deploy

# 可选：只在你明确设置 RUN_SEED=1 时才 seed（避免每次重启都重置数据）
if [ "$RUN_SEED" = "1" ]; then
  echo "Running prisma seed..."
  npx prisma db seed
fi

echo "Starting app..."
node dist/main
