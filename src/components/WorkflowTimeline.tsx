/**
 * 工作流节点时间线（可复用）。
 *
 * 需求背景（老大 2026-09-18）：「点击开始抽取之后，整个工作流程怎么显示？
 * 我最初的设想是有一个流程图显示当前任务的节点，或者说一个进度条显示任务进度。」
 * 原来只做成了**一行平铺的阶段符号**，且**跑完就消失** —— 事后看不到每一步做了什么、
 * 花了多久、产出多少，也没法核对。
 *
 * 这里升级为**竖向节点时间线**：
 * - 每个阶段一个节点（圆点 + 连接线），能一眼看出先后关系
 * - 进行中：转圈 + 实时明细（如「已写入 12/60 章」「第 3/6 章：塔灵」）
 * - 完成后：**保留**节点，显示该阶段产物摘要与耗时
 * - 失败/跳过/已取消都有对应形态，不再只有"没了"
 *
 * 数据全部来自 `FlowProgress.stages`（`status/ratio/detail/startedAt/endedAt`），无需额外埋点。
 * 拆书与创意写作共用；后续新增流程只要走 `lib/flow` 就能直接复用。
 */
import { CheckCircle2, Circle, CircleDashed, Loader2, MinusCircle, XCircle } from 'lucide-react'
import { Z } from '@/lib/zLayer'
import type { FlowProgress, StageStatus } from '@/lib/flow/types'

const NODE: Record<StageStatus, { icon: typeof Circle; cls: string }> = {
  pending: { icon: Circle, cls: 'text-ink-600' },
  running: { icon: Loader2, cls: 'text-amber' },
  done: { icon: CheckCircle2, cls: 'text-success' },
  skipped: { icon: MinusCircle, cls: 'text-ink-500' },
  failed: { icon: XCircle, cls: 'text-danger' },
  cancelled: { icon: CircleDashed, cls: 'text-ink-500' },
}

const STATUS_TEXT: Record<StageStatus, string> = {
  pending: '待处理',
  running: '进行中',
  done: '已完成',
  skipped: '已跳过',
  failed: '失败',
  cancelled: '已中止',
}

const STATUS_TEXT_CLS: Record<StageStatus, string> = {
  pending: 'text-ink-600',
  running: 'text-amber',
  done: 'text-success',
  skipped: 'text-ink-500',
  failed: 'text-danger',
  cancelled: 'text-ink-500',
}

/** 阶段耗时（毫秒 → 人话）；进行中或没有时间戳时返回空串 */
function durationOf(s: { status: StageStatus; startedAt?: number; endedAt?: number }): string {
  if (!s.startedAt || !s.endedAt) return ''
  const ms = s.endedAt - s.startedAt
  if (ms < 1000) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} 秒`
  const m = Math.floor(sec / 60)
  const r = sec % 60
  return r ? `${m} 分 ${r} 秒` : `${m} 分`
}

const FLOW_STATUS_TEXT = {
  idle: '未开始',
  running: '进行中',
  done: '已完成',
  cancelled: '已中止',
  error: '出错',
} as const

interface Props {
  progress: FlowProgress | null
  /** 是否正在运行（决定顶部文案与转圈） */
  running: boolean
  /**
   * 各阶段**产物摘要**（完成后显示），键＝阶段 id。
   * 例：`{ split: '识别到 6 章 / 29,163 字', persist: '写入 1 卷 6 章' }`
   * 这些是阶段内部才知道的信息（detail 在下一阶段开始时就被覆盖了），故由调用方提供。
   */
  summaries?: Record<string, string>
  className?: string
}

export default function WorkflowTimeline({ progress, running, summaries = {}, className = '' }: Props) {
  if (!progress) return null
  const stages = progress.stages
  const pct = Math.round(progress.ratio * 100)

  return (
    <div className={`rounded border border-ink-700 bg-ink-900/40 px-3 py-2.5 ${className}`}>
      {/* 顶部：总进度条 + 当前说明 */}
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
          <div
            className={`h-full transition-all ${progress.status === 'error' ? 'bg-red-400' : progress.status === 'cancelled' ? 'bg-ink-500' : 'bg-amber'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-10 tabular-nums text-ink-400">{pct}%</span>
        <span className={`text-10 ${running ? 'text-amber' : 'text-ink-400'}`}>
          {running ? '进行中' : FLOW_STATUS_TEXT[progress.status]}
        </span>
      </div>
      {running && progress.message && (
        <div className="mt-1 truncate text-11 text-ink-300">{progress.message}</div>
      )}

      {/* 节点时间线 */}
      <ul className="mt-2.5">
        {stages.map((s, i) => {
          const n = NODE[s.status]
          const Icon = n.icon
          const dur = durationOf(s)
          const summary = summaries[s.id] ?? ''
          const isLast = i === stages.length - 1
          // 明细：进行中显示实时 detail；完成后优先显示产物摘要
          const line = s.status === 'running' ? (s.detail || '') : (summary || s.detail || '')
          return (
            <li key={s.id} className="relative flex gap-2 pb-2 last:pb-0">
              {/* 连接线（最后一个节点不画） */}
              {!isLast && <span className="absolute left-[7px] top-4 h-full w-px bg-ink-700" aria-hidden />}
              <span className="relative mt-[2px] shrink-0" style={{ zIndex: Z.pageHandle }}>
                <Icon size={15} className={`${n.cls} ${s.status === 'running' ? 'animate-spin' : ''}`} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className={`text-11 ${s.status === 'pending' ? 'text-ink-500' : 'text-ink-200'}`}>{s.label}</span>
                  <span className={`text-10 ${STATUS_TEXT_CLS[s.status]}`}>{STATUS_TEXT[s.status]}</span>
                  {dur && <span className="text-10 tabular-nums text-ink-500">{dur}</span>}
                </span>
                {line && (
                  <span className="mt-0.5 block text-10 leading-relaxed text-ink-400">
                    {line}
                    {s.status === 'running' && !s.detail && '…'}
                  </span>
                )}
                {s.error && <span className="mt-0.5 block text-10 text-danger">{s.error}</span>}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
