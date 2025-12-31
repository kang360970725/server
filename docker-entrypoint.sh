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

if [ -f "/app/dist/main.js" ]; then
  node /app/dist/main.js
elif [ -f "/app/dist/src/main.js" ]; then
  node /app/dist/src/main.js
else
  echo "❌ Cannot find entry file. Printing dist tree:"
  ls -al /app || true
  ls -al /app/dist || true
  ls -al /app/dist/src || true
  exit 1
fi
