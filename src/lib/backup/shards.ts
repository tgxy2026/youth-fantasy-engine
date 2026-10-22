/**
 * 逻辑分片（3.1.3 补丁）：把一个 `ProjectBundle` 拆成四个**逻辑片**再合回来。
 *
 * 依据：`docs/3.1.3-数据分片与备份策略-方案-2026-10-18.md`（主人 2026-10-18 拍板「逻辑分片」）。
 *
 * 【为什么按这四片切】
 *   core     项目 / 卷 / 章节            —— 正文，变更集中，必须保留完整历史
 *   settings 设定表 / 角色卡 / 表单 / 设置 —— 中等体积、变更频繁
 *   media    所有 dataURL（封面 / 立绘 / 图鉴主图）—— **体积大头、变更极少**
 *   stats    统计 / AI 账本 / 推演报告     —— 可重建、价值最低
 *
 * 🔴 分片的目的不是"拆文件好看"，而是让**保留策略可以不同**：
 *    文字片照旧留 30 份，媒体片只留 2～3 份 ⇒ 一张图不会被 60 份备份各复制一遍。
 *
 * 🔴 本文件是**纯函数层**：不读库、不写盘、不碰 localStorage。
 *    这样"拆了能原样合回来"可以被单测直接钉死，再接进备份流程（下一步）就不会把数据拆坏。
 */
import type { CardRecord, Chapter, FormData, Project, TableRow, Volume } from '@/lib/types'
// 只要类型：`ProjectBundle` 是备份包的形状真源；`DailyStat` 同理（定义在 db/meta）。
// 🔴 两条都是 `import type` ⇒ 编译后不产生运行时依赖，分片层仍是纯函数（见单测 ⑨）。
import type { ProjectBundle } from '@/lib/db/projects'

/** 四个逻辑片 */
export type ShardId = 'core' | 'settings' | 'media' | 'stats'

export const SHARD_IDS: readonly ShardId[] = ['core', 'settings', 'media', 'stats']

// ============ 片结构 ============

export interface CoreShard {
  project: Project
  volumes: Volume[]
  chapters: Chapter[]
}

export interface SettingsShard {
  /** 表格行（**已剥离图片**：图鉴主图抽到 media 片） */
  tableRows: TableRow[]
  /** 角色卡（**已剥离立绘**） */
  cardRecords: CardRecord[]
  formData: FormData[]
  settings: { key: string; value: unknown }[]
  customOptions?: { key: string; value: unknown }[]
  snapshots?: ProjectBundle['snapshots']
  knowledgeBase?: ProjectBundle['knowledgeBase']
}

/** 一张图片本体（按内容寻址 ⇒ 同一张图在 media 片里只出现一次） */
export interface MediaBlob {
  /** 内容寻址键（`mediaRef` 生成） */
  ref: string
  mime: string
  /** 原始 dataURL 的字符数（体积口径与备份 meta 的 bytes 一致） */
  bytes: number
  dataUrl: string
}

/** 业务字段 → 图片的引用关系（恢复时按这个写回） */
export interface MediaLink {
  /** `cover` | `card:<id>:portrait` | `card:<id>:portrait2` | `row:<id>:atlas` */
  target: string
  ref: string
}

export interface MediaShard {
  blobs: MediaBlob[]
  links: MediaLink[]
}

export interface StatsShard {
  dailyStats?: ProjectBundle['dailyStats']
  aiRuns?: ProjectBundle['aiRuns']
  tavernReports?: ProjectBundle['tavernReports']
}

export interface ProjectShards {
  core: CoreShard
  settings: SettingsShard
  media: MediaShard
  stats: StatsShard
}

/** 拆分时的旁注（给备份列表显示"文字多少 / 图片多少"用） */
export interface ShardManifest {
  formatVersion: 1
  /** 图片数量（blobs 条数，已去重） */
  mediaCount: number
  /** 图片字符数合计 */
  mediaChars: number
  /** 文字片字符数合计（core + settings + stats） */
  textChars: number
  /** 被抽出的引用条数（links 条数，可能大于 mediaCount：同一张图可被多处引用） */
  linkCount: number
}

// ============ 内容寻址 ============

