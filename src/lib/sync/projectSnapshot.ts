// ============ 3.3.2 · P2-2 客户端快照生成 ============
//
// 【它在链路里的位置】`exportProject()`（`lib/db/projects.ts`）已经算好了「一本作品的全部内容」——
//   按 projectId 过滤、剥掉 `pid::` 前缀、出口再挡一道敏感键、快照只带 AI 来源。
//   本模块**不重复那套投影**，只做它之后的两件事：
//     ① 把内嵌图片抽成内容寻址的资源（协议 §4 / D8）；
//     ② 把每一类记录序列化成稳定字节、算哈希，产出 manifest（协议 §3）。
//
// 🔴 为什么要抽图片（不是优化，是门槛前提）：含图项目实测 45.69 MiB、图片占 68.4%；
//    直接内嵌时「改一个字」要重传全部图片，而 10 MiB / 30 秒的性能门槛根本不成立。
//    抽成引用后同一份样本降到 4.02 MiB（gzip 1.40）。
//
// 🔴 为什么不在这里读数据库：纯函数才好测、才能在网页/桌面/便携三端复用。
//    调用方拿到 `ProjectBundle` 再调 `buildProjectSnapshot()`，本模块不碰 IDB / 文件 / 网络。
//
// 🔴 序列化必须**确定**：同一份内容两次生成必须得到同一个哈希，否则服务端会把「没改动的书」
//    判成新版本，每次保存都产生一个 revision。故：记录按主键排序、字段顺序沿用记录自身、
//    数组按规范顺序拼接，不做任何依赖插入顺序的「优化」。
import type { ProjectBundle } from '@/lib/db/projects'
import { webcrypto } from '@/lib/storage/webcrypto'

/** 快照协议版本（与服务端 `projectStore.PROTOCOL_VERSION` 对齐；不兼容改动必须升它） */
export const SNAPSHOT_PROTOCOL = 1

/** 一类记录序列化后的对象 */
export interface SnapshotObject {
  /** 协议里的 kind（chapters / tableRows / settings …） */
  kind: string
  /** 内容哈希（hex，对 payload 的 UTF-8 字节做 SHA-256） */
  hash: string
  /** 字节数（上传时用于配额预估） */
  bytes: number
  /** 实际要上传的文本（服务端按字节存，读回来再解析） */
  payload: string
}

/** 一张被抽出来的图片 */
export interface SnapshotAsset {
  hash: string
  bytes: number
  mime: string
  /** 原始 dataURL，调用方负责转成二进制后 PUT /objects/:hash */
  dataUrl: string
}

/** 一条删除标记（跨设备删除靠它，不靠回收站） */
export interface SnapshotTombstone {
  kind: string
  id: string
  deletedAt: number
}

export interface SnapshotManifest {
  protocol: number
  createdAt: number
  project: { name: string; genre: string; projectType?: string }
  counts: Record<string, number>
  objects: { kind: string; hash: string; bytes: number; records: number }[]
  assets: { hash: string; bytes: number; mime: string }[]
  tombstones: SnapshotTombstone[]
}

export interface BuiltSnapshot {
  manifest: SnapshotManifest
  objects: SnapshotObject[]
  assets: SnapshotAsset[]
}

/** 记录主键字段（与 `KEY_FIELD` 同口径；这里只需要能稳定排序） */
const KEY_OF: Record<string, (r: Record<string, unknown>) => string> = {
  chapters: (r) => String(r.id ?? ''),
  volumes: (r) => String(r.id ?? ''),
  tableRows: (r) => String(r.id ?? ''),
  cardRecords: (r) => String(r.id ?? ''),
  formData: (r) => String(r.tabId ?? ''),
  settings: (r) => String(r.key ?? ''),
  dailyStats: (r) => String(r.key ?? r.date ?? ''),
  aiRuns: (r) => String(r.id ?? ''),
  tavernReports: (r) => String(r.id ?? ''),
  snapshots: (r) => String(r.id ?? ''),
}

const encoder = new TextEncoder()

/** SHA-256(hex)。WebCrypto 是异步的，调用方必须 await —— 这里不做同步兜底 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await webcrypto().subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest as ArrayBuffer)
  let out = ''
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0')
  return out
}

/** dataURL → 字节；不是合法 base64 dataURL 时返回 null（**不猜**、不当作空图） */
function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  if (typeof dataUrl !== 'string') return null
  const m = /^data:([^;,]+)?(;base64)?,/.exec(dataUrl)
  if (!m || !m[2]) return null
  const mime = m[1] || 'application/octet-stream'
  const b64 = dataUrl.slice(m[0].length)
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { bytes, mime }
  } catch {
    return null
  }
}

/** 稳定排序：按主键，主键相同再按整条记录的 JSON（保证「同内容同哈希」） */
function sortRecords(kind: string, rows: readonly unknown[]): Record<string, unknown>[] {
  const keyOf = KEY_OF[kind] ?? ((r: Record<string, unknown>) => String(r.id ?? ''))
  const list = rows.map((r) => r as Record<string, unknown>)
  return list.slice().sort((a, b) => {
    const ka = keyOf(a), kb = keyOf(b)
    if (ka !== kb) return ka < kb ? -1 : 1
    const ja = JSON.stringify(a), jb = JSON.stringify(b)
    return ja < jb ? -1 : ja > jb ? 1 : 0
  })
}

