#!/usr/bin/env bash
# PRED-ARB deploy/update script for VPS
# Run from project root: ./scripts/deploy.sh

set -e

cd "$(dirname "$0")/.."

echo "==> Pulling latest..."
git pull

echo "==> Installing dependencies..."
npm run setup

echo "==> Building..."
npm run build:all

echo "==> Rebuilding native modules..."
npm rebuild better-sqlite3

echo "==> Ensuring data dir exists..."
mkdir -p data

if command -v pm2 &>/dev/null; then
  echo "==> Restarting PM2..."
  pm2 restart pred-arb 2>/dev/null || pm2 start ecosystem.config.cjs
  pm2 save
  echo "==> Done. pm2 status:"
  pm2 status
else
  echo "==> Build complete. Start manually: npm start"
  echo "    Or install PM2: npm i -g pm2 && pm2 start ecosystem.config.cjs"
fi
