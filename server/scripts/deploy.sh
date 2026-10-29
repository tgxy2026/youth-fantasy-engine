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
#
# 🔴 PLT-10（三端兼容专项审计候选，2026-10-18）：
#    原先健康检查只探「ping 通 + 首页 200」，证明不了「线上跑的就是刚上传的这份构建」——
#    前端半新半旧、或服务端重启失败但旧进程仍在，ping 照样绿。现在加两层：
#    ① 构建摘要核对：包里带 BUILD_ID，解压后重算比对，防「解压不完整/传错包」；
#    ② 首页主包可达：从首页 HTML 里抓出实际引用的主包路径再请求一次，
#       证明「这份首页引用的资源真实存在」，而不是只返回了个空壳 200。
set -u

# 🔴 构建摘要算法：与本地 server/deploy.sh 的 build_id() 必须逐字一致，改一边必须同步改另一边。
build_id() {
  (cd "$1" && find . -type f -not -name BUILD_ID | LC_ALL=C sort | while read -r f; do
     printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
   done | sha256sum | cut -d' ' -f1)
}

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

# 4) 健康检查（PLT-10：从「能响应」升级为「响应的就是这份构建」）
#    4a. 构建摘要：包里带的 BUILD_ID vs 解压后重算
EXPECTED=""
[ -f "$DIR/BUILD_ID" ] && EXPECTED=$(tr -d '[:space:]' < "$DIR/BUILD_ID")
ACTUAL=$(build_id "$DIR")
if [ -z "$EXPECTED" ]; then
  echo "DEPLOY_FAIL 包里没有 BUILD_ID，无法核对版本"
  rm -rf "$DIR"; mv "$BAK" "$DIR"; systemctl restart yfe-web; exit 1
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "DEPLOY_FAIL 构建摘要不匹配（期望 ${EXPECTED:0:12}… 实际 ${ACTUAL:0:12}…），回滚"
  rm -rf "$DIR"; mv "$BAK" "$DIR"; systemctl restart yfe-web; exit 1
fi
# 摘要留档（www 目录里不放，移到上级供审计与排查取用）
mv "$DIR/BUILD_ID" "/opt/yfe/BUILD_ID.$TARGET" 2>/dev/null

#    4b. 接口 + 首页都要通（只探接口会漏掉产物本身坏掉的情况）
if ! curl -sf --max-time 8 http://127.0.0.1:8082/api/ping >/dev/null 2>&1 \
   || ! curl -sf --max-time 8 http://127.0.0.1:8082/ >/dev/null 2>&1; then
  echo "DEPLOY_FAIL 健康检查未过（接口或首页不通），回滚到 $BAK"
  rm -rf "$DIR"
  mv "$BAK" "$DIR"
  systemctl restart yfe-web
  sleep 2
  exit 1
fi

#    4c. 首页引用的主包真实可达（防「返回 200 但资源 404」的半坏状态）
#        🔴 必须从**磁盘上的 index.html** 抓主包名，不能 curl `/`：
#           未登录访问 `/` 拿到的是服务端渲染的登录页，里面没有任何 assets 引用。
if [ "$TARGET" = "www" ]; then
  MAINJS=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$DIR/index.html" 2>/dev/null | head -1)
  if [ -z "$MAINJS" ] || ! curl -sf --max-time 15 "http://127.0.0.1:8082/$MAINJS" >/dev/null 2>&1; then
    echo "DEPLOY_FAIL 首页主包不可达（${MAINJS:-index.html 中未找到引用}），回滚到 $BAK"
    rm -rf "$DIR"
    mv "$BAK" "$DIR"
    systemctl restart yfe-web
    sleep 2
    exit 1
  fi
  echo "DEPLOY_OK 摘要核对通过（${EXPECTED:0:12}…），主包 $MAINJS 可达，备份在 $BAK"
else
  echo "DEPLOY_OK 摘要核对通过（${EXPECTED:0:12}…），备份在 $BAK"
fi
# 只留最近 3 份备份（`rm -rf` 只作用于本目录下自己生成的 bak.*，不碰别处）
ls -dt /opt/yfe/backups/${TARGET}.bak.* 2>/dev/null | tail -n +4 | while read -r d; do
  case "$d" in /opt/yfe/backups/${TARGET}.bak.*) rm -rf "$d" ;; esac
done
exit 0
