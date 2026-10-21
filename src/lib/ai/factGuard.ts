// ============ WQ8 文本守卫 · 事实保留自检（方案 A：登记实体 + 只报告不判定） ============
// 2026-10-21 · 方案 §11 / §16.9 · 决策记录 `docs/3.2.0-WQ8-guardText事实来源-待决-2026-10-21.md`
//
// 🔴🔴 为什么**只报告、不判定通过与否**（主人 10-21 拍板方案 A 的核心）：
//   `knownFacts` 取自「本章正文出现过的登记实体」，而实体被改写删掉**常常是合理润色**
//   （一段里少提一次人名、换个叫法）。十条"可能丢失事实"里九条是这种 ——
//   一旦接上 `guardText` 的 `passed` 阈值（保留率 ≥ 0.8），界面就会假阴性刷屏，
//   作者两周后不再看它，**真问题也一起被无视**。噪音比没有守卫更糟。
//   所以这里只回答一个问题：「改写后哪些登记实体没再出现」，附上来源让作者自己判断。
//
// 🔴 别名的处理：判定"丢没丢"要看**正式名 + 全部别称**是否还在。
//   只用正式名会把「正文用简称、改写后简称还在」误报成丢失。

import type { EntityRegistry } from '@/lib/settings/settingLedger'
import { guardText } from './qualityGuard'

/** 一个"改写后应该还在"的事实：登记实体名 + 来源（作者能指回设定表哪一行） */
export interface GuardFact {
  /** 正式名（判定用） */
  name: string
  /** 别称（判定用：任一还在就算保留） */
  aliases: string[]
  /** 实体类别（人物 / 势力 / 地点 / 种族 / 物品 / 术语） */
  type: string
  /** 来源页签（char-main / nations / terms …），供界面跳转核对 */
  tabId: string
  /** 登记条目 id */
  entryId: string
}

export interface FactGuardReport {
  /**
   * 有没有真的核验过。
   * 🔴 正文为空 / 登记表为空 ⇒ `false` —— 此时界面**不该渲染这一段**，
   *    而不是显示"0/0 保留"或"没有丢失"（没查过和查过没事是两回事）。
   */
  checked: boolean
  /** 参与核验的实体数（本章正文出现过的） */
  total: number
  /** 改写后仍出现的 */
  retained: number
  /** 改写后没再出现的（带来源，作者自己判断该不该在） */
  lost: GuardFact[]
  /** 额外提示（如"正文被过度缩短"）—— 同样只提示，不判定 */
  notes: string[]
  /** 一句话摘要；**空串 ⇒ 调用方别渲染这一段** */
  summary: string
}

/** 少于这个长度的名字不参与（单字名如「剑」几乎必然误报）—— 导出供单测钉住 */
export const MIN_NAME_LEN = 2

/**
 * 从登记表里挑出**在正文中出现过**的实体。
 *
 * 🔴 为什么要"出现过"：没在正文里出现的实体，改写后当然也不在 ——
 *    把它算进 knownFacts 等于制造必然的误报（保留率永远上不去）。
 */
export function collectFacts(reg: EntityRegistry, body: string): GuardFact[] {
  const text = body ?? ''
  if (!text.trim()) return []
  const out: GuardFact[] = []
  for (const [type, entries] of Object.entries(reg)) {
    for (const e of entries) {
      const name = (e.name ?? '').trim()
      if (name.length < MIN_NAME_LEN) continue
      const aliases = (e.aliases ?? []).map(a => (a ?? '').trim()).filter(a => a.length >= MIN_NAME_LEN)
      const hit = text.includes(name) || aliases.some(a => text.includes(a))
      if (!hit) continue
      out.push({ name, aliases, type, tabId: e.tabId, entryId: e.id })
    }
  }
  // 同名条目（正式名撞车）只留一条：留第一个，来源足够作者核对
  const seen = new Set<string>()
  return out.filter(f => (seen.has(f.name) ? false : (seen.add(f.name), true)))
}

/** 摘要（给界面/日志用；一切正常就返回空串，别刷屏） */
function summarize(rep: FactGuardReport): string {
  if (!rep.checked || (rep.lost.length === 0 && rep.notes.length === 0)) return ''
  const parts: string[] = []
  if (rep.lost.length) {
    const shown = rep.lost.slice(0, 3).map(f => `${f.name}（${f.type}）`).join('、')
    parts.push(`${rep.lost.length} 个登记实体改写后没再出现：${shown}${rep.lost.length > 3 ? ' 等' : ''}`)
  }
  parts.push(...rep.notes)
  return parts.join('；')
}

/**
 * 事实保留自检：改写前后，哪些登记实体没再出现。
 *
 * @param reg   全项目登记表（`loadRegistry()`）
 * @param original 改写前正文（实体集合从它里面挑）
 * @param revised  改写后正文
 *
 * 🔴 全程不抛：这是旁路自检，读库/计算失败都不该影响已落库的正文。
 */
export async function checkFactRetention(
  reg: EntityRegistry,
  original: string,
  revised: string,
): Promise<FactGuardReport> {
  const facts = collectFacts(reg, original)
  const report: FactGuardReport = {
    checked: facts.length > 0,
    total: facts.length,
    retained: 0,
    lost: [],
    notes: [],
    summary: '',
  }
  if (!report.checked) return report

  for (const f of facts) {
    const still = revised.includes(f.name) || f.aliases.some(a => revised.includes(a))
    if (still) report.retained++
    else report.lost.push(f)
  }

  // `guardText` 的 `falsePositives`（正文被过度缩短）是它独有的价值，这里只取**提示**，
  // 不取 `passed` / 不取 `factRetentionRate`（我们自己的口径含别名，比它的更准）。
  const guard = guardText(original, revised, new Set(facts.map(f => f.name)), [])
  report.notes.push(...guard.issues.filter(i => i.includes('过度缩短')))
  report.summary = summarize(report)
  return report
}
