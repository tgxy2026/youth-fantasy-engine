/**
 * 跑团互动 · 秘密与结局（3.0 · W4-3d）
 *
 * 【D3=A：结构化表单 + 条件判定】为什么不做纯叙事：§10.3 #11 要求
 *   「**三条结局**……不同玩家 / 不同分支拥有**独立经历**」——
 *   只有条件**可判、可复现**，才有「换一组选择 → 走到另一个结局」这回事。
 *   纯叙事下模型每次判得都不一样，谈不上「分支」。
 *
 * 【秘密的两条解锁路径】
 *   ① **派生**（本文件）：条件满足自动揭露 —— `revealOn.clueIds` 命中任一 / `revealOn.flags` 命中任一；
 *   ② **显式**（KP 裁决）：`KpVerdict.revealsSecretId` 指定 —— 有些秘密是「说破了」而非「查到了」。
 *   两条路的落点都是同一个 `unlocked` 字段，界面只认它。
 *
 * 【结局的 Tier】达成 / 接近 / 未启 —— 不只是「成没成」：给作者看「还差什么」才有用
 *   （`missing` 就是那份清单）。⚠️ 空条件的结局判为**未启**（不是「达成」）——
 *   否则忘填条件的结局会一开局就自动达成。
 *
 * 【边界】纯逻辑：不调 AI、不碰 React、不碰 db。
 */
import type { RunSession, RunSecret, RunEnding, RunEndingCondition } from './runTypes'

// ==================== 剧情 flag ====================

function normFlag(s: string): string { return String(s ?? '').trim() }

export function hasFlag(s: RunSession, flag: string): boolean {
  const f = normFlag(flag)
  return !!f && (s.flags ?? []).includes(f)
}

export function addFlag(s: RunSession, flag: string): RunSession {
  const f = normFlag(flag)
  const cur = s.flags ?? []
  if (!f || cur.includes(f)) return s
  return { ...s, flags: [...cur, f], updatedAt: Date.now() }
}

export function removeFlag(s: RunSession, flag: string): RunSession {
  const f = normFlag(flag)
  const cur = s.flags ?? []
  if (!f || !cur.includes(f)) return s
  return { ...s, flags: cur.filter(x => x !== f), updatedAt: Date.now() }
}

// ==================== 秘密 ====================

/**
 * 这条秘密的**派生解锁条件**是否已满足。
 *
 * 判据：`revealOn` 里声明的维度（`clueIds` / `flags`）**任一命中即算满足**（OR）。
 * 为什么是 OR 而不是 AND：作者写两条线索时，通常表达的是「查到 A 或查到 B 都能知道」；
 * 要他表达 AND，就把两件事写成同一条线索。**未声明任何条件** → 不由线索驱动（false），
 * 这条秘密只能靠 KP 显式揭示（`unlockSecretById`）。
 */
export function secretUnlockable(s: RunSession, secret: RunSecret): boolean {
  if (secret.unlocked) return true
  const cond = secret.revealOn
  if (!cond) return false

  const acquiredIds = new Set(s.clues.filter(c => c.acquired).map(c => c.id))
  if (cond.clueIds?.some(id => acquiredIds.has(id))) return true
  if (cond.flags?.some(f => hasFlag(s, f))) return true
  return false
}

/**
 * 结算这一轮所有「可由线索 / flag 触发」的秘密。返回新会话与**本次新揭露**的清单。
 * 已揭的不会重复计入 `unlocked`（幂等）。
 */
export function checkSecretUnlock(s: RunSession): { session: RunSession; unlocked: RunSecret[] } {
  const unlocked: RunSecret[] = []
  const secrets = s.secrets.map(sec => {
    if (sec.unlocked || !secretUnlockable(s, sec)) return sec
    const next = { ...sec, unlocked: true }
    unlocked.push(next)
    return next
  })
  if (!unlocked.length) return { session: s, unlocked }
  return { session: { ...s, secrets, updatedAt: Date.now() }, unlocked }
}

