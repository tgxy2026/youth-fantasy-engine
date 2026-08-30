/**
 * AI 一键续写 + 设定补完 编排逻辑（纯逻辑，无 React 依赖）。
 *
 * 设计红线（详见 docs/一键续写与设定补完功能方案.md）：
 * - 生成与落盘分离：正文是纯字符串只进 Chapter.content；设定是另一条结构化通道。
 * - 每章独立 uid()，saveChapter 按 id upsert，绝不写到别的章；顺序由 chapterSeq 派生，永不解析标题。
 * - 设定补登：classify 三档判重 + commitEntities 只写安全字段（名称/描述/首现章/编号），其余留空。
 * - 编辑自检单轮改写（≤2 轮约束内），接受不完美退出，杜绝 self-refine 死循环。
 * - 章节数 1–5、字数 2000–8000 汉字（countWords 校验）。
 */
import * as db from './db'
import { uid } from './id'
import { countWords } from './textStats'
import { chat, requireActiveProvider, stripThink } from './ai'
import { buildProjectContext, type ProjectContextResult } from './aiContext'
import {
  aiExtractSettingEntities, aiContinuityAudit, aiOocCheck, aiForeshadowReview,
  aiRewritePassage, aiChapterSummary, type ExtractedEntity,
} from './aiTasks'
import { classify, commitEntities, loadRegistry, normName, type LedgerItem } from './settingLedger'
import { sortChapters, chapterSeqOf } from './chapterSeq'
import { syncChapterMaster } from './chapterMaster'
import type { Chapter } from './types'

/** 已有设定更新策略（创建任务时由用户选择） */
export type ContinueStrategy = 'add-only' | 'confirm' | 'auto-update'

export interface ContinueCallbacks {
  onPhase?: (p: string) => void
  onBodyToken?: (delta: string) => void
  onChapterSaved?: (ch: { id: string; title: string; no: number }) => void
  /** B 策略：返回用户勾选的待补登项；返回 null 表示跳过本次补登 */
  onSettingsCandidates?: (cands: LedgerItem[]) => Promise<LedgerItem[] | null>
  onLog?: (msg: string) => void
  signal?: AbortSignal
}

interface SettingUpdate { name: string; note: string }

// ============ 单章生成 ============

async function generateOneChapter(opts: {
  ctx: ProjectContextResult
  prevTail: string
  intent?: string
  targetWords: number
  signal?: AbortSignal
  onToken?: (d: string) => void
  onPhase?: (p: string) => void
}): Promise<string> {
  const cfg = await requireActiveProvider()
  const sys = [
    '你是长篇网络小说的续写助手。请基于作者已有的世界观、角色与剧情，续写下一章正文。',
    '硬性约束：',
    `1. 目标篇幅约 ${opts.targetWords} 个汉字（按汉字个数计，不含标点与英文单词；允许 ±10% 浮动，宁缺毋滥，不得明显注水凑字数）。`,
    '2. 严格贴合已写章节的叙事视角、文风与人设，保持爽文节奏，章末留一个能勾住读者点下一章的钩子。',
    '3. 只输出正文本身，不要任何解说、不要小标题、不要"以下是续写"之类的开场白。',
    '4. 若用户给了情节概要，优先沿概要推进；没给则在前文基础上自然延续。',
  ].join('\n')
  const user = [
    '【作品设定资料】',
    opts.ctx.text || '（暂无设定资料，按通用网文逻辑续写）',
    '',
    '【上一章结尾】',
    opts.prevTail || '（这是开篇第一章）',
    '',
    '【续写意图】',
    opts.intent?.trim() || '（自由发挥，在前文基础上自然延续）',
    '',
    '请续写下一章正文。',
  ].join('\n')

  let body = stripThink(await chat(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], { onToken: opts.onToken, signal: opts.signal }))

  // 字数卡法：不足目标 85% 时分幕续写补足（上限 5 幕，防弱模型无限凑）
  let pass = 1
  while (countWords(body) < opts.targetWords * 0.85 && pass < 5) {
    const cont = await chat(cfg, [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: `【已写部分】\n${body}\n\n请继续往下写，务必把篇幅写到接近 ${opts.targetWords} 个汉字（可略少，但不得明显注水凑字、不得提前收尾，除非已自然到达目标篇幅），保持剧情连贯，不要重复已写内容。`,
      },
    ], { onToken: opts.onToken, signal: opts.signal }).catch(() => '')
    body += cont
    body = stripThink(body)
    pass++
  }

  body = await selfRefine(body, opts.ctx, opts.signal, opts.onPhase)
  return body.trim()
}

