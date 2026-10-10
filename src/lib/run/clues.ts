/**
 * 跑团互动 · 线索板与同伴（3.0 · W4-3c）
 *
 * 【线索板（§10.3 #11「调查」）】玩家「观察 / 交谈 / 取证」得来的碎片，入板后可回看、可关联秘密。
 *   两条设计约束：
 *   ① **去重** —— 同一处反复搜会得到同一条线索，不去重就会攒出一堆重复条目、白占上下文；
 *   ② **未获 / 已获两态** —— 线索可以在开局**先埋**（`acquired:false`），到条件满足才入手，
 *      这样「场上有几条线」对 KP 是已知的，对玩家是未知的。
 *
 * 【同伴（§10.3 #11「同伴」）】随行的 NPC，各有立场与**知晓边界** ——
 *   复用本项目独门「知情权限」思路：`knows` 里没写的事，AI 不许让他「知道」。
 *   本文件只提供**判定**（`companionKnows` / `whoKnows` / `auditKnowsLeak`）；
 *   把边界写进提示词、并在生成后校验，是 W4-3b（KP 层）与 W4-3e（界面）的活。
 *
 * 【边界】纯逻辑：不调 AI、不碰 React、不碰 db。
 */
import type { RunSession, RunClue, RunClueSource, RunCompanion } from '@/lib/run/runTypes'

// ==================== 线索板 ====================

let clueSeq = 0
function clueId(): string { return `clue_${Date.now().toString(36)}_${(clueSeq++).toString(36)}` }

/** 去重键：抹掉空白、忽略大小写 —— 「钟声 停了」与「钟声停了」算同一条 */
function normKey(text: string): string {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase()
}

export interface AcquireResult {
  session: RunSession
  /** 新入板的线索（重复时为**已存在的那条**；空文本时为 null） */
  clue: RunClue | null
  /** 是否因重复而未新增 */
  duplicated: boolean
}

/**
 * 获得一条线索（纯函数）。空文本会被忽略（`clue: null`）。
 * 🔴 去重按归一化文本比对：**同一文本不重复入板**。
 */
export function acquireClue(
  s: RunSession,
  input: { text: string; source?: RunClueSource; linksSecretId?: string },
): AcquireResult {
  const text = String(input.text ?? '').trim()
  if (!text) return { session: s, clue: null, duplicated: false }

  const key = normKey(text)
  const existing = s.clues.find(c => normKey(c.text) === key)
  if (existing) {
    // 🔴 命中**已埋未获**的那条 ⇒ 这是「发现了它」，不是重复 —— 置为已获（否则线索永远拿不到手）
    if (!existing.acquired) {
      const idx = s.clues.indexOf(existing)
      const clues = s.clues.slice()
      clues[idx] = { ...existing, acquired: true, at: Date.now() }
      return { session: { ...s, clues, updatedAt: Date.now() }, clue: clues[idx], duplicated: false }
    }
    return { session: s, clue: existing, duplicated: true }
  }

  const clue: RunClue = {
    id: clueId(),
    text,
    source: input.source ?? '其他',
    acquired: true,
    at: Date.now(),
  }
  if (input.linksSecretId) clue.linksSecretId = input.linksSecretId
  return { session: { ...s, clues: [...s.clues, clue], updatedAt: Date.now() }, clue, duplicated: false }
}

/** 预设一条「已埋未获」的线索（开局用；玩家还没发现它） */
export function plantClue(s: RunSession, input: { text: string; source?: RunClueSource; linksSecretId?: string }): RunSession {
  const text = String(input.text ?? '').trim()
  if (!text || s.clues.some(c => normKey(c.text) === normKey(text))) return s
  const clue: RunClue = { id: clueId(), text, source: input.source ?? '其他', acquired: false, at: Date.now() }
  if (input.linksSecretId) clue.linksSecretId = input.linksSecretId
  return { ...s, clues: [...s.clues, clue], updatedAt: Date.now() }
}

export function acquiredClues(s: RunSession): RunClue[] {
  return s.clues.filter(c => c.acquired)
}

export function pendingClues(s: RunSession): RunClue[] {
  return s.clues.filter(c => !c.acquired)
}

/** 已获线索 id（供「秘密解锁条件」判定用） */
export function acquiredClueIds(s: RunSession): string[] {
  return acquiredClues(s).map(c => c.id)
}

