import { useEffect, useRef, useState } from 'react'
import AIDataSourceNote from './AIDataSourceNote'
import { Sparkles, Loader2, AlertCircle, Layers } from 'lucide-react'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { aiDedupTerms } from '../lib/aiTasks'
import { ToolModal } from './EditorModals'
import { Button } from './Button'


interface Props {
  /** 名词术语当前所有行（含未保存草稿） */
  rows: Record<string, string>[]
  onClose: () => void
}

/**
 * 名词术语 AI 查重弹窗。
 * 扫描术语表，找出同义 / 重复的概念并建议合并归一，避免"同一事物两个名字"的前后矛盾。
 * 纯增强：未配置模型时按钮禁用，本表手动录入完全不受影响。
 */
export default function TermDedupPanel({ rows, onClose }: Props) {
  const { ready: aiReady } = useAIReady()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [groups, setGroups] = useState<{ terms: string[]; reason: string; suggestion: string }[]>([])
  const [done, setDone] = useState(false)

  const terms = rows
    .map(r => ({ term: r['名称'] || '', category: r['类别'] || '', definition: r['定义（一句话）'] || '' }))
    .filter(t => t.term)

  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const run = async () => {
    setLoading(true)
    setError(null)
    setDone(false)
    try {
      const r = await aiDedupTerms(terms)
      if (mounted.current) {
        setGroups(r.groups)
        setDone(true)
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  return (
    <ToolModal title="名词术语 AI 查重" icon={<Layers size={16} />} onClose={onClose} wide>
      <div className="flex items-center gap-1.5 mb-3">
        <span className="flex-1 text-[11px] text-ink-500">
          让 AI 扫描术语表，找出同义 / 重复的概念并建议合并归一，避免"同一事物两个名字"的前后矛盾。未配置模型不影响手动录入。
        </span>
      </div>
      <AIDataSourceNote feature="term-dedup" />

      {terms.length === 0 && !done && (
        <div className="text-[12px] text-ink-400 py-6 text-center">术语表还是空的，先登记一些术语再来查重。</div>
      )}

      {terms.length > 0 && !done && (
        <Button onClick={run}
          disabled={!aiReady || loading}
          
          title={!aiReady ? AI_DISABLED_HINT : '基于已登记的术语做 AI 查重'} variant="primary" size="md" className="flex items-center text-[13px]">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {loading ? '查重中…' : `开始查重（${terms.length} 个术语）`}
        </Button>
      )}

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[12px] text-red-300 mt-3">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {done && (
        groups.length === 0 ? (
          <div className="text-[12px] text-emerald-400 py-6 text-center">未发现明显重复 / 同义的术语 ✓</div>
        ) : (
          <div className="space-y-3 mt-2">
            <div className="text-[12px] text-ink-400">AI 找到 {groups.length} 组可能重复 / 同义的术语：</div>
            {groups.map((g, i) => (
              <div key={i} className="rounded-lg border border-amber/25 bg-amber/5 p-3">
                <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                  {g.terms.map((t, j) => (
                    <span key={j} className="px-2 py-0.5 rounded bg-ink-800 text-ink-100 text-[12px] border border-ink-700">
                      {t}
                    </span>
                  ))}
                </div>
                <div className="text-[11.5px] text-ink-400 mb-1">
                  <span className="text-ink-500">为什么重复：</span>{g.reason || '—'}
                </div>
                <div className="text-[11.5px] text-amber/80">
                  <span className="text-ink-500">建议统一为：</span>{g.suggestion || '—'}
                </div>
              </div>
            ))}
            <Button variant="bare"
              onClick={() => setDone(false)}
              className="px-3 py-2 bg-ink-700 text-ink-200 border border-ink-600 rounded-lg text-[12px] hover:bg-ink-600"
            >
              重新查重
            </Button>
          </div>
        )
      )}
    </ToolModal>
  )
}
