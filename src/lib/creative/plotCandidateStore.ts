/**
 * 剧情候选 · 生成与安全应用（3.6.0 · F 包首期）
 *
 * 落点：`settingsKV` 的 `<projectId>::plotCandidates`（滚动 50 条）。
 * 唯一可写目标：**已有章节细纲卡的字段**（`chapter-outline` 的 cardRecords.data）。
 * 不建卷/章、不改正文、不改设定、不动作画布 —— 本文件里根本没有那几条写路径。
 *
 * 三条执行纪律（与 `plotCandidates.ts` 的纯逻辑对应）：
 *  · 应用前**重读**卡并比指纹：过期 ⇒ 拒绝（只给差异）；
 *  · 逐字段核对 `before === current`：被改过 ⇒ 跳过并展示，绝不覆盖；
 *  · 只把 `ok` 字段合并进一次性写入，并如实返回逐项结果。
 */
import * as db from '@/lib/db'
import { getSettingFor, setSettingFor } from '@/lib/db/meta'
import { uid } from '@/lib/app/id'
import { chapterSeqMap } from '@/lib/outline/chapterSeq'
import { ask } from '@/lib/editor/wordRange'
import { requireProviderFor } from '@/lib/ai'
import { loadDraftMappingContexts } from '@/lib/flow/draftMapping'
// 3.6.0 · F：项目还没保存过模板快照时，**内置 schema 就是有效模板**（作者没改过）
import { TABS } from '@/lib/schema'
import { adaptBuiltinTab } from '@/lib/templates/legacyAdapter'
import {
  APPLY_OUTCOME_LABEL, OUTLINE_SLOTS, OUTLINE_TAB, outlineFingerprintOf, parsePlotCandidates, bodyDigestOf,
  planPlotApply, planPlotRevert, resolveOutlineFields, type PlotApplyReport, type PlotCandidate,
} from './plotCandidates'

export const PLOT_CANDIDATE_KEY = 'plotCandidates'
export const PLOT_CANDIDATE_LIMIT = 50

export interface LoadedPlotCandidates {
  list: PlotCandidate[]
  error?: string
}

function isCandidate(v: unknown): v is PlotCandidate {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.outlineCardId === 'string'
    && Array.isArray(o.fields) && typeof o.createdAt === 'number'
}