/**
 * dataURL → 内容寻址键。
 *
 * 🔴 不用 crypto.subtle：那是异步 API 且各端可用性不一（Electron file:// / 非安全上下文会缺），
 *    而这里只需要"同一张图给同一个键"——双轮 FNV-1a（不同初值）拼 64 位近似，再带长度，
 *    在"单项目几百张图"这个量级上碰撞概率可以忽略；真碰撞的最坏后果也只是取到另一张图，
 *    故额外要求 `bytes` 一致才算命中（见 `mergeShards` 的兜底）。
 */
export function mediaRef(dataUrl: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < dataUrl.length; i++) {
    const c = dataUrl.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0
  }
  return `m${h1.toString(36)}${h2.toString(36)}.${dataUrl.length.toString(36)}`
}

function mimeOf(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl)
  return m ? m[1] : 'application/octet-stream'
}

/**
 * 媒体片的载荷 id：**项目 + 「图片 ref 集合」的哈希**。
 *
 * 🔴 图片没变 ⇒ 同一个 id ⇒ 后续备份直接复用它（不重写）—— 这就是"60 份备份只占一份图"的落点。
 *    排序后拼接是必须的：refs 顺序会随遍历顺序变，不排序会让同一图集算出两个 id（复用失效）。
 *    带 projectId 是刻意的：跨项目共享媒体片会让"删项目"变成跨项目引用问题，收益不值这个风险。
 *
 * 🔴🔴 **3.1.3 · R01 修复：id 里绝不能掺 links（归属表）。**
 *    踩过的坑：只按 ref 集合算 id 时，把角色 A／B 的立绘**交换**一下再备份 —— 图集（ref 集合）
 *    一个字节没变，id 相同 ⇒ 复用上一份媒体片 ⇒ 那份里写的是「A→甲、B→乙」，
 *    恢复出来两人的图还是换回来之前的样子。作者看到的是"我明明换了图，备份恢复了旧归属"。
 *    反过来把 links 也塞进 id 同样不行：那等于"改一次归属就复制一遍全部图片"，
 *    分片省空间的初衷直接作废（30 份备份各存一份图集）。
 *
 *    正解是**两件事分开存**：
 *      · 图片本体按内容寻址、跨备份复用（本函数算的 id，只认内容）；
 *      · 归属表（links）随**每一份文字快照**存 —— 见 `createAutoBackup` 写入的 `mediaLinks`。
 *    于是"图没变但换人了"只会多存一份几十字节的归属表，不用再复制图片。
 */
export function mediaPayloadIdOf(projectId: string, refs: readonly string[]): string {
  return `media-${projectId}-${mediaRef([...refs].sort().join('|'))}`
}

/**
 * 落盘用的媒体片：**只带图片本体，不带归属表**（R01）。
 *
 * 归属表改由文字快照携带，所以这里恒为 `links: []`。
 * 🔴 旧备份的媒体片里是**带** links 的（那正是出问题的写法），读取侧必须保留
 *    「文字片没带归属表就回退到媒体片 links」的兜底，否则老备份恢复出来一张图都没有。
 */
export function mediaShardForPayload(blobs: readonly MediaBlob[]): MediaShard {
  return { blobs: [...blobs], links: [] }
}

function isDataUrl(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('data:') && v.includes(';base64,')
}

// ============ 拆 ============

/**
 * `ProjectBundle` 去掉「包封皮」（app / version / exportedAt）之后的形状。
 * 用 type-only 引用真身，避免手写一份"看起来一样"的接口 —— 那边加字段这边不会静默漏掉。
 */
export type BundleLike = Omit<ProjectBundle, 'app' | 'version' | 'exportedAt'>

