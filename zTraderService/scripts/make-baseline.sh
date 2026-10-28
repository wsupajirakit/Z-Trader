#!/usr/bin/env bash
# สร้าง dist-baseline จาก savepoint tag เพื่อให้ test:regression รันได้จากรีโปเปล่า
#
# instrument-regression.test.js เทียบ dist ปัจจุบันกับ dist ของโค้ดก่อนงาน multi-asset
# ถ้าไม่มี baseline เทสต์จะข้ามไปเงียบ ๆ = คำอ้าง "ของเดิมไม่พัง" พิสูจน์ซ้ำไม่ได้
set -euo pipefail

TAG="${1:-savepoint-2026-10-28-pre-resume-deploy}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WT="$ROOT/.baseline-worktree"
OUT="$ROOT/dist-baseline"

cd "$ROOT"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1 \
  || { echo "ไม่พบ tag $TAG — ระบุ tag/commit เป็น argument แรกได้"; exit 1; }

rm -rf "$WT" "$OUT"
git worktree add --detach "$WT" "$TAG" >/dev/null
trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT

echo "→ ติดตั้ง deps ของ baseline ($TAG)…"
( cd "$WT" && npm ci --silent >/dev/null 2>&1 || npm install --silent >/dev/null 2>&1 )
echo "→ build baseline…"
( cd "$WT" && npx nest build >/dev/null )

cp -R "$WT/dist" "$OUT"
# baseline ต้องใช้ dependency ของตัวเอง (เช่น uuid ที่ตัวปัจจุบันเลิกใช้แล้ว)
# วาง node_modules ไว้ใน dist-baseline ให้ require ของ baseline หาเจอก่อนของรีโปหลัก
cp -R "$WT/node_modules" "$OUT/node_modules"
echo "✅ สร้าง dist-baseline จาก $TAG แล้ว — รัน: npm run test:regression"
