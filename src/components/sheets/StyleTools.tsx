/**
 * 3.3.3 · B4：写作规范页的三个工具 —— 导出 / 导入 / **按章反推**。
 *
 * 【为什么独立成组件】FormSheet 已经承担草稿、自动补存、AI 补全三条链路；再塞两个弹窗会
 * 让它越过 1200 行硬上限（`tests/structureGates.test.ts`），也给"取消是否写库"留下歧义。
 * 这里只做三件事，且**一律不直接落库**：
 *   · 导出：从当前草稿生成文件（含空值，未知键不带走）；
 *   · 导入：解析 → 差异预览 → 作者确认后才并入草稿；
 *   · 反推：AI 只产出"这一章实际怎么写"的建议，作者逐条勾选后才并入草稿。
 * 🔴 三条路的落库时机都仍是作者按「保存」（Ctrl+S）；取消 / 关窗 = 零写入。
 */
import { useEffect, useRef, useState } from 'react'
import { FileDown, FileUp, Sparkles, Loader2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Modal } from '@/components/dialogs/Modal'
import { showToast } from '@/components/dialogs/dialogs'
import { getAllChapters } from '@/lib/db'
import { downloadText } from '@/lib/storage/zip'
import { useAIReady } from '@/lib/ai/useAIReady'
import { AI_DISABLED_HINT } from '@/lib/ai/aiScope'
import { aiInferStyle, STYLE_INFER_MATERIAL_LIMIT } from '@/lib/aiTasks/styleInfer'
import type { StyleSuggestion } from '@/lib/aiTasks/styleInfer'
import {
  applyStyleValues, diffStyleValues, exportStyleSheet, parseStyleSheet, styleFieldDefs,
} from '@/lib/forms/styleIO'
import type { StyleDiffItem } from '@/lib/forms/styleIO'
import type { Chapter, TabDef } from '@/lib/types'

interface Props {
  tab: TabDef
  /** 读**当前草稿**（不是已落库值）：作者刚改完就导出/反推，拿到的必须是最新的 */
  readData: () => Record<string, string>
  /** 并入草稿：只改 keys 指定的字段，其余保持当前值；由 FormSheet 置 dirty */
  applyValues: (values: Record<string, string>, keys: readonly string[]) => void
}

interface ImportPreview {
  changed: StyleDiffItem[]
  unchanged: number
  skippedEmpty: number
  unknown: string[]
}