/** 把一条「已埋」的线索置为已获（按 id）。找不到或已获则原样返回。 */
export function revealClue(s: RunSession, clueId: string): RunSession {
  const i = s.clues.findIndex(c => c.id === clueId)
  if (i < 0 || s.clues[i].acquired) return s
  const clues = s.clues.slice()
  clues[i] = { ...clues[i], acquired: true, at: Date.now() }
  return { ...s, clues, updatedAt: Date.now() }
}

export function dropClue(s: RunSession, id: string): RunSession {
  return { ...s, clues: s.clues.filter(c => c.id !== id), updatedAt: Date.now() }
}

/** 线索统计（界面与索引共用一处口径） */
export function clueStats(s: RunSession): { acquired: number; total: number } {
  const acquired = s.clues.filter(c => c.acquired).length
  return { acquired, total: s.clues.length }
}

// ==================== 同伴 ====================

/** 添加同伴（按 charId 去重：同一角色不重复入列；名字空白时回落到「同伴」） */
export function addCompanion(
  s: RunSession,
  c: { charId: string; name?: string; stance?: string; knows?: string[]; canHelp?: boolean },
): RunSession {
  const charId = String(c.charId ?? '').trim()
  if (!charId || s.companions.some(x => x.charId === charId)) return s
  const companion: RunCompanion = {
    charId,
    name: String(c.name ?? '').trim() || '同伴',
    stance: String(c.stance ?? '').trim(),
    knows: (c.knows ?? []).map(k => String(k ?? '').trim()).filter(Boolean),
    canHelp: !!c.canHelp,
  }
  return { ...s, companions: [...s.companions, companion], updatedAt: Date.now() }
}

export function dropCompanion(s: RunSession, charId: string): RunSession {
  return { ...s, companions: s.companions.filter(c => c.charId !== charId), updatedAt: Date.now() }
}

export function updateCompanion(
  s: RunSession,
  charId: string,
  patch: Partial<Omit<RunCompanion, 'charId'>>,
): RunSession {
  const i = s.companions.findIndex(c => c.charId === charId)
  if (i < 0) return s
  const companions = s.companions.slice()
  companions[i] = { ...companions[i], ...patch, charId }
  return { ...s, companions, updatedAt: Date.now() }
}

/**
 * 这个同伴是否**知晓**某件事。
 *
 * 🔴 判据＝归一化后的**双向包含**：`知晓条目 ⊇ 话题` 或 `话题 ⊇ 知晓条目`。
 *   为什么双向：作者的「知晓」写得宽（「码头的事」）而模型问得细（「码头第三根桩」）时要算知道；
 *   反过来「知晓」写得很细、话题写得很粗（「码头的事」）时也不该判成不知道。
 * ⚠️ 这是**粗匹配**，用于「防越界」的保守提示，不是法律级判定 —— 宁可放过、不可误伤。
 */
export function companionKnows(c: RunCompanion, topic: string): boolean {
  const t = normKey(topic)
  if (!t) return false
  return c.knows.some(k => {
    const kk = normKey(k)
    return !!kk && (kk.includes(t) || t.includes(kk))
  })
}

/** 在场同伴里**知晓**这件事的人（知情权限：不在名单里的就不该「知道」） */
export function whoKnows(companions: RunCompanion[], topic: string): RunCompanion[] {
  return companions.filter(c => companionKnows(c, topic))
}

export interface KnowsLeak {
  charId: string
  name: string
  topic: string
}

/**
 * 知晓边界审计：给定文本里出现的「话题」，找出**明确不在场知情**的同伴（可用于生成后自查）。
 *
 * @param topics 需要核对的「事」的清单（如本场秘密 / 关键线索的文案）
 * @returns 每个「被提及但不知晓」的同伴 × 话题组合 —— 调用方可据此提示作者或喂给 KP 纠正
 */
export function auditKnowsLeak(companions: RunCompanion[], text: string, topics: string[]): KnowsLeak[] {
  const body = normKey(text)
  if (!body) return []
  const out: KnowsLeak[] = []
  for (const c of companions) {
    for (const topic of topics) {
      const t = String(topic ?? '').trim()
      if (!t || !body.includes(normKey(t))) continue      // 文本里没提这件事
      if (companionKnows(c, t)) continue                  // 他本来就知道
      out.push({ charId: c.charId, name: c.name, topic: t })
    }
  }
  return out
}

/** 能搭把手的同伴（检定加成用） */
export function helpfulCompanions(companions: RunCompanion[]): RunCompanion[] {
  return companions.filter(c => c.canHelp)
}