/** 显式揭示某条秘密（KP 裁决 `revealsSecretId` 的落点）。找不到或已揭则原样返回。 */
export function unlockSecretById(s: RunSession, id: string): RunSession {
  const i = s.secrets.findIndex(x => x.id === id)
  if (i < 0 || s.secrets[i].unlocked) return s
  const secrets = s.secrets.slice()
  secrets[i] = { ...secrets[i], unlocked: true }
  return { ...s, secrets, updatedAt: Date.now() }
}

export function lockedSecrets(s: RunSession): RunSecret[] { return s.secrets.filter(x => !x.unlocked) }
export function unlockedSecrets(s: RunSession): RunSecret[] { return s.secrets.filter(x => x.unlocked) }

// ==================== 结局 ====================

export type EndingTier = '达成' | '接近' | '未启'

export interface EndingEval {
  ending: RunEnding
  tier: EndingTier
  /** 未满足的条件（人话），界面据此显示「还差什么」 */
  missing: string[]
}

/**
 * 单条结局的条件是否成立 —— 逐项列出「满没满足」，供 Tier 与 `missing` 共用。
 * 三个维度都是「**全部**满足」才算这一维度过（与秘密的 OR 不同：结局是「凑齐」）。
 */
function requirements(s: RunSession, cond: RunEndingCondition): { label: string; ok: boolean }[] {
  const reqs: { label: string; ok: boolean }[] = []

  for (const id of cond.secretIds ?? []) {
    const sec = s.secrets.find(x => x.id === id)
    reqs.push({ label: `秘密「${sec?.text ?? id}」未揭晓`, ok: !!sec?.unlocked })
  }

  const acquired = new Set(s.clues.filter(c => c.acquired).map(c => c.id))
  for (const id of cond.clueIds ?? []) {
    const clue = s.clues.find(x => x.id === id)
    reqs.push({ label: `线索「${clue?.text ?? id}」未获得`, ok: acquired.has(id) })
  }

  for (const [key, min] of Object.entries(cond.varMin ?? {})) {
    if (typeof min !== 'number') continue
    const raw = s.vars?.values?.[key as keyof typeof s.vars.values]
    const v = typeof raw === 'number' ? raw : Number(raw)
    const ok = Number.isFinite(v) && v >= min
    reqs.push({ label: `${key} 需达到 ${min}（当前 ${Number.isFinite(v) ? v : '无'}）`, ok })
  }

  return reqs
}

/** 判一条结局：达成（全中）/ 接近（中了至少一项）/ 未启（一项没中，或压根没填条件） */
export function evalEnding(s: RunSession, ending: RunEnding): EndingEval {
  const reqs = requirements(s, ending.condition ?? {})
  if (!reqs.length) {
    return { ending, tier: '未启', missing: ['（未设定达成条件 —— 该结局不会自动达成）'] }
  }
  const missing = reqs.filter(r => !r.ok).map(r => r.label)
  const hit = reqs.length - missing.length
  const tier: EndingTier = missing.length === 0 ? '达成' : (hit > 0 ? '接近' : '未启')
  return { ending, tier, missing }
}

export function evalEndings(s: RunSession): EndingEval[] {
  return s.endings.map(e => evalEnding(s, e))
}

/** 已达成（Tier='达成'）的结局 */
export function reachedEndings(s: RunSession): EndingEval[] {
  return evalEndings(s).filter(e => e.tier === '达成')
}

/**
 * 把 Tier 写回 `endings[].reached`（界面 / 索引读 `reached` 一处，不各自再算一遍）。
 * 无变化时原样返回（避免无意义的落库）。
 */
export function applyEndings(s: RunSession): RunSession {
  const evals = evalEndings(s)
  let changed = false
  const endings = s.endings.map((e, i) => {
    const reached = evals[i].tier === '达成'
    if (e.reached === reached) return e
    changed = true
    return { ...e, reached }
  })
  if (!changed) return s
  return { ...s, endings, updatedAt: Date.now() }
}
