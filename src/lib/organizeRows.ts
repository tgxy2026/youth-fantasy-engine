/**
 * 「AI 整理」的执行体（域中立，零 React）。
 *
 * 【为什么从 components/AIOrganize.tsx 里下沉出来】
 * 「一键拆书」末尾的「整理关系」阶段要做的事与弹窗里的「AI 整理」**是同一件事**：
 * 读已有条目 → 注入候选值 → 打包项目资料 → 调模型 → 按关键列本地判重。
 * 若各写一份，**候选值口径会漂移**（后果很具体：界面下拉里有的值 AI 说没有，
 * 模型编出一个下拉里不存在的值就成了幽灵选项），判重规则也会分叉。
 * 所以：执行逻辑只此一份，弹窗只负责 UI（选章节 / 粘贴 / 勾选结果）。
 *
 * ⚠️ 本文件住在 lib，**不得 import components**（分层红线，见 tests/importCycles.test.ts）。
 */
import { buildProjectContext, isPrunedForAI, loadCharacterNames } from './aiContext'
import { aiOrganizeRows, keyRowToLine, type OrganizeColumn, type OrganizeResult } from './aiTasks'
import { writerBudgetFor } from './aiWriterBudget'
import { resolveOptions } from './customOptions'
import * as db from './db'
import { isVolumeLedgerTab, type VisCtx } from './schema'
import { isDirectedPairTab, organizeHint, organizeKeyColumns } from './aiScope'
import type { CalendarDef, TableColumn, TabDef } from './types'

export interface OrganizeRunOptions {
  /**
   * 已有行数据（含表格里未保存的草稿合并结果），用于判重。
   * 🔴 必须传全 —— 少传会让重复条目漏过。
   */
  existing: Record<string, string>[]
  /** 待整理的正文（传空串 = 仅依据项目资料整理） */
  sourceText: string
  /** 是否带入项目资料上下文（世界观 / 角色卡 / 各类设定），默认 true */
  useCtx?: boolean
  /**
   * 项目资料里是否附「章节清单」。
   * 正文来源是「手选章节」时为 false（那些章的内容正在下面给着，清单是重复占用预算）；
   * 「手动粘贴 / 仅依据已有设定」时为 true（模型得知道这本书有哪些章，才好填章节号）。
   */
  includeChapterList?: boolean
  /** 单次最多返回条数（默认 12） */
  maxRows?: number
  signal?: AbortSignal
  /** 流式回调：提供时整理过程逐块可见 */
  onToken?: (delta: string) => void
  /** 界面阶段提示（「正在读取下拉选项…」这类）。后台流水线里通常不传。 */
  onPhase?: (text: string) => void
  /** 角色可见性上下文（决定 NPC 页签的姓名是否纳入候选值） */
  ctx?: VisCtx
  /** 日历定义（日期型列的候选取日历名） */
  calendars?: CalendarDef[]
  /** 追加到「整理目标」末尾的语境说明（如拆书场景的「本次依据是整本书的抽取结果」） */
  purposeSuffix?: string
  /**
   * **按列覆盖候选值**（列名 → 允许值列表）。给了就以它为准，不再按列类型去库里算。
   *
   * 🔴 拆书场景必须用它。理由很具体：拆书时角色卡与《国家势力》**还几乎是空的**
   *    （抽出的实体草稿还没落库），按库算出来的候选值是空列表 —— 模型手里没有名单，
   *    只能自己编，于是「陈渊 · 青岚宗」这种**把势力写进人物列**、"青岚宗山门"（地点）
   *    当成关系的脏数据就出来了。正确做法是把「库里的已有名字 ∪ 本次抽出的同类实体名」
   *    一起作为名单喂进去（作者刚拆的书，人名就在实体清单里）。
   */
  allowedOverride?: Record<string, string[]>
  /** 额外要求模型输出的**校验字段**（如「依据」原文片段）—— 透传给 `aiOrganizeRows`，见那里的说明 */
  evidenceField?: string
}

/** 该表用于判重的关键列（已按表内实际存在的列过滤）。界面要用它显示「判重依据」。 */
export function organizeKeyColsOf(tab: TabDef): string[] {
  return organizeKeyColumns(tab)
}

/** 该表在「AI 整理」里是否按无序对判重（A-B 与 B-A 算同一条）。2.7.2 起配对表改为有向对 ⇒ 恒 false。 */
function organizeUnorderedOf(tab: TabDef): boolean {
  return !isDirectedPairTab(tab.id)
}

/**
 * 跑一次「AI 整理」。
 *
 * 双重保险防重复：prompt 里明确告知已有条目（`existingKeys`）+ 返回后本地按关键列再去一遍重
 * （后者在 `aiOrganizeRows` 内实现）。
 */
/**
 * 逐列算出「模型填这一列时该用哪些候选值」。
 *
 * 🔴 这段逻辑**必须只此一份**：任何让模型"从固定清单里挑"的链路（AI 整理、拆书末尾整理、
 *    表格导入的 AI 智能拆分）都走它 —— 各写一份的后果很具体：界面下拉里有的值，模型说没有；
 *    模型编出一个下拉里不存在的值，写回去就成了幽灵选项 / 悬空引用。
 */
