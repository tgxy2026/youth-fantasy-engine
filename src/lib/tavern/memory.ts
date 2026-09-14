/**
 * 酒馆模式 · 六栏记忆（方案 §4.5 / §4.6）
 *
 * 【为什么六栏行为不同】——这是实测出来的设计，别改成「全部压缩」或「全部保留」：
 *   · 长期摘要 「会缩」   —— 已解决、已过期的旧事压掉，只留仍影响当下的
 *   · 关键事实 「只增不改」—— 全压掉就等于失忆
 *   · 关系状态 「每次重写」—— 由总结时重新判断（情绪并入本栏）
 *   · 未爆的雷 「只增不改」—— 埋着还没用的伏笔 / 秘密 / 未说出口的事
 *   · 纪念日   「可增可清」
 *   · 最近日记 「硬性滚动」—— 保留最近五天，倒序
 * 全部压缩 → 伏笔被抹掉；全部保留 → 无限膨胀吃满上下文。分两种行为是唯一同时成立的做法。
 *
 * 【改写而非追加】每次总结 = 「旧档案 + 新剧情 → 重写整份完整档案」，
 * 所以字数在 500~1200 浮动、不会无限长大。
 *
 * 【无服务端约束】novel-studio 是纯前端 SPA + Electron，**不能后台跑任何东西**，
 * 所以总结只能事件驱动（回复后判阈值 / 下次打开补算），绝不轮询。
 *
 * 本文件是纯逻辑：无 React、无 IO、无网络。读写归 store.ts，调模型归 summarize.ts。
 */
import {
  MEMORY_SOFT_LIMIT, MEMORY_HARD_LIMIT, MEMORY_LONGTERM_LIMIT, MEMORY_DIARY_DAYS,
  SUMMARY_TRIGGER_MESSAGES, SUMMARY_MIN_INTERVAL_MS, SUMMARY_LOCK_TTL_MS,
  type FreeMemory, type FreeSession,
} from './types'

/** 六栏的键（收窄成「只有这六栏」，避免索引赋值时把 charId / updatedAt 混进来） */
export type MemorySectionKey = 'longTerm' | 'facts' | 'relation' | 'mines' | 'anniversaries' | 'diaries'

/** 六栏的键与标题（标题用于序列化/解析，顺序即展示顺序） */
/**
 * 可覆盖的记忆字数约束（来自控制面板）。**不传即用内置默认**，所以既有调用零变化。
 */
export type MemoryLimits = {
  hardLimit: number
  longTermLimit: number
  diaryDays: number
}

export function limitsOf(opts?: Partial<MemoryLimits>): MemoryLimits {
  return {
    hardLimit: opts?.hardLimit ?? MEMORY_HARD_LIMIT,
    longTermLimit: opts?.longTermLimit ?? MEMORY_LONGTERM_LIMIT,
    diaryDays: opts?.diaryDays ?? MEMORY_DIARY_DAYS,
  }
}

export const MEMORY_SECTIONS: { key: MemorySectionKey; title: string }[] = [
  { key: 'longTerm', title: '一、长期摘要' },
  { key: 'facts', title: '二、关键事实' },
  { key: 'relation', title: '三、关系状态' },
  { key: 'mines', title: '四、未爆的雷' },
  { key: 'anniversaries', title: '五、纪念日与待办' },
  { key: 'diaries', title: '六、最近日记' },
]

/** 「只增不改」的两栏：新档案里若这两栏变空，判定为模型丢失，保留旧值 */
const APPEND_ONLY: MemorySectionKey[] = ['facts', 'mines']

export function emptyMemory(charId: string): FreeMemory {
  return {
    charId,
    longTerm: '', facts: '', relation: '', mines: '', anniversaries: '', diaries: '',
    updatedAt: 0,
  }
}

/** 六栏合计字数（不含栏目标题，纯内容） */
export function memoryChars(m: FreeMemory): number {
  return MEMORY_SECTIONS.reduce((n, s) => n + String(m[s.key] ?? '').length, 0)
}

/** 是否还是一张白纸（用来判断「首次记忆」与 UI 空态） */
export function isMemoryEmpty(m: FreeMemory | null | undefined): boolean {
  if (!m) return true
  return memoryChars(m) === 0
}

/** 序列化成交给模型的档案文本（空栏也保留标题，便于模型知道有这一栏可填） */
export function memoryToText(m: FreeMemory): string {
  return MEMORY_SECTIONS
    .map(s => `【${s.title}】\n${String(m[s.key] ?? '').trim() || '（暂无）'}`)
    .join('\n\n')
}

/** 按行拆出「- 日期 内容」形式，倒序保留最近 N 条（方案：最近五天，新在上） */
export function rollDiaries(text: string, keep = MEMORY_DIARY_DAYS): string {
  const lines = String(text ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^（暂无）$/.test(l))
  return lines.slice(0, keep).join('\n')
}

