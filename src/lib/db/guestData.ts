// ============ 游客模式（浏览器本地存储）的整库导出 / 导入 ============
//
// 【为什么必须有这个文件】网页版对未注册用户开放，他们的数据落在浏览器 IndexedDB 里。
// 但 `decideDataDockView` 原本的判据是 `desktop || portable || dev` —— 游客三者都不满足，
// 数据坞**整块不渲染**，界面上没有任何导出入口。也就是说：游客写了十万字，
// 既不能带走、也没人告诉他数据只在本机。清一次浏览器缓存就是全部心血蒸发。
// 这不是"体验瑕疵"，是数据安全问题 —— 所以补上这条通道。
//
// 导出格式与桌面版 / 便携版**完全一致**（`kind: 'portable-data'`）：
//   · 游客导出的 JSON 可以直接在桌面版「导入数据文件」里打开；
//   · 打赏用户升级后也能把自己的本地稿子搬进云端账号。
//   这是三端互通的唯一基础，格式一旦分叉就再也合不回来。
//
// ⚠️ 语义向量与知识库在**两个独立 IDB**（`novel-studio-vec` / `-kb`）里，按设计不进整库 JSON。
//    所以游客导出**不含**这两块 —— 导入后语义检索需要重新建档（界面要如实告知，别让用户以为丢了）。
import { ops } from '@/lib/db/core'
import { stripSensitiveMeta } from '@/lib/storage/sensitiveMeta'

/** 主库全部 store（与 `db/core.ts` 的 DB_VERSION=13 建表清单严格一致） */
export const GUEST_STORES = [
  'projects', 'volumes', 'chapters', 'formData', 'tableRows', 'cardRecords',
  'meta', 'snapshots', 'dailyStats', 'settingsKV', 'trash', 'backups',
  'tavernReports', 'backupPayloads', 'aiRuns', 'worlds',
] as const

/** 各 store 的主键字段（与 `syncCore.KEY_FIELD` / `fileBackend.PORTABLE_KEY_FIELDS` 同口径） */
const KEY_FIELD: Record<string, string> = {
  projects: 'id', volumes: 'id', chapters: 'id', tableRows: 'id',
  cardRecords: 'id', snapshots: 'id', trash: 'id', backups: 'id', backupPayloads: 'id',
  formData: 'tabId', meta: 'key', dailyStats: 'key', settingsKV: 'key',
  tavernReports: 'id', aiRuns: 'id', worlds: 'id',
}

const keyOf = (store: string, rec: unknown): string => {
  const kf = KEY_FIELD[store] ?? 'id'
  const v = (rec as Record<string, unknown>)?.[kf]
  return v == null ? '' : String(v)
}

/** 读出全部 store（返回原始行数组） */
async function collectAll(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const name of GUEST_STORES) {
    try {
      out[name] = (await ops.getAll(name)) as unknown[]
    } catch {
      // 某个 store 读失败不该让整次导出失败（用户至少要拿到其余数据）
      out[name] = []
    }
  }
  return out
}

/** 生成与便携版同构的整库对象（已剥敏感 meta） */
export async function guestDataObject(): Promise<{ data: Record<string, unknown>; strippedSecrets: string[] }> {
  const stores = await collectAll()
  // 导出即外传：AI 密钥 / 检索密钥一律剥掉（与 exportDesktopData / exportPortableData 同口径）
  const stripped = stripSensitiveMeta(stores)
  return {
    data: {
      app: 'youth-fantasy-engine',
      kind: 'portable-data',
      fileVersion: 1,
      savedAt: Date.now(),
      stores: stripped.stores,
    },
    strippedSecrets: stripped.removed,
  }
}

/**
 * 导出为 JSON 文件（浏览器下载）。
 * 🔴 不走 File System Access API：它只在 Chromium 且需用户手势，Safari/Firefox 直接不可用。
 */
export async function exportGuestData(): Promise<{
  ok: boolean
  fileName?: string
  strippedSecrets?: string[]
  error?: string
}> {
  try {
    const { data, strippedSecrets } = await guestDataObject()
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      + `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    const fileName = `youth-fantasy-engine-游客备份-${stamp}.json`
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return { ok: true, fileName, strippedSecrets }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 用一份 JSON 覆盖本机全部数据。
 * 🔴 语义是「替换」而不是「合并」：导入的是一份完整快照，合并会产生主键冲突与半新半旧的状态，
 *    比直接替换更难解释。调用方必须在导入成功后刷新页面（内存缓存全部失效）。
 */
export async function importGuestData(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!text || !text.trim()) return { ok: false, error: '所选文件是空文件' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件已损坏（不是有效的 JSON）' }
  }

  const o = parsed as { app?: string; kind?: string; stores?: Record<string, unknown[]> }
  if (o?.app !== 'youth-fantasy-engine' || o?.kind !== 'portable-data' || !o.stores || typeof o.stores !== 'object') {
    return { ok: false, error: '这不是本软件导出的数据文件（缺少格式标识）' }
  }

  try {
    for (const name of GUEST_STORES) {
      const incoming = Array.isArray(o.stores[name]) ? (o.stores[name] as unknown[]) : []

      // 先清空：不先删的话，旧库里多出来的记录会残留，形成「导入后仍看到已删内容」的怪状态
      const existing = (await ops.getAll(name)) as unknown[]
      if (existing.length) {
        const keys = existing.map((r) => keyOf(name, r)).filter(Boolean)
        if (keys.length) await ops.bulkDel(name, keys)
      }

      const rows = incoming.filter((r) => keyOf(name, r) !== '')
      if (rows.length) await ops.bulkPut(name, rows)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: '写入本地存储失败：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/** 当前是否运行在游客模式（判定统一收在 `lib/app/platform`，这里只做转出，避免两处各写一份） */
export { WEB_GUEST as GUEST } from '@/lib/app/platform'
