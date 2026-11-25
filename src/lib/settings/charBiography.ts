// ============ 人物小传（3.7.1 · W1）============
//
// 角色生平小传正文 + 重要节点事件轴（服务主要角色 / 次要角色）：
//   · 与「状态演变（stateTrack）」的分工：状态演变记单章结束时的原子快照，
//     人物小传记完整生平长文与里程碑级转折节点，互不覆盖、支持按需单向引入。
//   · 主键采用稳定 `CardRecord.id`（不以姓名作键），角色改名或跨页签升降级不丢小传。
//
// 🔴 数据安全红线：
//   · 写入一律走模块级串行链（防手动保存与章后整理并发交错）；
//   · 读库失败即中止写入（绝不拿空对象当基线覆盖整本小传）；
//   · AI 抽取只追加去重，不覆盖作者已有正文或节点。
//
// 存储：项目级 settingsKV 键 `charBiographies`（随项目隔离，同步/备份通用）。
import * as db from '@/lib/db'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import type { StateRecord } from '@/lib/settings/stateTrack'

export const CHAR_BIOGRAPHY_KEY = 'charBiographies'
/** 单角色节点上限（防止异常高频写入膨胀）；超限如实返回 overflow */
export const BIO_NODE_LIMIT = 200
/** 自定义节点类型在 customOptions 中的列名（与 CustomSelect 共用） */
export const BIO_TAG_COL_NAME = '节点类型'

export type BioNodePhase = 'prequel' | 'story'
export type BioNodeTag = string

export const BIO_NODE_TAGS = [
  '前传背景',
  '成长突破',
  '关系转折',
  '高光时刻',
  '重大失去',
  '身份变化',
  '其他',
] as const

export type BioNodeSource = 'manual' | 'post-process' | 'batch-scan' | 'state-promote'

export interface BioEventNode {
  id: string
  /** 前传（开篇前）或正文阶段 */
  phase: BioNodePhase
  /** 正文阶段关联章 id（有则支持跳回正文编辑器） */
  chapterId?: string
  /** 叙事章号（前传为 0；正文阶段 > 0，按章号升序排列） */
  chapterNo: number
  /** 前传节点手动排序号（仅 phase='prequel' 生效） */
  order: number
  /** 可选故事内时间（自由文本，如「灵历3015年冬」） */
  storyTime?: string
  /** 节点标题（一句话概括） */
  title: string
  /** 事件经过与心理/立场转折 */
  summary: string
  tag: BioNodeTag
  /** 来源标记 */
  source: BioNodeSource
  /** 原文证据片段（AI 整理时可溯源） */
  evidence?: string
  createdAt: number
  updatedAt: number
}

export interface CharacterBiography {
  characterId: string
  /** 上层：人物生平小传正文（自由分段长文本） */
  prose: string
  /** 下层：重要节点事件轴 */
  nodes: BioEventNode[]
  /** 最近一次 AI 批量扫描覆盖到的最大章号 */
  lastScannedChapterNo?: number
  updatedAt: number
}

type BioMap = Record<string, CharacterBiography>

const VALID_SOURCES = new Set<BioNodeSource>(['manual', 'post-process', 'batch-scan', 'state-promote'])

function normalizeChapterNo(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function normalizeTag(tag: unknown, fallbackPhase: BioNodePhase): BioNodeTag {
  const s = typeof tag === 'string' ? tag.trim() : ''
  if (s) return s.slice(0, 24)
  return fallbackPhase === 'prequel' ? '前传背景' : '其他'
}

function validNode(v: unknown): v is BioEventNode {
  if (!v || typeof v !== 'object') return false
  const n = v as Partial<BioEventNode>
  return typeof n.id === 'string' && n.id.trim().length > 0
    && (n.phase === 'prequel' || n.phase === 'story')
    && typeof n.chapterNo === 'number' && Number.isFinite(n.chapterNo)
    && typeof n.order === 'number' && Number.isFinite(n.order)
    && typeof n.title === 'string'
    && typeof n.summary === 'string'
    && VALID_SOURCES.has(n.source as BioNodeSource)
}

function validBiography(key: string, v: unknown): CharacterBiography | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Partial<CharacterBiography>
  if (typeof b.prose !== 'string' || !Array.isArray(b.nodes)) return null
  const characterId = typeof b.characterId === 'string' && b.characterId.trim() ? b.characterId : key
  return {
    characterId,
    prose: b.prose,
    nodes: sortBioNodes(b.nodes.filter(validNode)),
    ...(typeof b.lastScannedChapterNo === 'number' && Number.isFinite(b.lastScannedChapterNo) && b.lastScannedChapterNo > 0
      ? { lastScannedChapterNo: Math.floor(b.lastScannedChapterNo) }
      : {}),
    updatedAt: typeof b.updatedAt === 'number' && Number.isFinite(b.updatedAt) ? b.updatedAt : 0,
  }
}

