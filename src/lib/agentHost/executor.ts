/**
 * Agent 工具执行器（页面侧，运行在引擎渲染进程）。
 *
 * 🔴 为什么必须在这里执行：整库数据的内存真源在渲染进程（桌面 `desktopStore` /
 *   便携 `portableStore`）。外部进程直接改 JSON 会与内存、2s 防抖、云同步互相覆盖。
 *   本模块只被宿主桥调用：桌面上由主进程 IPC 转进来，便携上由本地服务队列转进来。
 *
 * 🔴 归属与并发：
 *   · 只允许写**当前打开的项目**（`PROJECT_NOT_OPEN`）。跨项目写入会绕开编辑器 / 设定页的
 *     上下文保护，而现有业务函数（`saveChapter` 等）都以当前项目为归属；
 *   · 每次写都用 `captureOwnedOperation` 包一层，任何“切换项目 / 切换存储空间”都会中止；
 *   · 正文存在未保存草稿时拒绝写入（`DRAFT_DIRTY`），绝不覆盖作者正在编辑的内容；
 *   · 覆盖 / 追加正文前留一版可恢复快照；写后等待落盘并回读确认，失败如实上报。
 */

import * as db from '@/lib/db'
import { DESKTOP, flushDesktop } from '@/lib/app/desktop'
import { PORTABLE, flushPortable } from '@/lib/storage/fileBackend'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'
import { leaveGuardDirty } from '@/lib/editor/leaveBarrier'
import { countWords } from '@/lib/editor/textStats'
import { uid } from '@/lib/app/id'
import { getTab } from '@/lib/schema'
import { cardFieldsOf } from '@/lib/storage/cardIO'
import { latestChapterTarget, nextOrderInVolume } from '@/lib/outline/chapterAppend'
import { chapterSeqOf } from '@/lib/outline/chapterSeq'
import { syncChapterMaster } from '@/lib/outline/chapterMaster'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import type { CardRecord, Chapter, Project, TabDef, Volume } from '@/lib/types'
import {
  AGENT_TOOL_NAMES,
  MAX_CARD_NAME_CHARS, MAX_CARD_TOTAL_CHARS, MAX_CONTENT_CHARS, MAX_FIELD_CHARS, MAX_NAME_CHARS,
  agentActionAllowed, chapterSummary, fail, projectSummary,
  type AgentAction, type AgentChapterWriteResult, type AgentScope, type AgentToolCall,
  type AgentToolResult, type SettingTabInfo,
} from '@/lib/agentHost/contract'

export interface AgentExecutorDeps {
  currentProjectId(): string
  captureOwner(projectId: string): OwnedOperation
  getProjects(): Promise<Project[]>
  getVolumes(owner?: OwnedOperation): Promise<Volume[]>
  getChapters(owner?: OwnedOperation): Promise<Chapter[]>
  saveChapter(ch: Chapter, owner?: OwnedOperation): Promise<void>
  patchChapter(id: string, patch: Partial<Omit<Chapter, 'id' | 'projectId'>>, owner?: OwnedOperation): Promise<Chapter | undefined>
  saveCardRecord(rec: CardRecord, owner?: OwnedOperation): Promise<void>
  createSnapshot(ch: Chapter, source: 'ai-rewrite', owner?: OwnedOperation): Promise<unknown>
  syncChapterMaster(ch: Chapter, no: number, narrativeIndex?: number, owner?: OwnedOperation): Promise<void>
  chapterSeqOf(volumes: Volume[], chapters: Chapter[], chapterId: string): number
  flush(): Promise<boolean>
  unsavedDraft(): boolean
  now(): number
  uid(): string
  countWords(text: string): number
  getTab(tabId: string): TabDef | undefined
  cardFieldsOf(tab: TabDef): { name: string; path: string; desc: string }[]
}

export interface AgentExecutor {
  /** 执行一次工具调用。`scope` 由宿主传入，执行器**再校验一次**（纵深防御）。 */
  call(call: AgentToolCall, scope: AgentScope): Promise<AgentToolResult>
}

