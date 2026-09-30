#!/usr/bin/env bash
# 远端 星河剑歌 (ctwh-881019-xyz) 整库数据重新同步到本地 manage dev 数据库。
# 用法: bash .scratch/backups/resync-remote-to-local.sh
# 前置: 先停掉本地 manage dev（避免锁库）；本脚本不负责启停服务。
set -euo pipefail
cd /d/git/AiCode/microfeed
export PATH="/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:$PATH"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

INSTANCE=ctwh-881019-xyz
DB_DIR=".microfeed/instances/$INSTANCE/local-state/v3/d1/miniflare-D1DatabaseObject"
DB_FILE=$(ls "$DB_DIR"/*.sqlite | grep -v metadata | head -n 1)
if [ -z "$DB_FILE" ]; then echo "!! local D1 sqlite not found under $DB_DIR"; exit 1; fi
echo "local DB: $DB_FILE"

STAMP=$(date +%Y%m%d-%H%M%S)
BK=".scratch/backups/ctwh-local-pre-resync-$STAMP"
mkdir -p "$BK"
cp "$DB_FILE"* "$BK"/ 2>/dev/null || true
echo "backup -> $BK"

FLAGS=""
while IFS= read -r t; do
  [ -z "$t" ] && continue
  FLAGS="$FLAGS --table $t"
done < .scratch/backups/realtables.txt

echo "== exporting remote data (60 real tables) =="
./node_modules/.bin/wrangler d1 export ctwh-881019-xyz-db \
  --config ".microfeed/instances/$INSTANCE/wrangler.jsonc" \
  --remote -y --no-schema --output .scratch/backups/remote-ctwh-data.sql $FLAGS

echo "== filtering derived site_search_documents (triggers rebuild it) =="
grep -v '^INSERT INTO "site_search_documents"' .scratch/backups/remote-ctwh-data.sql \
  > .scratch/backups/remote-ctwh-data-nosearchdocs.sql

echo "== atomic in-place swap (rollback on error) =="
NODE_PATH="" /c/Users/zhs/.workbuddy/binaries/node/versions/22.22.2-3/node.exe .scratch/backups/do-sync.mjs
echo "DONE"