/** 把 bundle 拆成四片。**输入对象不会被修改**（备份可能还要原样用） */
export function splitBundle(bundle: BundleLike): { shards: ProjectShards; manifest: ShardManifest } {
  const blobs = new Map<string, MediaBlob>()
  const links: MediaLink[] = []

  const pull = (target: string, dataUrl: string) => {
    const ref = mediaRef(dataUrl)
    if (!blobs.has(ref)) blobs.set(ref, { ref, mime: mimeOf(dataUrl), bytes: dataUrl.length, dataUrl })
    links.push({ target, ref })
  }

  // --- media：项目封面 ---
  const project: Project = { ...bundle.project }
  if (isDataUrl(project.cover)) {
    pull('cover', project.cover!)
    delete (project as { cover?: string }).cover
  }

  // --- media：角色立绘（一卡可有两形态）---
  const cardRecords: CardRecord[] = bundle.cardRecords.map(card => {
    const next: CardRecord = { ...card }
    const c = card as unknown as { portrait?: string; portrait2?: string }
    if (isDataUrl(c.portrait)) {
      pull(`card:${card.id}:portrait`, c.portrait!)
      delete (next as unknown as { portrait?: string }).portrait
    }
    if (isDataUrl(c.portrait2)) {
      pull(`card:${card.id}:portrait2`, c.portrait2!)
      delete (next as unknown as { portrait2?: string }).portrait2
    }
    return { ...next, data: { ...card.data } }
  })

  // --- media：图鉴主图（字段尚未落地，这里先按可选处理；落地后无需再改本函数）---
  const tableRows: TableRow[] = bundle.tableRows.map(row => {
    const r = row as unknown as TableRow & { atlasImage?: { dataUrl?: string } }
    if (r.atlasImage && isDataUrl(r.atlasImage.dataUrl)) {
      pull(`row:${row.id}:atlas`, r.atlasImage.dataUrl!)
      const { atlasImage: _drop, ...rest } = r
      return { ...rest, data: { ...row.data } } as TableRow
    }
    return { ...row, data: { ...row.data } }
  })

  const settings: SettingsShard = {
    tableRows,
    cardRecords,
    formData: bundle.formData.map(f => ({ tabId: f.tabId, data: { ...f.data } })),
    settings: bundle.settings ?? [],
    ...(bundle.customOptions ? { customOptions: bundle.customOptions } : {}),
    ...(bundle.snapshots ? { snapshots: bundle.snapshots } : {}),
    ...(bundle.knowledgeBase ? { knowledgeBase: bundle.knowledgeBase } : {}),
  }

  const core: CoreShard = {
    project,
    volumes: bundle.volumes,
    chapters: bundle.chapters,
  }

  const stats: StatsShard = {
    ...(bundle.dailyStats ? { dailyStats: bundle.dailyStats } : {}),
    ...(bundle.aiRuns ? { aiRuns: bundle.aiRuns } : {}),
    ...(bundle.tavernReports ? { tavernReports: bundle.tavernReports } : {}),
  }

  const shards: ProjectShards = {
    core,
    settings,
    media: { blobs: [...blobs.values()], links },
    stats,
  }

  const mediaChars = [...blobs.values()].reduce((n, b) => n + b.bytes, 0)
  const textChars = JSON.stringify({ core, settings, stats }).length
  const manifest: ShardManifest = {
    formatVersion: 1,
    mediaCount: blobs.size,
    mediaChars,
    textChars,
    linkCount: links.length,
  }
  return { shards, manifest }
}

// ============ 合 ============

/** 取图助手：按 target 找 blob。三条硬规矩都收在这里，别在别处再写一遍 */
function mediaAccessor(media: MediaShard) {
  const byRef = new Map(media.blobs.map(b => [b.ref, b]))
  const linksOf = new Map<string, MediaLink[]>()
  for (const l of media.links) {
    const arr = linksOf.get(l.target)
    if (arr) arr.push(l)
    else linksOf.set(l.target, [l])
  }
  return (target: string): string | undefined => {
    const l = linksOf.get(target)?.[0]
    if (!l) return undefined
    const blob = byRef.get(l.ref)
    if (!blob) return undefined
    // 长度不符 ⇒ 视为哈希碰撞，拒绝写回（宁可少图，不能错图）
    if (blob.bytes !== blob.dataUrl.length) return undefined
    return blob.dataUrl
  }
}

/**
 * 把媒体片里的图**写回**一份（不含图的）bundle。
 *
 * 🔴 与 `mergeShards` 分开是刻意的：备份实际存的是「文字 bundle + 媒体片」两件东西
 *    （文字片沿用既有 `ProjectBundle` 契约，旧代码路径不用改），恢复时只需要这一步拼装。
 *    图片缺失 ⇒ 该字段保持缺省，**不写空串**（写空串会让界面显示"有一张空图"，比没有更糟）。
 */