/**
 * 硬约束收敛：长期摘要超限截断、日记滚动、总量超硬上限时按「先牺牲长期摘要」的顺序压缩。
 * 注意**不动** facts / mines —— 那两栏是「不失忆」的底线。
 */
export function trimMemory(m: FreeMemory, opts?: Partial<MemoryLimits>): FreeMemory {
  const L = limitsOf(opts)
  const out: FreeMemory = { ...m }
  out.longTerm = clipSection(out.longTerm, L.longTermLimit)
  out.diaries = rollDiaries(out.diaries, L.diaryDays)
  if (memoryChars(out) > L.hardLimit) {
    // 依次牺牲：长期摘要 → 纪念日/待办 → 关系状态（都属「可重建」信息）
    out.longTerm = clipSection(out.longTerm, Math.floor(L.longTermLimit * 0.6))
    if (memoryChars(out) > L.hardLimit) out.anniversaries = clipSection(out.anniversaries, 120)
    if (memoryChars(out) > L.hardLimit) out.relation = clipSection(out.relation, 160)
  }
  return out
}

/** 截断到 n 字，超出则在行边界收尾（不把半句话切得莫名其妙） */
function clipSection(s: string, n: number): string {
  const t = String(s ?? '').trim()
  if (t.length <= n) return t
  const cut = t.slice(0, n)
  const i = cut.lastIndexOf('\n')
  return (i > n * 0.5 ? cut.slice(0, i) : cut).trim()
}

/**
 * 从模型输出的整份档案里解析六栏。
 * 容错策略（模型不一定听话）：
 *   · 栏目标题放宽匹配 —— 「一、长期摘要」「长期摘要」「1. 长期摘要」都认
 *   · 认不出的内容不丢 —— 追加到「长期摘要」末尾，总比整段蒸发好
 *   · prev 给定时对「只增不改」两栏做保护：新值为空而旧值非空 → 保留旧值（防整段丢失）
 */
export function parseMemoryText(text: string, charId: string, prev?: FreeMemory | null, opts?: Partial<MemoryLimits>): FreeMemory {
  const raw = String(text ?? '').replace(/\r\n/g, '\n')
  const out = emptyMemory(charId)
  const hit: Partial<Record<MemorySectionKey, string[]>> = {}
  let current: MemorySectionKey | null = null

  for (const line of raw.split('\n')) {
    const hitLine = matchSectionTitle(line)
    if (hitLine) {
      current = hitLine.key
      const arr = (hit[current] ??= [])
      // 模型有时写成「长期摘要：内容」同一行 —— 标题后的剩余部分当本栏首行，别丢
      if (hitLine.rest) arr.push(hitLine.rest)
      continue
    }
    if (current) (hit[current] ??= []).push(line)
    // 标题之前的内容（模型偶尔先寒暄一句）直接忽略，不当成档案正文
  }

  for (const s of MEMORY_SECTIONS) {
    const body = (hit[s.key] ?? []).join('\n').trim()
    // 去掉「（暂无）」这类占位
    out[s.key] = /^（暂无）$/.test(body.replace(/\s/g, '')) ? '' : body
  }

  if (prev) {
    for (const k of APPEND_ONLY) {
      if (!String(out[k] ?? '').trim() && String(prev[k] ?? '').trim()) {
        out[k] = prev[k] // 只增不改的栏被整段丢掉 = 失忆，宁可沿用旧值
      }
    }
  }

  out.updatedAt = Date.now()
  return trimMemory(out, opts)
}

/**
 * 判断一行是不是某栏的标题（宽松匹配：模型爱加粗 / 加序号 / 写简称 / 把内容接在同一行）。
 * 返回 rest = 标题之后的剩余内容（如「长期摘要：甲」里的「甲」），没有则为空串。
 */
function matchSectionTitle(line: string): { key: MemorySectionKey; rest: string } | null {
  const t = line.replace(/[*#\s]/g, '')
  const pack = (key: MemorySectionKey, bare: string) => {
    const i = t.indexOf(bare)
    if (i < 0) return null
    const after = t.slice(i + bare.length).replace(/^[】\]）):：、.。\-]+/, '')
    return { key, rest: after }
  }
  for (const s of MEMORY_SECTIONS) {
    // 标题本体 = 去掉「一、」这类前缀后的名字
    const bare = s.title.replace(/^[一二三四五六]、/, '')
    const got = pack(s.key, bare)
    if (got) return got
  }
  // 常见别名（模型不一定照抄标题）
  return pack('longTerm', '长期记忆') ?? pack('longTerm', '长期摘要')
    ?? pack('facts', '重要事实') ?? pack('facts', '关键事实')
    ?? pack('mines', '未爆') ?? pack('mines', '埋着的雷') ?? pack('mines', '待引爆')
    ?? pack('anniversaries', '纪念日') ?? pack('anniversaries', '待办')
    ?? pack('diaries', '日记')
    ?? pack('relation', '关系状态') ?? pack('relation', '关系')
    ?? null
}