/** 生产依赖：真实 db + 平台落盘。 */
export function defaultExecutorDeps(): AgentExecutorDeps {
  return {
    currentProjectId: () => db.getCurrentProjectId(),
    captureOwner: captureOwnedOperation,
    getProjects: () => db.getAllProjects(),
    getVolumes: owner => (owner ? owner.store.getAll<Volume>('volumes') : db.getAllVolumes()),
    getChapters: owner => (owner ? owner.store.getAll<Chapter>('chapters') : db.getAllChapters()),
    saveChapter: (ch, owner) => db.saveChapter(ch, owner),
    patchChapter: (id, patch, owner) => db.patchChapter(id, patch, owner),
    saveCardRecord: (rec, owner) => db.saveCardRecord(rec, owner),
    createSnapshot: (ch, source, owner) => db.createSnapshot(ch, source, owner),
    syncChapterMaster: (ch, no, narrativeIndex, owner) => syncChapterMaster(ch, no, narrativeIndex, owner),
    chapterSeqOf: (volumes, chapters, chapterId) => chapterSeqOf(volumes, chapters, chapterId),
    flush: async () => (DESKTOP ? flushDesktop() : PORTABLE ? flushPortable() : true),
    unsavedDraft: () => leaveGuardDirty(),
    now: () => Date.now(),
    uid: () => uid(),
    countWords: text => countWords(text),
    getTab: id => getTab(id),
    cardFieldsOf: tab => cardFieldsOf(tab),
  }
}

// ---------- 参数读取 ----------

function str(args: Record<string, unknown>, key: string, max: number, required = true): string {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    if (required) throw new AgentInputError(`参数 ${key} 必填（非空字符串）`)
    return ''
  }
  if (typeof raw !== 'string') throw new AgentInputError(`参数 ${key} 必须是字符串`)
  const value = raw
  if (required && !value.trim()) throw new AgentInputError(`参数 ${key} 必填（非空字符串）`)
  if (value.length > max) throw new AgentInputError(`参数 ${key} 超过上限（${max} 字符，实际 ${value.length}）`)
  return value
}

function num(args: Record<string, unknown>, key: string): number {
  const raw = args[key]
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new AgentInputError(`参数 ${key} 必填（非负整数时间戳）`)
  }
  return raw
}

class AgentInputError extends Error {}

// ---------- 执行器 ----------

