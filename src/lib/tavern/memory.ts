/**
 * 酒馆模式 · 六栏记忆（方案 §4.5 / §4.6）
 *
 * 【为什么六栏行为不同】——这是实测出来的设计，别改成「全部压缩」或「全部保留」：
 *   · 长期摘要 「会缩」   —— 已解决、已过期的旧事压掉，只留仍影响当下的
 *   · 关键事实 「只增不改」—— 全压掉就等于失忆
 *   · 关系状态 「每次重写」—— 由总结时重新判断（情绪并入本栏）
 *   · 未爆的雷 「只增不改」—— 埋着还没用的伏笔 / 秘密 / 未说出口的事
 *   · 纪念日   「可增可清」
 *   · 最近日记 「硬性滚动」—— 保留最近若干天（默认 7，见 MEMORY_DIARY_DAYS），倒序
 * 全部压缩 → 伏笔被抹掉；全部保留 → 无限膨胀吃满上下文。分两种行为是唯一同时成立的做法。
 *
 * 【改写而非追加】每次总结 = 「旧档案 + 新剧情 → 重写整份完整档案」，
 * 所以字数在 500~1200 浮动、不会无限长大。
 *
 * 【无服务端约束 + 不自动整理】novel-studio 是纯前端 SPA + Electron，**不能后台跑任何东西**，
 * 也不轮询。总结**只由作者手动触发**（2026-09-16 起，两种模式都是）：
 *   自由对话 = 「结束本轮对话」（一次跑完记忆 + 日记 + 数值 + 设定审查）
 *   剧情推演 = 「整理本场记忆」
 * 早年的「回复后判条数阈值自动整理」已整层废除 —— 本地模型一次几十秒，压在对话之后就是「说完卡半天」。
 *
 * 本文件是纯逻辑：无 React、无 IO、无网络。读写归 store.ts，调模型归 summarize.ts。
 */
import {
  MEMORY_SOFT_LIMIT, MEMORY_HARD_LIMIT, MEMORY_LONGTERM_LIMIT, MEMORY_DIARY_DAYS,
  SUMMARY_LOCK_TTL_MS,
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
    .map(s => `〖${s.title}〗\n${String(m[s.key] ?? '').trim() || '（暂无）'}`)
    .join('\n\n')
}

/** 按行拆出「- 日期 内容」形式，倒序保留最近 N 条（方案：最近五天，新在上） */
/**
 * 整栏 / 整行只剩一个占位词 ⇒ 这里其实什么都没写。
 *
 * 🔴 为什么必须清洗（审计 P0-2）：提示词是给模型留了「没内容就写占位」的口子的
 *    （「确实没有就写『暂无』」「留一个『-』」…），但旧实现只认 `^（暂无）$` 这一种写法。
 *    于是 `暂无` / `-` / `（还没有发生过任何事）` 会变成**永久记忆内容**：
 *      · 每轮注入 system，白占上下文额度（"空层不占额度"是本项目红线）；
 *      · 状态栏按非空行计数，把「暂无」数成「未爆的雷 1」，骗作者以为真有内容。
 *    判定放宽到「各种常见占位写法」，**只匹配整段就是占位**的情况，正文里出现这些词不受影响。
 */
const PLACEHOLDER_ONLY_RE = new RegExp(
  '^[（(【\\[《]?\\s*(?:'
  + '暂无|无|没有|略|空|无内容|待补充|待补|未提及|'
  + '尚未发生|还没有发生过任何事|还没有发生任何事|什么?都没有发生过|未发生任何事|'
  + '尚未确定|暂不确定|尚不确定|未确定|'
  + '[-\\u2014\\u2013\\uff0d_]{1,4}|\\.{2,}|\\u2026{1,3}'
  + ')\\s*[）)】\\]》]?$',
)

