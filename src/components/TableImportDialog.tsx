import { useEffect, useMemo, useRef, useState } from 'react'
import { Upload, FileDown, Check, CheckSquare, Square, AlertTriangle, Loader2, FileText, Trash2, Sparkles, CircleStop } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import AutoTextarea from './AutoTextarea'
import { showToast } from './dialogs'
import { foldVh } from '../lib/theme'
import type { TabDef, TableRow } from '../lib/types'
import { getTableRows } from '../lib/db'
import { TABS } from '../lib/schema'
import { downloadBlob } from '../lib/zip'
import { useAIReady } from '../lib/useAIReady'
import { useTaskRunner } from '../lib/aiTaskCenter'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { tableImportSplit, type TableImportSplitOutcome } from '../lib/tableImportAI'
import {
  parseImportText, mapHeaders, matrixToRows, textToRows, validateImport, mainColumn,
  exportTemplateCsv, buildImportGuide, type ImportRowResult, type ImportContext,
} from '../lib/tableIO'

interface Props {
  tab: TabDef
  /** 库里已有的行（判重 + 编号冲突；含未保存草稿更好，但至少要给库里的） */
  existing: TableRow[]
  /** 采用：把勾选的行交给父组件落库（父组件走 buildImportRows + saveTableRow，与 AI 整理同口径） */
  onAdd: (picked: ImportRowResult[]) => Promise<void> | void
  onClose: () => void
}

/**
 * 表格批量导入弹窗（2.6.4 起；2.7.0 加「AI 智能拆分」）。
 *
 * 社区诉求：作者已有一份成体系的设定，想整批搬进项目；而「AI 整理」只吃一段文本、上限 12 条。
 *
 * 三种导入方式（弹窗里也讲了一遍，别只写在这）：
 *   ① 照着模板填 —— 本地解析粘贴/文件（Markdown / Excel 复制 / CSV / 键值块），**不烧额度**；
 *   ② 交给别的 AI 整理成表再粘回来 —— 下载「导入说明 / AI 提示词」给它；
 *   ③ 直接粘贴、点「AI 智能拆分」—— 用本机已接入的模型把表格/散文解析成多条，**长文自动分批**。
 * 🔴 方式③ 只是「多一个入口」，①② 永远可用 —— 没配模型时本弹窗依然完整可用（只少了那个按钮）。
 *
 * 🔴 两条纪律：
 *   1. **勾稽不失效**：跨表引用存的是名称字符串，导入只做「名称存在性校验」并提示，绝不改写值。
 *   2. **不擅自替作者决定**：AI 拆出来的行与本地解析的行走**同一套校验与预览**，
 *      重复 / 缺必填 / 悬空都标出来，勾不勾、导不导由作者定。
 */
