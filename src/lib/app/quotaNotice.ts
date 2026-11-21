// ============ 存储配额提示（3.6.2 · W4）· 判定 + 文案，不弹窗 ============
//
// 【职责边界】本文件只做三件事：读配额 → 判"今天该不该提" → 给一句成品文案。
// **不调用 toast**（那是界面层的活）：lib 层一旦 import 界面组件，
// 层级就反了，而且单测里得把 toast 也桩掉。
//
// 🔴 提示频次：同一档位**每天最多一次**（键是 `level@YYYY-MM-DD`，见 storageQuota.ts）。
//    跨天重置是"温和地再提一次" —— 作者一天没腾出空间，不代表他希望永远不再被提醒；
//    但同一天连提三次只会让他关掉提示。
import { readStringPref, writeStringPref } from '@/lib/settings/uiPrefs'
import { localDateKey } from '@/lib/app/webVersionNotice'
import {
  QUOTA_CRITICAL_RATIO,
  QUOTA_WARN_RATIO,
  quotaLevel,
  quotaNoticeKey,
  quotaPercent,
  readQuota,
  shouldNotifyQuota,
  type QuotaInfo,
  type QuotaLevel,
} from '@/lib/app/storageQuota'

const KEY_LAST = 'quota-notice-last'

export interface QuotaNotice {
  level: Extract<QuotaLevel, 'warn' | 'critical'>
  /** 成品文案（界面直接显示，不再拼） */
  text: string
}

/**
 * 按档位给文案。
 *
 * 🔴 措辞三条：
 *   ① **不说"你的作品占了 N%"** —— `estimate()` 给的是整个源的用量（同源还有其它存储）；
 *   ② `critical` 必须**明说"保存可能失败"**，否则作者不会当回事；
 *   ③ 都要给一个**能立刻做的动作**（去导出备份 / 删旧备份），而不是只报数字。
 */
export function quotaNoticeText(level: 'warn' | 'critical', percent: number): string {
  if (level === 'critical') {
    return `存储空间只剩约 ${100 - percent}%（已用 ${percent}%），保存随时可能失败 —— `
      + `请立刻到「备份与恢复」里导出一份备份，再删掉不需要的旧备份。`
  }
  return `存储空间已用约 ${percent}%，建议到「备份与恢复」里导出一份备份，并清理不需要的旧备份。`
}

/**
 * 检查一次配额，返回"该提示什么"或 null。
 *
 * @param deps 全部可注入（单测用）：estimate / today / readPref / writePref / info
 */
export async function checkQuotaNotice(deps?: {
  info?: QuotaInfo | null
  today?: string
  readPref?: (key: string) => string | null
  writePref?: (key: string, v: string) => boolean
}): Promise<QuotaNotice | null> {
  const info = deps && 'info' in deps ? deps.info ?? null : await readQuota()
  if (!info) return null

  const level = quotaLevel(info.usage, info.quota)
  const today = deps?.today ?? localDateKey()
  const readPref = deps?.readPref ?? readStringPref
  const writePref = deps?.writePref ?? writeStringPref

  let last: string | null = null
  try { last = readPref(KEY_LAST) } catch { last = null }
  if (!shouldNotifyQuota(level, last, today)) return null
  if (level !== 'warn' && level !== 'critical') return null

  const percent = quotaPercent(info.usage, info.quota) ?? Math.round((info.usage / info.quota) * 100)
  try { writePref(KEY_LAST, quotaNoticeKey(level, today)) } catch { /* 记不住就下次再提，不算错 */ }
  return { level, text: quotaNoticeText(level, percent) }
}

/** 供界面显示"当前用量"（设置页/备份面板用）；拿不到返回 null */
export async function describeQuota(): Promise<{ level: QuotaLevel; percent: number | null } | null> {
  const info = await readQuota()
  if (!info) return null
  return { level: quotaLevel(info.usage, info.quota), percent: quotaPercent(info.usage, info.quota) }
}

export { QUOTA_WARN_RATIO, QUOTA_CRITICAL_RATIO }