// ==================== 水位线与触发判定（方案 §4.6） ====================

/**
 * 水位线之后**需要被总结**的消息条数（只数 user / assistant，system 不计）。
 * 水位线消息已被删除等异常情况下，保守地按「全部未总结」处理 ——
 * 宁可多总结一次，也不要漏掉一大段记忆。
 */
export function countUnsummarized(session: Pick<FreeSession, 'messages' | 'watermark'>): number {
  const msgs = session.messages.filter(m => m.role !== 'system')
  const wm = session.watermark?.messageId
  if (!wm) return msgs.length
  const i = msgs.findIndex(m => m.id === wm)
  if (i < 0) return msgs.length
  return msgs.length - i - 1
}

/** 水位线之后的第一条消息 id（总结完成后推进到哪 —— 推进到「最后一条」即可） */
export function nextWatermark(session: Pick<FreeSession, 'messages'>): { messageId: string; at: number } | null {
  const msgs = session.messages.filter(m => m.role !== 'system')
  const last = msgs[msgs.length - 1]
  return last ? { messageId: last.id, at: Date.now() } : null
}

/** 是否够条件触发一次自动总结（方案 §4.6 ①：回复结束后判阈值） */
export function shouldSummarize(session: Pick<FreeSession, 'messages' | 'watermark'>, threshold = SUMMARY_TRIGGER_MESSAGES): boolean {
  return countUnsummarized(session) >= threshold
}

// ==================== 三层防重（方案 §4.6） ====================
// ① 时间节流 ② 跨实例锁 ③ 锁的 TTL 兜底。纯前端没有原子操作，
// localStorage 锁只能「尽力而为」—— 但足以挡掉「两个窗口同时总结」这种常见情形。

const LOCK_KEY = 'yfe-tavern-summary-lock'

/** ② 尝试取锁；③ 陈旧锁（超过 TTL）可被接管 */
export function acquireSummaryLock(now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(LOCK_KEY)
    if (raw) {
      const at = Number(raw)
      if (Number.isFinite(at) && now - at < SUMMARY_LOCK_TTL_MS) return false // 别的窗口正在跑
      // 超过 TTL → 上次可能跑到一半崩了，接管
    }
    localStorage.setItem(LOCK_KEY, String(now))
    return true
  } catch {
    return true // localStorage 不可用时不因此阻塞功能
  }
}

export function releaseSummaryLock(): void {
  try { localStorage.removeItem(LOCK_KEY) } catch { /* 读不到也无所谓 */ }
}

/**
 * ① 时间节流：两次自动总结的间隔下限（用记忆的 updatedAt 当上次总结时间）。
 * 手动点「立即总结」时**不走这个判断** —— 作者点了就该跑。
 */
export function throttleOk(
  m: FreeMemory | null | undefined,
  now = Date.now(),
  minIntervalMs = SUMMARY_MIN_INTERVAL_MS,
): boolean {
  if (!m?.updatedAt) return true
  return now - m.updatedAt >= minIntervalMs
}

/** 一次总结是否该跑（把①与阈值判断合起来，供调用方一问到底） */
export function shouldRunAutoSummary(
  session: Pick<FreeSession, 'messages' | 'watermark'>,
  mem: FreeMemory | null | undefined,
  now = Date.now(),
  opts: { triggerMessages?: number; minIntervalMs?: number } = {},
): { run: boolean; reason: string } {
  const trigger = opts.triggerMessages ?? SUMMARY_TRIGGER_MESSAGES
  if (!shouldSummarize(session, trigger)) {
    return { run: false, reason: `新消息不足 ${trigger} 条` }
  }
  if (!throttleOk(mem, now, opts.minIntervalMs)) {
    return { run: false, reason: '距上次总结太近（时间节流）' }
  }
  return { run: true, reason: 'ok' }
}

export { MEMORY_SOFT_LIMIT, MEMORY_HARD_LIMIT }

/**
 * 取出尚未被总结的消息（水位线之后的 user / assistant）。
 * 与 countUnsummarized 同一套判定：水位线消息被删等异常时按全部未总结处理。
 */
export function messagesAfterWatermark(
  messages: FreeSession['messages'],
  watermark?: { messageId: string } | null,
): FreeSession['messages'] {
  const msgs = messages.filter(m => m.role !== 'system')
  const wm = watermark?.messageId
  if (!wm) return msgs
  const i = msgs.findIndex(m => m.id === wm)
  if (i < 0) return msgs
  return msgs.slice(i + 1)
}
