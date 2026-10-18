#!/usr/bin/env bash
# ============ 磁盘用量巡检（WEB-13） ============
# 由 crontab 每日调用一次，记录用量并在超阈值时写告警。
#
# 算术：40 GB 系统盘，每账号配额 200 MB ⇒ 约 180 个满配额用户就写满，
# 而系统自身要占十几个 GB，实际警戒线更早。**写满之后所有用户都无法保存**，
# 且 journald 与临时文件会开始连环报错——所以宁可早叫。
set -u

LOG=/opt/yfe/logs/disk.log
TS() { date '+%Y-%m-%d %H:%M:%S'; }

mkdir -p /opt/yfe/logs

PCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
[ -z "$PCT" ] && exit 0
DATA_SIZE=$(du -sh /opt/yfe/data 2>/dev/null | cut -f1)
USER_COUNT=$(ls /opt/yfe/data/users 2>/dev/null | wc -l | tr -d ' ')

echo "$(TS) / 已用 ${PCT}% · 用户数据 ${DATA_SIZE:-0} · 账号数 ${USER_COUNT}" >> "$LOG"

if [ "$PCT" -ge 90 ]; then
  echo "$(TS) 严重：磁盘已用 ${PCT}%，用户即将无法保存，请立刻清理或扩容" >> "$LOG"
elif [ "$PCT" -ge 70 ]; then
  echo "$(TS) 警告：磁盘已用 ${PCT}%，接近警戒线" >> "$LOG"
fi

# 日志自身也要有上限（否则巡检日志自己把磁盘写满）
tail -n 500 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG" 2>/dev/null