export default function StyleTools({ tab, readData, applyValues }: Props) {
  const { ready: aiReady } = useAIReady()
  const fileRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)

  // ── 反推弹窗状态 ──────────────────────────────────────────────
  const [inferOpen, setInferOpen] = useState(false)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [chapterId, setChapterId] = useState('')
  const [loading, setLoading] = useState(false)
  const [suggestions, setSuggestions] = useState<StyleSuggestion[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const runRef = useRef(0)

  const chapter = chapters.find(c => c.id === chapterId)
  const material = (chapter?.content ?? '').trim()
  const truncated = material.length > STYLE_INFER_MATERIAL_LIMIT

  useEffect(() => {
    if (!inferOpen) return
    let alive = true
    getAllChapters().then(list => {
      if (!alive) return
      const withText = list.filter(c => (c.content ?? '').trim())
      setChapters(list)
      // 默认选**最后一章有正文的**：作者刚写完的那章最贴近当前写法
      setChapterId(withText.length ? withText[withText.length - 1].id : '')
    }).catch(() => { if (alive) setChapters([]) })
    return () => { alive = false }
  }, [inferOpen])

  useEffect(() => () => { abortRef.current?.abort() }, [])

  const resetInfer = () => {
    abortRef.current?.abort()
    abortRef.current = null
    runRef.current++
    setLoading(false); setSuggestions([]); setPicked(new Set()); setError('')
  }

  const openInfer = () => { resetInfer(); setInferOpen(true) }

  const closeInfer = () => {
    if (loading) {
      abortRef.current?.abort()
      abortRef.current = null
      setLoading(false)
    }
    setInferOpen(false)
  }

  const runInfer = async () => {
    if (loading) return
    if (!aiReady) { showToast(AI_DISABLED_HINT, 'info'); return }
    if (!material) { showToast('先选一章有正文的章节', 'info'); return }
    const ac = new AbortController()
    abortRef.current = ac
    const run = ++runRef.current
    setLoading(true); setError(''); setSuggestions([]); setPicked(new Set())
    try {
      const list = await aiInferStyle({
        material: material.slice(0, STYLE_INFER_MATERIAL_LIMIT),
        fields: styleFieldDefs(tab).map(d => ({ key: d.key, label: d.label })),
        signal: ac.signal,
      })
      if (run !== runRef.current) return
      if (list.length === 0) {
        setError('模型没有给出可用建议（可能是这一章特征不明显，或输出没有对上字段）。可以换一章再试。')
        return
      }
      const cur = readData()
      setSuggestions(list)
      // 默认勾选"确实会改动草稿"的条目；与现有值一字不差的默认不选（免得白点）
      setPicked(new Set(list.filter(s => String(cur[s.key] ?? '') !== s.value).map(s => s.key)))
    } catch (e) {
      if (run !== runRef.current) return
      setError(`反推失败：${(e as Error)?.message || '未知原因'}。这次没有改任何内容，可以直接重试。`)
    } finally {
      if (run === runRef.current) { setLoading(false); abortRef.current = null }
    }
  }

  const toggle = (key: string) => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const applyInfer = () => {
    const keys = [...picked]
    if (keys.length === 0) { showToast('还没勾选任何建议', 'info'); return }
    const values: Record<string, string> = {}
    for (const s of suggestions) if (picked.has(s.key)) values[s.key] = s.value
    applyValues(values, keys)
    showToast(`已并入草稿 ${keys.length} 项（记得保存）`, 'success')
    setInferOpen(false)
    resetInfer()
  }

  // ── 导出 ──────────────────────────────────────────────────────
  const doExport = () => {
    const sheet = exportStyleSheet(tab, readData())
    const day = new Date().toISOString().slice(0, 10)
    downloadText(
      `${sheet.tabName}-写作规范-${day}.json`,
      JSON.stringify(sheet, null, 2),
      'application/json',
    )
    showToast('已导出写作规范（含本页全部字段，可用同一页导入回来）', 'success')
  }

  // ── 导入 ──────────────────────────────────────────────────────
  const doImport = async (file: File) => {
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      showToast('这个文件不是合法 JSON，未做任何改动', 'error')
      return
    }
    const parsed = parseStyleSheet(raw, tab)
    if (!parsed.ok) {
      showToast(`${parsed.reason}，未做任何改动`, 'error')
      return
    }
    const d = diffStyleValues(readData(), parsed.values, tab)
    const unknown = [...parsed.unknown, ...parsed.invalid.map(k => `${k}（值不是文本）`)]
    if (d.changed.length === 0) {
      showToast(
        unknown.length
          ? `没有可导入的差异；文件里有 ${unknown.length} 个本页没有的字段，已忽略`
          : '文件内容与本页现有草稿一致，无需导入',
        'info',
      )
      return
    }
    setPreview({ ...d, unknown })
  }

  const mergedPreview = preview
    ? applyStyleValues(readData(), Object.fromEntries(preview.changed.map(c => [c.key, c.to])), preview.changed.map(c => c.key))
    : {}

  return (
    <>
      <Button variant="secondary" onClick={doExport} className="flex items-center gap-1.5 font-medium"
        title="导出本页写作规范为 JSON 文件（含空字段；可再用「导入」回到同一页）">
        <FileDown size={12} /> 导出
      </Button>
      <Button variant="secondary" onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 font-medium"
        title="从导出的 JSON 文件导入；先预览差异，确认后才并入草稿">
        <FileUp size={12} /> 导入
      </Button>
      <Button variant="secondary" onClick={openInfer} className="flex items-center gap-1.5 font-medium"
        title="选一章正文，让 AI 按本页已有字段反推「这一章实际怎么写」；只产建议，逐条勾选后才并入草稿">
        <Sparkles size={12} /> 按章反推
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0]
          e.currentTarget.value = ''
          if (f) void doImport(f)
        }}
      />

      {/* 导入预览：列出"哪几项会变 / 从什么变成什么"，确认后才并入 */}
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title="导入写作规范 · 预览"
        width="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPreview(null)}>取消（不导入）</Button>
            <Button
              onClick={() => {
                if (!preview) return
                applyValues(mergedPreview, preview.changed.map(c => c.key))
                showToast(`已并入草稿 ${preview.changed.length} 项（记得保存）`, 'success')
                setPreview(null)
              }}
            >
              采用这 {preview?.changed.length ?? 0} 项
            </Button>
          </>
        }
      >
        {preview && (
          <div className="space-y-3">
            <p className="text-12 text-ink-300 leading-relaxed">
              只会改动下面列出的字段，其它字段保持当前草稿不变；<b>导入值留空的字段不会被套用</b>（避免误清空）。
              {preview.skippedEmpty > 0 && `本文件有 ${preview.skippedEmpty} 个字段是空的，已跳过。`}
              {preview.unchanged > 0 && ` ${preview.unchanged} 项与现有内容相同。`}
            </p>
            <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-ink-700 divide-y divide-ink-700">
              {preview.changed.map(c => (
                <div key={c.key} className="p-3">
                  <div className="text-12 font-medium text-ink-100">{c.label}
                    <span className="ml-2 text-10 text-ink-500 font-normal">{c.key}</span>
                  </div>
                  <div className="mt-1.5 grid gap-1.5">
                    <div className="text-11 text-ink-400 leading-relaxed">
                      <span className="text-ink-500">现在：</span>{c.from || <span className="text-ink-600">（空）</span>}
                    </div>
                    <div className="text-11 text-amber/90 leading-relaxed whitespace-pre-wrap">
                      <span className="text-ink-500">导入后：</span>{c.to}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {preview.unknown.length > 0 && (
              <p className="text-11 text-ink-400 leading-relaxed rounded-lg border border-ink-700 bg-ink-850 p-3">
                以下字段本页没有，已<b>忽略</b>：{preview.unknown.slice(0, 12).join('、')}
                {preview.unknown.length > 12 ? ` 等 ${preview.unknown.length} 项` : ''}
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* 按章反推：选章 → 一次请求 → 逐条勾选 → 采用选中 */}
      <Modal
        open={inferOpen}
        onClose={closeInfer}
        title="按章反推写作规范"
        width="xl"
        footer={
          <>
            <Button variant="secondary" onClick={closeInfer}>取消（不采用）</Button>
            <Button onClick={applyInfer} disabled={loading || picked.size === 0}>
              采用选中（{picked.size}）
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-12 text-ink-300 leading-relaxed">
            选一章正文，让模型按<b>本页已有的字段</b>反推"这一章实际是怎么写的"。建议只写进预览，
            <b>勾选后才会并入草稿</b>；不点「采用」不会改动任何内容，也不会自动保存。
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={chapterId}
              onChange={e => { setChapterId(e.target.value); setSuggestions([]); setPicked(new Set()); setError('') }}
              className="bg-ink-800 border border-ink-700 rounded-md px-2.5 py-1.5 text-12 text-ink-100 max-w-[22rem]"
            >
              <option value="">选择章节（只列有正文的）</option>
              {chapters.filter(c => (c.content ?? '').trim()).map(c => (
                <option key={c.id} value={c.id}>{c.title || '未命名章节'}</option>
              ))}
            </select>
            <span className="text-11 text-ink-400">
              {material ? `本章 ${material.length} 字${truncated ? `（只送前 ${STYLE_INFER_MATERIAL_LIMIT} 字）` : ''}` : '还没有正文'}
            </span>
            <Button variant="secondary" onClick={() => void runInfer()} disabled={loading || !aiReady || !material}
              title={!aiReady ? AI_DISABLED_HINT : '只发一次请求；不会自动重试、不会换模型'}
              className="flex items-center gap-1.5">
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {loading ? '反推中…' : '开始反推'}
            </Button>
          </div>

          {truncated && (
            <p className="text-11 text-ink-400">正文超过 {STYLE_INFER_MATERIAL_LIMIT} 字，只按前 {STYLE_INFER_MATERIAL_LIMIT} 字分析（节省费用；结论以这部分为准）。</p>
          )}
          {error && (
            <p className="text-11 text-danger leading-relaxed rounded-lg border border-danger/30 bg-danger/5 p-3">{error}</p>
          )}

          {suggestions.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-12 text-ink-200">建议 {suggestions.length} 项</span>
                <div className="flex gap-2">
                  <button className="text-11 text-ink-300 hover:text-ink-100"
                    onClick={() => setPicked(new Set(suggestions.map(s => s.key)))}>全选</button>
                  <button className="text-11 text-ink-300 hover:text-ink-100"
                    onClick={() => setPicked(new Set())}>全不选</button>
                </div>
              </div>
              <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-ink-700 divide-y divide-ink-700">
                {suggestions.map(s => {
                  const cur = readData()[s.key] ?? ''
                  const same = cur === s.value
                  const label = styleFieldDefs(tab).find(d => d.key === s.key)?.label ?? s.key
                  return (
                    <label key={s.key} className="flex gap-3 p-3 cursor-pointer hover:bg-ink-850/60">
                      <input type="checkbox" className="mt-1" checked={picked.has(s.key)} onChange={() => toggle(s.key)} />
                      <div className="min-w-0 flex-1">
                        <div className="text-12 font-medium text-ink-100">{label}
                          <span className="ml-2 text-10 text-ink-500 font-normal">{s.key}</span>
                          {same && <span className="ml-2 text-10 text-ink-500">（与现有相同）</span>}
                        </div>
                        <div className="mt-1 text-11 text-ink-400 leading-relaxed">
                          <span className="text-ink-500">现有：</span>{cur || '（空）'}
                        </div>
                        <div className="text-11 text-amber/90 leading-relaxed whitespace-pre-wrap">
                          <span className="text-ink-500">建议：</span>{s.value}
                        </div>
                        {(s.reason || s.quote) && (
                          <div className="mt-1 text-10 text-ink-500 leading-relaxed">
                            {s.reason}
                            {s.quote && <span className="block mt-0.5">原文：「{s.quote}」</span>}
                          </div>
                        )}
                      </div>
                    </label>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  )
}