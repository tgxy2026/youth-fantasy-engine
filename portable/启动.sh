#!/usr/bin/env bash
# ============================================================
#  青春幻想引擎 · 便携版启动脚本（macOS / Linux）
#  在终端执行：  bash 启动.sh
#  （也可 chmod +x 启动.sh 后双击 / ./启动.sh 运行）
#
#  行为（2026-10-14）：直接调用系统已装的 Node.js 运行本地服务。
#  说明：单文件 exe 打包（Node SEA）已于 2026-10-14 放弃（维护成本高于收益）；
#  因此本目录**只服务 macOS / Linux**（Windows 用户请用同包的 启动.bat）。
# ============================================================
set -u

cd "$(dirname "$0")" || exit 1

echo
echo "=================================================="
echo "  青春幻想引擎 · 便携版"
echo "=================================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有找到 Node.js。本便携版需要它才能运行（免费，约 30MB，只需装一次）。"
  echo
  echo "  下载地址："
  echo "    · 官方：https://nodejs.org/zh-cn/download  （选 LTS 版）"
  echo "    · 国内镜像：https://npmmirror.com/mirrors/node/"
  echo
  echo "  装完后重新打开终端再运行本脚本（让 PATH 生效）。"
  echo
  read -r -p "按回车键退出..." _
  exit 1
fi

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
  echo "  请确认整个「便携版」文件夹都从压缩包里解压出来了。"
  echo
  read -r -p "按回车键退出..." _
  exit 1
fi

echo "启动本地服务..."
echo "数据将保存在本目录的 data/ 文件夹里。"
echo

# 脚本内部会自动探测端口并打开浏览器
node "$SRV" --root "$(pwd)" "$@"

echo
echo "服务已停止。数据已保存在 data/ 目录。"
read -r -p "按回车键退出..." _
