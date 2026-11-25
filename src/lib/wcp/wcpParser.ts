// ============ WCP 网页资料包 · 双段解析器（3.7.3 · W2）============
//
// 把网页模型返回的「两段式回复」拆成：
//   · Part 1 纯净结果正文（正文 / 润色稿 / 细纲 / 审校报告 / 小传）；
//   · Part 2 结构化变动摘要（JSON 默认 / 固定 Markdown 清单备选）。
//
// 🔴 第一铁律：**任何情况下都不丢 Part 1**。
//    哪怕 Part 2 是彻底损坏的 JSON，`body` 仍逐字保留；UI 照常可复制 / 入章。
//    解析失败只体现在 `jsonFailed` 与 `warnings`，不允许抛异常。
// 🔴 JSON 不用裸 `JSON.parse`：统一走 `aiParse.parseLooseObject`（剥代码块、清尾逗号、截断修复），
//    与全站「模型文本 → 结构化数据」同一条口径（结构闸 ④）。
// 🔴 退化识别（规划 §3.3.1）：分隔符缺失时按 `## 第一部分` / `## 变动摘要` / 尾部 ```json 块
//    安全切分；完全找不到第二部分时整段归入 Part 1。
import { parseLooseObject } from '@/lib/ai/aiParse'
import type {
  ExtractedBioNode,
  ExtractedEntity,
  ExtractedForeshadow,
  ExtractedRelation,
  ExtractedResource,
  ExtractedStatus,
  SettingEntityType,
} from '@/lib/ai/aiTasks'
import {
  WCP_BODY_END,
  WCP_BODY_START,
  WCP_CHANGES_END,
  WCP_CHANGES_START,
} from '@/lib/wcp/wcpTemplates'
import type { WcpSummaryFormat } from '@/lib/wcp/wcpTypes'

/** Part 2 归一化后的 6 类候选（结构与 `chapterPostProcess` 的比对器输入一一对应） */
export interface WcpParsedChanges {
  entities: ExtractedEntity[]
  statuses: ExtractedStatus[]
  resources: ExtractedResource[]
  foreshadows: ExtractedForeshadow[]
  relations: ExtractedRelation[]
  biographies: ExtractedBioNode[]
}

/** Markdown 清单的一段（`### 新登场设定` 这类三级标题） */
export interface WcpMarkdownCard {
  section: string
  items: string[]
}

export interface WcpParseResult {
  /** Part 1：**永远保留**的纯净正文 */
  body: string
  /** Part 2 原文（可能为空） */
  rawChanges: string
  changes: WcpParsedChanges
  /** 实际识别到的第二部分格式 */
  format: 'json' | 'markdown' | 'none'
  /** 是否尝试过 JSON（决定要不要亮「一键切 Markdown」提醒条） */
  jsonAttempted: boolean
  /** JSON 尝试失败（语法 / 结构不符合契约 / 该出 JSON 却给了 Markdown） */
  jsonFailed: boolean
  /** 缺分隔符、字段丢弃等如实提示 */
  warnings: string[]
  /** Markdown 清单卡片（试解析台 / 回流弹窗直接展示） */
  markdownCards: WcpMarkdownCard[]
  hasPart1Marker: boolean
  hasPart2Marker: boolean
}

const EMPTY_CHANGES: WcpParsedChanges = {
  entities: [], statuses: [], resources: [], foreshadows: [], relations: [], biographies: [],
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function recordOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

/** 契约里的中文类型 → `SettingEntityType`（制度 / 其他归入「术语」，避免被 classify 静默丢弃） */
function entityTypeOf(v: string): SettingEntityType {
  switch (v) {
    case '人物': return '人物'
    case '势力': return '势力'
    case '地点': return '地点'
    case '种族': return '种族'
    case '物品': return '物品'
    default: return '术语'
  }
}

function resourceActionOf(v: string): ExtractedResource['action'] {
  return v === '获得' || v === '失去' || v === '消耗' ? v : '转移'
}

function foreshadowActionOf(v: string): ExtractedForeshadow['action'] {
  return v === '回收' ? '回收' : '埋设'
}

/** 有序地找最后一个 Markdown 代码块（模型常把 JSON 放在回复末尾） */
function lastCodeFence(text: string): { start: number; end: number; content: string } | null {
  const re = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g
  let hit: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) hit = m
  if (!hit) return null
  return { start: hit.index, end: hit.index + hit[0].length, content: hit[1] }
}

