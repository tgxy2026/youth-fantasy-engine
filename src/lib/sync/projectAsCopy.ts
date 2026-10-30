// ============ 3.3.2 · B3-1 另存为新书（云端快照 → 本地副本）============
//
// 【它补的是哪一段】`projectPull` 能把云端版本下载下来并算出 `planApply`，但 `planApply`
//   的语义是「按 id 原地替换」——执行它要改写原项目的 10 类记录与双前缀
//   （`settingsKV` 的 `pid::` 与 `customOption::pid::`、`formData` 的 tabId、快照 chapterId 联动…），
//   错一处就是数据损坏，且自动化验不出「写完的书还能不能正常打开」。
//
//   「另存为新书」走另一条路：**不碰原项目**，把云端内容装成一个全新的本地项目。
//   所有 id 重映射都交给既有的 `importProject()` —— 它已经踩过并修好了这些坑：
//     · 章节快照的 chapterId 必须跟着换（否则时光机一片空白）
//     · 卷台账行的 tabId 内嵌卷 id，必须换（否则台账数据全丢）
//     · `worldSubActive::<tabId>` 里的子项活跃态要跟着 cardRecords 换 id
//     · 两套设置前缀（`pid::` / `customOption::pid::`）必须各自重建
//   ⇒ 本模块只做「把分片还原成 ProjectBundle 的形状」这一件事，**绝不重写一遍 id 规则**。
//     复制一份必然漂移，而漂移方向永远是「导入后的书看起来正常、某个角落少了东西」。
//
// 🔴 未知 kind 一律拒绝：宁可这次不另存，也不要把本版本不认识的数据静默丢掉。
// 🔴 纯函数：不读库、不写库、不联网，入参一个字段都不改（单测钉着）。
import type { ProjectBundle } from '@/lib/db/projects'
import type { Project } from '@/lib/types'
import type { SnapshotManifest } from '@/lib/sync/projectSnapshot'
import { KNOWN_KINDS } from '@/lib/sync/projectApply'

export type AsCopyCode =
  | 'OK'
  /** 清单格式不认识 */
  | 'PROTOCOL'
  /** 还有内容没下齐 */
  | 'MISSING_OBJECT'
  /** 云端有本版本不认识的数据类型 */
  | 'UNKNOWN_KIND'
  /** 清单里一类记录都没有 */
  | 'NO_CONTENT'

export interface AsCopyInput {
  manifest: SnapshotManifest & { revision?: number; snapshotId?: string }
  /** 已下载并校验通过的对象载荷：hash → 记录数组（图片已由 projectPull 还原） */
  loaded: Record<string, Record<string, unknown>[]>
  /**
   * 本机原项目（可选）。只用来继承**元数据**：简介、封面、自定义功能…
   * 云端清单目前只带名称 / 题材 / 形态（见 `projectSnapshot` 的 `manifest.project`）。
   * 传 null 时会用清单里的最少信息新建，并在 `omitted` 里如实说明。
   */
  baseProject?: Project | null
  /** 副本名；不传则「原名（云端副本）」 */
  name?: string
  now?: number
}

export interface AsCopyResult {
  ok: boolean
  code: AsCopyCode
  /** 中文人话原因（可直接显示，别让界面再翻译） */
  reason: string
  /** 可交给 `importProject()` 的项目包；`ok:false` 时为 null */
  bundle: ProjectBundle | null
  stats: { put: number; kinds: string[] }
  /** 副本没带过来的东西 —— 如实告知，不假装完整 */
  omitted: string[]
  /** 快照身份，写入成功后上层用来记「这份副本来自哪一版」 */
  snapshotId: string
  revision: number
}

/** 快照 kind → ProjectBundle 字段（未列出的 kind 由 KNOWN_KINDS 拦掉） */
const BUNDLE_FIELD = {
  chapters: 'chapters',
  volumes: 'volumes',
  tableRows: 'tableRows',
  cardRecords: 'cardRecords',
  formData: 'formData',
  settings: 'settings',
  dailyStats: 'dailyStats',
  aiRuns: 'aiRuns',
  tavernReports: 'tavernReports',
  snapshots: 'snapshots',
} as const

type BundleField = typeof BUNDLE_FIELD[keyof typeof BUNDLE_FIELD]

/**
 * 生成「另存为新书」的项目包。**不动任何数据**，只回答「要写哪些内容」。
 */
