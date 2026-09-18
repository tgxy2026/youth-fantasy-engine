import { useState } from 'react'
import { Database, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from './Button'
import { sourcesOf, summarizeSources } from '../lib/aiDataSources'

interface Props {
  /** `AI_DATA_SOURCES` 里的功能 id */
  feature: string
  /** 紧凑模式：不加分隔线（用于已经嵌在段落中间的场景） */
  compact?: boolean
  className?: string
}

/**
 * 「本次会读」标注：告诉作者**这个 AI 功能会调用项目里的哪些数据**。
 *
 * 默认只显示一行概括（如「项目设定资料（8 项） + 本章正文」），点「看明细」再展开
 * 逐项内容与边界说明（是否按预算裁剪、能不能关、明确不读什么）。
 *
 * 用法：塞进各功能已有的问号气泡里（`HelpPopover` 的 children 是 ReactNode，可直接嵌）：
 *   <HelpPopover title="剧情推演怎么用">
 *      …原有的操作说明…
 *     <AIDataSourceNote feature="tavern-plot" />
 *   </HelpPopover>
 *
 * 🔴 明细区自带 `max-h` + 内部滚动：气泡是「鼠标移出即关」的浮层，
 *    展开若把气泡撑得过高会顶到视口外，用户反而看不到。
 */
export default function AIDataSourceNote({ feature, compact = false, className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const f = sourcesOf(feature)
  if (!f) return null // 未登记的功能不显示，避免文案与实现各说各话

  return (
    <div className={`${compact ? '' : 'mt-2 border-t border-ink-700/70 pt-2'} ${className}`}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Database size={11} className="shrink-0 text-ink-500" />
        <span className="text-ink-400">本次会读：</span>
        <span className="text-ink-200">{summarizeSources(f)}</span>
        <Button variant="bare" type="button" size="xs"
          onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
          className="inline-flex items-center gap-0.5 px-1 py-px rounded text-[10.5px] text-ink-400 hover:text-amber hover:bg-ink-700/60 transition-colors"
          title={open ? '收起明细' : '展开看具体读了哪些内容与边界'}>
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {open ? '收起' : '看明细'}
        </Button>
      </div>

      {open && (
        <div className="mt-1.5 pl-4 max-h-52 overflow-y-auto">
          <ul className="space-y-1.5">
            {f.sources.map(s => (
              <li key={s.group}>
                <div className="text-ink-200">
                  {s.group}
                  {s.note && <span className="text-ink-500">：{s.note}</span>}
                </div>
                {s.items.length > 0 && (
                  <div className="text-ink-500 leading-relaxed">{s.items.join(' / ')}</div>
                )}
              </li>
            ))}
          </ul>
          {f.excludes && f.excludes.length > 0 && (
            <div className="mt-1.5 border-t border-ink-700/60 pt-1.5">
              <div className="text-ink-400">不读：</div>
              <ul className="space-y-0.5">
                {f.excludes.map(x => <li key={x} className="text-ink-500">{x}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
