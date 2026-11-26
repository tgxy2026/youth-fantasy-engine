/**
 * WCP 回流 · 第二部分「变动摘要」面板（3.7.4）。
 *
 * 纯展示：候选比对、勾选、写入均由 `WcpImportModal` 注入。
 * 抽出后回流弹窗回到 600 行以内，避免继续膨胀成难以维护的巨石组件。
 */
import { CheckCircle2, ListChecks, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { isWcpItemSelectable } from '@/lib/wcp/wcpApply'
import { hasWcpCandidates, type WcpParseResult } from '@/lib/wcp/wcpParser'
import type { PostProcessItem, PostProcessStatus } from '@/lib/outline/chapterPostProcess'

export interface WcpCandidateStats {
  selectable: number
  hintOnly: number
  registered: number
}

export interface WcpApplyResultView {
  created: number
  failed: string[]
  warnings?: string[]
}

export interface WcpChangesPanelProps {
  parsed: WcpParseResult
  items: PostProcessItem[] | null
  picked: Set<string>
  building: boolean
  applying: boolean
  stats: WcpCandidateStats | null
  chapterId?: string
  showRawChanges: boolean
  result: WcpApplyResultView | null
  onBuild: () => void
  onApply: () => void
  onToggle: (key: string) => void
}

const STATUS_META: Record<PostProcessStatus, { label: string; cls: string }> = {
  new: { label: '新增', cls: 'border-amber/30 bg-amber/10 text-amber' },
  changed: { label: '可写入', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  registered: { label: '已存在', cls: 'border-ink-700 bg-ink-800/60 text-ink-400' },
  duplicate: { label: '重复', cls: 'border-ink-700 bg-ink-800/60 text-ink-400' },
  unregistered: { label: '需先登记', cls: 'border-danger/30 bg-danger/10 text-danger' },
}

export default function WcpChangesPanel({
  parsed, items, picked, building, applying, stats, chapterId, showRawChanges, result,
  onBuild, onApply, onToggle,
}: WcpChangesPanelProps) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
      <p className="flex flex-wrap items-center gap-2 text-11 text-ink-300">
        <ListChecks size={12} className="text-amber" />
        第二部分 · 变动摘要
        {parsed.format === 'json' && parsed.jsonFailed && <span className="text-amber">（解析失败，仅保留原文）</span>}
      </p>

      {parsed.format === 'markdown' && parsed.markdownCards.length > 0 && (
        <div className="mt-1.5 space-y-2">
          {parsed.markdownCards.map((c, i) => (
            <div key={i}>
              <p className="text-11 font-medium text-ink-300">{c.section}</p>
              <ul className="mt-0.5 space-y-0.5 text-11 text-ink-400">
                {c.items.map((it, j) => <li key={j}>· {it}</li>)}
              </ul>
            </div>
          ))}
          <p className="text-11 text-ink-500">Markdown 清单不含可直接入库的候选；请按上面的卡片人工核对。</p>
        </div>
      )}

      {parsed.format === 'json' && !parsed.jsonFailed && (
        <>
          <p className="mt-1 text-11 text-ink-500">
            候选必须与库内登记现状比对后才能勾选；未登记的伏笔 / 关系 / 物品 / 小传只提示，不会凭空建。
          </p>
          {!chapterId && <p className="mt-1 text-11 text-amber">当前上下文没有章节 id，候选写入不可用。</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onBuild}
              disabled={building || !chapterId || !hasWcpCandidates(parsed.changes)}>
              {building ? <Loader2 size={12} className="animate-spin" /> : <ListChecks size={12} />}
              {items ? '重新比对' : '比对成候选'}
            </Button>
            {items && stats && (
              <span className="text-11 text-ink-500">
                可勾选 {stats.selectable} · 仅提示 {stats.hintOnly} · 已存在 {stats.registered}
              </span>
            )}
          </div>

          {items && (
            <div className="mt-2 max-h-64 overflow-auto space-y-1.5">
              {items.map((item, idx) => {
                const selectable = isWcpItemSelectable(item)
                const st = STATUS_META[item.status]
                return (
                  <label key={`${item.key}::${idx}`} className="flex items-start gap-2 rounded-md border border-ink-700 bg-ink-900/50 px-2.5 py-1.5">
                    <input type="checkbox" className="mt-0.5 shrink-0 accent-amber" disabled={!selectable}
                      checked={selectable && picked.has(item.key)} onChange={() => onToggle(item.key)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-12 text-ink-200">{item.label}</span>
                        <span className={`rounded border px-1 py-0.5 text-10 ${st.cls}`}>{st.label}</span>
                      </span>
                      <span className="block text-11 text-ink-500 leading-relaxed">{item.detail}</span>
                      {item.evidence && <span className="block text-11 text-ink-600">依据：「{item.evidence}」</span>}
                    </span>
                  </label>
                )
              })}
            </div>
          )}

          {items && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" onClick={onApply}
                disabled={applying || !chapterId || picked.size === 0}>
                {applying ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                写入勾选条目
              </Button>
              <span className="text-11 text-ink-500">只追加不覆盖；写入后可在对应页签继续修改。</span>
            </div>
          )}
        </>
      )}

      {showRawChanges && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-ink-700 bg-ink-950/60 p-2.5 text-11 text-ink-300">
          {parsed.rawChanges || '（没有识别到第二部分）'}
        </pre>
      )}

      {result && (
        <div className="mt-2 rounded-md border border-ink-700 bg-ink-900/60 px-2.5 py-2 text-11">
          <p className="flex items-center gap-1.5 text-emerald-300"><CheckCircle2 size={12} /> 已写入 {result.created} 条</p>
          {result.failed.length > 0 && <p className="mt-1 text-danger">失败 {result.failed.length} 条：{result.failed.slice(0, 3).join('、')}{result.failed.length > 3 ? ' 等' : ''}</p>}
          {(result.warnings ?? []).map((w, i) => <p key={i} className="mt-1 text-amber">{w}</p>)}
        </div>
      )}
    </div>
  )
}