export function planAsCopy(input: AsCopyInput): AsCopyResult {
  const now = input.now ?? Date.now()
  const manifest = input.manifest
  const empty = (code: AsCopyCode, reason: string): AsCopyResult => ({
    ok: false, code, reason, bundle: null,
    stats: { put: 0, kinds: [] }, omitted: [],
    snapshotId: manifest?.snapshotId || '', revision: manifest?.revision ?? 0,
  })

  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.objects)) {
    return empty('PROTOCOL', '云端清单格式无法识别，本机未做任何改动')
  }

  // ① 完整性：清单列出的每个对象都必须已经拿到
  const missing: string[] = []
  for (const o of manifest.objects) {
    if (!o?.hash || !Array.isArray(input.loaded[o.hash])) missing.push(String(o?.hash || '(空哈希)'))
  }
  if (missing.length) {
    return empty('MISSING_OBJECT', `还有 ${missing.length} 份内容没下载完，本次不另存（避免得到一本残缺的书）`)
  }

  // ② 未知类型：拒绝整次另存
  const unknown = manifest.objects
    .map((o) => String(o?.kind || ''))
    .filter((k) => !(KNOWN_KINDS as readonly string[]).includes(k))
  if (unknown.length) {
    return empty('UNKNOWN_KIND', `云端有本版本不认识的数据类型（${[...new Set(unknown)].join('、')}），请升级软件后再试`)
  }

  // ③ 已知 kind 必须有字段映射：`KNOWN_KINDS` 加了新项却忘了 `BUNDLE_FIELD` 时，
  //    记录会被静默跳过 —— 宁可报错，也不能交出一本少了一类数据的副本。
  const unmapped = manifest.objects
    .map((o) => String(o?.kind || ''))
    .filter((k) => (KNOWN_KINDS as readonly string[]).includes(k) && !(k in BUNDLE_FIELD))
  if (unmapped.length) {
    return empty('PROTOCOL', `本版本还不会还原这些数据类型（${[...new Set(unmapped)].join('、')}），请升级软件后再试`)
  }

  // ④ 按 kind 合并记录（同一类正常只有一个对象，合并是为了不丢任何一片）
  const byField = new Map<BundleField, Record<string, unknown>[]>()
  let put = 0
  const kinds: string[] = []
  for (const o of manifest.objects) {
    const field = BUNDLE_FIELD[o.kind as keyof typeof BUNDLE_FIELD]
    if (!field) continue
    const rows = input.loaded[o.hash]
    const list = byField.get(field) ?? []
    list.push(...rows)
    byField.set(field, list)
    put += rows.length
    kinds.push(String(o.kind))
  }

  if (put === 0) {
    return empty('NO_CONTENT', '云端这一版没有作品内容，未另存。')
  }

  // ⑤ 项目元数据：有本机原项目就继承它（简介 / 封面 / 自定义功能），
  //    没有则只能用清单里的名称 / 题材 / 形态 —— 这是清单当前的字段边界。
  const base = input.baseProject ?? null
  const baseName = base?.name || manifest.project?.name || '未命名'
  const name = input.name?.trim() || `${baseName}（云端副本）`
  const project: Project = base
    ? { ...base, name, createdAt: now, updatedAt: now }
    : {
        id: '',
        name,
        genre: manifest.project?.genre || '',
        intro: '',
        createdAt: now,
        updatedAt: now,
        projectType: manifest.project?.projectType === 'custom' ? 'custom' : 'full',
      }

  const omitted: string[] = []
  if (!base) omitted.push('作品简介、封面与自定义功能（云端清单只带名称、题材与形态）')
  // 当前快照协议没有 customOptions 分片：自定义下拉选项传不过去。
  // 不在这里"顺便补一个 kind"——协议变更要单独评估并升版本，先如实说明。
  omitted.push('自定义下拉选项（当前同步协议未包含）')

  const rows = (field: BundleField): Record<string, unknown>[] => byField.get(field) ?? []

  const bundle: ProjectBundle = {
    app: 'youth-fantasy-engine',
    version: 3,
    exportedAt: now,
    project,
    volumes: rows('volumes') as unknown as ProjectBundle['volumes'],
    chapters: rows('chapters') as unknown as ProjectBundle['chapters'],
    formData: rows('formData') as unknown as ProjectBundle['formData'],
    tableRows: rows('tableRows') as unknown as ProjectBundle['tableRows'],
    cardRecords: rows('cardRecords') as unknown as ProjectBundle['cardRecords'],
    dailyStats: rows('dailyStats') as unknown as ProjectBundle['dailyStats'],
    settings: rows('settings') as unknown as ProjectBundle['settings'],
    tavernReports: rows('tavernReports') as unknown as ProjectBundle['tavernReports'],
    aiRuns: rows('aiRuns') as unknown as ProjectBundle['aiRuns'],
    snapshots: rows('snapshots') as unknown as ProjectBundle['snapshots'],
  }

  return {
    ok: true,
    code: 'OK',
    reason: '',
    bundle,
    stats: { put, kinds: [...new Set(kinds)] },
    omitted,
    snapshotId: manifest.snapshotId || '',
    revision: manifest.revision ?? 0,
  }
}