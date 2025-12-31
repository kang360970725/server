#!/bin/sh
set -e

echo "Starting app..."

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
