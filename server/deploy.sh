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
  # 🔴 YFE_SKIP_BUILD=1：跳过构建直接用现有 dist。
  #    用途：dist 里已有 `version.json`（由 release-version-manifest.mjs 依据**已封装产物**生成），
  #    而 `npm run build` 会清空 dist 把它冲掉 —— 重建后清单就没了。
  #    不是"图快"，是为了不丢版本清单；正常发布仍走默认（会构建）。
  if [ "${YFE_SKIP_BUILD:-}" = "1" ]; then
    echo "==> 跳过构建（YFE_SKIP_BUILD=1），使用现有 dist"
  else
    echo "==> 构建前端"
    (cd "$ROOT" && npm run build >/dev/null)
  fi

  # ---- 1) 版本清单：必须依据**真实产物**现算，不能沿用 dist 里的旧文件 ----
  # 🔴 顺序（踩过两次）：
  #    ① 先删 BUILD_ID：残留的上一次指纹会被清单脚本当成 webBuildId 读走，线上就会
  #       「换了版但清单里的 webBuildId 没变」，老页面永远不提示刷新；
  #    ② 生成清单：三件产物缺一即 FAIL（清单指向不存在的包 = 所有用户都下载失败）；
  #    ③ 自校验：体积 + sha256 逐字节比对，几秒钟换掉"发版后才发现"；
  #    ④ 最后才算 BUILD_ID —— 它含清单本身，所以必须排在清单之后。
  echo "==> 生成版本清单"
  rm -f "$ROOT/dist/BUILD_ID"
  (cd "$ROOT" && node scripts/release-version-manifest.mjs)
  (cd "$ROOT" && node scripts/verify/version-manifest-check.mjs)

  echo "==> 打包并上传 www"
  # 把构建摘要写进包里（BUILD_ID 被 build_id 自身排除，不会自我循环）
  printf '%s\n' "$(build_id "$ROOT/dist")" > "$ROOT/dist/BUILD_ID"
  tar -czf /tmp/yfe-www.tgz -C "$ROOT/dist" .
  rm -f "$ROOT/dist/BUILD_ID"
  $SCP /tmp/yfe-www.tgz "$HOST":/tmp/ >/dev/null
  $SSH "$HOST" "bash /opt/yfe/scripts/deploy.sh /tmp/yfe-www.tgz www; rc=\$?; rm -f /tmp/yfe-www.tgz; exit \$rc"

  # ---- 2) 缓存头断言：头错了，页面再新用户也看不到 ----
  verify_cache_headers
}

# 取远端一条响应的头（走 127.0.0.1，绕开 DNS / TLS，只验服务端本身）
remote_head() {
  $SSH "$HOST" "curl -sSI --max-time 8 'http://127.0.0.1:8082$1' | tr -d '\r'"
}

# 断言某个路径的 Cache-Control 命中期望模式
expect_cache() { # path 模式 说明
  local hdrs line
  hdrs="$(remote_head "$1" || true)"
  line="$(printf '%s\n' "$hdrs" | grep -i '^Cache-Control:' | head -1 | tr -d '\r')"
  if printf '%s' "$line" | grep -qiE "$2"; then
    echo "  PASS $3 :: ${line:-（无 Cache-Control）}"
    return 0
  fi
  echo "  FAIL $3 :: 期望匹配 /$2/，实际 ${line:-（无 Cache-Control）}"
  return 1
}

# ============ 部署后缓存头门禁 ============
# 🔴 为什么必须在部署后验：缓存头曾经只存在于"某个版本的 nginx 片段"里，
#    而线上反代其实是 Caddy（全透传，头由 Node 发）。片段与真实拓扑脱节时，
#    部署脚本一切正常、页面也能开，只有"老用户永远看到旧版"这一个症状 ——
#    谁也联想不到缓存。所以把三条口径变成门禁，部署完立刻打脸。
verify_cache_headers() {
  echo "==> 核对线上缓存头"
  local mainjs
  mainjs="$($SSH "$HOST" "grep -oE 'assets/index-[A-Za-z0-9_-]+[.]js' /opt/yfe/www/index.html | head -1" || true)"
  if [ -z "$mainjs" ]; then
    echo "  FAIL 主包定位 :: /opt/yfe/www/index.html 里没有 assets/index-*.js"
    return 1
  fi

  local fail=0
  # ① HTML 壳：每次回源验证（no-store 也可接受：登录页是服务端现渲染的）
  expect_cache "/" 'no-store|no-cache' "HTML 壳" || fail=1
  # ② 版本清单：客户端靠它判断"线上换版了没"
  expect_cache "/version.json" 'no-cache' "version.json" || fail=1
  # ③ 带内容哈希的构建产物：永久缓存
  expect_cache "/$mainjs" 'immutable' "构建产物 $mainjs" || fail=1

  if [ "$fail" != 0 ]; then
    echo "DEPLOY_WARN 缓存头不符（内容已上线，不自动回滚）—— 用户会看到旧页面/收不到刷新提示，请立即处理"
    return 1
  fi
  echo "  缓存头三项全部符合"
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
