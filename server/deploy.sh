#!/usr/bin/env bash
# ============ 一键部署（WEB-09） ============
# 在**本机**运行：构建 → 打包 → 上传 → 远端原子上线 → 健康检查 → 失败自动回滚。
#
# 用法：
#   bash server/deploy.sh              # 部署前端产物 + 服务端（默认都发）
#   bash server/deploy.sh www          # 只发前端
#   bash server/deploy.sh server       # 只发服务端
#
# 环境变量：
#   YFE_HOST    默认 root@115.120.232.153
#   YFE_KEY     默认 ~/.workbuddy/deploy-keys/yfe_huawei
#
# 🔴 为什么需要它：此前每次更新是「build → tar → scp → 解压 → restart」五步手工，
#    漏一步（典型：改了 server 忘了传）就会线上半新半旧，排查极难。
#    现在五步合成一条，且远端有备份与自动回滚。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/server"
HOST="${YFE_HOST:-root@115.120.232.153}"
KEY="${YFE_KEY:-$HOME/.workbuddy/deploy-keys/yfe_huawei}"
WHAT="${1:-both}"

SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=15"
SCP="scp -i $KEY -o BatchMode=yes -o ConnectTimeout=15"

# 🔴 构建摘要算法（PLT-10）：与 server/scripts/deploy.sh 里的 build_id() 必须逐字一致，
#    两端不一致会让「版本核对」永远失败。改这里必须同步改远端。
#    口径：目录内全部文件（排除 BUILD_ID 自身）按路径排序，逐个 sha256 后与路径一起再 sha256。
build_id() {
  (cd "$1" && find . -type f -not -name BUILD_ID | LC_ALL=C sort | while read -r f; do
     printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
   done | sha256sum | cut -d' ' -f1)
}

# 远端上线脚本（先确保它在，版本跟着仓库走）
$SCP "$SERVER_DIR/scripts/deploy.sh" "$HOST":/tmp/yfe-deploy.sh >/dev/null
$SSH "$HOST" "mkdir -p /opt/yfe/scripts && mv /tmp/yfe-deploy.sh /opt/yfe/scripts/deploy.sh && chmod +x /opt/yfe/scripts/deploy.sh"

deploy_www() {
  echo "==> 构建前端"
  (cd "$ROOT" && npm run build >/dev/null)
  echo "==> 打包并上传 www"
  # 把构建摘要写进包里（BUILD_ID 被 build_id 自身排除，不会自我循环）
  printf '%s\n' "$(build_id "$ROOT/dist")" > "$ROOT/dist/BUILD_ID"
  tar -czf /tmp/yfe-www.tgz -C "$ROOT/dist" .
  rm -f "$ROOT/dist/BUILD_ID"
  $SCP /tmp/yfe-www.tgz "$HOST":/tmp/ >/dev/null
  $SSH "$HOST" "bash /opt/yfe/scripts/deploy.sh /tmp/yfe-www.tgz www; rc=\$?; rm -f /tmp/yfe-www.tgz; exit \$rc"
}

deploy_server() {
  echo "==> 打包并上传 server"
  printf '%s\n' "$(build_id "$SERVER_DIR")" > "$SERVER_DIR/BUILD_ID"
  tar -czf /tmp/yfe-server.tgz -C "$SERVER_DIR" .
  rm -f "$SERVER_DIR/BUILD_ID"
  $SCP /tmp/yfe-server.tgz "$HOST":/tmp/ >/dev/null
  $SSH "$HOST" "bash /opt/yfe/scripts/deploy.sh /tmp/yfe-server.tgz server; rc=\$?; rm -f /tmp/yfe-server.tgz; exit \$rc"
}

case "$WHAT" in
  www)    deploy_www ;;
  server) deploy_server ;;
  both)   deploy_www; deploy_server ;;
  *) echo "用法: bash server/deploy.sh [www|server|both]"; exit 1 ;;
esac

echo "==> 完成：$(date '+%H:%M:%S')"