/**
 * 抽掉记录里的内嵌图片，换成 `sha256:<hash>` 引用。
 *
 * 覆盖当前全部图片字段（盘点 §4）：
 *   · `cardRecords.portrait` / `portrait2` —— 立绘，值是 dataURL 字符串
 *   · `tableRows.atlasImage.dataUrl` —— 图鉴主图，值在对象里，同对象还带 mime/宽高/字节
 * 🔴 新增图片字段必须同步这里；漏一个的后果是「那张图永远不同步」，且不会有任何报错。
 */
async function extractAssets(bundle: ProjectBundle): Promise<{
  cardRecords: Record<string, unknown>[]
  tableRows: Record<string, unknown>[]
  assets: SnapshotAsset[]
}> {
  const byHash = new Map<string, SnapshotAsset>()

  const take = async (dataUrl: unknown, fallbackMime = 'image/webp') => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null
    const parsed = dataUrlToBytes(dataUrl)
    if (!parsed) return null
    const hash = await sha256Hex(parsed.bytes)
    if (!byHash.has(hash)) {
      byHash.set(hash, { hash, bytes: parsed.bytes.length, mime: parsed.mime || fallbackMime, dataUrl })
    }
    return `sha256:${hash}`
  }

  const cardRecords: Record<string, unknown>[] = []
  for (const row of bundle.cardRecords ?? []) {
    const next: Record<string, unknown> = { ...row }
    for (const field of ['portrait', 'portrait2'] as const) {
      const ref = await take(next[field])
      if (ref) next[field] = ref
      else if (next[field] !== undefined && !String(next[field]).startsWith('sha256:')) delete next[field]
    }
    cardRecords.push(next)
  }

  const tableRows: Record<string, unknown>[] = []
  for (const row of bundle.tableRows ?? []) {
    const next: Record<string, unknown> = { ...row }
    const img = next.atlasImage as { dataUrl?: unknown } | undefined
    if (img && typeof img === 'object') {
      const ref = await take(img.dataUrl)
      if (ref) next.atlasImage = { ...img, dataUrl: ref }
    }
    tableRows.push(next)
  }

  return { cardRecords, tableRows, assets: [...byHash.values()] }
}

/** 把一类记录序列化成对象（排序 + JSON） */
async function seal(kind: string, rows: readonly unknown[]): Promise<SnapshotObject> {
  const sorted = sortRecords(kind, rows)
  const payload = JSON.stringify(sorted)
  const hash = await sha256Hex(encoder.encode(payload))
  return { kind, hash, bytes: encoder.encode(payload).length, payload }
}

/**
 * 生成快照。
 *
 * @param bundle 必须是 `exportProject()` 的产物（那一步已经做完项目过滤与敏感键剥离）。
 *   🔴 别把整库数据塞进来：那会把别的作品一起上传（盘点 §6 列了 7 条不能整库上传的理由）。
 * @param opts.tombstones 自上次成功提交以来删除的记录（跨设备删除只认这个，不认回收站）
 */
export async function buildProjectSnapshot(
  bundle: ProjectBundle,
  opts: { tombstones?: SnapshotTombstone[]; now?: number } = {},
): Promise<BuiltSnapshot> {
  if (!bundle || !bundle.project) throw new Error('快照需要合法的项目包')
  const now = opts.now ?? Date.now()

  const { cardRecords, tableRows, assets } = await extractAssets(bundle)

  const slices: { kind: string; rows: readonly unknown[] }[] = [
    { kind: 'chapters', rows: bundle.chapters ?? [] },
    { kind: 'volumes', rows: bundle.volumes ?? [] },
    { kind: 'tableRows', rows: tableRows },
    { kind: 'cardRecords', rows: cardRecords },
    { kind: 'formData', rows: bundle.formData ?? [] },
    { kind: 'settings', rows: bundle.settings ?? [] },
    { kind: 'dailyStats', rows: bundle.dailyStats ?? [] },
    { kind: 'aiRuns', rows: bundle.aiRuns ?? [] },
    { kind: 'tavernReports', rows: bundle.tavernReports ?? [] },
    { kind: 'snapshots', rows: bundle.snapshots ?? [] },
  ]

  const objects: SnapshotObject[] = []
  const counts: Record<string, number> = {}
  for (const s of slices) {
    // 空类也生成对象：否则「某一类被清空」这种事实无法被下游看出来
    const sealed = await seal(s.kind, s.rows)
    objects.push(sealed)
    counts[s.kind] = s.rows.length
  }

  const tombstones = (opts.tombstones ?? [])
    .filter((t) => t && t.kind && t.id)
    .map((t) => ({ kind: t.kind, id: t.id, deletedAt: Number(t.deletedAt) || now }))
    .sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : a.kind + a.id > b.kind + b.id ? 1 : 0))

  const manifest: SnapshotManifest = {
    protocol: SNAPSHOT_PROTOCOL,
    createdAt: now,
    project: {
      name: bundle.project.name,
      genre: bundle.project.genre,
      projectType: bundle.project.projectType,
    },
    counts,
    objects: objects.map((o) => ({ kind: o.kind, hash: o.hash, bytes: o.bytes, records: counts[o.kind] ?? 0 })),
    assets: assets.map((a) => ({ hash: a.hash, bytes: a.bytes, mime: a.mime })),
    tombstones,
  }

  return { manifest, objects, assets }
}

/** 快照总量（配额预估用）：对象字节 + 资源字节 */
export function snapshotBytes(built: BuiltSnapshot): number {
  const obj = built.objects.reduce((n, o) => n + o.bytes, 0)
  const asset = built.assets.reduce((n, a) => n + a.bytes, 0)
  return obj + asset
}
