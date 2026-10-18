#!/usr/bin/env bash
# ============ 访问统计每日汇总（WEB-17 · 方案 E） ============
# 由 crontab 每日 23:58 调用：把当天的明细汇总成一行，写进 stats-daily.log。
#
# 设计取舍：
#   · 明细（stats.log）保留但有 3000 行上限，防止统计日志自己把磁盘写满；
#   · 汇总行用 tab 分隔，方便 `awk`/`cut` 二次处理，也方便自动化任务直接读；
#   · 当天零访问不写行（省得日报里一堆 0，看不出「没人来」和「没采集到」的区别要靠前一天的对比）。
set -u

LOG=/opt/yfe/logs/stats.log
OUT=/opt/yfe/logs/stats-daily.log
TODAY=$(date +%Y-%m-%d)

[ -f "$LOG" ] || exit 0

TOTAL=$(awk -F'\t' -v d="$TODAY" '$1 == d' "$LOG" | wc -l | tr -d ' ')
[ "$TOTAL" -eq 0 ] && exit 0

LINE=$(awk -F'\t' -v d="$TODAY" '
  $1 == d { c[$2]++ }
  END {
    printf "%s\t登录页=%d\t游客=%d\t云端=%d\t注册=%d\t登录=%d\t重置=%d", \
      d, c["visit_loginpage"], c["visit_guest"], c["visit_cloud"], \
      c["register"], c["login"], c["reset"]
  }' "$LOG")

echo "$LINE" >> "$OUT"

# 明细自限（只保留最近 3000 行；跨天的那部分反正已经汇总过了）
tail -n 3000 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG" 2>/dev/null
exit 0