/** 编辑自检：连续性 / 人设崩坏 / 伏笔 三类检查，命中严重/中等则单轮改写后接受不完美退出 */
async function selfRefine(body: string, ctx: ProjectContextResult, signal?: AbortSignal, onPhase?: (p: string) => void): Promise<string> {
  if (!ctx.text.trim() || countWords(body) < 200) return body
  onPhase?.('AI 编辑自检（连续性 / 人设 / 伏笔）')
  const findings: Array<{ level?: string; title?: string; detail?: string }> = []
  const push = (arr: any[]) => { for (const f of arr) if (f && (f.level === '严重' || f.level === '中等')) findings.push(f) }
  push(await aiContinuityAudit(ctx.text, body, { signal }).catch(() => [] as any[]))
  push(await aiOocCheck(ctx.text, body, { signal }).catch(() => [] as any[]))
  push(await aiForeshadowReview(ctx.text, { signal }).catch(() => [] as any[]))
  if (!findings.length) return body
  onPhase?.('根据审读问题改写修正')
  const instr = findings.map(f => `- ${f.title || '问题'}：${f.detail || ''}`).join('\n')
  const res = await aiRewritePassage(body, `修正以下审读问题，保持剧情与文风一致，不要改变原意：\n${instr}`, '', { signal }).catch(() => null)
  return res?.rewritten ? stripThink(res.rewritten) : body
}