export function isPlaceholder(text: string | null | undefined): boolean {
  const t = String(text ?? '').replace(/\s+/g, '')
  return t === '' || PLACEHOLDER_ONLY_RE.test(t)
}

export function rollDiaries(text: string, keep = MEMORY_DIARY_DAYS): string {
  const lines = String(text ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => !isPlaceholder(l))
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
/**
 * 「整份档案退化」判定 —— 新档案比旧档案少太多 = 模型把内容丢了，不是正常压缩。
 *
 * 判据（2026-09-19 六维审计 P0-2 后加）：
 *   · 旧档案得有实质内容（>200 字）才套用 —— 短档案的正常波动不该误报；
 *   · 新档案总字数不足旧档案的 40%。
 * 为什么用「总字数」而不是逐栏比：长期摘要本来就会缩、日记本来就会滚，逐栏判必误报；
 * 而实测的失败形态是「模型把六栏写成散文 / 标题走了样」→ 四栏一起空，总量骤降最灵敏。
 */
export function isMemoryDegraded(next: FreeMemory, prev?: FreeMemory | null): boolean {
  if (!prev) return false
  const p = memoryChars(prev)
  if (p <= 200) return false
  return memoryChars(next) < p * 0.4
}

export function parseMemoryText(
  text: string, charId: string, prev?: FreeMemory | null, opts?: Partial<MemoryLimits>,
  onDegraded?: (reason: string) => void,
): FreeMemory {
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
    // 去掉「暂无」/「-」/「（还没有发生过任何事）」这类占位（见 isPlaceholder）：
    // 先逐行丢掉纯占位行，再处理「整栏就是一个占位」的情况。
    const kept = body.split('\n').map(l => l.trim()).filter(l => !isPlaceholder(l))
    out[s.key] = kept.join('\n')
  }

  if (prev) {
    for (const k of APPEND_ONLY) {
      if (!String(out[k] ?? '').trim() && String(prev[k] ?? '').trim()) {
        out[k] = prev[k] // 只增不改的栏被整段丢掉 = 失忆，宁可沿用旧值
      }
    }
    // 🔴 整份退化保护（2026-09-19 六维审计 P0-2）：上面那条只兜住「关键事实 / 未爆的雷」两栏，
    //    而模型的真实失败形态是**四栏一起空**（长期摘要 / 关系状态 / 纪念日 / 日记）——
    //    落库就等于「失忆」，界面却还报「本场记忆已更新」。这里判整份退化 → 整份回退旧档案 +
    //    如实上报，由调用方提示作者「本次没覆盖」。
    if (isMemoryDegraded(out, prev)) {
      onDegraded?.('模型输出比旧档案少太多，本次未覆盖旧档案（原样保留）')
      return trimMemory({ ...prev, updatedAt: Date.now() }, opts)
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
  // 归一化：去掉 markdown 装饰与空白，再按「先剥包裹、后剥序号」的顺序处理开头 ——
  // 模型写法五花八门：〖一、长期摘要〗 / 【长期摘要】 / 一、长期摘要 / **长期摘要**。
  // ⚠️ 顺序不能反：包裹在序号**外面**（〖一、…〗）时先剥序号会落空。
  // ⚠️ 尾部**不做**无条件剥离：那会把内容自带的「（他说的）」这类右括号一起削掉。
  //    标题后紧跟的 〗】 由下面的 SEP 处理。
  const t = line.replace(/[*#\s]/g, '')
    .replace(/^[〖【\[（(“"'「]+/, '')
    .replace(/^(?:[一二三四五六]、|\d+[.、]|[一二三四五六][)）.、])/, '')
  // 标题后面必须**紧跟分隔符或行尾** —— 这是「整词标题」与「正文里恰好含这个词」的分界线。
  const SEP = '[】〗\\]）):：、.。\\-—]'
  const pack = (key: MemorySectionKey, bare: string) => {
    // 🔴 只认**行首**命中，绝不用 indexOf 之类的子串查找：
    //    正文里含「关系」「日记」这类词的句子极其常见（典型如长期摘要里写
    //    "关系状态从疏远转向缓和"）—— 子串命中会把那一行当成新栏标题，
    //    其后的内容全部串进错误的栏，下一轮总结再基于串栏的档案继续漂移。
    if (!t.startsWith(bare)) return null
    const after = t.slice(bare.length)
    if (after && !new RegExp(`^${SEP}`).test(after)) return null
    return { key, rest: after.replace(new RegExp(`^${SEP}+`), '') }
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

/** 水位线之后的第一条消息 id（总结完成后推进到哪 —— 推进到「最后一条」即可） */
export function nextWatermark(session: Pick<FreeSession, 'messages'>): { messageId: string; at: number } | null {
  // 🔴 必须与 `messagesAfterWatermark` 用**同一个过滤条件**（都排除 hidden）：
  //    两边不一致时，若末尾消息被隐藏，水位线记的 id 在消费端会被过滤掉 → `i < 0` → 整场重喂
  //    （旧剧情被重复总结、数值按同一批事件反复累加）。2026-09-19 六维审计 P1-6。
  const msgs = session.messages.filter(m => m.role !== 'system' && !m.hidden)
  const last = msgs[msgs.length - 1]
  return last ? { messageId: last.id, at: Date.now() } : null
}

// ==================== 跨实例锁（方案 §4.6 的②③） ====================
// 🚫 ① 时间节流 与「条数阈值判断」在 2026-09-16 随**自动整理**一并废除：
//    两种模式都由作者手动触发（自由对话「结束本轮对话」/ 剧情推演「整理本场记忆」），
//    手动触发不受阈值与节流限制，留着一整套自动判定只会成为死代码。
//    现在只剩跨实例锁 + TTL：纯前端没有原子操作，localStorage 锁只能「尽力而为」——
//    但足以挡掉「两个窗口同时总结」这种常见情形，以及在跑崩之后靠 TTL 解锁。

const LOCK_KEY = 'yfe-tavern-summary-lock'

/** 尝试取锁；陈旧锁（超过 TTL）可被接管 */
export function acquireSummaryLock(now = Date.now(), ttlMs = SUMMARY_LOCK_TTL_MS): boolean {
  try {
    const raw = localStorage.getItem(LOCK_KEY)
    if (raw) {
      const at = Number(raw)
      if (Number.isFinite(at) && now - at < ttlMs) return false // 别的窗口正在跑
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

export { MEMORY_SOFT_LIMIT, MEMORY_HARD_LIMIT }

/**
 * 取出尚未被总结的消息（水位线之后的 user / assistant）。
 * 水位线消息被删等异常时按「全部未总结」处理（宁可多总结一次，也别漏掉一大段）。
 */
export function messagesAfterWatermark(
  messages: FreeSession['messages'],
  watermark?: { messageId: string; at?: number } | null,
): FreeSession['messages'] {
  // 隐藏的消息既不进上下文，也不该被整理进记忆（隐藏的语义就是「别让 AI 看见」）
  const msgs = messages.filter(m => m.role !== 'system' && !m.hidden)
  const wm = watermark?.messageId
  if (!wm) return msgs
  const i = msgs.findIndex(m => m.id === wm)
  if (i < 0) {
    // 🔴 水位线消息找不到（被删 / 刚被隐藏）时**不能整场重喂**（2026-09-19 六维审计 P1-6）：
    //    那会把旧剧情重新总结一遍、数值按同一批事件反复累加。按水位线的时间戳兜底取它之后的。
    const at = watermark?.at
    if (typeof at === 'number') {
      const after = msgs.filter(m => (m.at ?? 0) > at)
      if (after.length !== msgs.length) return after
    }
    return msgs // 连时间也没有（老数据）→ 只能按「全部未总结」处理，宁可多总结一次
  }
  return msgs.slice(i + 1)
}