export function createAgentExecutor(deps: AgentExecutorDeps): AgentExecutor {
  async function projectOf(projectId: string): Promise<Project | AgentToolResult> {
    const projects = await deps.getProjects()
    const project = projects.find(p => p.id === projectId)
    if (!project) return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
    if (deps.currentProjectId() !== projectId) {
      return fail('PROJECT_NOT_OPEN', `该项目当前未在引擎中打开。请先在青春幻想引擎中打开《${project.name}》后再让 Agent 写入。`)
    }
    return project
  }

  function requireAction(scope: AgentScope, projectId: string, action: AgentAction): AgentToolResult | null {
    return agentActionAllowed(scope, projectId, action)
      ? null
      : fail('SCOPE_DENIED', `当前连接未授权该项目执行「${action}」动作。请在引擎「模型设置 → Agent 连接」中勾选授权。`)
  }

  /** 写后统一收口：落盘确认 + 回读确认。失败区分“确定没写”与“结果不明”。 */
  async function confirmWrite<T>(
    owner: OwnedOperation,
    verify: () => Promise<boolean>,
    value: T,
    describeFailure: string,
  ): Promise<AgentToolResult> {
    let flushed = false
    try {
      flushed = await deps.flush()
    } catch {
      flushed = false
    }
    // 落盘期间项目 / 存储空间可能已被切换。此时写入可能已经成功，
    // 🔴 必须按「结果不明」上报，不能标成可安全重试。
    try {
      owner.assertCurrent()
    } catch (error) {
      return fail('OUTCOME_UNKNOWN', `${describeFailure}：写入过程中项目或存储空间已切换，结果不明（${error instanceof Error ? error.message : String(error)}）。请先在引擎中核对，不要盲目重试。`)
    }
    if (!flushed) {
      return fail('SAVE_FAILED', `${describeFailure}：写入可能已进入内存，但未能确认落盘。请先在引擎中核对并手动保存；不要复用同一 requestId 重试。`)
    }
    if (!(await verify())) {
      return fail('OUTCOME_UNKNOWN', `${describeFailure}：落盘后回读不到刚写入的内容，结果不明。请先在引擎中核对，不要盲目重试。`)
    }
    return { ok: true, value }
  }

  async function listProjects(scope: AgentScope): Promise<AgentToolResult> {
    const projects = await deps.getProjects()
    const current = deps.currentProjectId()
    return {
      ok: true,
      value: projects.map(p => ({
        ...projectSummary(p),
        open: p.id === current,
        grantedActions: scope.projects.find(g => g.projectId === p.id)?.actions ?? [],
      })),
    }
  }

  async function listChapters(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const chapters = await deps.getChapters(owner)
    owner.assertCurrent()
    return {
      ok: true,
      value: {
        projectId,
        projectName: project.name,
        grantedActions: scope.projects.find(g => g.projectId === projectId)?.actions ?? [],
        chapters: chapters.filter(c => c.projectId === projectId)
          .sort((a, b) => (a.volumeId ?? '').localeCompare(b.volumeId ?? '') || a.order - b.order)
          .map(c => chapterSummary(c)),
      },
    }
  }

  async function readChapter(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const chapterId = str(args, 'chapterId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    const chapter = await owner.store.get<Chapter>('chapters', chapterId)
    if (!chapter || chapter.projectId !== projectId) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
    return {
      ok: true,
      value: {
        ...chapterSummary(chapter),
        projectId,
        content: chapter.content,
        summary: chapter.summary,
        createdAt: chapter.createdAt,
      },
    }
  }

  async function listSettingTabs(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const tabs: SettingTabInfo[] = []
    // 只列 card 型页签：首期写工具只支持设定卡（表格题不在其中）
    for (const tab of cardTabs()) {
      tabs.push({
        tabId: tab.id, name: tab.name, group: tab.group, description: tab.description,
        fields: deps.cardFieldsOf(tab).map(f => ({ path: f.path, name: f.name, desc: f.desc })),
      })
    }
    return { ok: true, value: { projectId, tabs } }
  }

  function cardTabs(): TabDef[] {
    // 通过 getTab 逐个取，避免直接依赖 TABS 数组的静态导出形态
    const out: TabDef[] = []
    const seen = new Set<string>()
    for (const tabId of CARD_TAB_IDS) {
      const tab = deps.getTab(tabId)
      if (tab && tab.type === 'card' && !seen.has(tab.id)) { seen.add(tab.id); out.push(tab) }
    }
    return out
  }

  async function createSettingCard(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'setting:create')
    if (denied) return denied
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const tabId = str(args, 'tabId', 120)
    const name = str(args, 'name', MAX_CARD_NAME_CHARS).trim()
    const tab = deps.getTab(tabId)
    if (!tab || tab.type !== 'card') return fail('BAD_REQUEST', `栏目不是可写设定卡栏目：${tabId}`)
    const fields = args.fields
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return fail('BAD_REQUEST', '参数 fields 必填（对象：字段路径 / 字段名 → 字符串值）')
    }
    const schemaFields = deps.cardFieldsOf(tab)
    const byName = new Map(schemaFields.map(f => [f.name, f.path]))
    const byPath = new Set(schemaFields.map(f => f.path))
    const data: Record<string, string> = {}
    let total = 0
    for (const [key, raw] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof raw !== 'string') return fail('BAD_REQUEST', `字段 ${key} 的值必须是字符串`)
      if (raw.length > MAX_FIELD_CHARS) return fail('BAD_REQUEST', `字段 ${key} 超过单字段上限（${MAX_FIELD_CHARS} 字符）`)
      const path = byPath.has(key) ? key : byName.get(key)
      if (!path) {
        const hint = schemaFields.slice(0, 12).map(f => f.path).join('、')
        return fail('BAD_REQUEST', `未知字段：${key}。该栏目可用字段示例：${hint}`)
      }
      total += raw.length
      if (total > MAX_CARD_TOTAL_CHARS) return fail('BAD_REQUEST', `字段内容总量超过上限（${MAX_CARD_TOTAL_CHARS} 字符）`)
      data[path] = raw
    }
    if (!Object.keys(data).length) return fail('BAD_REQUEST', '至少需要一个设定字段')
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const all = await owner.store.getAll<CardRecord>('cardRecords')
    owner.assertCurrent()
    const sameTab = all.filter(r => r.projectId === projectId && r.tabId === tabId)
    const order = sameTab.reduce((max, r) => (Number.isFinite(r.order) && r.order > max ? r.order : max), -1) + 1
    const rec: CardRecord = {
      id: deps.uid(), projectId, tabId, name, data, order, createdAt: deps.now(),
    }
    await deps.saveCardRecord(rec, owner)
    return confirmWrite(owner, async () => {
      const saved = await owner.store.get<CardRecord>('cardRecords', rec.id)
      return !!saved && saved.projectId === projectId && saved.tabId === tabId && saved.name === name
    }, { cardId: rec.id, tabId, name, order, saved: true }, '创建设定卡后未能确认保存')
  }

  async function createChapter(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'chapter:create')
    if (denied) return denied
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const title = str(args, 'title', MAX_NAME_CHARS).trim()
    const content = str(args, 'content', MAX_CONTENT_CHARS, false)
    const summary = str(args, 'summary', MAX_FIELD_CHARS, false)
    const wantedVolume = str(args, 'volumeId', 200, false)
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const [volumes, chapters] = await Promise.all([deps.getVolumes(owner), deps.getChapters(owner)])
    owner.assertCurrent()
    let volumeId = ''
    if (wantedVolume) {
      if (!volumes.some(v => v.id === wantedVolume && v.projectId === projectId)) {
        return fail('BAD_REQUEST', `卷不存在或不属于该项目：${wantedVolume}`)
      }
      volumeId = wantedVolume
    } else {
      const target = latestChapterTarget(volumes.filter(v => v.projectId === projectId), chapters.filter(c => c.projectId === projectId))
      if (!target) return fail('NO_VOLUME', '项目中还没有分卷。请先在引擎「正文写作」中新建至少一个卷，再让 Agent 录入正文。')
      volumeId = target.volumeId
    }
    const order = nextOrderInVolume(chapters, volumeId)
    const now = deps.now()
    const ch: Chapter = {
      id: deps.uid(), projectId, volumeId, order, title,
      content, summary, status: '草稿', wordCount: deps.countWords(content),
      createdAt: now, updatedAt: now,
    }
    await deps.saveChapter(ch)
    owner.assertCurrent()
    // 台账 / 序号是派生行为：失败不能让已写入的章节变成“未知”，但要如实带回警告
    const warnings: string[] = []
    try {
      const [lv, lc] = await Promise.all([deps.getVolumes(owner), deps.getChapters(owner)])
      await deps.syncChapterMaster(ch, deps.chapterSeqOf(lv, lc, ch.id), undefined, owner)
    } catch (error) {
      warnings.push(`章节台账同步失败（正文已保存）：${error instanceof Error ? error.message : String(error)}`)
    }
    const value = { ...toWriteResult(ch), ...(warnings.length ? { warnings } : {}) }
    return confirmWrite(owner, async () => {
      const saved = await owner.store.get<Chapter>('chapters', ch.id)
      return !!saved && saved.projectId === projectId && saved.content === content
    }, value, '创建章节后未能确认保存')
  }

  async function appendOrReplace(args: Record<string, unknown>, scope: AgentScope, mode: 'append' | 'replace'): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'chapter:write')
    if (denied) return denied
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const chapterId = str(args, 'chapterId', 200)
    const content = str(args, 'content', MAX_CONTENT_CHARS, mode === 'replace')
    const expected = num(args, 'expectedUpdatedAt')
    if (deps.unsavedDraft()) {
      return fail('DRAFT_DIRTY', '引擎中还有未保存的编辑草稿。请先保存（或离开编辑页）后再让 Agent 写入，以免覆盖作者正在修改的内容。')
    }
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const old = await owner.store.get<Chapter>('chapters', chapterId)
    if (!old || old.projectId !== projectId) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
    if (old.updatedAt !== expected) {
      return fail('CONFLICT', '章节已在引擎中更新，本次写入未执行。请重新读取章节后再试。', {
        chapterId, updatedAt: old.updatedAt, wordCount: old.wordCount, title: old.title,
      })
    }
    const nextContent = mode === 'replace'
      ? content
      : appendText(old.content, content)
    if (nextContent === old.content) return { ok: true, value: { ...toWriteResult(old), saved: true, unchanged: true } }
    // 覆盖 / 追加前留一版可恢复快照（章级最多 12 份，自动裁剪走引擎既有策略）
    try {
      await deps.createSnapshot(old, 'ai-rewrite', owner)
    } catch {
      return fail('SAVE_FAILED', '无法创建可恢复版本，已放弃本次正文写入（未改动原章节）。')
    }
    const updated = await deps.patchChapter(chapterId, {
      content: nextContent,
      wordCount: deps.countWords(nextContent),
    }, owner)
    if (!updated) return fail('OUTCOME_UNKNOWN', '写入过程中章节已不存在，结果不明。请先在引擎中核对。')
    const warnings: string[] = []
    try {
      const [lv, lc] = await Promise.all([deps.getVolumes(owner), deps.getChapters(owner)])
      await deps.syncChapterMaster(updated, deps.chapterSeqOf(lv, lc, updated.id), undefined, owner)
    } catch (error) {
      warnings.push(`章节台账同步失败（正文已保存）：${error instanceof Error ? error.message : String(error)}`)
    }
    const value = { ...toWriteResult(updated), ...(warnings.length ? { warnings } : {}) }
    return confirmWrite(owner, async () => {
      const saved = await owner.store.get<Chapter>('chapters', updated.id)
      return !!saved && saved.content === nextContent && saved.wordCount === updated.wordCount
    }, value, mode === 'replace' ? '覆盖正文后未能确认保存' : '追加正文后未能确认保存')
  }

  return {
    async call(call: AgentToolCall, scope: AgentScope): Promise<AgentToolResult> {
      try {
        switch (call.tool) {
          case AGENT_TOOL_NAMES.listProjects: return await listProjects(scope)
          case AGENT_TOOL_NAMES.listChapters: return await listChapters(call.args, scope)
          case AGENT_TOOL_NAMES.readChapter: return await readChapter(call.args)
          case AGENT_TOOL_NAMES.listSettingTabs: return await listSettingTabs(call.args)
          case AGENT_TOOL_NAMES.createSettingCard: return await createSettingCard(call.args, scope)
          case AGENT_TOOL_NAMES.createChapter: return await createChapter(call.args, scope)
          case AGENT_TOOL_NAMES.appendChapter: return await appendOrReplace(call.args, scope, 'append')
          case AGENT_TOOL_NAMES.replaceChapter: return await appendOrReplace(call.args, scope, 'replace')
          default: return fail('UNKNOWN_TOOL', `未知工具：${call.tool}`)
        }
      } catch (error) {
        if (error instanceof AgentInputError) return fail('BAD_REQUEST', error.message)
        const message = error instanceof Error ? error.message : String(error)
        // 归属 / 存储上下文切换：写函数在写前抛错＝未写入；写后抛错＝结果不明。
        // 这里无法区分，按**结果不明**上报（宁可让作者核对，也不能让 Agent 盲目重试造成重复追加）。
        if (message.includes('项目或存储空间已切换') || message.includes('存储空间已切换')) {
          return fail('OUTCOME_UNKNOWN', `${message}（结果不明，请先在引擎中核对，不要复用同一 requestId 重试）`)
        }
        return fail('INTERNAL', `执行失败（未确认写入）：${message}`)
      }
    },
  }
}

function toWriteResult(ch: Chapter): AgentChapterWriteResult {
  return {
    chapterId: ch.id, title: ch.title, wordCount: ch.wordCount, updatedAt: ch.updatedAt, saved: true,
  }
}

/** 追加时避免正文直接粘连：旧文非空且两边都没有换行时补一个空行分隔 */
export function appendText(old: string, add: string): string {
  if (!old) return add
  if (!add) return old
  if (old.endsWith('\n') || add.startsWith('\n')) return old + add
  return old + (old.endsWith('\n\n') ? '' : '\n\n') + add
}

/**
 * 首期开放的「设定卡」栏目 —— 与 `schemaTabs/part*.ts` 里 `type: 'card'` 的页签逐项一致。
 * 🔴 只列 card 型：表单型（世界设定 / 力量体系）是单份母级数据，不能“创建一张卡”；
 *    表格型没有卡片名与字段结构，首期不纳入写工具。
 */
export const CARD_TAB_IDS: readonly string[] = [
  'char-main', 'char-secondary', 'char-npc', 'misc-settings', 'volume-outline', 'chapter-outline',
]