export async function loadPlotCandidates(projectId: string): Promise<LoadedPlotCandidates> {
  if (!projectId) return { list: [] }
  try {
    const raw = await getSettingFor<unknown>(projectId, PLOT_CANDIDATE_KEY, null)
    if (raw === null || raw === undefined) return { list: [] }
    if (!Array.isArray(raw)) return { list: [], error: '剧情候选的结构不合法（不是数组）' }
    return { list: raw.filter(isCandidate).sort((a, b) => b.createdAt - a.createdAt) }
  } catch (e) {
    return { list: [], error: `剧情候选读取失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

async function write(projectId: string, list: PlotCandidate[]): Promise<void> {
  await setSettingFor(projectId, PLOT_CANDIDATE_KEY, list.slice(0, PLOT_CANDIDATE_LIMIT))
}

/**
 * 3.7.0 · W2：按章号取所属章正文摘要（只服务“候选基准”提示；取不到就是 undefined）。
 * 🔴 只对**当前项目**能取：章列表读的是 currentProjectId 的库，串书比取不到更糟。
 */
async function bodyDigestForChapterNo(projectId: string, chapterNo: number): Promise<string | undefined> {
  if (!(chapterNo > 0) || projectId !== db.getCurrentProjectId()) return undefined
  try {
    const chapters = await db.getAllChapters()
    const seq = chapterSeqMap(await db.getAllVolumes(), chapters)
    const hit = chapters.find(c => (seq.get(c.id) ?? 0) === chapterNo)
    return hit ? bodyDigestOf(hit.content ?? '') : undefined
  } catch {
    return undefined
  }
}

/**
 * 取细纲卡当前的有效字段解析。
 *
 * 🔴 回落规则：项目**还没有模板快照**（新建项目、从没编辑过模板）时，内置 schema 就是
 *    "有效模板" —— 作者没改过，就该按内置字段来。没有这条回落，新项目会一直显示
 *    「字段解析不到 ⇒ 只能参考不能应用」，功能等于不可用（而这不是安全边界，是误判）。
 *    只有在**读到了自定义模板但匹配不唯一/找不到**时，才真的是"不给应用"。
 */
export async function outlineFieldKeys(projectId: string): Promise<{
  resolved: { slot: string; key: string; label: string }[]
  missing: { slot: string; reason: 'not-found' | 'ambiguous' }[]
}> {
  const ctx = await loadDraftMappingContexts(projectId, [OUTLINE_TAB]).catch(() => null)
  const live = ctx?.get(OUTLINE_TAB)?.template.fields ?? []
  const fields = live.length ? live : builtinOutlineFields()
  if (!fields.length) {
    return { resolved: [], missing: OUTLINE_SLOTS.map(d => ({ slot: d.slot, reason: 'not-found' as const })) }
  }
  return resolveOutlineFields(fields)
}

/** 内置细纲页签的字段（只读；模板读不到时用它） */
function builtinOutlineFields(): { sourceKey: string; label: string; archived?: boolean }[] {
  const tab = TABS.find(t => t.id === OUTLINE_TAB)
  if (!tab) return []
  try {
    return adaptBuiltinTab(tab).fields.map(f => ({ sourceKey: f.sourceKey, label: f.label, archived: f.archived }))
  } catch {
    return []
  }
}

/**
 * 读细纲卡。
 * 🔴 必须按**调用方给的项目**读（`getCardRecordsFor`）：用 `getCardRecords` 会落到
 *    「当前打开的项目」，后台任务/切换项目时可能读不到卡，甚至读到别的项目的同名卡。
 */
async function loadCard(projectId: string, cardId: string) {
  const cards = await db.getCardRecordsFor(projectId, OUTLINE_TAB)
  return cards.find(c => c.id === cardId) ?? null
}

/** 生成提示词：只给这张细纲卡的当前值 + 可选上下文，不重读全书 */
function buildPrompt(card: { name: string; data: Record<string, string> }, resolved: readonly { slot: string; key: string }[], contextText?: string): string {
  const cur = resolved.map(r => `- ${r.slot}：${(card.data[r.key] ?? '').trim() || '（空）'}`).join('\n')
  return [
    '你在帮作者把这一章的细纲想出几个"可以怎么走"的分歧方案。',
    `【本章】${card.name}`,
    '【当前细纲】',
    cur,
    ...(contextText?.trim() ? ['', '【项目上下文（只读）】', contextText.trim().slice(0, 4000)] : []),
    '',
    '请给 2~3 个候选，每个候选是一个**不同的走法**（不是同义改写）：',
    '{"title":"≤20字","branchPoint":"分歧点一句话（在哪里分岔）","rationale":"为什么这样走，≤150字","fields":{"一句话事件":"...","章末钩子":"...","本章功能":"..."}}',
    '要求：',
    `1. fields 的键只能用：${OUTLINE_SLOTS.map(d => d.aiKey).join(' / ')}，只给需要改的；`,
    '2. 只写这些字段的新值，不要重写没提到的字段；',
    '3. 不要编造新人物/新设定，除非上下文里已有；',
    '4. 只输出 JSON 数组，不要解释。',
  ].join('\n')
}

export interface GeneratePlotOptions {
  signal?: AbortSignal
  acpText?: (prompt: string, call?: { signal?: AbortSignal }) => Promise<string>
  /** 可选的只读上下文（如最近三章摘要），不会写回任何地方 */
  contextText?: string
  maxCandidates?: number
}

/**
 * 为一张细纲卡生成候选（只保存候选，不动细纲）。
 * 失败/无字段可写时返回明确原因，不抛。
 */
export async function generatePlotCandidates(projectId: string, cardId: string, opts: GeneratePlotOptions = {}): Promise<{
  ok: boolean
  created: number
  error?: string
  candidateIds: string[]
}> {
  const card = await loadCard(projectId, cardId)
  if (!card) return { ok: false, created: 0, error: '这张细纲卡已不在项目里', candidateIds: [] }
  const { resolved } = await outlineFieldKeys(projectId)
  if (!resolved.length) {
    return { ok: false, created: 0, error: '当前模板里解析不到可写的细纲字段（可能被改名或归档）—— 这种情况只支持看参考，不提供应用', candidateIds: [] }
  }
  const cfg = opts.acpText ? null : await requireProviderFor('create').catch(() => null)
  if (!cfg && !opts.acpText) return { ok: false, created: 0, error: '还没有配置模型（或 ACP 未就绪）', candidateIds: [] }

  let text = ''
  try {
    text = await ask(cfg, '你是资深网文编辑。只基于给出的细纲与上下文提出走法，不编造设定。', buildPrompt(card, resolved, opts.contextText), {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.acpText ? { acpText: opts.acpText } : {}),
    })
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    return {
      ok: false, created: 0, candidateIds: [],
      error: name === 'AbortError' ? '已中止' : `生成失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const no = card.name.match(/第\s*(\d+)\s*章/)?.[1]
  const chapterNo = no ? Number(no) : 0
  const parsed = parsePlotCandidates(text, {
    projectId,
    outlineCardId: card.id,
    chapterNo,
    chapterTitle: card.name,
    outlineFingerprint: outlineFingerprintOf(card, resolved.map(r => r.key)),
    resolved,
    current: card.data,
    makeId: uid,
    now: Date.now(),
    maxCandidates: opts.maxCandidates ?? 3,
  })
  if (!parsed.candidates.length) {
    return { ok: false, created: 0, candidateIds: [], error: '模型没有给出可应用的候选（可能字段没变化或格式不对），可重试' }
  }
  const { list } = await loadPlotCandidates(projectId)
  // 3.7.0 · W2：候选基准包含“所属章正文”—— 正文改了以后这份候选就该过期
  const bodyDigest = await bodyDigestForChapterNo(projectId, chapterNo)
  await write(projectId, [...parsed.candidates.map(c => (bodyDigest ? { ...c, bodyDigest } : c)), ...list])
  return { ok: true, created: parsed.candidates.length, candidateIds: parsed.candidates.map(c => c.id) }
}

export interface ApplyPlotResult {
  ok: boolean
  status: PlotCandidate['status']
  report: PlotApplyReport
  error?: string
}

/**
 * 应用候选：重读 → 指纹校验 → 逐字段比对 → 一次性写入 ok 字段。
 *
 * 🔴 过期/已放弃/已应用 ⇒ 直接拒绝（先把 reason 交出去，界面展示差异）。
 */
export async function applyPlotCandidate(projectId: string, candidateId: string): Promise<ApplyPlotResult> {
  const { list } = await loadPlotCandidates(projectId)
  const idx = list.findIndex(c => c.id === candidateId)
  if (idx < 0) {
    return {
      ok: false, status: 'pending',
      report: { at: Date.now(), items: [], okCount: 0, skippedCount: 0, writeOk: false },
      error: '找不到这条候选',
    }
  }
  const cand = list[idx]
  const card = await loadCard(projectId, cand.outlineCardId)
  if (!card) {
    return {
      ok: false, status: cand.status,
      report: { at: Date.now(), items: [], okCount: 0, skippedCount: 0, writeOk: false },
      error: '这张细纲卡已不在项目里（不会按章名猜替代卡）',
    }
  }
  const { resolved } = await outlineFieldKeys(projectId)
  const keys = new Set(resolved.map(r => r.key))
  if (cand.outlineFingerprint !== outlineFingerprintOf(card, [...keys])) {
    // 过期：不改状态、不写卡；界面展示逐字段差异供人工处理
    const items = planPlotApply(cand, card, keys)
    return {
      ok: false, status: cand.status,
      report: { at: Date.now(), items, okCount: 0, skippedCount: items.length, writeOk: false, error: '细纲已改动，候选过期' },
      error: '细纲在生成候选后被改过（候选已过期），已拒绝应用以免覆盖你的修改；可重新生成候选',
    }
  }

  const items = planPlotApply(cand, card, keys)
  const okItems = items.filter(i => i.outcome === 'ok')
  let writeOk = false
  let error: string | undefined
  if (okItems.length) {
    const data = { ...card.data }
    for (const it of okItems) data[it.key] = it.after
    try {
      await db.saveCardRecord({ ...card, data })
      writeOk = true
    } catch (e) {
      error = `写入细纲失败：${e instanceof Error ? e.message : String(e)}`
    }
  }

  const report: PlotApplyReport = {
    at: Date.now(),
    items,
    okCount: writeOk ? okItems.length : 0,
    skippedCount: items.length - okItems.length + (writeOk ? 0 : okItems.length),
    writeOk,
    ...(error ? { error } : {}),
  }
  const status: PlotCandidate['status'] = !writeOk
    ? cand.status
    : okItems.length === items.length ? 'applied' : 'partial'
  const next = list.slice()
  next[idx] = { ...cand, status, updatedAt: Date.now(), applyReport: report }
  await write(projectId, next)
  return { ok: writeOk, status, report, ...(error ? { error } : {}) }
}

/**
 * 撤销：只在「当前值仍等于应用后的值」时回滚；否则给人工差异（不猜）。
 */
export async function revertPlotCandidate(projectId: string, candidateId: string): Promise<{
  ok: boolean
  reverted: number
  blocked: { key: string; label: string; current: string; expected: string }[]
  error?: string
}> {
  const { list } = await loadPlotCandidates(projectId)
  const idx = list.findIndex(c => c.id === candidateId)
  if (idx < 0) return { ok: false, reverted: 0, blocked: [], error: '找不到这条候选' }
  const cand = list[idx]
  if (!cand.applyReport) return { ok: false, reverted: 0, blocked: [], error: '这条候选还没有应用过，没有可撤销的字段' }
  const card = await loadCard(projectId, cand.outlineCardId)
  const plan = planPlotRevert(cand.applyReport, card)
  if (!plan.revertible.length) {
    return {
      ok: false, reverted: 0, blocked: plan.blocked,
      error: plan.blocked.length ? '字段在应用后又被改过，不能自动撤销（下面是对比）' : '没有可撤销的字段',
    }
  }
  if (plan.blocked.length) {
    return {
      ok: false, reverted: 0, blocked: plan.blocked,
      error: '部分字段在应用后又被改过，已全部停下，不做半截撤销',
    }
  }
  if (!card) return { ok: false, reverted: 0, blocked: plan.blocked, error: '细纲卡已不在' }
  const data = { ...card.data }
  for (const r of plan.revertible) data[r.key] = r.to
  try {
    await db.saveCardRecord({ ...card, data })
  } catch (e) {
    return { ok: false, reverted: 0, blocked: [], error: `撤销写入失败：${e instanceof Error ? e.message : String(e)}` }
  }
  const next = list.slice()
  const { applyReport: _drop, ...rest } = cand
  next[idx] = { ...rest, status: 'pending', updatedAt: Date.now() }
  await write(projectId, next)
  return { ok: true, reverted: plan.revertible.length, blocked: [] }
}

/** 放弃候选（保留记录与理由，便于日后回看） */
export async function discardPlotCandidate(projectId: string, candidateId: string, reason: string): Promise<boolean> {
  const { list } = await loadPlotCandidates(projectId)
  const idx = list.findIndex(c => c.id === candidateId)
  if (idx < 0) return false
  const next = list.slice()
  next[idx] = {
    ...list[idx], status: 'discarded', updatedAt: Date.now(),
    discardedReason: reason.trim().slice(0, 200) || '未填理由',
  }
  try {
    await write(projectId, next)
    return true
  } catch {
    return false
  }
}

/**
 * 3.7.0 · W2：正文 / 细纲保存后**主动**把失配候选落库为 `stale`（规划 §3 W2.2 ③）。
 *
 * 🔴 只改状态、不删候选、不改细纲：作者还能看到“它当时想改成什么”。
 * 🔴 应用前重读比指纹的防线保留不动 —— 状态是提示，二次校验才是安全边界。
 */
export async function refreshPlotCandidateStaleness(
  projectId: string, opts: { cardId?: string; chapterNo?: number } = {},
): Promise<number> {
  const { list } = await loadPlotCandidates(projectId)
  if (!list.length) return 0
  const fingerprints = new Map<string, string | null>()
  const bodies = new Map<number, string | undefined>()
  const next: PlotCandidate[] = []
  let changed = 0
  for (const c of list) {
    if (c.status !== 'pending' && c.status !== 'partial') { next.push(c); continue }
    if (opts.cardId && c.outlineCardId !== opts.cardId) { next.push(c); continue }
    if (opts.chapterNo && c.chapterNo && c.chapterNo !== opts.chapterNo) { next.push(c); continue }
    let fp = fingerprints.get(c.outlineCardId)
    if (fp === undefined) { fp = await outlineFingerprintNow(projectId, c.outlineCardId).catch(() => null); fingerprints.set(c.outlineCardId, fp) }
    let body = c.chapterNo ? bodies.get(c.chapterNo) : undefined
    if (c.bodyDigest && c.chapterNo && body === undefined) { body = await bodyDigestForChapterNo(projectId, c.chapterNo); bodies.set(c.chapterNo, body) }
    const stale = fp === null || fp !== c.outlineFingerprint || (!!c.bodyDigest && !!body && body !== c.bodyDigest)
    if (!stale) { next.push(c); continue }
    changed++
    next.push({ ...c, status: 'stale', updatedAt: Date.now() })
  }
  if (changed) await write(projectId, next)
  return changed
}

/** 供界面显示：某张卡当前指纹（判候选是否过期） */
export async function outlineFingerprintNow(projectId: string, cardId: string): Promise<string | null> {
  const card = await loadCard(projectId, cardId)
  if (!card) return null
  const { resolved } = await outlineFieldKeys(projectId)
  return outlineFingerprintOf(card, resolved.map(r => r.key))
}

/** 逐项结果的人话（界面直接用；集中一处避免各写一套） */
export function reportLines(report: PlotApplyReport): string[] {
  return report.items.map(i => `${i.label}：${APPLY_OUTCOME_LABEL[i.outcome]}${i.outcome === 'value-changed' ? `（当前「${i.current}」）` : ''}`)
}
