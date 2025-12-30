#!/bin/sh
set -e

echo "Starting with NODE_ENV=$NODE_ENV"

echo "Running prisma db push..."
npx prisma db push

if [ "$RUN_SEED" = "1" ]; then
  echo "Running prisma seed..."
  npx prisma db seed
fi

echo "Starting app..."
node dist/main
