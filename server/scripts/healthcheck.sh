#!/usr/bin/env bash
# ============ 存活探活（WEB-10） ============
# 由 crontab 每 5 分钟调用。探测 yfe-web 是否还在响应。
#
# 🔴 连续两次失败才重启：单次抖动可能来自瞬时负载或系统调度，
#    一失败就重启反而会把「慢」变成「更慢」（重启期间所有人都在转圈）。
set -u

LOG=/opt/yfe/logs/healthcheck.log
FLAG=/tmp/yfe-ping-fail
URL=http://127.0.0.1/api/ping
TS() { date '+%Y-%m-%d %H:%M:%S'; }

mkdir -p /opt/yfe/logs

if curl -sf --max-time 8 "$URL" >/dev/null 2>&1; then
  [ -f "$FLAG" ] && rm -f "$FLAG"
  exit 0
fi

COUNT=$(cat "$FLAG" 2>/dev/null || echo 0)
COUNT=$((COUNT + 1))
echo "$COUNT" > "$FLAG"

if [ "$COUNT" -ge 2 ]; then
  echo "$(TS) ping 连续 $COUNT 次失败，重启 yfe-web" >> "$LOG"
  systemctl restart yfe-web
  sleep 5
  if curl -sf --max-time 8 "$URL" >/dev/null 2>&1; then
    echo "$(TS) 重启成功" >> "$LOG"
  else
    # 重启也救不回来 ⇒ 记 ERROR 并留下现场信息，等人来看
    echo "$(TS) 重启后仍无响应，需人工介入" >> "$LOG"
    journalctl -u yfe-web -n 30 --no-pager >> "$LOG" 2>&1
  fi
  rm -f "$FLAG"
else
  echo "$(TS) ping 失败一次（$COUNT/2），继续观察" >> "$LOG"
fi
