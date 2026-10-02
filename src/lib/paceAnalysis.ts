// ============ 爽点节奏与章末钩子 · 本地统计层（B5 · 2.4.1）============
//
// 立场（🔴 与「创作轨迹 / 证据包」同一条线）：
//   本模块只做「**把章内结构事实摆出来**」，帮作者自己看节奏，不做评分、不排名、
//   不判定"是否达到某标准"。AI 那半（aiTasks/pace.ts）也只给观察与建议。
//
// 设计要点（为什么位置由**本地**算，而不是让 AI 报）：
//   AI 报"这段在第几段"经常算不准（它并不真的数百分比），但**引用原文很准**。
//   所以协议是：AI 只出 `quote`（原文片段）+ 类型 + 说明；**位置由本地用 quote 在正文里的
//   字符下标换算**。这样位置是"算出来的"，不是"模型说了算" —— 也顺带能在 quote 定位失败时
//   显式标出「未定位」，而不是悄悄给一个错位置。

import { parseObjectArray, parseLooseObject, asText, humanText } from './aiParse'
import { stripEmphasis } from './mdLite'

/** 章内三段（与 B5 规划口径一致：前段 / 中段 / 后段） */
export const PACE_SEGMENTS = ['前段', '中段', '后段'] as const
export type PaceSegment = typeof PACE_SEGMENTS[number]

/** 定位失败（AI 引用的原文在正文里找不到，多半是被它顺手改写了） */
export const PACE_SEG_UNKNOWN = '未定位'

/** 章末钩子区：正文最后 12% 视为「钩子位」 */
export const HOOK_ZONE_RATIO = 0.12

/** 爽点类型（与「爽点节奏」表 hookpoints 的枚举对齐，便于作者对照落表） */
export const PACE_BEAT_KINDS = ['打脸', '升级', '获宝', '逆转', '扬名', '复仇', '揭秘', '温情'] as const

/** 章末钩子类型（封闭枚举） */
export const HOOK_KINDS = ['悬念', '未完成事件', '信息缺口', '情绪悬置', '无'] as const
export type HookKind = typeof HOOK_KINDS[number]

export interface PaceBeat {
  /** 爆点类型（自由文本，通常是 PACE_BEAT_KINDS 之一） */
  kind: string
  /** 原文片段（AI 给的引文） */
  quote: string
  /** **本地**定位结果 */
  segment: PaceSegment | typeof PACE_SEG_UNKNOWN
  /** 引文在正文中的字符下标；未定位为 -1 */
  at: number
  note: string
}

export interface PaceDistribution {
  前段: number
  中段: number
  后段: number
  /** 未定位的爆点数（不计入三段） */
  未定位: number
  /** 趋势判定 —— 只描述分布形态，不做好坏评价 */
  shape: '分布均匀' | '集中于前段' | '集中于后段' | '后段空转' | '数据不足'
  /** 本地生成的一句事实描述（供 UI 直接显示） */
  note: string
}

/** 去掉所有空白后的字符串（定位时用，抵消模型复制引文时的换行/空格差异） */
function squeeze(s: string): string {
  return s.replace(/\s+/g, '')
}

/** 定位内核：对给定的（已 trim 的）引文跑四级兜底 —— 原样/去空白/前 12 字/前 12 字去空白 */
function locateRaw(text: string, q: string): number {
  const exact = text.indexOf(q)
  if (exact >= 0) return exact

  // 去空白匹配：把正文逐字符压成「无空白串 + 下标映射」
  const sq = squeeze(q)
  if (sq.length < 4) return -1
  const map: number[] = []
  const buf: string[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) continue
    buf.push(ch)
    map.push(i)
  }
  const hit = buf.join('').indexOf(sq)
  if (hit >= 0) return map[hit]

  // 引文被模型动了几个字：只用开头 12 字找（同样先精确、再去空白）
  const head = q.slice(0, 12)
  const h1 = text.indexOf(head)
  if (h1 >= 0) return h1
  const sh = squeeze(head)
  if (sh.length >= 6) {
    const h2 = buf.join('').indexOf(sh)
    if (h2 >= 0) return map[h2]
  }
  return -1
}