function headingIndex(text: string, names: readonly string[]): number {
  for (const name of names) {
    const re = new RegExp(`^##\\s*${name}\\s*$`, 'm')
    const m = re.exec(text)
    if (m && typeof m.index === 'number') return m.index
  }
  return -1
}

/**
 * 切分两段。返回的 body 不含任何分隔标记。
 *
 * 注意顺序：先认完整标记 → 再认 `## 第一部分` → 再认尾部代码块 → 最后整段归 Part 1。
 */
function splitParts(raw: string): {
  body: string
  changes: string
  hasPart1Marker: boolean
  hasPart2Marker: boolean
  warnings: string[]
} {
  const text = raw.replace(/\r\n?/g, '\n')
  const warnings: string[] = []
  const bStart = text.indexOf(WCP_BODY_START)
  const bEnd = text.indexOf(WCP_BODY_END)
  const cStart = text.indexOf(WCP_CHANGES_START)
  const cEnd = text.indexOf(WCP_CHANGES_END)

  let body = ''
  let changes = ''
  let hasPart1Marker = false
  let hasPart2Marker = false

  if (bStart >= 0) {
    hasPart1Marker = true
    const from = bStart + WCP_BODY_START.length
    const candidates = [bEnd, cStart].filter(n => n > from)
    const to = candidates.length ? Math.min(...candidates) : text.length
    body = text.slice(from, to)
    if (bEnd < 0) warnings.push('回复缺少正文结束标记，已按下一个段落边界切分。')
    const afterBody = to
    if (cStart >= 0 && cStart >= afterBody) {
      hasPart2Marker = true
      const end = cEnd > cStart ? cEnd : text.length
      changes = text.slice(cStart + WCP_CHANGES_START.length, end)
      if (cEnd < 0) warnings.push('回复缺少变动摘要结束标记，已取到文本末尾。')
    }
  } else {
    const p1 = headingIndex(text, ['第一部分'])
    const p2 = headingIndex(text, ['变动摘要', '第二部分'])
    if (p1 >= 0) {
      hasPart1Marker = true
      const from = text.indexOf('\n', p1) >= 0 ? text.indexOf('\n', p1) + 1 : p1
      const to = p2 > from ? p2 : (cStart > from ? cStart : text.length)
      body = text.slice(from, to)
    } else if (cStart >= 0) {
      hasPart1Marker = true
      body = text.slice(0, cStart)
    }

    if (cStart >= 0) {
      hasPart2Marker = true
      const end = cEnd > cStart ? cEnd : text.length
      changes = text.slice(cStart + WCP_CHANGES_START.length, end)
    } else if (p2 >= 0) {
      hasPart2Marker = true
      const from = text.indexOf('\n', p2) >= 0 ? text.indexOf('\n', p2) + 1 : p2
      // 第二部分之后的 ```json 块若存在，优先取块内容（其余当说明）
      const fence = lastCodeFence(text.slice(from))
      changes = fence ? fence.content : text.slice(from)
    }
  }

  // 仍然没有正文：整段文本安全归入 Part 1（模型完全没按格式来时，正文不能丢）
  if (!body.trim()) {
    if (!hasPart1Marker && !hasPart2Marker) {
      const fence = lastCodeFence(text)
      const hasJson = !!fence && /[{[]/.test(fence.content)
      if (hasJson && fence) {
        body = text.slice(0, fence.start)
        changes = fence.content
        hasPart2Marker = true
        warnings.push('没有找到分隔标记，已把末尾代码块识别为变动摘要。')
      } else {
        body = text
      }
    } else if (hasPart1Marker && hasPart2Marker) {
      // 有标记但正文为空：只提示，不把 Part 2 冒充正文
      warnings.push('第一部分为空，已保留第二部分原文供核对。')
    }
  }
  if (!hasPart2Marker) {
    // 尾部代码块兜底：模型把 JSON 放在正文后面、但漏了变动摘要标记
    const fence = lastCodeFence(text)
    if (fence && !body.includes(fence.content) && /[{[]/.test(fence.content)) {
      const before = text.slice(0, fence.start).trim()
      if (before && before !== body.trim()) body = before
      changes = fence.content
      hasPart2Marker = true
      warnings.push('变动摘要缺少分隔标记，已从末尾代码块提取。')
    }
  }

  /**
   * 只收到一个裸 JSON（没有正文、没有任何标记）：
   * 只有「结构确实是变动摘要」时才归入 Part 2 —— 否则一段以 `{` 开头的正文会被吞掉。
   */
  if (!hasPart1Marker && !hasPart2Marker && looksLikeJson(text)) {
    const obj = parseLooseObject(text)
    if (obj && CHANGE_KEYS.some(k => Object.prototype.hasOwnProperty.call(obj, k))) {
      body = ''
      changes = text
      hasPart2Marker = true
      warnings.push('只识别到变动摘要，没有找到正文段落；请核对网页模型回复。')
    }
  }

  return { body: body.trim(), changes: changes.trim(), hasPart1Marker, hasPart2Marker, warnings }
}

// ---------- JSON 归一化 ----------

function normalizeJsonChanges(obj: Record<string, unknown>): WcpParsedChanges {
  const entities: ExtractedEntity[] = []
  for (const raw of arr(obj.entities)) {
    const r = recordOf(raw)
    const name = str(r.name)
    if (!name) continue
    entities.push({
      type: entityTypeOf(str(r.type)),
      name,
      desc: str(r.summary) || str(r.desc),
      evidence: str(r.evidence),
    })
  }

  const statuses: ExtractedStatus[] = []
  for (const raw of arr(obj.statusChanges ?? obj.statuses)) {
    const r = recordOf(raw)
    const name = str(r.character) || str(r.name)
    const state = str(r.after) || str(r.state)
    if (!name || !state) continue
    statuses.push({ name, state, evidence: str(r.quote) || str(r.evidence) })
  }

  const resources: ExtractedResource[] = []
  for (const raw of arr(obj.resourceTransfers ?? obj.resources)) {
    const r = recordOf(raw)
    const item = str(r.item)
    if (!item) continue
    const q = Number(r.quantity)
    resources.push({
      item,
      action: resourceActionOf(str(r.action)),
      from: str(r.from),
      to: str(r.to),
      ...(Number.isFinite(q) && q > 0 ? { quantity: Math.floor(q) } : {}),
      evidence: str(r.quote) || str(r.evidence),
    })
  }

  const foreshadows: ExtractedForeshadow[] = []
  for (const raw of arr(obj.foreshadows)) {
    const r = recordOf(raw)
    const content = str(r.content)
    if (!content) continue
    foreshadows.push({ action: foreshadowActionOf(str(r.action)), code: str(r.code), content })
  }

  const relations: ExtractedRelation[] = []
  for (const raw of arr(obj.relations)) {
    const r = recordOf(raw)
    const a = str(r.charA) || str(r.a)
    const b = str(r.charB) || str(r.b)
    if (!a || !b) continue
    const change = str(r.change)
    const quote = str(r.quote) || str(r.evidence)
    relations.push({
      a,
      b,
      type: str(r.type),
      // 关系类型没有独立的 evidence 字段：把引文并进变化说明，落库后仍可溯源
      change: quote ? `${change || '关系发生变化'}（依据：「${quote}」）` : change,
    })
  }

  const biographies: ExtractedBioNode[] = []
  for (const raw of arr(obj.bioNodes ?? obj.biographies)) {
    const r = recordOf(raw)
    const name = str(r.character) || str(r.name)
    const title = str(r.title)
    if (!name || !title) continue
    biographies.push({
      name,
      chapterNo: Number.isFinite(Number(r.chapterNo)) ? Math.max(0, Math.floor(Number(r.chapterNo))) : 0,
      title,
      summary: str(r.summary),
      tag: str(r.tag),
      evidence: str(r.evidence),
    })
  }

  return { entities, statuses, resources, foreshadows, relations, biographies }
}

const CHANGE_KEYS = ['entities', 'statusChanges', 'statuses', 'resourceTransfers', 'resources', 'foreshadows', 'relations', 'bioNodes', 'biographies']

function looksLikeJson(text: string): boolean {
  const t = text.trim()
  return t.startsWith('{') || t.startsWith('[') || /^```[a-zA-Z0-9_-]*\s*\n\s*[{[]/.test(t)
}

function looksLikeMarkdown(text: string): boolean {
  return /^###\s+\S/m.test(text)
}

// ---------- Markdown 清单 ----------

export function parseMarkdownCards(raw: string): WcpMarkdownCard[] {
  const cards: WcpMarkdownCard[] = []
  let cur: WcpMarkdownCard | null = null
  for (const line of raw.split('\n')) {
    const h = /^###\s+(.+?)\s*$/.exec(line)
    if (h) {
      cur = { section: h[1], items: [] }
      cards.push(cur)
      continue
    }
    if (!cur) continue
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line)
    if (item) {
      cur.items.push(item[1])
      continue
    }
    const plain = line.trim()
    if (!plain || /^#{1,6}\s/.test(plain)) continue
    // 续行 / 模型没用列表符号时，并入上一条；没有上一条就单列
    if (cur.items.length) cur.items[cur.items.length - 1] += ` ${plain}`
    else cur.items.push(plain)
  }
  return cards.filter(c => c.items.length > 0)
}

// ---------- 主入口 ----------

/**
 * 解析网页模型回复。
 *
 * @param raw 网页模型返回的原始文本（可含寒暄 / 代码块）
 * @param format 当前设置的摘要格式（只影响「是否按 JSON 尝试」与提醒口径）
 */
export function parseWcpReply(raw: string, format: WcpSummaryFormat): WcpParseResult {
  const split = splitParts(raw ?? '')
  const warnings = [...split.warnings]
  const changesText = split.changes
  let parsed = { ...EMPTY_CHANGES }
  let actual: 'json' | 'markdown' | 'none' = 'none'
  let jsonAttempted = false
  let jsonFailed = false

  if (!changesText.trim()) {
    warnings.push('模型没有提供变动摘要；第一部分正文已完整保留。')
    if (looksLikeMarkdown(split.body)) {
      // 第二部分缺失但正文里带了清单标题：不强行当正文解析，留给作者判断
      warnings.push('正文里出现了清单式三级标题，可能把变动摘要写进了第一部分，请核对。')
    }
  } else if (looksLikeJson(changesText)) {
    jsonAttempted = format === 'json'
    const obj = parseLooseObject(changesText)
    if (!obj) {
      jsonFailed = true
      warnings.push('第二部分 JSON 语法不完整，已完整保留正文；可一键切换为 Markdown 清单模式。')
    } else {
      const hasKey = CHANGE_KEYS.some(k => Object.prototype.hasOwnProperty.call(obj, k))
      if (!hasKey) {
        jsonFailed = true
        warnings.push('第二部分 JSON 结构不符合约定（缺少 6 类字段），已完整保留正文；建议切换 Markdown 清单。')
      } else {
        parsed = normalizeJsonChanges(obj)
        actual = 'json'
        if (format !== 'json') warnings.push('当前设为 Markdown 清单，但检测到 JSON 摘要，已按 JSON 解析。')
      }
    }
  } else if (looksLikeMarkdown(changesText)) {
    actual = 'markdown'
    // 设的是 JSON，模型却给了清单：算「JSON 体验不佳」，亮切换引导但不判为语法错误
    if (format === 'json') {
      jsonAttempted = true
      jsonFailed = true
      warnings.push('模型返回的是 Markdown 清单而不是 JSON；正文已完整保留，可一键切为 Markdown 清单模式。')
    }
  } else {
    actual = 'markdown'
    if (format === 'json') {
      jsonAttempted = true
      jsonFailed = true
      warnings.push('第二部分不是可识别的 JSON / 清单；正文已完整保留。')
    }
  }

  const markdownCards = actual === 'markdown' ? parseMarkdownCards(changesText) : []
  if (actual === 'markdown' && markdownCards.length === 0 && changesText.trim()) {
    warnings.push('第二部分没有识别出固定的三级标题，已按原文保留供人工核对。')
  }

  return {
    body: split.body,
    rawChanges: changesText,
    changes: parsed,
    format: actual,
    jsonAttempted,
    jsonFailed,
    warnings,
    markdownCards,
    hasPart1Marker: split.hasPart1Marker,
    hasPart2Marker: split.hasPart2Marker,
  }
}

/** Part 2 是否有任何可入库的候选（UI 决定「写入候选」按钮是否可用） */
export function hasWcpCandidates(changes: WcpParsedChanges): boolean {
  return changes.entities.length > 0 || changes.statuses.length > 0 || changes.resources.length > 0
    || changes.foreshadows.length > 0 || changes.relations.length > 0 || changes.biographies.length > 0
}

/** 候选总数（含未登记条目；仅供界面展示） */
export function countWcpCandidates(changes: WcpParsedChanges): number {
  return changes.entities.length + changes.statuses.length + changes.resources.length
    + changes.foreshadows.length + changes.relations.length + changes.biographies.length
}