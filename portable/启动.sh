#!/usr/bin/env bash
# ============================================================
#  青春幻想引擎 · 便携版启动脚本（macOS / Linux）
#  双击运行，或在终端执行：  ./启动.sh
#
#  行为（3.0.3+）：
#    1) 优先用**自带的免安装运行时**（同目录下的单个可执行文件，
#       已内嵌 JS 运行时）—— 本机什么都不用装；
#    2) 找不到时回退到系统已装的 Node.js；
#    3) 都没有则给出明确提示。
#
#  ⚠️ 免安装运行时是**按平台**构建的：Windows 版是 .exe，macOS / Linux
#     需要各自的产物（构建方法见 scripts/build-portable-server.mjs 顶部说明）。
#     若本目录没有对应平台的运行时，会自动走第 2 条回退路径。
# ============================================================
set -u

cd "$(dirname "$0")" || exit 1

echo
echo "=================================================="
echo "  青春幻想引擎 · 便携版"
echo "=================================================="
echo

# ---- 1) 自带的免安装运行时（首选，零依赖）----
for RT in ./青春幻想引擎-便携版 ./youth-fantasy-engine-portable ./*.exe; do
  if [ -f "$RT" ] && [ -x "$RT" ]; then
    echo "[运行时] 自带（无需安装 Node.js）"
    echo
    # "$@" 透传附加参数（如 --no-open / --port 8765），便于脚本化与排查
    exec "$RT" --root "$(pwd)" "$@"
  fi
done

# ---- 2) 回退：系统已装的 Node.js ----
SRV="./scripts/portable-server.mjs"
[ -f "$SRV" ] || SRV="./portable-server.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 本目录没有对应平台的免安装运行时，且本机没有 Node.js。"
  echo
  echo "  两种解法（任选其一）："
  echo "    1. 下载对应平台的便携版（Windows / macOS / Linux 各自一个包）；"
  echo "    2. 安装 Node.js（免费，约 30MB）：https://nodejs.org/zh-cn/download"
  echo
  read -r -p "按回车键退出..." _
  exit 1
fi

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

echo "[运行时] 系统 Node.js（回退）"
echo
echo "启动本地服务..."
echo "数据将保存在本目录的 data/ 文件夹里。"
echo

# 脚本内部会自动探测端口并打开浏览器
node "$SRV" --root "$(pwd)"

echo
echo "服务已停止。数据已保存在 data/ 目录。"
read -r -p "按回车键退出..." _
