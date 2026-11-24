// ============ 开篇结论快照（3.7.0 · W6 复核补）============
//
// 为什么需要它：黄金三章检查原本只活在一次会话的结果卡里 —— 关掉面板就没了，
// 「投稿体检」因此只能写「未跑」。这里把**那次结论的原话**存进项目 settingsKV（只存结论一句，
// 不复制整篇报告），体检页就能引用「当时到底怎么说的」。
//
// 🔴 只存结论、不存正文/提示词；读不到一律返回 null（体检页据此如实写「未跑」，不编造）。
import * as db from '@/lib/db'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'

export const OPENING_SNAPSHOT_KEY = 'openingConclusion'
export const OPENING_SOURCE = '颉文姬 · 审读 · 黄金三章'

export interface OpeningSnapshot {
  /** AI 的定性原话（一句话定调；取不到定调时退化为报告首句） */
  conclusion: string
  at: number
  source: string
  chapterId?: string
}

/**
 * 纯函数：从「黄金三章」报告里取那句定调。
 *
 * 优先「定调」那一行；否则在报告前 40 行里找含「能签 / 需改 / 扑街」的句子。
 * 都取不到就取第一句实质内容 —— 绝不编造结论。
 */
export function extractOpeningConclusion(report: string): string {
  const lines = (report ?? '').split(/\r?\n/).map(l => l.replace(/^[#>\-*\s]+/, '').trim()).filter(Boolean)
  const verdictRe = /能签|需改|要改|扑街/
  const tone = lines.find(l => l.includes('定调') && verdictRe.test(l))
  if (tone) return clip(tone.replace(/^一句话定调[：:]\s*/, ''))
  const early = lines.slice(0, 40).find(l => verdictRe.test(l))
  if (early) return clip(early)
  return clip(lines[0] ?? '')
}

function clip(text: string): string {
  const t = text.trim()
  return t.length > 120 ? `${t.slice(0, 120)}…` : t
}

/** 存结论（旁路：失败静默，检查结果本身不受影响） */
export async function saveOpeningSnapshot(
  projectId: string, report: string, opts: { chapterId?: string; owner?: OwnedOperation } = {},
): Promise<boolean> {
  const conclusion = extractOpeningConclusion(report)
  if (!projectId || !conclusion) return false
  const snap: OpeningSnapshot = {
    conclusion,
    at: Date.now(),
    source: OPENING_SOURCE,
    ...(opts.chapterId ? { chapterId: opts.chapterId } : {}),
  }
  try {
    opts.owner?.assertCurrent()
    if (opts.owner) await db.setSettingFor(projectId, OPENING_SNAPSHOT_KEY, snap, opts.owner)
    else await db.setSetting(OPENING_SNAPSHOT_KEY, snap)
    return true
  } catch {
    return false
  }
}

/** 读结论快照；没有 / 损坏一律 null（界面写「未跑」） */
export async function readOpeningSnapshot(projectId: string, owner?: OwnedOperation): Promise<OpeningSnapshot | null> {
  try {
    const raw = owner
      ? await db.getSettingFor<unknown>(projectId, OPENING_SNAPSHOT_KEY, null, owner)
      : await db.getSettingFor<unknown>(projectId, OPENING_SNAPSHOT_KEY, null)
    if (!raw || typeof raw !== 'object') return null
    const v = raw as Partial<OpeningSnapshot>
    if (typeof v.conclusion !== 'string' || !v.conclusion.trim()) return null
    return {
      conclusion: v.conclusion,
      at: typeof v.at === 'number' ? v.at : 0,
      source: typeof v.source === 'string' && v.source ? v.source : OPENING_SOURCE,
      ...(typeof v.chapterId === 'string' && v.chapterId ? { chapterId: v.chapterId } : {}),
    }
  } catch {
    return null
  }
}