/**
 * 3.3.3 · A2：章内变化清单（"这一章到底发生了什么变化"）。
 *
 * 【替代了什么】原稿想用「动词/名词密度」推「空转」—— 那是词频→语义的因果推断，不可验证。
 *    现在只做两件事：
 *      ① **本地**组装材料并定预算（≤10,000 字；超出分批或明确截断，不静默发全书）；
 *      ② 由作者**主动**触发一次模型调用，把模型给的线索逐条回原文**逐字核验**。
 *
 * 【结论只有四种】发现变化线索 / 可供核对的线索较少 / 证据不足 / 未检测。
 *    🔴 没有"通过 / 空转"：材料不足就是证据不足，不能显示成"这章没推进"。
 *
 * 【证据规则】每条变化的 `quote` 必须**逐字**出现在当前输入里，并由程序定位出区间；
 *    对不上就整条剔除（模型说"原文写着…"不算数）。铺垫、休整、内心变化同样有价值，
 *    不要求"不可逆"，也不因地点改变自动判断为推进。
 *
 * 【预算】每次作者动作最多 3 次模型请求（含自动重试）；超过就由作者再发起。
 *    本模块只发 1 次，失败不自动换模型兜底 —— 不静默替作者付费。
 */
import { countWords } from '@/lib/editor/textStats'

export const CHANGE_PROTOCOL_VERSION = 'change-list-v1'
/** 单次最多送给模型的材料字数（规划 §4：每批 ≤10,000 字） */
export const CHANGE_MATERIAL_LIMIT = 10_000
/** 最多 3 条变化（规划 §4） */
export const MAX_CHANGES = 3

export const CHANGE_TYPE_LABELS = ['目标', '关系', '信息', '资源/地位', '处境或情绪认知'] as const
export type ChangeType = typeof CHANGE_TYPE_LABELS[number]

export type ChangeConclusion = 'found' | 'few' | 'insufficient' | 'not-run'

export const CHANGE_CONCLUSION_TEXT: Record<ChangeConclusion, string> = {
  found: '发现变化线索',
  few: '可供核对的线索较少',
  insufficient: '证据不足',
  'not-run': '未检测',
}

export interface ChangeItem {
  id: string
  type: ChangeType
  /** 变化前（可空：模型可能只给"变成什么"） */
  before: string
  /** 变化后 */
  after: string
  /** 原文短引用（逐字；定位以它为准） */
  quote: string
  /** 在**当前章正文**里的字符区间；核验失败时整条不会返回 */
  start: number
  end: number
}

export interface ChangeMaterial {
  material: string
  /** 送审字数（≤ limit） */
  chars: number
  /** 原章字数 */
  totalChars: number
  /** 是否被截断（true 时界面必须写明"只看了前 N 字"） */
  truncated: boolean
}

/**
 * 组装材料：**只取前 10,000 字**，并明确回报截断。
 * 🔴 不静默发全书：模型的上下文与费用都是有限的，作者必须先知道"这次只看了多少"。
 */
export function buildChangeMaterial(text: string, limit = CHANGE_MATERIAL_LIMIT): ChangeMaterial {
  const body = String(text ?? '')
  const totalChars = countWords(body)
  if (totalChars <= limit) {
    return { material: body, chars: totalChars, totalChars, truncated: false }
  }
  // 按"字"截断（与界面显示的字数口径一致）；超长时保留句读边界更可读，但**绝不能悄悄多送**
  const slice = body.slice(0, limit)
  return { material: slice, chars: countWords(slice), totalChars, truncated: true }
}

/** 逐字定位（返回第一处；找不到返回 null）。不做模糊匹配 —— 定位失效就剔除。 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const q = String(quote ?? '')
  if (!q.trim()) return null
  const idx = String(text ?? '').indexOf(q)
  return idx >= 0 ? { start: idx, end: idx + q.length } : null
}

/** 结论：只有 0 条 ⇒ 线索较少；材料为空 ⇒ 证据不足 */
export function concludeChanges(items: ChangeItem[], hasMaterial: boolean): ChangeConclusion {
  if (!hasMaterial) return 'insufficient'
  return items.length > 0 ? 'found' : 'few'
}

