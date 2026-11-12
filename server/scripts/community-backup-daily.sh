#!/usr/bin/env bash
# 3.5.2 · 生产社区每日停写备份（工具已安装在 /opt/yfe/tools/community-backup）
# 计划默认：每日一次、本机保留 14 份、备份后校验；失败写日志并以非零退出。
# 告警：logger 写入系统日志；外部通道未配置，不伪装成已送达。
set -u

TOOL=/opt/yfe/tools/community-backup/community-backup.mjs
DATA=/opt/yfe/data/community
BACKUP_ROOT=/opt/yfe/backups
LOG=/opt/yfe/logs/community-backup.log
STATUS=/opt/yfe/logs/community-backup-status.json
LOCK=/opt/yfe/backups/.community-backup-daily.lock
KEEP=14

mkdir -p /opt/yfe/logs "$BACKUP_ROOT"
log() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }
alert() {
  log "ALERT $*"
  logger -p user.err -t yfe-community-backup "$*" 2>/dev/null || true
}

exec 9>"$LOCK"
if ! flock -n 9; then
  alert "已有社区备份任务运行，本次跳过"
  exit 75
fi

STAMP=$(date +%Y-%m-%dT%H-%M-%S)
OUTDIR="$BACKUP_ROOT/community-$STAMP"
WAS_ACTIVE=0
systemctl is-active --quiet yfe-web && WAS_ACTIVE=1
RESULT=failed
BACKUP_RC=1
VERIFY_RC=1

restart_service() {
  if [ "$WAS_ACTIVE" = 1 ]; then
    systemctl start yfe-web || log "ALERT 无法重启 yfe-web，请人工检查"
  fi
}

trap restart_service EXIT

log "BEGIN stamp=$STAMP wasActive=$WAS_ACTIVE"
if [ "$WAS_ACTIVE" = 1 ]; then
  systemctl stop yfe-web || { alert "停止 yfe-web 失败，未执行备份"; exit 1; }
fi
if systemctl is-active --quiet yfe-web; then
  alert "yfe-web 仍为 active，拒绝在未停写状态备份"
  exit 1
fi

BACKUP_OUT=$(node "$TOOL" backup --data "$DATA" --backup-root "$BACKUP_ROOT" --out "$OUTDIR" --keep "$KEEP" --confirm-stopped --json 2>&1)
BACKUP_RC=$?
log "BACKUP rc=$BACKUP_RC $BACKUP_OUT"
if [ "$BACKUP_RC" -ne 0 ]; then
  alert "社区每日备份失败 rc=$BACKUP_RC；详见 $LOG"
  exit 1
fi

chmod 700 "$OUTDIR" 2>/dev/null || true
VERIFY_OUT=$(node "$TOOL" verify "$OUTDIR" --json 2>&1)
VERIFY_RC=$?
log "VERIFY rc=$VERIFY_RC $VERIFY_OUT"
if [ "$VERIFY_RC" -ne 0 ]; then
  alert "社区备份校验失败 rc=$VERIFY_RC dir=$OUTDIR；详见 $LOG"
  exit 1
fi

cleanup_done=1
restart_service
trap - EXIT
if [ "$WAS_ACTIVE" = 1 ] && ! systemctl is-active --quiet yfe-web; then
  alert "备份完成但 yfe-web 重启失败，请人工检查"
  exit 1
fi

# ---- 匿名代号密钥：与社区数据同一时点备份 ----
# 服务启动会把 profiles 里的 anonKeyId 与密钥做比对；密钥丢失/更换会导致启动失败，
# 所以它必须跟数据一起备份，副本权限保持 600。未配置密钥（未启用周代号）时跳过。
ANON_KEY=/opt/yfe/anon-key/community-anon.key
ANON_KEY_DIR="$BACKUP_ROOT/anon-key"
ANON_KEY_RC=0
if [ -f "$ANON_KEY" ]; then
  mkdir -p "$ANON_KEY_DIR" && chmod 700 "$ANON_KEY_DIR"
  if cp -p "$ANON_KEY" "$ANON_KEY_DIR/community-anon-$STAMP.key" \
     && chmod 600 "$ANON_KEY_DIR/community-anon-$STAMP.key" \
     && cmp -s "$ANON_KEY" "$ANON_KEY_DIR/community-anon-$STAMP.key"; then
    log "anon-key OK $ANON_KEY_DIR/community-anon-$STAMP.key"
    ls -1t "$ANON_KEY_DIR"/community-anon-*.key 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old"; done
  else
    ANON_KEY_RC=1
    alert "匿名代号密钥备份失败，请人工检查 $ANON_KEY"
  fi
else
  log "anon-key 未配置（周代号未启用），跳过密钥备份"
fi
if [ "$ANON_KEY_RC" -ne 0 ]; then log "FAILED anon-key"; exit 1; fi

RESULT=ok
cat >"$STATUS" <<EOF
{"at":"$(date -Is)","result":"ok","backupDir":"$OUTDIR","backupExit":$BACKUP_RC,"verifyExit":$VERIFY_RC,"anonKeyExit":$ANON_KEY_RC,"serviceActive":$(systemctl is-active --quiet yfe-web && echo true || echo false)}
EOF
log "OK dir=$OUTDIR"
exit 0