/**
 * 在正文里定位一段引文，返回字符下标；找不到返回 -1。
 * 策略：① 精确匹配 → ② 去空白后匹配（换算回原下标）→ ③ 截取引文前 12 字再试。
 * 故意**不做**模糊相似度匹配 —— 宁可标「未定位」，也不要指到错的地方。
 *
 * 🔴 兜底一层：模型有时给引文自行加上 markdown 强调（`**…**`）—— 先按原样找，
 *    找不到再剥掉强调标记重找一次。不这么做的话，引文一旦带星号就定位失败、
 *    爆点 / 读者反应的条目会被**静默丢弃**（净化见 `mdLite.stripEmphasis`）。
 */
export function locateQuote(text: string, quote: string): number {
  const q = (quote || '').trim()
  if (!q || !text) return -1
  const direct = locateRaw(text, q)
  if (direct >= 0) return direct
  const clean = stripEmphasis(q).trim()
  if (clean && clean !== q) return locateRaw(text, clean)
  return -1
}

/** 字符下标 → 三段之一（按正文长度的三等分） */
export function segmentAt(textLength: number, at: number): PaceSegment | typeof PACE_SEG_UNKNOWN {
  if (at < 0 || textLength <= 0) return PACE_SEG_UNKNOWN
  const r = at / textLength
  if (r < 1 / 3) return '前段'
  if (r < 2 / 3) return '中段'
  return '后段'
}

/** 把爆点列表补上本地定位（kind/quote 保持不变；segment 与 at 一律本地覆盖） */
export function locateBeats(text: string, beats: Array<{ kind: string; quote: string; note?: string }>): PaceBeat[] {
  return beats.map(b => {
    const at = locateQuote(text, b.quote)
    return {
      kind: (b.kind || '').trim() || '未标注',
      quote: (b.quote || '').trim(),
      at,
      segment: segmentAt(text.length, at),
      note: (b.note || '').trim(),
    }
  })
}

/**
 * 按三段统计分布形态。
 * 🔴 只产出**形态描述**（集中在前段 / 后段空转 …），不含"好/差"评价 ——
 * 「后段空转」是形态，不是判决；要不要改由作者定。
 */
export function buildDistribution(beats: PaceBeat[]): PaceDistribution {
  const dist: PaceDistribution = { 前段: 0, 中段: 0, 后段: 0, 未定位: 0, shape: '数据不足', note: '' }
  for (const b of beats) {
    if (b.segment === PACE_SEG_UNKNOWN) dist.未定位++
    else dist[b.segment]++
  }
  const total = dist.前段 + dist.中段 + dist.后段
  if (total < 2) {
    dist.shape = '数据不足'
    dist.note = total === 0 ? '本章未识别到爆点。' : '本章只识别到 1 处爆点，分布形态暂不判断。'
    return dist
  }
  // ⚠️ 判定顺序有讲究（写这版时踩过）：均匀分布（如 1/1/1）会让「后段 >= 前段 && 后段 >= 中段」
  //    同时成立，若把「集中于后段」排在前面，均匀永远判不出来。所以先判均匀。
  const vals = [dist.前段, dist.中段, dist.后段]
  const mx = Math.max(...vals)
  const mn = Math.min(...vals)
  if (dist.后段 === 0) {
    dist.shape = '后段空转'
    dist.note = `共 ${total} 处爆点，全部落在前中段；后段（约后 1/3）没有爆点。`
  } else if (mn > 0 && mx - mn <= 1) {
    dist.shape = '分布均匀'
    dist.note = `共 ${total} 处爆点，三段均有分布（${dist.前段}/${dist.中段}/${dist.后段}）。`
  } else if (dist.前段 >= dist.中段 && dist.前段 >= dist.后段) {
    dist.shape = '集中于前段'
    dist.note = `共 ${total} 处爆点，其中前段 ${dist.前段} 处，重心偏前。`
  } else if (dist.后段 >= dist.前段 && dist.后段 >= dist.中段) {
    dist.shape = '集中于后段'
    dist.note = `共 ${total} 处爆点，其中后段 ${dist.后段} 处，重心偏后。`
  } else {
    dist.shape = '分布均匀'
    dist.note = `共 ${total} 处爆点，三段均有分布（${dist.前段}/${dist.中段}/${dist.后段}）。`
  }
  if (dist.未定位 > 0) dist.note += ` 另有 ${dist.未定位} 处引文未能在正文中定位，未计入。`
  return dist
}

