// ============ 3.5.3 · P0-4 同步结局 → 用户文案（纯函数）============
//
// 【为什么单独一层】上传器（projectUploader）已经把服务端结果翻译成 UploadOutcome，
// 但「界面该对用户说什么」是另一件事：要区分五类失败、且每一类都得点明「本机稿件还在」。
// 把文案散在组件里必然漂移，也没法单测。这里集中一份，组件只管渲染。
//
// 🔴 失败类文案必须含「本机/保留/不受影响」之类的安抚：同步失败最忌讳让用户以为稿子丢了
//    （与 syncStatusMeta 的「失败类必须露出文字且说明数据在哪」是同一条底线）。
// 🔴 网络类单独归一类：状态机把它走 offline，文案要说「会自动重试」，而不是「同步失败」。
import type { UploadOutcome } from '@/lib/sync/projectUploader'

export type SyncPromptKind =
  | 'ok' | 'conflict' | 'quota'
  | 'data-anomaly' | 'account-busy' | 'epoch' | 'old-server' | 'legacy-blocked'
  | 'network' | 'error'

const DATA_ANOMALY = new Set([
  'PROJECT_DATA_INVALID', 'PROJECT_DATA_READ_FAILED', 'PROJECT_DATA_MISSING', 'PROJECT_DATA_RECOVERY_REQUIRED',
])

/** 结局归类（界面据此选图标/颜色，单测据此穷举五类失败） */
export function syncPromptKind(o: UploadOutcome): SyncPromptKind {
  if (o.ok) return 'ok'
  if (o.status === 'conflict') return 'conflict'
  if (o.status === 'quota') return 'quota'
  if (o.code === 'NETWORK' || o.code === 'TIMEOUT' || o.code === 'ECONNRESET') return 'network'
  if (DATA_ANOMALY.has(o.code)) return 'data-anomaly'
  if (o.code === 'PROJECT_ACCOUNT_BUSY') return 'account-busy'
  if (o.code === 'EPOCH_STALE') return 'epoch'
  if (o.code === 'SERVER_TOO_OLD') return 'old-server'
  if (o.code === 'LEGACY_WRITE_BLOCKED') return 'legacy-blocked'
  return 'error'
}

/** 用户文案；成功返回空串（界面不需要为成功挂告警） */
export function syncPrompt(o: UploadOutcome): string {
  if (o.ok) return ''
  const kind = syncPromptKind(o)
  // message 只存在于 error 变体；conflict/quota 没有，先收窄再取，避免联合类型上报错
  const msg = o.status === 'error' ? o.message : ''
  switch (kind) {
    case 'conflict': return '本机与云端各有改动，需要你选择保留哪一份；本机稿件已保留。'
    case 'quota': return '云端空间不足，本次未上传；本机稿件已保留，请腾出空间后重试。'
    case 'network': return '暂时连不上云端（网络问题）；本机稿件已保留，网络恢复后会自动重试。'
    case 'data-anomaly': return msg || '云端数据异常，本次未上传；本机稿件已保留，请联系管理员检查云端数据。'
    case 'account-busy': return msg || '云端正在处理该账号的其他写入，请稍后重试；本机稿件已保留。'
    case 'epoch': return msg || '云端数据已迁移或恢复，请重新拉取云端全部内容后再同步；本机稿件不受影响。'
    case 'old-server': return msg || '服务器不支持项目级同步（版本过旧）；请升级服务器，本机稿件不受影响。'
    case 'legacy-blocked': return msg || '云端已升级，旧版写入已停用；请升级客户端，本机稿件不受影响。'
    default: return msg || '同步失败；本机稿件已保留。'
  }
}