function sanitizeMap(raw: unknown): BioMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: BioMap = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k.trim()) continue
    const bio = validBiography(k, v)
    if (bio) out[k] = bio
  }
  return out
}

/** 构造空人物小传对象 */
export function emptyBiography(characterId: string): CharacterBiography {
  return { characterId, prose: '', nodes: [], updatedAt: 0 }
}

/** 构造一条标准重要节点 */
export function buildBioNode(input: {
  id?: string
  phase: BioNodePhase
  chapterId?: string
  chapterNo?: number
  order?: number
  storyTime?: string
  title: string
  summary?: string
  tag?: BioNodeTag | string
  source?: BioNodeSource
  evidence?: string
  now?: number
}): BioEventNode {
  const now = input.now ?? Date.now()
  const chapterNo = input.phase === 'story' ? normalizeChapterNo(input.chapterNo) : 0
  const phase: BioNodePhase = input.phase === 'story' && chapterNo > 0 ? 'story' : 'prequel'
  const id = input.id?.trim() || `bio-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    phase,
    ...(input.chapterId?.trim() ? { chapterId: input.chapterId.trim() } : {}),
    chapterNo: phase === 'story' ? chapterNo : 0,
    order: typeof input.order === 'number' && Number.isFinite(input.order) ? Math.floor(input.order) : 0,
    ...(input.storyTime?.trim() ? { storyTime: input.storyTime.trim() } : {}),
    title: input.title.trim(),
    summary: (input.summary ?? '').trim(),
    tag: normalizeTag(input.tag, phase),
    source: input.source && VALID_SOURCES.has(input.source) ? input.source : 'manual',
    ...(input.evidence?.trim() ? { evidence: input.evidence.trim().slice(0, 120) } : {}),
    createdAt: now,
    updatedAt: now,
  }
}

/** 排序规则：前传（prequel）在前按 order 升序；正文（story）在后按 chapterNo 升序；同位按 createdAt 升序 */
export function sortBioNodes(nodes: readonly BioEventNode[]): BioEventNode[] {
  return [...nodes].sort((a, b) => {
    if (a.phase !== b.phase) return a.phase === 'prequel' ? -1 : 1
    if (a.phase === 'prequel') {
      return (a.order - b.order) || (a.createdAt - b.createdAt) || a.id.localeCompare(b.id)
    }
    return (a.chapterNo - b.chapterNo) || (a.createdAt - b.createdAt) || a.id.localeCompare(b.id)
  })
}

/**
 * 调整前传节点顺序（仅在 phase='prequel' 内部上移/下移一位，并规范重排 order）。
 * 边界或找不到时原样返回，不改动正文节点。
 */
export function reorderPrequelNode(
  nodes: readonly BioEventNode[],
  nodeId: string,
  dir: -1 | 1,
): BioEventNode[] {
  const sorted = sortBioNodes(nodes)
  const prequels = sorted.filter(n => n.phase === 'prequel')
  const idx = prequels.findIndex(n => n.id === nodeId)
  if (idx < 0) return sorted
  const targetIdx = idx + dir
  if (targetIdx < 0 || targetIdx >= prequels.length) return sorted
  const moved = [...prequels]
  const [item] = moved.splice(idx, 1)
  moved.splice(targetIdx, 0, item)
  const renumbered = moved.map((n, i) => ({ ...n, order: i }))
  const stories = sorted.filter(n => n.phase === 'story')
  return [...renumbered, ...stories]
}

function normTitle(s: string): string {
  return s.replace(/[\s，。、“”"‘’'：:；;！？!?,.\-—·()（）【】[\]]+/g, '').toLowerCase()
}

/**
 * 判重：同 phase + 同 chapterNo 下，归一化标题相同或（标题均空时）归一化摘要相同即视为重复。
 */
export function isDuplicateBioNode(
  existing: readonly BioEventNode[],
  candidate: Pick<BioEventNode, 'phase' | 'chapterNo' | 'title' | 'summary'>,
): boolean {
  const ct = normTitle(candidate.title)
  const cs = normTitle(candidate.summary)
  return existing.some(n => {
    if (n.phase !== candidate.phase || n.chapterNo !== candidate.chapterNo) return false
    const nt = normTitle(n.title)
    if (ct && nt && nt === ct) return true
    const ns = normTitle(n.summary)
    return !!ct && !!cs && nt === ct && ns === cs
  })
}

/**
 * 将 3.7.0 状态演变记录转为「人物小传节点」（零 AI 消耗提拔）。
 * chapterNo > 0 归入正文阶段；chapterNo <= 0 归入前传阶段。
 */
export function bioNodeFromStateRecord(record: StateRecord, order = 0, now = Date.now()): BioEventNode {
  const hasChapter = normalizeChapterNo(record.chapterNo) > 0
  const phase: BioNodePhase = hasChapter ? 'story' : 'prequel'
  const stateText = record.state.trim()
  const prevText = record.previous?.trim()
  const triggerText = record.trigger?.trim()
  const summaryParts = [
    prevText ? `变化前：${prevText}；变化后：${stateText}` : `状态记录：${stateText}`,
    triggerText ? `触发：${triggerText}` : '',
  ].filter(Boolean)
  return buildBioNode({
    phase,
    chapterId: record.chapterId || undefined,
    chapterNo: record.chapterNo,
    order,
    title: stateText.length > 24 ? `${stateText.slice(0, 24)}…` : stateText,
    summary: summaryParts.join('。'),
    tag: hasChapter ? '身份变化' : '前传背景',
    source: 'state-promote',
    evidence: record.evidence,
    now,
  })
}

/** 导出单角色角色小传为 Markdown */
export function formatBiographyMarkdown(
  characterName: string,
  tierLabel: string,
  bio: CharacterBiography,
): string {
  const name = characterName.trim() || '未命名角色'
  const lines: string[] = [`# ${name} · 角色小传`, '']
  if (tierLabel.trim()) {
    lines.push(`> 定位：${tierLabel.trim()}`, '')
  }
  lines.push('## 一、角色生平小传', '')
  lines.push(bio.prose.trim() || '（暂未编写小传正文）', '')
  lines.push('## 二、重要节点事件轴', '')
  const sorted = sortBioNodes(bio.nodes)
  if (sorted.length === 0) {
    lines.push('（暂无重要节点记录）', '')
    return lines.join('\n')
  }
  const prequels = sorted.filter(n => n.phase === 'prequel')
  const stories = sorted.filter(n => n.phase === 'story')
  if (prequels.length > 0) {
    lines.push('### 开篇前（前传）', '')
    for (const n of prequels) {
      const time = n.storyTime ? `（${n.storyTime}）` : ''
      lines.push(`- **[${n.tag}] ${n.title}**${time}`)
      if (n.summary) lines.push(`  - ${n.summary}`)
      if (n.evidence) lines.push(`  - 原文依据：「${n.evidence}」`)
    }
    lines.push('')
  }
  if (stories.length > 0) {
    lines.push('### 正文阶段', '')
    for (const n of stories) {
      const time = n.storyTime ? ` · ${n.storyTime}` : ''
      lines.push(`- **第${n.chapterNo}章${time} · [${n.tag}] ${n.title}**`)
      if (n.summary) lines.push(`  - ${n.summary}`)
      if (n.evidence) lines.push(`  - 原文依据：「${n.evidence}」`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ============ 存储读写与串行锁 ============

let writeChain: Promise<unknown> = Promise.resolve()
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.then(() => undefined, () => undefined)
  return run
}

async function readMapStrict(owner?: OwnedOperation): Promise<{ ok: true; map: BioMap } | { ok: false }> {
  try {
    const raw = owner
      ? await db.getSettingFor<unknown>(owner.projectId, CHAR_BIOGRAPHY_KEY, {}, owner)
      : await db.getSetting<unknown>(CHAR_BIOGRAPHY_KEY, {})
    return { ok: true, map: sanitizeMap(raw) }
  } catch {
    return { ok: false }
  }
}

async function writeMapStrict(map: BioMap, owner?: OwnedOperation): Promise<boolean> {
  try {
    if (owner) await db.setSettingFor(owner.projectId, CHAR_BIOGRAPHY_KEY, map, owner)
    else await db.setSetting(CHAR_BIOGRAPHY_KEY, map)
    return true
  } catch {
    return false
  }
}

/** 读取全部角色小传（只读：损坏或异常返回空映射，不抛错） */
export async function readAllBiographies(owner?: OwnedOperation): Promise<BioMap> {
  const res = await readMapStrict(owner)
  return res.ok ? res.map : {}
}

/** 读取单个角色小传（未建立返回 null） */
export async function readBiography(characterId: string, owner?: OwnedOperation): Promise<CharacterBiography | null> {
  if (!characterId.trim()) return null
  const all = await readAllBiographies(owner)
  return all[characterId] ?? null
}

/** 保存人物小传正文（读失败即中止写入） */
export async function saveBiographyProse(
  characterId: string,
  prose: string,
  owner?: OwnedOperation,
): Promise<{ ok: boolean; bio?: CharacterBiography }> {
  if (!characterId.trim()) return { ok: false }
  return serialized(async () => {
    const read = await readMapStrict(owner)
    if (!read.ok) return { ok: false }
    const existing = read.map[characterId] ?? emptyBiography(characterId)
    const nextBio: CharacterBiography = {
      ...existing,
      characterId,
      prose,
      updatedAt: Date.now(),
    }
    const nextMap: BioMap = { ...read.map, [characterId]: nextBio }
    if (!await writeMapStrict(nextMap, owner)) return { ok: false }
    return { ok: true, bio: nextBio }
  })
}

/** 只追加重要节点（自动按 id 与标题去重；超出 BIO_NODE_LIMIT 如实返回 overflow） */
export async function appendBioNodes(
  characterId: string,
  incoming: readonly BioEventNode[],
  opts?: { lastScannedChapterNo?: number },
  owner?: OwnedOperation,
): Promise<{ ok: boolean; appended: number; skippedDup: number; overflow: number; total: number }> {
  if (!characterId.trim()) return { ok: false, appended: 0, skippedDup: 0, overflow: 0, total: 0 }
  return serialized(async () => {
    const read = await readMapStrict(owner)
    if (!read.ok) return { ok: false, appended: 0, skippedDup: 0, overflow: 0, total: 0 }
    const existing = read.map[characterId] ?? emptyBiography(characterId)
    const baseNodes = [...existing.nodes]
    const seenIds = new Set(baseNodes.map(n => n.id))
    let skippedDup = 0
    const accepted: BioEventNode[] = []

    for (const rawNode of incoming) {
      if (!validNode(rawNode)) continue
      if (seenIds.has(rawNode.id) || isDuplicateBioNode([...baseNodes, ...accepted], rawNode)) {
        skippedDup++
        continue
      }
      seenIds.add(rawNode.id)
      accepted.push(rawNode)
    }

    const scanNo = normalizeChapterNo(opts?.lastScannedChapterNo)
    const prevScan = existing.lastScannedChapterNo ?? 0
    const needScanUpdate = scanNo > prevScan

    if (accepted.length === 0 && !needScanUpdate) {
      return { ok: true, appended: 0, skippedDup, overflow: 0, total: baseNodes.length }
    }

    const merged = sortBioNodes([...baseNodes, ...accepted])
    const kept = merged.slice(0, BIO_NODE_LIMIT)
    const overflow = Math.max(0, merged.length - kept.length)
    const keptIds = new Set(kept.map(n => n.id))
    const actualAppended = accepted.filter(n => keptIds.has(n.id)).length

    const nextBio: CharacterBiography = {
      ...existing,
      characterId,
      nodes: kept,
      ...(needScanUpdate ? { lastScannedChapterNo: scanNo } : {}),
      updatedAt: Date.now(),
    }
    const nextMap: BioMap = { ...read.map, [characterId]: nextBio }
    if (!await writeMapStrict(nextMap, owner)) {
      return { ok: false, appended: 0, skippedDup: 0, overflow: 0, total: existing.nodes.length }
    }
    return { ok: true, appended: actualAppended, skippedDup, overflow, total: kept.length }
  })
}

/** 新增或更新单条节点（手动编辑/新增用） */
export async function upsertBioNode(
  characterId: string,
  node: BioEventNode,
  owner?: OwnedOperation,
): Promise<{ ok: boolean; total: number; overflow: number }> {
  if (!characterId.trim() || !validNode(node)) return { ok: false, total: 0, overflow: 0 }
  return serialized(async () => {
    const read = await readMapStrict(owner)
    if (!read.ok) return { ok: false, total: 0, overflow: 0 }
    const existing = read.map[characterId] ?? emptyBiography(characterId)
    const idx = existing.nodes.findIndex(n => n.id === node.id)
    const nextList = idx >= 0
      ? existing.nodes.map((n, i) => (i === idx ? { ...node, updatedAt: Date.now() } : n))
      : [...existing.nodes, node]
    const sorted = sortBioNodes(nextList)
    const kept = sorted.slice(0, BIO_NODE_LIMIT)
    const overflow = Math.max(0, sorted.length - kept.length)
    const nextBio: CharacterBiography = {
      ...existing,
      characterId,
      nodes: kept,
      updatedAt: Date.now(),
    }
    const nextMap: BioMap = { ...read.map, [characterId]: nextBio }
    if (!await writeMapStrict(nextMap, owner)) return { ok: false, total: existing.nodes.length, overflow: 0 }
    return { ok: true, total: kept.length, overflow }
  })
}

/** 删除单条节点 */
export async function deleteBioNode(
  characterId: string,
  nodeId: string,
  owner?: OwnedOperation,
): Promise<{ ok: boolean; deleted: boolean; total: number }> {
  if (!characterId.trim() || !nodeId.trim()) return { ok: false, deleted: false, total: 0 }
  return serialized(async () => {
    const read = await readMapStrict(owner)
    if (!read.ok) return { ok: false, deleted: false, total: 0 }
    const existing = read.map[characterId]
    if (!existing) return { ok: true, deleted: false, total: 0 }
    const nextNodes = existing.nodes.filter(n => n.id !== nodeId)
    if (nextNodes.length === existing.nodes.length) return { ok: true, deleted: false, total: existing.nodes.length }
    const nextBio: CharacterBiography = {
      ...existing,
      characterId,
      nodes: nextNodes,
      updatedAt: Date.now(),
    }
    const nextMap: BioMap = { ...read.map, [characterId]: nextBio }
    if (!await writeMapStrict(nextMap, owner)) return { ok: false, deleted: false, total: existing.nodes.length }
    return { ok: true, deleted: true, total: nextNodes.length }
  })
}

/** 持久化调整前传节点顺序 */
export async function reorderCharacterPrequelNode(
  characterId: string,
  nodeId: string,
  dir: -1 | 1,
  owner?: OwnedOperation,
): Promise<{ ok: boolean }> {
  if (!characterId.trim() || !nodeId.trim()) return { ok: false }
  return serialized(async () => {
    const read = await readMapStrict(owner)
    if (!read.ok) return { ok: false }
    const existing = read.map[characterId]
    if (!existing) return { ok: false }
    const nextNodes = reorderPrequelNode(existing.nodes, nodeId, dir)
    const nextBio: CharacterBiography = {
      ...existing,
      characterId,
      nodes: nextNodes,
      updatedAt: Date.now(),
    }
    const nextMap: BioMap = { ...read.map, [characterId]: nextBio }
    return { ok: await writeMapStrict(nextMap, owner) }
  })
}

/** 记录最近一次 AI 批量扫描的最大章号 */
export async function updateLastScannedChapter(
  characterId: string,
  chapterNo: number,
  owner?: OwnedOperation,
): Promise<{ ok: boolean }> {
  const no = normalizeChapterNo(chapterNo)
  if (!characterId.trim() || no <= 0) return { ok: false }
  return serialized(async () => {
    const read = await readMapStrict(owner)
    if (!read.ok) return { ok: false }
    const existing = read.map[characterId] ?? emptyBiography(characterId)
    if ((existing.lastScannedChapterNo ?? 0) >= no) return { ok: true }
    const nextBio: CharacterBiography = {
      ...existing,
      characterId,
      lastScannedChapterNo: no,
      updatedAt: Date.now(),
    }
    const nextMap: BioMap = { ...read.map, [characterId]: nextBio }
    return { ok: await writeMapStrict(nextMap, owner) }
  })
}

/** 批量重命名已有节点中的类型标签（配合 CustomSelect 内置/自定义选项改名同步既有节点） */
export async function renameBioNodeTag(
  oldTag: string,
  newTag: string,
  owner?: OwnedOperation,
): Promise<{ ok: boolean; updated: number }> {
  const prev = oldTag.trim()
  const next = newTag.trim().slice(0, 24)
  if (!prev || !next || prev === next) return { ok: true, updated: 0 }
  return serialized(async () => {
    const read = await readMapStrict(owner)
    if (!read.ok) return { ok: false, updated: 0 }
    let updated = 0
    const nextMap: BioMap = {}
    const now = Date.now()
    for (const [charId, bio] of Object.entries(read.map)) {
      let changed = false
      const nextNodes = bio.nodes.map(n => {
        if (n.tag !== prev) return n
        changed = true
        updated++
        return { ...n, tag: next, updatedAt: now }
      })
      nextMap[charId] = changed ? { ...bio, nodes: nextNodes, updatedAt: now } : bio
    }
    if (updated === 0) return { ok: true, updated: 0 }
    if (!await writeMapStrict(nextMap, owner)) return { ok: false, updated: 0 }
    return { ok: true, updated }
  })
}
