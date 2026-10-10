/**
 * 正文前后对照（2.8.0 · 台账 #016）—— `lib/textDiff` 的**薄渲染层**。
 *
 * 【配色口径】新增 = 绿、删除 = 红 —— 这是**编辑器 / diff 工具的通用约定**，与 A 股「涨红跌绿」无关。
 * 本项目在别处（行情类）用的是涨红跌绿，所以这里**必须在界面上写明**，否则作者会第一眼读反。
 * （2026-10-04 主人拍板：**就按这个通用口径**落地 —— 方案第 8 节第 1 项至此定稿，
 *  不再是"暂按 / 可一句话改"的待定状态。）
 *
 * 🔴 大改动不卡界面：`diffLines` 内部已有「剪公共前后缀 + DP 超限退化为整段替换」的保护，
 *    这里再叠一层**折叠未改动段**（连续 same 行只留改动附近 context 行），
 *    否则整章 3000 行里只有 2 行不同时，作者得滚 3000 行才看得到那 2 行。
 */
import { useMemo, useState } from 'react'
import { diffLines, diffStats, type DiffLine } from '@/lib/textDiff'
import { foldVh } from '@/lib/theme'
import { Button } from '@/components/Button'

type Row = { kind: 'line'; line: DiffLine } | { kind: 'gap'; count: number }

/** 找出「要显示的行」＝所有改动行 + 各自前后 context 行；其余连续 same 折叠成一条 gap */
function collapse(lines: DiffLine[], context: number): Row[] {
  const show = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === 'same') continue
    for (let d = -context; d <= context; d++) {
      const j = i + d
      if (j >= 0 && j < lines.length) show.add(j)
    }
  }
  // 通篇没改动（两版一致）⇒ 给开头几行，免得整块空白让人以为坏了
  if (!show.size) for (let i = 0; i < Math.min(lines.length, context * 2 + 1); i++) show.add(i)

  const out: Row[] = []
  let gap = 0
  for (let i = 0; i < lines.length; i++) {
    if (show.has(i)) {
      if (gap > 0) { out.push({ kind: 'gap', count: gap }); gap = 0 }
      out.push({ kind: 'line', line: lines[i] })
    } else gap++
  }
  if (gap > 0) out.push({ kind: 'gap', count: gap })
  return out
}

const LINE_CLS: Record<DiffLine['kind'], string> = {
  add: 'bg-success/10 border-l-2 border-success/50',
  del: 'bg-danger/10 border-l-2 border-danger/50',
  same: 'border-l-2 border-transparent',
}
/** 行首标记：与配色同源（+ 绿 / − 红） */
const MARK: Record<DiffLine['kind'], string> = { add: '+', del: '−', same: ' ' }
const MARK_CLS: Record<DiffLine['kind'], string> = {
  add: 'text-success', del: 'text-danger', same: 'text-ink-600',
}

interface Props {
  /** 旧版正文 */
  before: string
  /** 新版正文 */
  after: string
  /** 折叠时每处改动保留的上下文行数（默认 3） */
  context?: number
  /** 列表最大高度（默认 60vh） */
  maxHeight?: string
}

export default function DiffView({ before, after, context = 3, maxHeight = '60vh' }: Props) {
  const [showAll, setShowAll] = useState(false)
  const lines = useMemo(() => diffLines(before, after), [before, after])
  const stats = useMemo(() => diffStats(lines), [lines])
  // 「展开全文」时把上下文放到极大 ⇒ collapse 退化为「全显示」
  const rows = useMemo(() => collapse(lines, showAll ? lines.length : context), [lines, context, showAll])

  return (
    <div>
      {/* 统计 + 配色说明 */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-11">
        <span className="text-success">新增 {stats.added} 行</span>
        <span className="text-danger">删除 {stats.deleted} 行</span>
        <span className="text-ink-400">改动约 {stats.changed} 行</span>
        <span className="text-10 text-ink-500">
          （配色为 diff 通用口径：新增＝绿、删除＝红，与行情涨跌红绿无关）
        </span>
        <Button variant="secondary" size="xs" className="ml-auto"
          onClick={() => setShowAll(v => !v)}
          title={showAll ? '只显示改动附近的段落' : '展开整章（未改动的段落也会列出）'}>
          {showAll ? '只看改动' : '展开全文'}
        </Button>
      </div>

      <div className="rounded-lg border border-ink-700 bg-ink-950/60 overflow-auto font-mono text-11 leading-relaxed"
        style={{ maxHeight: foldVh(maxHeight) }}>
        {rows.map((r, i) => r.kind === 'gap' ? (
          <div key={`gap-${i}`} className="px-3 py-1 text-center text-10 text-ink-600 bg-ink-900/60 select-none">
            ⋯ 未改动 {r.count} 行 ⋯
          </div>
        ) : (
          <div key={`l-${i}`} className={`flex items-start gap-2 px-3 py-0.5 ${LINE_CLS[r.line.kind]}`}>
            <span className={`shrink-0 select-none ${MARK_CLS[r.line.kind]}`}>{MARK[r.line.kind]}</span>
            <span className={`min-w-0 whitespace-pre-wrap break-words ${
              r.line.kind === 'del' ? 'text-ink-400' : 'text-ink-200'
            }`}>{r.line.text || ' '}</span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-3 py-4 text-center text-11 text-ink-500">两版内容一致，没有差异。</div>
        )}
      </div>
    </div>
  )
}
