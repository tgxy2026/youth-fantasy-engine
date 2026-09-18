import { useEffect, useRef, useState } from 'react'
import AIDataSourceNote from './AIDataSourceNote'
import { Sparkles, Loader2, AlertCircle, BarChart3 } from 'lucide-react'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { aiAnalyzeFeedback, type FeedbackEntry } from '../lib/aiTasks'
import { ToolModal } from './EditorModals'
import { Button } from './Button'

interface Props {
  /** 读者反馈表当前所有行（含未保存草稿） */
  rows: Record<string, string>[]
  onClose: () => void
}

/**
 * 读者反馈 AI 分析弹窗。
 * 把已登记的运营台账（数据 + 吐槽 + 流失点）交给 AI 做编辑视角诊断。
 * 纯增强：未配置模型时按钮禁用，本表手动填写完全不受影响。
 */
export default function FeedbackAIPanel({ rows, onClose }: Props) {
  const { ready: aiReady } = useAIReady()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ summary: string; churnAttribution: string; suggestions: string } | null>(null)

  const entries: FeedbackEntry[] = rows
    .map(r => ({
      period: r['数据周期'] || r['日期'] || '',
      metrics: [r['追读'], r['均订'], r['留存']].filter(Boolean).join(' / '),
      complaints: r['高频吐槽'] || '',
      churnChapter: r['流失点章节'] || '',
      churnReason: r['流失原因分析'] || '',
    }))
    .filter(e => e.metrics || e.complaints || e.churnChapter || e.churnReason)

  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const run = async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const r = await aiAnalyzeFeedback(entries)
      if (mounted.current) setResult(r)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  return (
    <ToolModal title="读者反馈 AI 分析" icon={<BarChart3 size={16} />} onClose={onClose} wide>
      <div className="flex items-center gap-1.5 mb-3">
        <span className="flex-1 text-[11px] text-ink-500">
          把已登记的读者反馈 / 运营数据交给 AI，做流失归因与应对建议分析。未配置模型不影响本表手动填写。
        </span>
      </div>
      <AIDataSourceNote feature="feedback-ai" />

      {entries.length === 0 && !result && (
        <div className="text-[12px] text-ink-400 py-6 text-center">
          还没有可分析的反馈记录——先在表格里登记几行（数据周期 / 追读 / 均订 / 高频吐槽 / 流失点 / 流失原因），再来分析。
        </div>
      )}

      {entries.length > 0 && !result && (
        <Button onClick={run}
          disabled={!aiReady || loading}
          
          title={!aiReady ? AI_DISABLED_HINT : '基于已登记的反馈记录做 AI 分析'} variant="primary" size="md" className="flex items-center text-[13px]">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {loading ? '分析中…' : `开始分析（${entries.length} 条记录）`}
        </Button>
      )}

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[12px] text-red-300 mt-3">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="space-y-4 mt-2">
          <Section title="① 总体诊断" body={result.summary} />
          <Section title="② 流失归因" body={result.churnAttribution} />
          <Section title="③ 应对建议" body={result.suggestions} />
          <Button variant="bare"
            onClick={() => setResult(null)}
            className="px-3 py-2 bg-ink-700 text-ink-200 border border-ink-600 rounded-lg text-[12px] hover:bg-ink-600"
          >
            重新分析
          </Button>
        </div>
      )}
    </ToolModal>
  )
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="text-[12px] font-semibold text-amber mb-1">{title}</div>
      <div className="text-[12.5px] text-ink-200 leading-relaxed whitespace-pre-wrap break-words bg-ink-900/40 border border-ink-800 rounded-lg px-3 py-2">
        {body}
      </div>
    </div>
  )
}
