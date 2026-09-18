/**
 * 「一键拆书」页签面板。
 *
 * 三步：① 贴/导入原文 → ② 开始抽取（可中止）→ ③ 审阅草稿并勾选写入。
 * 拆书本身**不写库**；写入动作全部发生在审阅面板的「写入项目」按钮上。
 */
import { useEffect, useRef, useState } from 'react'
import { FileUp, Loader2, Play, X } from 'lucide-react'
import AIDataSourceNote from './AIDataSourceNote'
import { Button } from './Button'
import DraftReviewPanel from './DraftReviewPanel'
import HelpPopover from './HelpPopover'
import { showToast } from './dialogs'
import { estimateCalls, previewSplit, runBookBreak } from '../lib/bookbreak/run'
import type { SplitResult } from '../lib/bookbreak/split'
import type { DraftBundle, FlowProgress, StageStatus } from '../lib/flow/types'

const MAX_FILE_BYTES = 20 * 1024 * 1024

const STAGE_MARK: Record<StageStatus, string> = {
  pending: '○',
  running: '◐',
  done: '●',
  skipped: '－',
  failed: '✕',
  cancelled: '×',
}
const STAGE_CLS: Record<StageStatus, string> = {
  pending: 'text-ink-600',
  running: 'text-amber',
  done: 'text-emerald-400',
  skipped: 'text-ink-600',
  failed: 'text-red-400',
  cancelled: 'text-ink-600',
}

export default function BookBreakPanel() {
  const [raw, setRaw] = useState('')
  const [preview, setPreview] = useState<SplitResult | null>(null)
  const [progress, setProgress] = useState<FlowProgress | null>(null)
  const [bundle, setBundle] = useState<DraftBundle | null>(null)
  const [running, setRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // 切分预览防抖：粘贴几十万字时不能每敲一个键就跑一次全文正则
  useEffect(() => {
    const t = setTimeout(() => {
      setPreview(raw.trim().length >= 100 ? previewSplit(raw) : null)
    }, 350)
    return () => clearTimeout(t)
  }, [raw])

  const onFile = async (f: File) => {
    if (f.size > MAX_FILE_BYTES) { showToast('文件超过 20MB，请先拆成若干份再导入', 'error'); return }
    try {
      const text = await f.text()
      setRaw(text)
      showToast(`已导入 ${f.name}（${text.length.toLocaleString()} 字）`, 'success')
    } catch {
      showToast('读取文件失败', 'error')
    }
  }

  const start = async () => {
    if (!raw.trim()) { showToast('请先粘贴或导入原文', 'info'); return }
    const ctl = new AbortController()
    abortRef.current = ctl
    setRunning(true)
    setBundle(null)
    setProgress(null)
    try {
      const res = await runBookBreak(raw, { signal: ctl.signal, onProgress: setProgress })
      if (!res) { showToast('已中止，未写入任何数据', 'info'); return }
      setBundle(res.bundle)
      showToast(
        res.bundle.stats.total > 0
          ? `抽到 ${res.bundle.stats.total} 条草稿，请审阅后写入`
          : '这一轮没有抽到可登记的实体',
        res.bundle.stats.total > 0 ? 'success' : 'info',
      )
    } catch (e) {
      showToast('拆书失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-[15px] font-medium text-ink-100">一键拆书</h1>
        <HelpPopover title="一键拆书怎么用" pin>
          <div className="space-y-1.5 text-[11.5px] leading-relaxed text-ink-300">
            <p>粘贴或导入一整本小说原文，AI 会逐章抽出其中的<b>人物 / 势力 / 地点 / 种族 / 物品 / 术语</b>，整理成草稿供你勾选。</p>
            <p>抽出的每条都带<b>原文引用</b>与<b>置信度</b>，并会与项目里已有的设定比对：已登记过的标为「疑似已有」、默认不勾选。</p>
            <p>草稿只在你点「写入项目」之后才落库；<b>已有同名条目默认分毫不动</b>。</p>
            <p className="text-ink-500">流程：切分 → 逐块抽取 → 整理草稿 → 你审阅 → 写入。建议先用 5~10 万字试跑一轮，确认质量后再上整本。</p>
            <AIDataSourceNote feature="bookbreak" compact />
          </div>
        </HelpPopover>
      </div>

      {/* ① 原文 */}
      <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink-100">① 原文</span>
          <span className="text-[11px] text-ink-500">{raw.length.toLocaleString()} 字</span>
          <div className="flex-1" />
          <Button size="xs" variant="secondary" disabled={running} onClick={() => fileRef.current?.click()}>
            <FileUp size={12} /> 导入 .txt
          </Button>
          <Button size="xs" variant="ghost" disabled={running || !raw}
            onClick={() => { setRaw(''); setBundle(null); setPreview(null); setProgress(null) }}>
            <X size={12} /> 清空
          </Button>
        </div>
        <input
          ref={fileRef} type="file" accept=".txt,.md,text/plain" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = '' }}
        />
        <textarea
          value={raw}
          onChange={e => setRaw(e.target.value)}
          disabled={running}
          spellCheck={false}
          placeholder="把小说原文粘贴到这里（支持整本），或点右上角「导入 .txt」。"
          className="mt-2 h-56 w-full resize-y rounded border border-ink-700 bg-ink-900 px-3 py-2 text-[12px] leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
        />
      </section>

      {/* 切分预览 */}
      {preview && (
        <div className="mt-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2 text-[11.5px] leading-relaxed text-ink-300">
          识别为 <b className="text-ink-100">{preview.chapters.length}</b>
          {preview.mode === 'chapters' ? ' 章' : ' 块（未识别到章节标题，已按段落分块）'}
          ，共 {preview.stats.chars.toLocaleString()} 字 ≈ {preview.stats.estTokens.toLocaleString()} 词元
          ，预计 <b className="text-ink-100">{estimateCalls(preview)}</b> 次模型调用。
          {preview.stats.truncated && (
            <span className="text-amber"> ⚠️ 超出处理上限，本轮只处理前 {preview.chapters.length} {preview.mode === 'chapters' ? '章' : '块'}。</span>
          )}
        </div>
      )}

      {/* ② 运行 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" solid disabled={running || !raw.trim()} onClick={() => void start()}>
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {running ? '抽取中…' : '② 开始抽取'}
        </Button>
        {running && (
          <Button size="sm" variant="danger" onClick={() => abortRef.current?.abort()}>中止</Button>
        )}
        {running && <span className="text-[11px] text-ink-400">{progress?.message ?? ''}</span>}
      </div>

      {/* 进度 */}
      {progress && running && (
        <div className="mt-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
              <div className="h-full bg-amber transition-all" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
            </div>
            <span className="text-[10.5px] tabular-nums text-ink-400">{Math.round(progress.ratio * 100)}%</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {progress.stages.map(s => (
              <span key={s.id} className={`text-[10.5px] ${STAGE_CLS[s.status]}`}>
                {STAGE_MARK[s.status]} {s.label}
                {s.status === 'running' && s.detail && <span className="text-ink-500"> · {s.detail}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ③ 审阅 */}
      {bundle && (
        <div className="mt-5">
          <div className="mb-2 text-[13px] text-ink-100">③ 审阅草稿</div>
          <DraftReviewPanel bundle={bundle} />
        </div>
      )}
    </div>
  )
}