export function applyMediaToBundle<T extends BundleLike>(bundle: T, media: MediaShard): T {
  const urlOf = mediaAccessor(media)

  const project: Project = { ...bundle.project }
  const cover = urlOf('cover')
  if (cover) project.cover = cover

  const cardRecords: CardRecord[] = bundle.cardRecords.map(card => {
    const p1 = urlOf(`card:${card.id}:portrait`)
    const p2 = urlOf(`card:${card.id}:portrait2`)
    if (!p1 && !p2) return card
    const next = { ...card } as CardRecord & { portrait?: string; portrait2?: string }
    if (p1) next.portrait = p1
    if (p2) next.portrait2 = p2
    return next as CardRecord
  })

  const tableRows: TableRow[] = bundle.tableRows.map(row => {
    const url = urlOf(`row:${row.id}:atlas`)
    if (!url) return row
    return { ...row, atlasImage: { dataUrl: url, mime: mimeOf(url), width: 0, height: 0, bytes: url.length } } as TableRow
  })

  return { ...bundle, project, cardRecords, tableRows }
}

/**
 * 四片合回 `ProjectBundle`。
 *
 * 🔴 三条恢复语义（与方案 §2 的 A 方案一致）：
 *   1. 图片按 `links` 写回；找不到 blob（媒体片被清理）时**保持该字段缺省**，不写空串占位；
 *   2. `blobs` 里的 ref 若因内容哈希碰撞与 bytes 不符，**宁可不写**（宁可少一张图，不能写错图）；
 *   3. 未涉及的字段一律原样带出 —— 恢复后应能通过"再拆一次"得到相同的分片（见单测往返用例）。
 */
export function mergeShards(shards: ProjectShards): BundleLike {
  const base: BundleLike = {
    project: { ...shards.core.project },
    volumes: shards.core.volumes,
    chapters: shards.core.chapters,
    formData: shards.settings.formData,
    tableRows: shards.settings.tableRows,
    cardRecords: shards.settings.cardRecords,
    settings: shards.settings.settings,
    ...(shards.settings.customOptions ? { customOptions: shards.settings.customOptions } : {}),
    ...(shards.stats.dailyStats ? { dailyStats: shards.stats.dailyStats } : {}),
    ...(shards.stats.aiRuns ? { aiRuns: shards.stats.aiRuns } : {}),
    ...(shards.stats.tavernReports ? { tavernReports: shards.stats.tavernReports } : {}),
    ...(shards.settings.snapshots ? { snapshots: shards.settings.snapshots } : {}),
    ...(shards.settings.knowledgeBase ? { knowledgeBase: shards.settings.knowledgeBase } : {}),
  }
  return applyMediaToBundle(base, shards.media)
}

/**
 * **唯一**的「媒体片 + 归属表 → 可写回的 MediaShard」拼接点（3.1.3 · R01）。
 *
 * 🔴 归属表优先用**本份快照自带的** `mediaLinks`；只有旧备份没带时才回退到媒体片里的 `links`。
 *    这条优先级就是 R01 的修复本体 —— 共用媒体片里的 links 属于"第一次写它的那次备份"，
 *    谁后恢复到谁头上就错了（交换两张立绘后恢复出旧归属，已复现）。
 *
 * 拉成纯函数是为了让"交换归属"这条回归能脱离 IndexedDB 直接钉死（见 `tests/backupShards`）。
 */
export function composeBackupMedia(media: MediaShard, mediaLinks?: readonly MediaLink[]): MediaShard {
  const blobs = Array.isArray(media?.blobs) ? media.blobs : []
  const fallback = Array.isArray(media?.links) ? media.links : []
  return { blobs, links: mediaLinks ? [...mediaLinks] : fallback }
}

/** 各片体积（字符数，与备份 meta 的 bytes 同口径）—— 备份列表据此显示"文字 / 图片"拆分 */
export function shardChars(shards: ProjectShards): Record<ShardId, number> {
  return {
    core: JSON.stringify(shards.core).length,
    settings: JSON.stringify(shards.settings).length,
    media: JSON.stringify(shards.media).length,
    stats: JSON.stringify(shards.stats).length,
  }
}
