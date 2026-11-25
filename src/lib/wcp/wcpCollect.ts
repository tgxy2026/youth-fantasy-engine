// ============ WCP 网页资料包 · 取材适配层（3.7.3 · W1）============
//
// 职责：把「引擎里的项目数据」取成 `wcpPacker.ts` 需要的 `WcpPackSection[]`。
// 与组装引擎严格分工：本文件允许读库（IO），`wcpPacker` / `wcpTemplates` 保持纯函数。
//
// 复用底座（规划 §1）：
//   · 世界观 / 角色卡 / 规范 → `buildProjectContext({ onlyTabIds })`（继承保密过滤与预算裁剪）；
//   · 前文摘要 / 末尾正文 → `getContinuationSources`（与颉文姬续写同一套取材口径）；
//   · 章节细纲 → `loadChapterOutlines`（章号 → 细纲文本）；
//   · 角色状态 → `stateTrack.stateAt`；物品持有 → `resourceLedger.holderAt`；
//   · 人物小传 → `charBiography.formatBiographyMarkdown`。
//
// 🔴 所有读取都有 try/catch 兜底：缺一项只往 `notes` 里记一句，绝不中断整包导出。
// 🔴 不读取、不修改任何项目数据；本层只做「读 → 拼文本」。
import * as db from '@/lib/db'
import { buildProjectContext, getContinuationSources } from '@/lib/ai/aiContext'
import { loadChapterOutlines } from '@/lib/ai/aiWorkflow'
import { activeFingerprintNote } from '@/lib/ai/styleFingerprint'
import { deAiGenerateRule } from '@/lib/ai/deAiStyle'
import { renderTable } from '@/lib/ai/tableRender'
import { TABS } from '@/lib/schema'
import { resolveSlot } from '@/lib/flow/fieldMap'
import { chapterSeqMap } from '@/lib/outline/chapterSeq'
import {
  formatBiographyMarkdown,
  readAllBiographies,
  type CharacterBiography,
} from '@/lib/settings/charBiography'
import { readStateRecords, stateAt } from '@/lib/settings/stateTrack'
import { holderAt, readResourceTransfers } from '@/lib/settings/resourceLedger'
import { wcpFingerprintOf } from '@/lib/wcp/wcpFingerprint'
import {
  WCP_BASE_MODULES,
  DEFAULT_WCP_BASE_MODULES,
  DEFAULT_WCP_GLOBAL_CONFIG,
  type WcpFileExt,
  type WcpPackKind,
  type WcpSceneId,
  type WcpSummaryFormat,
} from '@/lib/wcp/wcpTypes'
import type { WcpPackInput, WcpPackSection } from '@/lib/wcp/wcpPacker'
import type { CardRecord, Chapter, TableRow } from '@/lib/types'

export interface WcpCollectInput {
  kind: WcpPackKind
  scene: WcpSceneId
  summaryFormat: WcpSummaryFormat
  /** 当前章 id（续写 / 润色 / 找茬 / 小传场景） */
  chapterId?: string
  chapterTitle?: string
  /** 当前章正文（编辑器最新态，可能尚未保存） */
  draft?: string
  /** 选中的待润色片段 */
  selectedText?: string
  /** 勾选的底包模块；缺省用出厂默认 */
  baseModules?: readonly string[]
  prevChapterCount?: number
  prevSummaryCount?: number
  /** 小传场景的指定角色 */
  focusCharacterId?: string
  focusCharacterName?: string
  budgetChars?: number
  ext?: WcpFileExt
  extraInstruction?: string
  includeWriterNotes?: boolean
}

export interface WcpCollectedPack {
  /** 可直接交给 `packWcpDocument()` */
  pack: WcpPackInput
  /** 底包源数据指纹（仅 base 包有意义；其它形态也一并返回，便于管理页对照） */
  baseFingerprint: string
  /** 取材过程中的如实提示（缺正文 / 缺摘要 / 未找到细纲…） */
  notes: string[]
}