export default function TableImportDialog({ tab, existing, onAdd, onClose }: Props) {
  const [raw, setRaw] = useState('')
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState(false)
  const [useCtx, setUseCtx] = useState(true)
  const [refValues, setRefValues] = useState<Map<string, Set<string>>>(new Map())
  const [refLabels, setRefLabels] = useState<Map<string, string>>(new Map())
  const fileRef = useRef<HTMLInputElement>(null)

  const { ready: aiReady } = useAIReady()
  // 🔴 接任务中心（kind 必须与同页签的 organize / fill 不同）：切页签 / 关弹窗都不会掐断请求，也不白烧额度。
  const t = useTaskRunner<TableImportSplitOutcome, string>({
    ownerTab: tab.id, kind: 'import-split', title: `AI 智能拆分 · ${tab.name}`,
    writes: [`table:${tab.id}`],
  })

  // 收集本表所有跨表引用列的候选值（校验悬空用）—— 只读，不写库
  useEffect(() => {
    const refCols = (tab.columns ?? []).filter(c => c.type === 'tableRef' && c.refTab)
    const tabs = [...new Set(refCols.map(c => c.refTab!))]
    if (tabs.length === 0) return
    let alive = true
    Promise.all(tabs.map(async tid => {
      const refCol = refCols.find(c => c.refTab === tid)?.refCol ?? '名称'
      try {
        const list = await getTableRows(tid)
        return [tid, new Set(list.map(r => (r.data[refCol] ?? '').trim()).filter(Boolean))] as const
      } catch {
        return [tid, new Set<string>()] as const
      }
    })).then(pairs => {
      if (!alive) return
      setRefValues(new Map(pairs))
      setRefLabels(new Map(tabs.map(tid => [tid, TABS.find(t => t.id === tid)?.name ?? tid])))
    }).catch(() => { /* 读不到就不做悬空校验，不阻断导入 */ })
    return () => { alive = false }
  }, [tab])

  /**
   * AI 结果只在「原文没被改过」时才用 —— 结果里存了发起时的原文快照，逐字比对。
   * 作者改过原文后，旧的拆分结果一律作废（否则会拿旧结果去导新内容）。
   */
  const aiRows = t.result && t.result.sourceText === raw ? t.result.rows : null

  /**
   * 弹窗被切页签卸载又重挂时，组件本地的原文已经丢了 —— 若任务中心里还有一份结果，
   * 用它的原文快照把输入恢复回来，免得"结果在、原文没了、白跑一趟"。
   */
  const restoredRef = useRef('')
  useEffect(() => {
    if (t.result && !raw && restoredRef.current !== t.result.sourceText) {
      restoredRef.current = t.result.sourceText
      setRaw(t.result.sourceText)
    }
  }, [t.result, raw])

  const parsed = useMemo(() => (raw.trim() ? parseImportText(raw) : null), [raw])

  /** 解析 → 行对象（AI 结果优先；否则表格走矩阵映射、纯文本走本地拆分） */
  const prepared = useMemo(() => {
    if (aiRows) {
      const rawN = t.result?.rawCount ?? aiRows.length
      const chunkN = t.result?.chunks ?? 1
      return {
        rows: aiRows,
        note: `AI 智能拆分 · 解析出 ${aiRows.length} 条（模型原始返回 ${rawN} 条）${chunkN > 1 ? ` · 分 ${chunkN} 段解析` : ''}`,
      }
    }
    if (!parsed) return { rows: [] as Record<string, string>[], note: '' }
    if (parsed.table) {
      const mapping = mapHeaders(parsed.table.headers, tab)
      const hit = mapping.filter(Boolean).length
      const lostCols = parsed.table.headers.filter((_, i) => !mapping[i])
      const lost = lostCols.length ? `；未识别的列已忽略：${lostCols.join('、')}` : ''
      return { rows: matrixToRows(parsed.table, mapping, tab), note: `${parsed.note} · 匹配到 ${hit}/${mapping.length} 列${lost}` }
    }
    const tx = textToRows(parsed.text ?? '', tab)
    return { rows: tx.rows, note: `${parsed.note} · ${tx.note}` }
  }, [parsed, tab, aiRows, t.result])

  const ctx: ImportContext = useMemo(() => ({ existing, refValues, refLabels }), [existing, refValues, refLabels])
  const results = useMemo(
    () => (prepared.rows.length ? validateImport(prepared.rows, tab, ctx) : []),
    [prepared, tab, ctx],
  )

  // 校验结果变化时，默认勾选「非重复且不缺必填」的行
  useEffect(() => {
    const okIdx = new Set<number>()
    results.forEach((r, i) => {
      if (!r.dupExisting && !r.dupInBatch && r.missing.length === 0) okIdx.add(i)
    })
    setChecked(okIdx)
  }, [results])

  const stat = useMemo(() => {
    let dup = 0, dangling = 0, missing = 0
    for (const r of results) {
      if (r.dupExisting || r.dupInBatch) dup++
      if (r.dangling.length) dangling++
      if (r.missing.length) missing++
    }
    return { total: results.length, dup, dangling, missing }
  }, [results])

  const cols = useMemo(() => (tab.columns ?? []).filter(c => !c.hidden), [tab])
  const main = useMemo(() => mainColumn(tab), [tab])

  const toggleRow = (i: number) => setChecked(prev => {
    const next = new Set(prev)
    if (next.has(i)) next.delete(i); else next.add(i)
    return next
  })
  const setAll = (on: boolean) => setChecked(on ? new Set(results.map((_, i) => i)) : new Set())

  const apply = async () => {
    const picked = results.filter((_, i) => checked.has(i))
    if (picked.length === 0) return
    setAdding(true)
    try {
      await onAdd(picked)
      onClose()
    } catch (e) {
      showToast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setAdding(false)
    }
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      setRaw(await f.text())
    } catch {
      showToast('文件读取失败，可改用粘贴方式。', 'error')
    }
  }

  const downloadTemplate = () => {
    downloadBlob(`${tab.name}-导入模板.csv`, new Blob(['\uFEFF' + exportTemplateCsv(tab)], { type: 'text/csv;charset=utf-8' }))
  }
  const downloadGuide = () => {
    downloadBlob(`${tab.name}-导入说明.md`, new Blob([buildImportGuide(tab)], { type: 'text/markdown;charset=utf-8' }))
  }

  /** 方式③：用已接入的模型把粘贴内容解析成多条（长文自动分批 → 突破一次十几条的限制） */
  const runAi = () => {
    if (!raw.trim()) { showToast('请先粘贴要解析的内容。', 'info'); return }
    const src = raw
    t.run(job => tableImportSplit(tab, {
      sourceText: src,
      useCtx,
      signal: job.signal,
      onPhase: job.progress,
    }))
  }

  return (
    <Modal open onClose={onClose} icon={<Upload size={14} />} title={`批量导入 · ${tab.name}`} width="2xl" maxHeight="90vh">
      <div className="space-y-4">
        <p className="text-12 text-ink-400 leading-relaxed">
          把已有设定搬进来，三种方式任选：
          <br />
          <span className="text-ink-300">① 已有表格 / CSV</span> —— 直接粘贴或选文件，本地解析、不耗额度；
          <span className="text-ink-300"> ② 散文式设定</span> —— 下载「导入说明 / AI 提示词」交给别的 AI 整理成表，再粘回来；
          <span className="text-ink-300"> ③ 懒得手动整理</span> —— 粘贴后点下方「AI 智能拆分」，用你当前配置的模型自动拆成多条。
          <HelpPopover title="三种导入方式怎么选" width="26rem" className="ml-0.5" size={12}>
            {'① 照着模板填（最简单、最确定）\n'
              + '适用：设定本来就条理清晰，或你愿意手动整理。\n'
              + '做法：把「下载空白模板」的表头填好，粘贴回来或选 CSV 文件；Markdown 表格、从 Excel 直接复制也认。\n'
              + '特点：完全本地解析，不消耗任何 AI 额度。\n\n'
              + '② 交给别的 AI 整理成表\n'
              + '适用：你的设定是文档/散文式的，想让别的 AI（如网页版对话模型）帮你誊。\n'
              + '做法：把「导入说明 / AI 提示词」整段复制给那个 AI，连设定原文一起发；拿回表格后粘到这里。\n'
              + '特点：不消耗本项目额度，由你选定的那个 AI 出力。\n\n'
              + '③ 用本项目已接入的 AI 智能拆分\n'
              + '适用：不想手动整理、也不想另开 AI，粘贴完点一下就好。\n'
              + '做法：把表格或散文直接粘进来，点「AI 智能拆分」；长文会自动分批，突破一次十几条的限制。\n'
              + '特点：会调用你配置的模型；效果取决于模型能力，拆完请在预览里过一眼再导入。\n\n'
              + '三种方式导入的行，都要经过同一套预览校验（重复 / 缺必填 / 名称对不上）。'}
            <AIDataSourceNote feature="table-import-split" />
          </HelpPopover>
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5">
            <FileText size={12} /> 选择文件
          </Button>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.md,text/plain" className="hidden" onChange={onFile} />
          <Button variant="secondary" size="sm" onClick={downloadTemplate} className="flex items-center gap-1.5">
            <FileDown size={12} /> 下载空白模板
          </Button>
          <Button variant="secondary" size="sm" onClick={downloadGuide} className="flex items-center gap-1.5">
            <FileDown size={12} /> 导入说明 / AI 提示词
          </Button>
          {raw && (
            <Button variant="bare" size="sm" onClick={() => { setRaw(''); t.clear() }} className="ml-auto flex items-center gap-1 text-ink-400 hover:text-danger">
              <Trash2 size={12} /> 清空
            </Button>
          )}
        </div>

        <AutoTextarea
          value={raw}
          onChange={setRaw}
          placeholder={'在此粘贴表格或文本，例如：\n名称,类别,上级\n青云宗,宗门,\n大炎王朝,王朝,\n\n也可以直接粘贴一段散文式设定，再点「AI 智能拆分」。'}
          className="text-12"
          minHeight={110}
          maxHeight={220}
        />

        {/* 方式③：AI 智能拆分 */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button onClick={runAi}
            disabled={t.running || !aiReady || !raw.trim()}
            title={!aiReady ? AI_DISABLED_HINT : (!raw.trim() ? '先粘贴要解析的内容' : '用你当前配置的模型把粘贴的内容拆成多条记录')}
            variant="secondary" size="md" className="flex items-center gap-1.5">
            {t.running ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {t.running ? (t.task?.progress || 'AI 正在解析…') : 'AI 智能拆分'}
          </Button>
          {t.running && (
            <Button onClick={t.stop} variant="secondary" size="md" className="flex items-center">
              <CircleStop size={12} /> 停止
            </Button>
          )}
          <label className="flex items-center gap-1.5 text-11 text-ink-400 cursor-pointer select-none">
            <input type="checkbox" checked={useCtx} onChange={e => setUseCtx(e.target.checked)} className="accent-amber" />
            带入项目资料（让拆分出的人名 / 势力名与已有设定对得上）
          </label>
          {aiRows && (
            <Button onClick={() => t.clear()} variant="bare" size="sm" className="text-ink-400 hover:text-ink-200 underline">
              放弃 AI 结果，改用本地解析
            </Button>
          )}
        </div>

        {t.error && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{t.error}</span>
          </div>
        )}

        {parsed && !t.running && (
          <div className="text-11 text-ink-400">
            识别为：<span className="text-amber/80">{prepared.note || parsed.note}</span>
          </div>
        )}

        {aiRows && aiRows.length === 0 && !t.running && (
          <div className="px-3 py-2 rounded-lg bg-ink-900/50 border border-ink-800 text-12 text-ink-400">
            模型没有解析出任何记录 —— 可以检查粘贴的内容是否完整，或换个模型 / 关掉「带入项目资料」再试。
          </div>
        )}

        {results.length > 0 && (
          <>
            <div className="flex items-center gap-3 flex-wrap text-12">
              <span className="text-ink-400">共 <span className="text-ink-100">{stat.total}</span> 行</span>
              {stat.dup > 0 && <span className="text-amber/80">与已有重复 {stat.dup}</span>}
              {stat.dangling > 0 && <span className="text-amber/80">名称对不上 {stat.dangling}</span>}
              {stat.missing > 0 && <span className="text-amber/80">缺必填 {stat.missing}</span>}
              <span className="ml-auto flex items-center gap-2">
                <Button variant="bare" size="sm" onClick={() => setAll(true)} className="px-2 py-0.5 rounded bg-ink-800 border border-ink-700 hover:bg-ink-700">全选</Button>
                <Button variant="bare" size="sm" onClick={() => setAll(false)} className="px-2 py-0.5 rounded bg-ink-800 border border-ink-700 hover:bg-ink-700">全不选</Button>
              </span>
            </div>

            <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: foldVh('40vh') }}>
              {results.map((r, i) => {
                const dup = r.dupExisting || r.dupInBatch
                const mainVal = main ? (r.data[main] ?? '').trim() : ''
                return (
                  <Button
                    variant="bare"
                    key={i}
                    onClick={() => toggleRow(i)}
                    className={`w-full text-left !justify-start rounded-lg border px-3 py-2 transition-colors ${
                      checked.has(i) ? 'border-amber/30 bg-amber/5' : 'border-ink-700 bg-ink-900/40 opacity-60'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {checked.has(i)
                        ? <CheckSquare size={13} className="text-amber shrink-0" />
                        : <Square size={13} className="text-ink-600 shrink-0" />}
                      <span className="text-11 text-ink-500 shrink-0">#{r.index}</span>
                      <span className="text-12 font-medium text-ink-100 truncate">{mainVal || '（未命名）'}</span>
                      {dup && <span className="ml-auto text-11 text-amber/80 shrink-0">与已有重复</span>}
                      {r.missing.length > 0 && <span className="ml-auto text-11 text-danger shrink-0">缺 {r.missing.join('、')}</span>}
                    </div>
                    <div className="pl-5 space-y-0.5">
                      {cols.filter(c => c.name !== main && (r.data[c.name] ?? '').trim() && !c.hidden).map(c => (
                        <div key={c.name} className="text-11 text-ink-400 break-words">
                          <span className="text-ink-500">{c.name}：</span>{r.data[c.name]}
                        </div>
                      ))}
                      {r.dangling.map((d, k) => (
                        <div key={k} className="text-11 text-amber/80 flex items-start gap-1">
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                          <span>{d.col}「{d.value}」在《{d.refLabel}》里找不到 —— 导入后此项勾稽会悬空，可先建好再导。</span>
                        </div>
                      ))}
                    </div>
                  </Button>
                )
              })}
            </div>
          </>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button
            onClick={apply}
            disabled={adding || checked.size === 0}
            variant="primary" size="md" className="flex items-center"
          >
            {adding ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            导入选中 {checked.size} 条
          </Button>
          <span className="text-11 text-ink-500">导入后可继续在表格里编辑；编号留空会自动续号。</span>
          <Button variant="secondary" onClick={onClose} className="ml-auto px-3 py-2 text-12">取消</Button>
        </div>
      </div>
    </Modal>
  )
}
