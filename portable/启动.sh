#!/usr/bin/env bash
# ============================================================
#  青春幻想引擎 · 便携版启动脚本（macOS / Linux）
#  双击运行，或在终端执行：  ./启动.sh
# ============================================================
set -u

cd "$(dirname "$0")" || exit 1

echo
echo "=================================================="
echo "  青春幻想引擎 · 便携版"
echo "=================================================="
echo

# ---- 找 Node ----
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有找到 Node.js。"
  echo
  echo "  便携版需要本机已安装 Node.js（免费，约 30MB）。"
  echo "  下载地址：https://nodejs.org/zh-cn/download"
  echo "  安装后重新运行本脚本即可。"
  echo
  read -r -p "按回车键退出..." _
  exit 1
fi

# ---- 定位服务脚本 ----
SRV="./scripts/portable-server.mjs"
[ -f "$SRV" ] || SRV="./portable-server.mjs"
if [ ! -f "$SRV" ]; then
  echo "[错误] 找不到服务脚本 portable-server.mjs。"
  echo "  请确认「便携版」目录完整（应含 dist/ 与 scripts/portable-server.mjs）。"
  echo
  read -r -p "按回车键退出..." _
  exit 1
fi

if [ ! -f "./dist/index.html" ]; then
  echo "[错误] 找不到前端产物 dist/index.html。"
  echo "  请在项目里先执行  npm run build:portable"
  echo
  read -r -p "按回车键退出..." _
  exit 1
fi

echo "启动本地服务..."
echo "数据将保存在本目录的 data/ 文件夹里。"
echo

# 脚本内部会自动探测端口并打开浏览器
node "$SRV" --root "$(pwd)"

echo
echo "服务已停止。数据已保存在 data/ 目录。"
read -r -p "按回车键退出..." _