export interface CandidateOpts {
  /** 目标表（select 列要按它读自定义选项） */
  tab: TabDef
  /** 日历定义（日期型列的候选取日历名） */
  calendars?: CalendarDef[]
  /** 角色可见性上下文（决定 NPC 页签的姓名是否纳入候选值） */
  ctx?: VisCtx
  /** 按列覆盖候选值（列名 → 允许值列表）。给了就以它为准，不再按列类型去库里算 */
  allowedOverride?: Record<string, string[]>
  /** 界面阶段提示（「正在读取下拉选项…」这类） */
  onPhase?: (text: string) => void
}

export async function resolveColumnCandidates(
  cols: TableColumn[],
  o: CandidateOpts,
): Promise<(string[] | undefined)[]> {
  const tab = o.tab
  // 跨表引用列的候选值缓存：同一张来源表在本次整理里只读一次（势力关系有 A/B 两列都引用《国家势力》）
  const refCache = new Map<string, string[]>()
  const charNames = await loadCharacterNames(o.ctx ?? { type: 'full', features: [] }).catch(() => [] as string[])
  const allowedOf = async (c: TableColumn): Promise<string[] | undefined> => {
    // 调用方点名覆盖的列优先（拆书场景用它把"本次刚抽出、还没落库"的名字并进名单）
    const override = o.allowedOverride?.[c.name]
    if (override) return override
    if (c.calendar) return (o.calendars ?? []).map(x => x.name).filter(Boolean)
    // 🔴 跨表引用列（如《势力关系》的势力A / 势力B）：候选值来自被引用表的指定列。
    //    不喂候选值，模型会自己编势力名 → 写回去就是悬空引用，《势力关系》图谱里会冒出并不存在的节点。
    if (c.type === 'tableRef' && c.refTab && c.refCol) {
      const hit = refCache.get(c.refTab)
      if (hit) return hit
      const rows = await db.getTableRows(c.refTab)
      const names = [...new Set(rows.map(r => String(r.data[c.refCol as string] ?? '').trim()).filter(Boolean))]
      refCache.set(c.refTab, names)
      return names
    }
    if (c.type === 'select' && c.options?.length) {
      const payload = await db.getCustomOptions(tab.id, c.name)
      return resolveOptions(c.options, payload).map(x => x.name)
    }
    if (c.type === 'character' || c.type === 'characters') return charNames
    return undefined
  }
  /**
   * 下拉列的合法取值。
   * 必须用与行内下拉完全一致的口径（resolveOptions）：直接给 col.options 会漏掉
   * 用户自定义的选项，还会把已被隐藏 / 改名的旧内置项继续喂给模型。
   */
  o.onPhase?.('正在读取下拉选项…')
  return Promise.all(cols.map(c => allowedOf(c)))
}

export async function organizeRows(tab: TabDef, o: OrganizeRunOptions): Promise<OrganizeResult> {
  const keyCols = organizeKeyColsOf(tab)
  const unordered = organizeUnorderedOf(tab)
  // 编号列由系统自动续号、隐藏列是给程序用的内部数据 —— 两者都不让模型插手
  // （隐藏列口径与 aiContext.renderTable 一致，2026-10-08 统一）
  const aiCols = (tab.columns ?? []).filter(c => c.name !== '编号' && !c.hidden)

  let ctx = ''
  if (o.useCtx !== false) {
    o.onPhase?.('正在打包项目资料…')
    // 排除当前表自身：它的已有条目单独作为「不得重复」清单给模型，避免重复占预算。
    // 卷台账页签还要排除 chapter-master 聚合段——那段含全部卷（含当前卷）的台账行，
    // 不排除的话当前表的行会重复进 prompt（1.9.2 按卷建表后）。
    const built = await buildProjectContext({
      budget: await writerBudgetFor('organize-rows'),
      excludeTabIds: isVolumeLedgerTab(tab.id) ? [tab.id, 'chapter-master'] : [tab.id],
      includeChapterList: !!o.includeChapterList,
    })
    ctx = built.text
  }

  const allowedList = await resolveColumnCandidates(aiCols, {
    tab,
    calendars: o.calendars,
    ctx: o.ctx,
    allowedOverride: o.allowedOverride,
    onPhase: o.onPhase,
  })
  const cols: OrganizeColumn[] = aiCols.map((c, i) => ({ name: c.name, desc: c.tip, allowed: allowedList[i] }))
  // 🔴 D 级（终结 / 弃用）不进判重清单 —— 它同样属于"不提供给模型"的数据：
  //    带上它，模型会以为"这条已登记过"从而跳过本该登记的新内容。
  const existingKeys = o.existing
    .filter(d => !isPrunedForAI(d))
    .map(d => keyRowToLine(d, keyCols))
    .filter(s => s.replace(/[｜\s]/g, '').length > 0)

  o.onPhase?.('模型正在整理，请稍候…')
  return aiOrganizeRows({
    tableName: tab.name,
    purpose: `${tab.description || ''} ${organizeHint(tab.id)}${o.purposeSuffix ? ` ${o.purposeSuffix}` : ''}`.trim(),
    columns: cols,
    existingKeys,
    keyColumns: keyCols,
    unorderedPair: unordered,
    sourceText: o.sourceText,
    projectContext: ctx,
    maxRows: o.maxRows ?? 12,
    ...(o.evidenceField ? { evidenceField: o.evidenceField } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.onToken ? { onToken: o.onToken } : {}),
  })
}
