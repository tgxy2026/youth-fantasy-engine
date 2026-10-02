import { useEffect, useMemo, useRef, useState } from 'react'
import { Upload, FileDown, Check, CheckSquare, Square, AlertTriangle, Loader2, FileText, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'
import AutoTextarea from './AutoTextarea'
import { showToast } from './dialogs'
import { foldVh } from '../lib/theme'
import type { TabDef, TableRow } from '../lib/types'
import { getTableRows } from '../lib/db'
import { TABS } from '../lib/schema'
import { downloadBlob } from '../lib/zip'
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
 * 表格批量导入弹窗（2.6.4）。
 *
 * 社区诉求：作者已有一份成体系的设定，想整批搬进项目；而「AI 整理」只吃一段文本、上限 12 条。
 * 这里提供**确定性**的导入：粘贴 / 选文件 → 自动识别格式 → 逐行校验预览 → 勾选落库。
 *
 * 🔴 两条纪律：
 *   1. **勾稽不失效**：跨表引用存的是名称字符串，导入只做「名称存在性校验」并提示，绝不改写值。
 *   2. **不烧模型**：全程本地解析，未接入任何 AI 也能用。
 */
export default function TableImportDialog({ tab, existing, onAdd, onClose }: Props) {
  const [raw, setRaw] = useState('')
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState(false)
  const [refValues, setRefValues] = useState<Map<string, Set<string>>>(new Map())
  const [refLabels, setRefLabels] = useState<Map<string, string>>(new Map())
  const fileRef = useRef<HTMLInputElement>(null)

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

  const parsed = useMemo(() => (raw.trim() ? parseImportText(raw) : null), [raw])

  /** 解析 → 行对象（表格走矩阵映射；纯文本走本地拆分） */
  const prepared = useMemo(() => {
    if (!parsed) return { rows: [] as Record<string, string>[], note: '' }
    if (parsed.table) {
      const mapping = mapHeaders(parsed.table.headers, tab)
      const hit = mapping.filter(Boolean).length
      const lostCols = parsed.table.headers.filter((_, i) => !mapping[i])
      const lost = lostCols.length ? `；未识别的列已忽略：${lostCols.join('、')}` : ''
      return { rows: matrixToRows(parsed.table, mapping, tab), note: `${parsed.note} · 匹配到 ${hit}/${mapping.length} 列${lost}` }
    }
    const t = textToRows(parsed.text ?? '', tab)
    return { rows: t.rows, note: `${parsed.note} · ${t.note}` }
  }, [parsed, tab])

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

  return (
    <Modal open onClose={onClose} icon={<Upload size={14} />} title={`批量导入 · ${tab.name}`} width="2xl" maxHeight="90vh">
      <div className="space-y-4">
        <p className="text-12 text-ink-400 leading-relaxed">
          把已有设定贴进来即可：支持 <span className="text-ink-300">Markdown 表格</span>、
          <span className="text-ink-300">从 Excel 直接复制</span>、
          <span className="text-ink-300">CSV</span>，或
          <span className="text-ink-300">一段纯文本</span>（按「列名：值」或逐行拆分）。
          列名与本表一致即能对上，列序随意。
          {tab.displayCol && <> 其中「{tab.displayCol}」为必填。</>}
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
            <Button variant="bare" size="sm" onClick={() => setRaw('')} className="ml-auto flex items-center gap-1 text-ink-400 hover:text-danger">
              <Trash2 size={12} /> 清空
            </Button>
          )}
        </div>

        <AutoTextarea
          value={raw}
          onChange={setRaw}
          placeholder={'在此粘贴表格或文本，例如：\n名称,类别,上级\n青云宗,宗门,\n大炎王朝,王朝,'}
          className="text-12"
          minHeight={110}
          maxHeight={220}
        />

        {parsed && (
          <div className="text-11 text-ink-400">
            识别为：<span className="text-amber/80">{prepared.note || parsed.note}</span>
          </div>
        )}

        {results.length > 0 && (
          <>
            <div className="flex items-center gap-3 flex-wrap text-12">
              <span className="text-ink-400">共 <span className="text-ink-100">{stat.total}</span> 行</span>
              {stat.dup > 0 && <span className="text-amber/80">与已有重复 {stat.dup}</span>}
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
