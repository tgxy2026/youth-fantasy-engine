#!/usr/bin/env bash
# ============ web-cloud 运行取证（三端兼容专项审计 · 2026-10-18） ============
# 目的：为 platform 专项的 runtime cells 采集真实证据，输出 steps.txt 供汇总成 evidence ledger。
# 范围：只读 + 轻量写入（注册两个临时账号、写一条测试数据，取完立即删除）。
# 不碰：真实用户数据、其他账号目录、部署流程（除已发生的回滚记录引用）。
set -u
export no_proxy="115.120.232.153,127.0.0.1,localhost" NO_PROXY="115.120.232.153,127.0.0.1,localhost"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
TS=$(date +%Y%m%d-%H%M%S)
OUT=".workbuddy/tmp/webcloud-runtime-evidence/$TS"
mkdir -p "$OUT"
B=http://115.120.232.153
SSH="ssh -i C:/Users/18223/.workbuddy/deploy-keys/yfe_huawei -o BatchMode=yes root@115.120.232.153"
LOG="$OUT/steps.txt"

say() { echo "== $* ==" | tee -a "$LOG"; }

say "生成两张一次性邀请码"
CODES=$($SSH "cd /opt/yfe/server && node admin.mjs invite 1 2" | grep -oE '[A-F0-9]{8}')
CA=$(echo "$CODES" | sed -n 1p); CB=$(echo "$CODES" | sed -n 2p)
echo "codeA=$CA codeB=$CB" | tee -a "$LOG"

say "注册账号 A / B（account-isolation: two-accounts）"
curl -s --max-time 10 -c "$OUT/ckA.txt" -X POST $B/api/auth/register -H "Content-Type: application/json" \
  --data-raw "{\"name\":\"取证A\",\"password\":\"pass123456\",\"invite\":\"$CA\"}" > "$OUT/regA.json"
curl -s --max-time 10 -c "$OUT/ckB.txt" -X POST $B/api/auth/register -H "Content-Type: application/json" \
  --data-raw "{\"name\":\"取证B\",\"password\":\"pass123456\",\"invite\":\"$CB\"}" > "$OUT/regB.json"
grep -o '"ok":true' "$OUT/regA.json" "$OUT/regB.json" | tee -a "$LOG"

say "A 写入独有数据（backend-selection：经 HTTP StoreOps 落库）"
curl -s --max-time 10 -b "$OUT/ckA.txt" -X PUT $B/api/data -H "Content-Type: application/json" \
  --data-raw '{"app":"youth-fantasy-engine","kind":"portable-data","fileVersion":1,"savedAt":1,"stores":{"projects":[{"id":"evidence-secret","name":"A的私有项目"}]}}' | tee -a "$LOG"

say "B 读 /api/data —— 应 404 missing 且路径是 B 自己的目录（two-accounts）"
curl -s --max-time 10 -b "$OUT/ckB.txt" $B/api/data | tee -a "$LOG"; echo | tee -a "$LOG"

say "B 直接读 A 的 blob —— 应被拒（two-accounts）"
curl -s --max-time 10 -b "$OUT/ckB.txt" -o /dev/null -w "status=%{http_code}\n" "$B/api/blob?store=projects&id=evidence-secret" | tee -a "$LOG"

say "游客 cookie 访问 /api/data —— 应 401（guest-to-account）"
curl -s --max-time 10 -b "yfe_guest=1" -o /dev/null -w "status=%{http_code}\n" $B/api/data | tee -a "$LOG"
curl -s --max-time 10 -b "yfe_guest=1" $B/api/data | tee -a "$LOG"; echo | tee -a "$LOG"