const TYPE_ALIASES: Record<string, ChangeType> = {
  '目标': '目标', 'goal': '目标',
  '关系': '关系', 'relation': '关系', 'relationship': '关系',
  '信息': '信息', 'information': '信息', 'info': '信息',
  '资源': '资源/地位', '地位': '资源/地位', 'resource': '资源/地位', 'status': '资源/地位', '资源/地位': '资源/地位',
  '处境': '处境或情绪认知', '情绪': '处境或情绪认知', '认知': '处境或情绪认知',
  'situation': '处境或情绪认知', 'emotion': '处境或情绪认知', '认知变化': '处境或情绪认知',
  '处境或情绪认知': '处境或情绪认知',
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim())
}

/**
 * 解析 + 核验模型输出（**纯函数**，单测直喂字符串）。
 *
 * 接受 `{ changes: [...] }` / `{ 变化: [...] }`；每条至少要有 `quote`。
 * 🔴 引文必须逐字命中当前正文；命中不了、类型不认识、重复的条目一律丢弃。
 * 🔴 最多 3 条；超出的不展示（不截断正文，也不假装全列）。
 */
export function verifyChangeItems(raw: unknown, chapterText: string): ChangeItem[] {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    // 容忍 markdown 代码块 / 前后解释：取第一个 { 到最后一个 }
    const s = raw.trim()
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a < 0 || b <= a) return []
    try { obj = JSON.parse(s.slice(a, b + 1)) } catch { return [] }
  }
  if (!obj || typeof obj !== 'object') return []
  const rec = obj as Record<string, unknown>
  const list = Array.isArray(rec.changes) ? rec.changes
    : Array.isArray(rec['变化']) ? rec['变化']
      : Array.isArray(rec.items) ? rec.items : []
  const out: ChangeItem[] = []
  const seen = new Set<string>()
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const row = it as Record<string, unknown>
    const typeRaw = str(row.type ?? row['类型'])
    const type = TYPE_ALIASES[typeRaw] ?? TYPE_ALIASES[typeRaw.toLowerCase()]
    if (!type) continue
    const quote = str(row.quote ?? row['原文'] ?? row['引文'])
    const after = str(row.after ?? row['变化后'] ?? row['now'])
    const before = str(row.before ?? row['变化前'] ?? row['prev'])
    if (!quote || !after) continue
    const loc = locateQuote(chapterText, quote)
    if (!loc) continue
    const id = `chg-${type}-${loc.start}-${loc.end}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, type, before, after, quote, start: loc.start, end: loc.end })
    if (out.length >= MAX_CHANGES) break
  }
  return out
}

/** 本机"我不认同"作用域：章 + 条目 id（正文变了 id 会变，旧记录自然不再命中） */
export function dissentKeyOf(chapterId: string, item: ChangeItem): string {
  return `${chapterId}::${item.id}`
}

export interface ChangeListReport {
  chapterId: string
  chapterTitle: string
  conclusion: ChangeConclusion
  items: ChangeItem[]
  material: ChangeMaterial
  requestCount: number
  /** 模型标识（不含端点/密钥）；换模型后结果不可比 */
  modelTag?: string
  protocolVersion: string
  /** 参与分析的章正文指纹 */
  inputFingerprint: string
  at: number
}

/** FNV-1a + 长度（只用于"变了没有"） */
export function fingerprintText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${CHANGE_PROTOCOL_VERSION}:${h.toString(16).padStart(8, '0')}-${text.length.toString(16)}`
}

/** 未检测报告（没模型 / 作者没点）：界面据此如实显示"未检测"，不能冒充通过 */
export function notRunReport(chapterId: string, chapterTitle: string, text: string): ChangeListReport {
  return {
    chapterId, chapterTitle,
    conclusion: 'not-run', items: [],
    material: buildChangeMaterial(text),
    requestCount: 0,
    protocolVersion: CHANGE_PROTOCOL_VERSION,
    inputFingerprint: fingerprintText(text),
    at: Date.now(),
  }
}