function clip(text: string, max: number): string {
  const t = (text ?? '').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}\n…（后文略）`
}

function splitNames(raw: string): string[] {
  return String(raw ?? '')
    .split(/[、,，;；/／|]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

function cardTier(tabId: string, card: CardRecord): string {
  const key = resolveSlot(tabId, '定位') ?? resolveSlot(tabId, '身份') ?? ''
  return key ? String(card.data[key] ?? '').trim() : ''
}

/** 把角色卡渲染成「字段：值」的可读文本（跳过空字段，避免一堆「：」） */
function renderCharacterCard(tabId: string, card: CardRecord): string {
  const fields = ['姓名', '别称', '性别', '年龄', '身份', '定位', '外貌', '性格', '目标', '人物状态', '背景', '简介']
  const lines: string[] = [`【${card.name || '未命名角色'}】`]
  for (const label of fields) {
    const key = resolveSlot(tabId, label)
    if (!key) continue
    const value = String(card.data[key] ?? '').trim()
    if (!value) continue
    lines.push(`${label}：${value}`)
  }
  return lines.join('\n')
}

async function readChapterNo(chapterId?: string): Promise<number> {
  if (!chapterId) return 0
  try {
    const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    return chapterSeqMap(vols, chs).get(chapterId) ?? 0
  } catch {
    return 0
  }
}

async function readChapter(chapterId?: string): Promise<Chapter | undefined> {
  if (!chapterId) return undefined
  try {
    return (await db.getAllChapters()).find(c => c.id === chapterId)
  } catch {
    return undefined
  }
}

async function readProjectName(): Promise<string> {
  try {
    const p = await db.getProject(db.getCurrentProjectId())
    return p?.name?.trim() || '未命名作品'
  } catch {
    return '未命名作品'
  }
}

/** 常用角色卡（主要 / 次要，找小传与状态时用） */
async function readMainCards(): Promise<{ tabId: string; list: CardRecord[] }[]> {
  const out: { tabId: string; list: CardRecord[] }[] = []
  for (const tabId of ['char-main', 'char-secondary'] as const) {
    try {
      out.push({ tabId, list: await db.getCardRecords(tabId) })
    } catch {
      out.push({ tabId, list: [] })
    }
  }
  return out
}

// ---------- 底包模块 ----------

async function collectBaseSections(
  modules: readonly string[],
  notes: string[],
): Promise<{ sections: WcpPackSection[]; fingerprint: string }> {
  const sections: WcpPackSection[] = []
  // 🔴 调用方已解析过「未配置 ⇒ 出厂默认」；这里**不再兜底**，
  //    否则作者显式保存「全不勾」会被悄悄改回默认模块。
  const selected = modules
  for (const [index, moduleId] of selected.entries()) {
    const mod = WCP_BASE_MODULES.find(m => m.id === moduleId)
    if (!mod) continue
    if (mod.id === 'bios') {
      const text = await collectBiographies(notes)
      if (text) {
        sections.push({
          id: `base-${mod.id}`, group: 'characters', title: mod.label, content: text,
          priority: 20 + index, sourceKind: 'tab', sourceRef: 'char-bio',
        })
      }
      continue
    }
    if (!mod.tabIds.length) continue
    try {
      const ctx = await buildProjectContext({
        onlyTabIds: [...mod.tabIds],
        // 底包是常驻资料，给足额度；真正的上限由 WCP 单包预算统一裁剪并申报
        budget: 200_000,
        includeChapterList: false,
        includeWriterStats: false,
        semantic: false,
        kb: false,
        includeTempDocs: false,
        inlineDropNote: false,
        tableMaxChars: 8_000,
      })
      const text = ctx.text.trim()
      if (!text) {
        notes.push(`底包模块「${mod.label}」没有可带入的资料。`)
        continue
      }
      sections.push({
        id: `base-${mod.id}`,
        group: mod.id === 'characters' || mod.id === 'relations' ? 'characters' : 'world',
        title: mod.label,
        content: text,
        priority: 20 + index,
        sourceKind: 'tab',
        sourceRef: mod.tabIds.join(','),
      })
    } catch {
      notes.push(`底包模块「${mod.label}」读取失败，已跳过。`)
    }
  }
  const fingerprint = wcpFingerprintOf(sections.map(s => ({ id: s.id, content: s.content })))
  return { sections, fingerprint }
}

async function collectBiographies(notes: string[]): Promise<string> {
  try {
    const [cards, bios] = await Promise.all([readMainCards(), readAllBiographies()])
    const blocks: string[] = []
    for (const { tabId, list } of cards) {
      for (const card of list) {
        const bio: CharacterBiography | undefined = bios[card.id]
        if (!bio || (!bio.prose.trim() && !bio.nodes.length)) continue
        blocks.push(formatBiographyMarkdown(card.name, cardTier(tabId, card), bio))
      }
    }
    if (!blocks.length) notes.push('还没有编写任何人物小传；底包「人物小传」模块已跳过。')
    return blocks.join('\n\n---\n\n')
  } catch {
    notes.push('人物小传读取失败，已跳过。')
    return ''
  }
}

// ---------- 当前章 / 前文 ----------

async function collectContinuation(
  chapterId: string,
  prevChapterCount: number,
  prevSummaryCount: number,
  notes: string[],
): Promise<string> {
  try {
    const src = await getContinuationSources(chapterId, {
      summaryCount: prevSummaryCount,
      prevTextCount: prevChapterCount,
      // 网页长窗口给宽裕的衔接段；整包预算还会再统一裁剪
      prevTextCap: 12_000,
    })
    if (!src.found) {
      notes.push('没有在当前项目的叙事序里找到本章，前文摘要与正文未带入。')
      return ''
    }
    const parts: string[] = []
    if (src.summaries) parts.push(`【前文摘要】\n${src.summaries}`)
    if (src.missingSummaries > 0) notes.push(`另有 ${src.missingSummaries} 章没有填写摘要。`)
    if (src.prevTexts) parts.push(`【前文末尾正文】\n${src.prevTexts}`)
    if (src.droppedPrevTexts > 0) notes.push(`有 ${src.droppedPrevTexts} 章前文因长度限制未带入。`)
    return parts.join('\n\n')
  } catch {
    notes.push('前文摘要 / 正文读取失败，已跳过。')
    return ''
  }
}

async function collectChapterOutline(chapterNo: number, radius: number, notes: string[]): Promise<string> {
  if (!chapterNo) return ''
  try {
    const map = await loadChapterOutlines()
    const lines: string[] = []
    for (let no = Math.max(1, chapterNo - radius); no <= chapterNo + radius; no++) {
      const text = map.get(no)
      if (!text) continue
      lines.push(`◆ 第${no}章细纲\n${text}`)
    }
    if (!lines.length) notes.push('没有找到本章及相邻章的细纲卡。')
    return lines.join('\n\n')
  } catch {
    notes.push('章节细纲读取失败，已跳过。')
    return ''
  }
}

// ---------- 角色 / 物品 / 伏笔 ----------

async function collectCharacters(
  chapterId: string | undefined,
  chapterNo: number,
  draft: string,
  notes: string[],
  focusCharacterId?: string,
): Promise<string> {
  const [cards, records, ledgerRows] = await Promise.all([
    readMainCards(),
    readStateRecords(),
    chapterId
      ? db.getAllChapterLedgerRows().catch(() => [] as TableRow[])
      : Promise.resolve([] as TableRow[]),
  ])
  const ledger = chapterId ? ledgerRows.find(r => r.id === `ch-${chapterId}`) : undefined
  const cast = new Set(splitNames(String(ledger?.data?.['出场人物'] ?? '')))
  const text = draft || ''
  const allCards = cards.flatMap(c => c.list.map(rec => ({ tabId: c.tabId, rec })))
  const picked = allCards.filter(({ rec }) => {
    if (focusCharacterId) return rec.id === focusCharacterId
    if (cast.size) return cast.has(rec.name)
    return rec.name.length >= 2 && text.includes(rec.name)
  })
  if (!picked.length) {
    notes.push('没有识别到本章出场角色；角色段只带了主要角色卡的简要信息。')
    return allCards.slice(0, 6).map(({ tabId, rec }) => renderCharacterCard(tabId, rec)).join('\n\n')
  }
  const blocks: string[] = []
  for (const { tabId, rec } of picked) {
    const lines = [renderCharacterCard(tabId, rec)]
    if (chapterNo > 0) {
      const st = stateAt(records, { kind: 'card', tabId, id: rec.id, projectId: db.getCurrentProjectId() }, chapterNo)
      if (st?.state) lines.push(`第${chapterNo}章状态：${st.state}${st.evidence ? `（依据：${st.evidence}）` : ''}`)
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n---\n\n')
}

async function collectItems(chapterId: string | undefined, chapterNo: number): Promise<string> {
  const tab = TABS.find(t => t.id === 'items')
  if (!tab) return ''
  try {
    const [rows, transfers] = await Promise.all([db.getTableRows('items'), readResourceTransfers()])
    const chapterTransfers = chapterId ? transfers.filter(t => t.chapterId === chapterId) : []
    const hitIds = new Set(chapterTransfers.map(t => t.itemId))
    const picked = hitIds.size ? rows.filter(r => hitIds.has(r.id)) : rows.slice(0, 12)
    if (!picked.length) return ''
    const table = renderTable(tab, picked, { tableMaxChars: 6_000 })
    const holderLines: string[] = []
    if (chapterNo > 0) {
      for (const row of picked) {
        const holder = holderAt(transfers, row.id, chapterNo)
        if (holder) holderLines.push(`- ${String(row.data['名称'] ?? row.id)}：第${chapterNo}章时由「${holder}」持有`)
      }
      for (const t of chapterTransfers) {
        holderLines.push(`- 本章流转：${t.itemName} · ${t.kind}（${t.from || '—'} → ${t.to || '—'}）${t.evidence ? `｜依据：「${t.evidence}」` : ''}`)
      }
    }
    return [table, holderLines.length ? `【持有与流转】\n${holderLines.join('\n')}` : ''].filter(Boolean).join('\n\n')
  } catch {
    return ''
  }
}

async function collectForeshadows(): Promise<string> {
  const tab = TABS.find(t => t.id === 'foreshadow')
  if (!tab) return ''
  try {
    const rows = await db.getTableRows('foreshadow')
    const open = rows.filter(r => !String(r.data['回收伏笔编号'] ?? '').trim())
    if (!open.length) return ''
    return renderTable(tab, open, { tableMaxChars: 6_000 })
  } catch {
    return ''
  }
}

// ---------- 润色片段的上下文 ----------

function polishContext(draft: string, selected: string): string {
  const body = draft || ''
  const sel = selected.trim()
  if (!body || !sel) return ''
  const at = body.indexOf(sel)
  if (at < 0) return ''
  const before = body.slice(Math.max(0, at - 400), at)
  const after = body.slice(at + sel.length, at + sel.length + 400)
  return [before ? `【前文】\n${before}` : '', after ? `【后文】\n${after}` : ''].filter(Boolean).join('\n\n')
}

// ---------- 小传场景 ----------

async function collectBioContext(
  characterId: string | undefined,
  characterName: string,
  chapterNo: number,
  notes: string[],
): Promise<string> {
  const blocks: string[] = []
  try {
    if (characterId) {
      const [bios, records] = await Promise.all([readAllBiographies(), readStateRecords()])
      const bio = bios[characterId]
      if (bio) blocks.push(formatBiographyMarkdown(characterName, '', bio))
      else notes.push('该角色还没有人物小传，本次只带出场片段，供整理初稿。')
      if (chapterNo > 0) {
        const evolution = records
          .filter(r => r.ref.kind === 'card' && r.ref.id === characterId)
          .sort((a, b) => a.chapterNo - b.chapterNo)
        if (evolution.length) {
          blocks.push(`【状态演变】\n${evolution.map(r => `- 第${r.chapterNo || '?'}章：${r.state}${r.evidence ? `（依据：${r.evidence}）` : ''}`).join('\n')}`)
        }
      }
    }
    if (characterName) {
      const chapters = await db.getAllChapters()
      const hits = chapters.filter(c => (c.content ?? '').includes(characterName))
      const excerpts = hits.slice(-5).map(c => {
        const body = (c.content ?? '').trim()
        return `◆ ${c.title || '未命名章节'}（末尾片段）\n${body.slice(-500)}`
      })
      if (excerpts.length) blocks.push(`【出场章节片段】\n${excerpts.join('\n\n')}`)
    }
  } catch {
    notes.push('角色小传 / 出场片段读取失败，已跳过。')
  }
  return blocks.join('\n\n---\n\n')
}

/**
 * 按场景取好材料，返回可直接组装的 `WcpPackInput`。
 *
 * 🔴 底包与增量包的合并只在 `kind === 'full'` 时发生：
 *    Base 段永远先取（按勾选模块），Delta 段按场景补充；同 id 段由 Delta 覆盖。
 */
export async function collectWcpPack(input: WcpCollectInput): Promise<WcpCollectedPack> {
  const notes: string[] = []
  const projectName = await readProjectName()
  const chapter = input.chapterId ? await readChapter(input.chapterId) : undefined
  const chapterNo = input.chapterId ? await readChapterNo(input.chapterId) : 0
  const chapterTitle = input.chapterTitle ?? chapter?.title ?? ''
  const draft = input.draft ?? chapter?.content ?? ''
  const needBase = input.kind !== 'delta' || input.scene === 'outline-expand' || input.scene === 'continuity-audit'
  const base = needBase
    ? await collectBaseSections(input.baseModules ?? DEFAULT_WCP_BASE_MODULES, notes)
    : { sections: [] as WcpPackSection[], fingerprint: '' }

  // 常驻底包只装长期设定：不掺当前章草稿、前文或找茬正文。
  // （否则 Gem / Project 的「常驻背景」会每天被一章草稿污染，且过期提示天天变。）
  if (input.kind === 'base') {
    // 底包也要带「文风 / 去 AI 味」红线（规划 §3.1）：它是长期约束，
    // 但底包不是具体任务，所以只放规则 + 只读声明，不放续写任务。
    let baseRules = ''
    try {
      baseRules = deAiGenerateRule('full')
      const note = await activeFingerprintNote()
      if (note.trim()) baseRules += `\n\n${note.trim()}`
    } catch { /* 没有文风指纹就只带去 AI 味规则 */ }
    const pack: WcpPackInput = {
      kind: 'base',
      scene: input.scene,
      projectName,
      summaryFormat: input.summaryFormat,
      ext: input.ext ?? 'md',
      budgetChars: input.budgetChars ?? DEFAULT_WCP_GLOBAL_CONFIG.maxPackBudgetChars,
      sections: base.sections,
      ...(baseRules ? { rules: baseRules } : {}),
    }
    return {
      pack,
      // 规则也属于底包内容：换了文风指纹 / 去 AI 味规则，底包同样应提示「建议重导」
      baseFingerprint: baseRules
        ? wcpFingerprintOf([
          ...base.sections.map(s => ({ id: s.id, content: s.content })),
          { id: 'base-rules', content: baseRules },
        ])
        : base.fingerprint,
      notes,
    }
  }

  const delta: WcpPackSection[] = []

  if (input.scene === 'chapter-continue') {
    delta.push({
      id: 'ctx-outline', group: 'context', title: '本章细纲',
      content: await collectChapterOutline(chapterNo, 0, notes), priority: 0,
      sourceKind: 'tab', sourceRef: 'chapter-outline',
    })
    delta.push({
      id: 'ctx-prev', group: 'context', title: '前文摘要与衔接正文',
      content: await collectContinuation(
        input.chapterId ?? '', input.prevChapterCount ?? DEFAULT_WCP_GLOBAL_CONFIG.prevChapterCount,
        input.prevSummaryCount ?? DEFAULT_WCP_GLOBAL_CONFIG.prevSummaryCount, notes,
      ),
      priority: 1, sourceKind: 'chapter', sourceRef: input.chapterId ?? '',
    })
    delta.push({
      id: 'ctx-draft', group: 'context', title: '本章已写草稿',
      content: clip(draft, 200_000), priority: 2, sourceKind: 'chapter', sourceRef: input.chapterId ?? '',
    })
    if (!draft.trim()) notes.push('本章还没有正文；续写包只带细纲与前文，请确认后再交给网页模型。')
  } else if (input.scene === 'chapter-polish') {
    const selected = input.selectedText ?? ''
    if (!selected.trim()) notes.push('没有选中片段；润色包将把整章正文作为待润色文本。')
    delta.push({
      id: 'ctx-polish', group: 'context', title: '待润色片段',
      content: clip(selected.trim() || draft, 30_000), priority: 0, sourceKind: 'chapter', sourceRef: input.chapterId ?? '',
    })
    const around = polishContext(draft, selected)
    if (around) {
      delta.push({
        id: 'ctx-around', group: 'context', title: '前后衔接段',
        content: around, priority: 3, sourceKind: 'chapter', sourceRef: input.chapterId ?? '',
      })
    }
  } else if (input.scene === 'outline-expand') {
    try {
      const ctx = await buildProjectContext({
        onlyTabIds: ['master', 'volume-outline'],
        budget: 120_000, includeChapterList: false, includeWriterStats: false,
        semantic: false, kb: false, includeTempDocs: false,
        inlineDropNote: false, tableMaxChars: 8_000,
      })
      delta.push({
        id: 'ctx-outline-plan', group: 'context', title: '总纲与卷纲',
        content: ctx.text.trim(), priority: 0, sourceKind: 'tab', sourceRef: 'master,volume-outline',
      })
    } catch {
      notes.push('总纲 / 分卷大纲读取失败，已跳过。')
    }
    delta.push({
      id: 'ctx-outline-near', group: 'context', title: '相邻章细纲',
      content: await collectChapterOutline(chapterNo, 2, notes), priority: 1,
      sourceKind: 'tab', sourceRef: 'chapter-outline',
    })
  } else if (input.scene === 'continuity-audit') {
    if (!draft.trim()) notes.push('没有可供检查的正文；请先在编辑器里选中章节或片段。')
    delta.push({
      id: 'ctx-audit', group: 'context', title: '待检正文',
      content: clip(input.selectedText?.trim() || draft, 200_000), priority: 0,
      sourceKind: 'chapter', sourceRef: input.chapterId ?? '',
    })
    delta.push({
      id: 'ctx-audit-note', group: 'context', title: '待检范围说明',
      content: `作品：${projectName}\n章节：${chapterNo ? `第${chapterNo}章「${chapterTitle}」` : (chapterTitle || '未指定')}\n` +
        '请只对照资料找事实矛盾；没有矛盾就明确写「未发现事实矛盾」。',
      priority: 1, sourceKind: 'instruction', sourceRef: 'wcp-audit-scope',
    })
  } else if (input.scene === 'bio-organize') {
    const name = input.focusCharacterName ?? ''
    delta.push({
      id: 'ctx-bio', group: 'context', title: `角色专项资料${name ? `：${name}` : ''}`,
      content: await collectBioContext(input.focusCharacterId, name, chapterNo, notes),
      priority: 0, sourceKind: 'tab', sourceRef: 'char-bio',
    })
  }

  // 角色 / 物品 / 伏笔快照（续写、润色、找茬、小传都需要；大纲推演只带角色与伏笔）
  if (input.scene === 'chapter-continue' || input.scene === 'continuity-audit' || input.scene === 'bio-organize') {
    delta.push({
      id: 'ctx-cast', group: 'characters', title: '出场角色与当前状态',
      content: await collectCharacters(input.chapterId, chapterNo, draft, notes, input.focusCharacterId),
      priority: 10, sourceKind: 'tab', sourceRef: 'char-main,char-secondary',
    })
  }
  if (input.scene === 'chapter-continue' || input.scene === 'continuity-audit') {
    const items = await collectItems(input.chapterId, chapterNo)
    if (items) {
      delta.push({
        id: 'ctx-items', group: 'characters', title: '物品与持有状态',
        content: items, priority: 12, sourceKind: 'tab', sourceRef: 'items',
      })
    }
  }
  if (input.scene === 'chapter-continue' || input.scene === 'outline-expand' || input.scene === 'continuity-audit') {
    const fs = await collectForeshadows()
    if (fs) {
      delta.push({
        id: 'ctx-foreshadow', group: 'context', title: '未回收伏笔',
        content: fs, priority: 4, sourceKind: 'tab', sourceRef: 'foreshadow',
      })
    }
  }

  // 去重：同 id 的段以 Delta 为准（当前章快照优先）
  const byId = new Map<string, WcpPackSection>()
  for (const s of base.sections) byId.set(s.id, s)
  for (const s of delta) byId.set(s.id, s)
  const sections = [...byId.values()]

  // 规则段：只有创作 / 润色场景注入去 AI 味；文风指纹（如果有）一并注入
  let rules = ''
  if (input.scene === 'chapter-continue' || input.scene === 'chapter-polish') {
    rules = deAiGenerateRule('full')
    try {
      const note = await activeFingerprintNote()
      if (note.trim()) rules += `\n\n${note.trim()}`
    } catch { /* 没有激活文风就只带去 AI 味规则 */ }
  }

  const pack: WcpPackInput = {
    kind: input.kind,
    scene: input.scene,
    projectName,
    ...(chapterNo > 0 ? { chapterNo } : {}),
    ...(chapterTitle ? { chapterTitle } : {}),
    summaryFormat: input.summaryFormat,
    ext: input.ext ?? 'md',
    budgetChars: input.budgetChars ?? DEFAULT_WCP_GLOBAL_CONFIG.maxPackBudgetChars,
    sections,
    ...(rules ? { rules } : {}),
    ...(input.includeWriterNotes && input.extraInstruction?.trim()
      ? { extraInstruction: input.extraInstruction.trim() }
      : {}),
  }
  return { pack, baseFingerprint: base.fingerprint, notes }
}