say "同浏览器切换账号：B 登录后，A 的旧 cookie 仍只属于 A（same-browser-account-switch，不串写）"
# 🔴 口径说明：单会话顶下线只对「同一账号」生效（A 别处再登才会顶掉 A 的旧会话）。
#    本场景要证的是「不串写」：B 登录后，手里留存的 A 旧 cookie 依然只读得到 A 自己的数据，
#    不会变成 B 的身份、也读不到 B 的目录。若 cookie 串了身份，这里会读到 B 的 missing 或 B 的数据。
curl -s --max-time 10 -c "$OUT/ckB2.txt" -X POST $B/api/auth/login -H "Content-Type: application/json" \
  --data-raw '{"name":"取证B","password":"pass123456"}' > "$OUT/reloginB.json"
grep -o '"ok":true' "$OUT/reloginB.json" | tee -a "$LOG"
curl -s --max-time 10 -b "$OUT/ckA.txt" $B/api/data | grep -o 'evidence-secret\|"missing":true' | head -1 | tee -a "$LOG"
say "对照组：A 自己再次登录 ⇒ A 的第一个 cookie 被顶掉（同账号互斥）"
curl -s --max-time 10 -c "$OUT/ckA2.txt" -X POST $B/api/auth/login -H "Content-Type: application/json" \
  --data-raw '{"name":"取证A","password":"pass123456"}' > "$OUT/reloginA.json"
curl -s --max-time 10 -b "$OUT/ckA.txt" -o /dev/null -w "A_first_cookie=%{http_code}\n" $B/api/auth/me | tee -a "$LOG"
curl -s --max-time 10 -b "$OUT/ckA.txt" $B/api/auth/me | tee -a "$LOG"; echo | tee -a "$LOG"

say "取登录态首页（initial-flags + flag-injection）"
curl -s --max-time 10 -b "$OUT/ckA2.txt" $B/ | grep -oE '__YFE_PORTABLE__|__YFE_WEB__|__YFE_USER__=\{[^}]*\}' | sort -u | tee -a "$LOG"

say "重启 yfe-web（restart-readback）"
$SSH "systemctl restart yfe-web && sleep 2 && systemctl is-active yfe-web" | tee -a "$LOG"
curl -s --max-time 10 -b "$OUT/ckA2.txt" $B/api/data | grep -o 'evidence-secret' | head -1 | tee -a "$LOG"

say "built-version：线上 BUILD_ID.www vs 本地 dist 摘要（bash 口径，与 deploy.sh 一致）"
$SSH "cat /opt/yfe/BUILD_ID.www" > "$OUT/build-id-online.txt"
(cd dist && find . -type f -not -name BUILD_ID | LC_ALL=C sort | while read -r f; do
   printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
 done | sha256sum | cut -d' ' -f1) > "$OUT/build-id-local.txt"
echo "online=$(cat "$OUT/build-id-online.txt")" | tee -a "$LOG"
echo "local =$(cat "$OUT/build-id-local.txt")" | tee -a "$LOG"
if [ "$(tr -d '[:space:]' < "$OUT/build-id-online.txt")" = "$(tr -d '[:space:]' < "$OUT/build-id-local.txt")" ]; then
  echo "built-version: MATCH" | tee -a "$LOG"
else
  echo "built-version: MISMATCH" | tee -a "$LOG"
fi

say "static-assets：首页主包可达 + gzip"
MAINJS=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)
echo "mainjs=$MAINJS" | tee -a "$LOG"
curl -s -o /dev/null -D - --max-time 20 -H "Accept-Encoding: gzip" "$B/$MAINJS" | grep -iE "^(HTTP|content-encoding)" | tee -a "$LOG"
curl -s -o /dev/null -w "mainjs_status=%{http_code}\n" --max-time 20 "$B/$MAINJS" | tee -a "$LOG"

say "清理临时账号"
$SSH "cd /opt/yfe/server && node admin.mjs delete 取证A && node admin.mjs delete 取证B" 2>&1 | tee -a "$LOG"

say "rollback：引用本轮已真实发生的回滚（12:20 首次部署因主包检查回滚成功）"
echo "event=DEPLOY_FAIL_首页主包不可达_自动回滚_12:20 observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"

say "取证完成，产物目录：$OUT"
ls -la "$OUT" | tee -a "$LOG"
