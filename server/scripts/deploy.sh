#!/usr/bin/env bash
# ============ 服务器端上线脚本（WEB-09） ============
# 由本地 `server/deploy.sh` 上传并调用：备份 → 解压 → 重启 → 健康检查 → 失败自动回滚。
#
# 用法：bash /opt/yfe/scripts/deploy.sh <tgz 路径> <www|server>
#
# 🔴 回滚用 `mv` 而不是「先 rm 再 cp 回去」：
#    * 项目红线之一 —— 本机 `fs.cpSync` 会静默杀进程，`cp -r` 虽可但也慢且中途失败会留下半份；
#    * `mv` 同分区是元数据操作，瞬间完成且不会出现「拷了一半」的中间态。
# 🔴 只在健康检查通过后才删除旧目录；失败则原样搬回去，服务与数据都不受影响。
set -u

PKG="$1"
TARGET="${2:-www}"
TS=$(date +%Y%m%d-%H%M%S)
BAK=/opt/yfe/backups/${TARGET}.bak.${TS}

if [ ! -f "$PKG" ]; then echo "DEPLOY_FAIL 找不到上传包：$PKG"; exit 1; fi

case "$TARGET" in
  www)    DIR=/opt/yfe/www ;;
  server) DIR=/opt/yfe/server ;;
  *) echo "DEPLOY_FAIL 目标只能是 www 或 server"; exit 1 ;;
esac

mkdir -p /opt/yfe/backups

# 1) 旧目录整体改名成备份（瞬间完成，不留半成品）
rm -rf "$BAK" 2>/dev/null
if ! mv "$DIR" "$BAK"; then echo "DEPLOY_FAIL 无法移走旧目录"; exit 1; fi
mkdir -p "$DIR"

# 2) 解压新产物
if ! tar -xzf "$PKG" -C "$DIR"; then
  echo "DEPLOY_FAIL 解压失败，回滚"
  rm -rf "$DIR"; mv "$BAK" "$DIR"; systemctl restart yfe-web; exit 1
fi

# 3) 重启
systemctl restart yfe-web
sleep 3

# 4) 健康检查：接口 + 首页都要通（只探接口会漏掉产物本身坏掉的情况）
if curl -sf --max-time 8 http://127.0.0.1/api/ping >/dev/null 2>&1 \
   && curl -sf --max-time 8 http://127.0.0.1/ >/dev/null 2>&1; then
  echo "DEPLOY_OK 备份在 $BAK"
  # 只留最近 3 份备份（`rm -rf` 只作用于本目录下自己生成的 bak.*，不碰别处）
  ls -dt /opt/yfe/backups/${TARGET}.bak.* 2>/dev/null | tail -n +4 | while read -r d; do
    case "$d" in /opt/yfe/backups/${TARGET}.bak.*) rm -rf "$d" ;; esac
  done
  exit 0
fi

# 5) 回滚
echo "DEPLOY_FAIL 健康检查未过，回滚到 $BAK"
rm -rf "$DIR"
mv "$BAK" "$DIR"
systemctl restart yfe-web
sleep 2
exit 1