async function suggestTitle(body: string, signal?: AbortSignal): Promise<string> {
  const cfg = await requireActiveProvider().catch(() => null)
  if (!cfg) return '未命名章节'
  const snippet = body.slice(0, 1500)
  const sys = '你是网文编辑。请给这一章起一个简洁、有吸引力、不剧透的章节标题。要求：不含"第N章"前缀，不超过 15 个汉字，只输出标题本身，不要标点、不要引号、不要解释。'
  const t = await chat(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: `【本章正文（节选）】\n${snippet}` },
  ], { signal }).catch(() => '')
  const clean = stripThink(t).replace(/[「」"'》>、。！？\s]/g, '').slice(0, 15)
  return clean || '未命名章节'
}

// ============ 建章（顺序/台账同步，绝不手填卷章号） ============

async function createChapterAfter(anchorId: string | null, title: string, content: string): Promise<Chapter> {
  const pid = db.getCurrentProjectId()
  const vols = await db.getAllVolumes()
  const chs = await db.getAllChapters()
  const anchor = anchorId ? chs.find(c => c.id === anchorId) : undefined
  const targetVolId = anchor?.volumeId ?? vols[vols.length - 1]?.id
  if (!targetVolId) throw new Error('项目中还没有卷，请先到「正文写作」创建至少一个卷再续写。')
  const volChs = chs.filter(c => c.volumeId === targetVolId)
  const order = volChs.length
  const ch: Chapter = {
    id: uid(), projectId: pid, volumeId: targetVolId, order,
    title: title || '未命名章节', content, summary: '',
    status: '草稿', wordCount: countWords(content),
    createdAt: Date.now(), updatedAt: Date.now(),
  }
  await db.saveChapter(ch) // upsert by id，绝不覆盖别的章
  const [lv, lc] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  await syncChapterMaster(ch, chapterSeqOf(lv, lc, ch.id))
  return ch
}

// ============ 设定抽取与补登（按策略） ============

async function extractAndCommitSettings(
  body: string, title: string, strategy: ContinueStrategy,
  onConfirm?: (cands: LedgerItem[]) => Promise<LedgerItem[] | null>,
  signal?: AbortSignal,
): Promise<{ created: number; failed: string[] }> {
  const entities = await aiExtractSettingEntities(body, title, { signal }).catch(() => [] as ExtractedEntity[])
  if (!entities.length) return { created: 0, failed: [] }
  const reg = await loadRegistry().catch(() => null)
  if (!reg) return { created: 0, failed: [] }
  const items = classify(entities, reg)
  const empty = { created: 0, failed: [] as string[] }

  if (strategy === 'add-only') {
    // 仅新增：只补登新实体，绝不碰已登记设定
    const news = items.filter(i => i.status === 'new')
    const r = await commitEntities(news, title).catch(() => empty)
    return { created: r.created, failed: r.failed }
  }
  if (strategy === 'auto-update') {
    // 自动更新：新实体自动补登 + 对已登记实体的变化做安全写回（追加到备注类字段，绝不覆盖属性列）
    const news = items.filter(i => i.status === 'new')
    const r = await commitEntities(news, title).catch(() => empty)
    await applySettingUpdates(body, title, signal).catch(() => {})
    return { created: r.created, failed: r.failed }
  }
  // confirm：把新实体与疑似重复项交给用户勾选
  const cands = items.filter(i => i.status === 'new' || i.status === 'duplicate')
  if (!cands.length) return empty
  const chosen = await onConfirm?.(cands)
  if (chosen && chosen.length) {
    const r = await commitEntities(chosen, title).catch(() => empty)
    return { created: r.created, failed: r.failed }
  }
  return empty
}

// ============ C 策略：对已登记实体的变化做安全写回 ============

async function extractSettingUpdates(body: string, title: string, signal?: AbortSignal): Promise<SettingUpdate[]> {
  const cfg = await requireActiveProvider()
  const sys = `你是设定更新侦探。对比本章正文与已有设定，找出"对已有设定实体的新信息/状态变化"（如角色修为提升、关系变化、物品被获得或损毁、地点状态改变等）。
返回 JSON 数组，元素形如 {"name":"实体名(必须与已登记名完全一致)","note":"一句话描述变化，如 修为提升至凝气四层"}。
只报确有文本依据的，最多 10 条，没有则返回 []。只输出 JSON 数组，不要解释、不要 markdown 代码块。`
  const user = `【章节】${title || '（未命名章节）'}\n【本章正文】\n${body.trim() || '（空白）'}`
  const text = await chat(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], { signal })
  try {
    const arr = JSON.parse(stripThink(text).trim())
    return Array.isArray(arr) ? arr.filter((x: any) => x && x.name).map((x: any) => ({ name: String(x.name), note: String(x.note || '') })) : []
  } catch { return [] }
}

function pickNoteCol(data: Record<string, string>): string | null {
  for (const k of ['备注', '描述', '小传', '近况', '简介']) if (k in data) return k
  return null
}
function appendNote(existing: string | undefined, note: string): string {
  return (existing ? existing + '\n' : '') + note
}
function findRegistered(reg: Awaited<ReturnType<typeof loadRegistry>>, name: string): { tabId: string; id: string } | null {
  const target = normName(name)
  if (!target) return null
  for (const list of Object.values(reg)) {
    for (const e of list) {
      if (normName(e.name) === target) return { tabId: e.tabId, id: e.id }
      if (e.aliases?.some(a => normName(a) === target)) return { tabId: e.tabId, id: e.id }
    }
  }
  return null
}