/** 章末钩子区的本地粗判（**只做"有没有内容"这类确定性判断**，钩子好坏交给 AI） */
export function hookZoneStats(text: string): { chars: number; hasContent: boolean; tail: string } {
  const t = (text || '').trim()
  const start = Math.max(0, Math.floor(t.length * (1 - HOOK_ZONE_RATIO)))
  const tail = t.slice(start)
  return { chars: tail.length, hasContent: tail.trim().length > 0, tail: tail.trim() }
}

/**
 * 把 AI 的原始输出整成安全的爆点数组（宽松校验，与本项目其它解析层同一尺度）：
 * 只认 {kind, quote, note} 三个键，quote 为空的一律丢弃 —— 没有引文就无法定位，留着只会占位。
 */
export function normalizeBeats(raw: unknown, max = 12): Array<{ kind: string; quote: string; note: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ kind: string; quote: string; note: string }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const quote = typeof o.quote === 'string' ? o.quote.trim() : ''
    if (!quote) continue
    out.push({
      kind: typeof o.kind === 'string' ? o.kind.trim() : '',
      quote,
      note: typeof o.note === 'string' ? o.note.trim() : '',
    })
    if (out.length >= max) break
  }
  return out
}

/** 从任意值里取非空字符串数组（用于 observations / increments 这类列表） */
export function toStringList(raw: unknown, max = 8): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(x => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .slice(0, max)
}

/** 钩子类型归一：只认封闭枚举，认不出的一律按「悬念」不成立 → 记「无」由调用方决定 */
export function normalizeHookKind(raw: unknown): HookKind {
  const s = typeof raw === 'string' ? raw.trim() : ''
  return (HOOK_KINDS as readonly string[]).includes(s) ? (s as HookKind) : '悬念'
}

// ============ AI 输出的解析（纯函数，放本层以便单测）============
//
// 放在这里而不是 aiTasks/pace.ts：解析是纯函数，与"发请求"无关。
// 好处是测试只 import 本模块 —— 不会连带把 AI 传输层拉进 Node 测试环境。

export interface PaceReport {
  /** 章末钩子类型（本地按封闭枚举归一） */
  hookKind: HookKind
  /** 章末是否有钩子（kind === '无'，或 present 显式为 false 时为 false） */
  hookPresent: boolean
  /** AI 引用的章末原文依据 */
  hookEvidence: string
  hookNote: string
  /** 章末钩子区的**本地事实**（字符数 / 区域原文）—— 与 AI 的判定并列显示，便于对照 */
  hookZone: { chars: number; hasContent: boolean; tail: string }
  /** 爆点：segment / at 由本地定位覆盖，AI 说了不算 */
  beats: PaceBeat[]
  distribution: PaceDistribution
  increments: string[]
  observations: string[]
  summary: string
}

/**
 * 解析 AI 输出。全部字段走兜底：缺字段、类型不对、JSON 截断、甚至模型回了散文，
 * 都只会让对应字段为空 —— **绝不抛异常**（AI 层铁律：失败只提示，不破坏已有数据）。
 */
export function parsePaceReport(raw: string, chapterText: string): PaceReport {
  // ⚠️ 提示词要求输出**单个对象**，所以先按对象解析，再兼容模型自作主张包成数组的情况。
  //    （写这版时踩过：直接用 parseObjectArray 解析对象 ⇒ 解析不出来 ⇒ 所有字段静默为空，
  //      而"钩子类型"还会因此退化成默认的「悬念」—— 静默错比报错更难发现。）
  const obj = parseLooseObject(raw) ?? (parseObjectArray(raw)[0] ?? {})

  const hookRaw = (obj.hook && typeof obj.hook === 'object' ? obj.hook : {}) as Record<string, unknown>
  const hookKind = normalizeHookKind(hookRaw.kind)
  const presentRaw = typeof hookRaw.present === 'boolean' ? hookRaw.present : undefined
  const hookPresent = presentRaw !== undefined ? (presentRaw && hookKind !== '无') : hookKind !== '无'

  const beats = locateBeats(chapterText, normalizeBeats(obj.beats))

  return {
    hookKind,
    hookPresent,
    hookEvidence: asText(hookRaw.evidence),
    hookNote: asText(hookRaw.note),
    hookZone: hookZoneStats(chapterText),
    beats,
    distribution: buildDistribution(beats),
    increments: toStringList(obj.increments, 5),
    observations: toStringList(obj.observations, 4),
    summary: asText(obj.summary) || humanText(raw),
  }
}
