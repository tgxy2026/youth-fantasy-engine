/**
 * 「表格导入 · AI 智能拆分」的执行体（域中立，零 React）。
 *
 * 【为什么单独一层，而不是直接在弹窗里调模型】
 * 和 `lib/organizeRows.ts` 同样的理由：候选值注入（select 选项 / 跨表引用名 / 角色名）
 * 与项目资料打包是**易漂移**的部分，必须与「AI 整理」共用同一套口径
 * （`resolveColumnCandidates`）—— 否则界面下拉里有的值模型说没有，模型编出下拉里不存在的值
 * 写回去就成了幽灵选项 / 悬空引用。
 *
 * 与「AI 整理」的差别只有两点：**不判重**、**按字数分批**（长散文拆开喂，单次更准、也突破条数上限）。
 *
 * ⚠️ 本文件住在 lib，**不得 import components**（分层红线，见 tests/importCycles.test.ts）。
 */
import { buildProjectContext } from './aiContext'
import { aiSplitTableRows, type ImportSplitColumn } from './aiTasks'
import { writerBudgetFor } from './aiWriterBudget'
import { organizeHint } from './aiScope'
import { resolveColumnCandidates } from './organizeRows'
import { splitIntoChunks } from './tableIO'
import type { TabDef } from './types'

export interface TableImportRunOptions {
  /** 作者粘贴的原始内容（表格或散文） */
  sourceText: string
  /** 是否带入项目资料上下文（世界观 / 角色卡 / 各类设定），默认 true */
  useCtx?: boolean
  /** 全部批次加起来的条数上限（防止模型在超长输入上无限吐行） */
  maxRows?: number
  signal?: AbortSignal
  /** 界面阶段提示（「AI 正在解析第 2/3 段…」这类） */
  onPhase?: (text: string) => void
}

export interface TableImportSplitOutcome {
  /** 解析出的行（key = schema 列名）；未判重，交给导入预览标注 */
  rows: Record<string, string>[]
  /** 模型原始返回条数（含整行空、被丢弃的占位对象） */
  rawCount: number
  /** 实际分了几段调用（=1 表示没触发分批） */
  chunks: number
  /**
   * 发起时的原文快照。
   * 🔴 必须带上：AI 任务跑在模块级 store 里，弹窗可能被卸载重挂（切页签），
   *    重挂时组件本地已没有原文 —— 靠这份快照才能把「输入 → 结果」还原回界面。
   */
  sourceText: string
}

/** 单批最多返回多少条（分批时每批各自适用） */
const PER_CHUNK_MAX = 60
/** 多大的文本开始分批 */
const CHUNK_CHARS = 3000

/**
 * 跑一次「AI 智能拆分」。
 *
 * 流程：算候选值 → （可选）打包项目资料 → 按字数分批 → 逐批解析 → 合并。
 * 🔴 不在这里判重：产出的行原样交给 `validateImport`，重复 / 缺必填 / 悬空都由预览呈现给作者决定。
 */
export async function tableImportSplit(
  tab: TabDef,
  o: TableImportRunOptions,
): Promise<TableImportSplitOutcome> {
  const src = (o.sourceText ?? '').trim()
  if (!src) return { rows: [], rawCount: 0, chunks: 0, sourceText: o.sourceText }

  // 编号列由系统自动续号，不让模型插手；隐藏列也不让它填
  const aiCols = (tab.columns ?? []).filter(c => c.name !== '编号' && !c.hidden)

  const allowedList = await resolveColumnCandidates(aiCols, { tab, onPhase: o.onPhase })
  const cols: ImportSplitColumn[] = aiCols.map((c, i) => ({ name: c.name, desc: c.tip, allowed: allowedList[i] }))

  let ctx = ''
  if (o.useCtx !== false) {
    o.onPhase?.('正在打包项目资料…')
    // 排除本表自身：作者要搬进来的就是这张表的数据，把已有内容整篇塞进去既费预算也没用。
    const built = await buildProjectContext({
      budget: await writerBudgetFor('table-import'),
      excludeTabIds: [tab.id],
    })
    ctx = built.text
  }

  const chunks = splitIntoChunks(src, CHUNK_CHARS)
  const purpose = `${tab.description || ''} ${organizeHint(tab.id)}`.trim()

  const rows: Record<string, string>[] = []
  let rawCount = 0
  // 总量上限按「批数 × 每批上限」兜底，避免超长输入把结果撑爆（预览也会很长）
  const totalMax = Math.max(PER_CHUNK_MAX, Math.min(o.maxRows ?? 300, 600))

  for (let i = 0; i < chunks.length; i++) {
    o.onPhase?.(chunks.length > 1 ? `AI 正在解析第 ${i + 1}/${chunks.length} 段…` : 'AI 正在解析…')
    const r = await aiSplitTableRows({
      tableName: tab.name,
      purpose,
      columns: cols,
      sourceText: chunks[i],
      projectContext: ctx,
      maxRows: PER_CHUNK_MAX,
      ...(o.signal ? { signal: o.signal } : {}),
    })
    rows.push(...r.rows)
    rawCount += r.rawCount
    if (rows.length >= totalMax) break
  }

  return { rows: rows.slice(0, totalMax), rawCount, chunks: chunks.length, sourceText: o.sourceText }
}