async function applySettingUpdates(body: string, title: string, signal?: AbortSignal) {
  const updates = await extractSettingUpdates(body, title, signal).catch(() => [] as SettingUpdate[])
  if (!updates.length) return
  const reg = await loadRegistry().catch(() => null)
  if (!reg) return
  for (const u of updates) {
    const hit = findRegistered(reg, u.name)
    if (!hit) continue
    try {
      if (hit.tabId.startsWith('char-')) {
        const recs = await db.getCardRecords(hit.tabId)
        const rec = recs.find(r => r.id === hit.id)
        if (rec) {
          const col = pickNoteCol(rec.data)
          if (col) { rec.data[col] = appendNote(rec.data[col], `[续写·${title}] ${u.note}`); await db.saveCardRecord(rec) }
        }
      } else {
        const rows = await db.getTableRows(hit.tabId)
        const row = rows.find(r => r.id === hit.id)
        if (row) {
          const col = pickNoteCol(row.data)
          if (col) { row.data[col] = appendNote(row.data[col], `[续写·${title}] ${u.note}`); await db.saveTableRow(row) }
        }
      }
    } catch { /* 单条失败不影响整体 */ }
  }
}

// ============ 顶层编排（L2 多章循环） ============

export async function runAutoContinue(
  opts: { chapters: number; targetWords: number; strategy: ContinueStrategy; intent?: string },
  cb: ContinueCallbacks = {},
): Promise<{ created: { id: string; title: string; no: number }[] }> {
  await requireActiveProvider() // 提前校验，无模型直接抛中文提示
  const vols = await db.getAllVolumes()
  const ordered = sortChapters(vols, await db.getAllChapters())
  let anchorId: string | null = ordered.length ? ordered[ordered.length - 1].id : null
  const created: { id: string; title: string; no: number }[] = []
  let memory = ''
  let lastBody = ''

  for (let i = 0; i < opts.chapters; i++) {
    if (cb.signal?.aborted) break
    try {
      cb.onPhase?.(`第 ${i + 1}/${opts.chapters} 章：组装上下文`)
      const ctx = await buildProjectContext({ focusChapterId: anchorId ?? undefined, budget: 12000 })
        .catch(() => ({ text: '', sections: [], dropped: [], chars: 0 }) as ProjectContextResult)
      const prevTail = (lastBody.slice(-300) + (memory ? `\n【本轮已写前序章节摘要（供衔接）】\n${memory}\n` : ''))
      cb.onPhase?.(`第 ${i + 1}/${opts.chapters} 章：AI 续写正文`)
      const body = await generateOneChapter({
        ctx, prevTail, intent: opts.intent, targetWords: opts.targetWords,
        signal: cb.signal, onToken: cb.onBodyToken,
        onPhase: (p) => cb.onPhase?.(`第 ${i + 1}/${opts.chapters} 章：${p}`),
      })
      cb.onPhase?.(`第 ${i + 1}/${opts.chapters} 章：生成标题并保存`)
      const title = await suggestTitle(body, cb.signal)
      const ch = await createChapterAfter(anchorId, title, body)
      const [lv, lc] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
      const no = chapterSeqOf(lv, lc, ch.id)
      cb.onChapterSaved?.({ id: ch.id, title: ch.title, no })
      created.push({ id: ch.id, title: ch.title, no })
      anchorId = ch.id
      lastBody = body
      cb.onPhase?.(`第 ${i + 1}/${opts.chapters} 章：抽取并补登设定`)
      const r = await extractAndCommitSettings(body, ch.title, opts.strategy, cb.onSettingsCandidates, cb.signal)
      cb.onLog?.(`第 ${i + 1} 章《${ch.title}》已保存（${countWords(body)} 字）；设定新增 ${r.created} 条` + (r.failed.length ? `，失败：${r.failed.join('、')}` : ''))
      // 滚动摘要回灌（应对多章记忆滚雪球，#4）
      const sum = await aiChapterSummary(body, { signal: cb.signal }).catch(() => '')
      if (sum) memory = (memory ? memory + '\n' : '') + `· 第${no}章《${ch.title}》：${sum.replace(/\s+/g, ' ').slice(0, 200)}`
    } catch (e) {
      cb.onLog?.(`第 ${i + 1} 章失败：${e instanceof Error ? e.message : String(e)}`)
      break
    }
  }
  cb.onPhase?.(created.length ? `✓ 续写完成，共新增 ${created.length} 章` : '未生成章节（请检查模型配置或查看日志）')
  return { created }
}
