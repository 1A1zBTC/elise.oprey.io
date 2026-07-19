#!/usr/bin/env bash
# One-command deploy for "Elise and Luke's Games".
#
# git push does NOT deploy — the live site is AWS S3 + CloudFront. This script:
#   1. regenerates sw.js (refresh precache list + bump cache version)
#   2. syncs the static site to s3://elise.oprey.io
#   3. invalidates the CloudFront distribution and waits for it
#
# Prereqs: aws CLI configured (IAM user `claude`), node on PATH.
# Usage:   tools/deploy.sh
set -euo pipefail

BUCKET="s3://elise.oprey.io"
DIST_ID="EDR208IJW4SS7"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Regenerating sw.js"
node tools/build-sw.mjs

echo "==> Syncing to $BUCKET"
# Sync the whole site, skipping dev-only files. No --delete (non-destructive).
aws s3 sync . "$BUCKET" \
  --exclude ".git/*" \
  --exclude ".gstack/*" \
  --exclude ".claude/*" \
  --exclude "tasks/*" \
  --exclude "tools/*" \
  --exclude ".gitignore"

# .webmanifest isn't always given the right content-type by `s3 sync`.
aws s3 cp manifest.webmanifest "$BUCKET/manifest.webmanifest" \
  --content-type "application/manifest+json"

echo "==> Invalidating CloudFront ($DIST_ID)"
INVAL_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' --output text)"
echo "    invalidation: $INVAL_ID"

aws cloudfront wait invalidation-completed --distribution-id "$DIST_ID" --id "$INVAL_ID"
echo "==> Deployed. Live at https://elise.oprey.io"
