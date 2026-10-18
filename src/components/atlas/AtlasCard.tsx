/**
 * 图鉴卡片（3.1.3 · 骨架版）。
 *
 * 依据：方案 §3.2「卡片及详情」——主图／占位、名称（最多两行）、类别等徽标、
 * 最多 3 项摘要（每项两行，全文进详情）。
 *
 * 🔴 图片存 `TableRow.atlasImage`（顶层字段），上传与压缩在 `lib/atlas/image.ts`；
 *    卡片只负责显示 —— 有图按 4:3 等比完整显示（不裁切），无图收成一条窄占位。
 */
import { ImageOff } from 'lucide-react'
import type { TableRow } from '@/lib/types'
import { atlasDisplayValue } from '@/lib/atlas/schema'
import type { AtlasImage, ResolvedAtlasField } from '@/lib/atlas/types'

interface Props {
  row: TableRow
  /** 名称列（`tab.displayCol`，默认「名称」）—— 存储键，不是显示名 */
  nameKey: string
  /** 卡片徽标（类别 / 品级 / 威胁等级），已过滤空值 */
  badges: string[]
  /** 摘要字段（≤3，已按作者配置／默认表选好） */
  summaryFields: readonly ResolvedAtlasField[]
  /** 主图（`TableRow.atlasImage`）；没有则显示占位 */
  image?: AtlasImage | null
  /** 密度（方案 §3.1 必交付项）：紧凑 / 标准 / 宽松 */
  density?: 'compact' | 'standard' | 'loose'
  selected: boolean
  onOpen: () => void
}

/** 密度 → 图片占位高度 / 内边距 / 字号（三档差异只在这几处，别在别处再判断一次） */
const DENSITY = {
  compact: { img: 'h-14', pad: 'p-2', name: 'text-12', gap: 'mt-1' },
  standard: { img: 'h-20', pad: 'p-3', name: 'text-13', gap: 'mt-1.5' },
  loose: { img: 'h-28', pad: 'p-4', name: 'text-14', gap: 'mt-2' },
} as const

export default function AtlasCard({ row, nameKey, badges, summaryFields, image, density = 'standard', selected, onOpen }: Props) {
  const d = DENSITY[density]
  const name = (row.data[nameKey] ?? '').trim() || '未命名条目'
  // 🔴 逐行过滤：这一行填了哪几个摘要字段就显示哪几个（不同条目条数本就不同）
  const summary = summaryFields
    .map(f => ({ key: f.key, label: f.label, value: atlasDisplayValue(f, row.data[f.key]) }))
    .filter(s => s.value.length > 0)

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className={`h-full flex flex-col text-left rounded-xl border overflow-hidden transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/60 ${
        selected
          ? 'border-amber ring-1 ring-amber/40 bg-amber/10'
          : 'border-ink-700 bg-ink-850 hover:border-ink-600 hover:bg-ink-800'
      }`}
    >
      {/* 图片区：方案要求「卡片统一图片区域」——有图无图都是 4:3，同一排卡片才对得齐；
          图本身 object-contain（等比完整显示、不裁切），无图只放一个淡图标 */}
      <div className="relative bg-ink-900/70 border-b border-ink-700/60" style={{ aspectRatio: '4 / 3' }}>
        {image ? (
          <img
            src={image.dataUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 w-full h-full object-contain"
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center"
            title="还没有主图：点开这张卡片，在详情里可以上传"
          >
            <ImageOff size={18} className="text-ink-700" />
          </div>
        )}
      </div>

      {/* flex-1：同一排卡片等高（摘要条数不同的卡片不会被拉得参差不齐） */}
      <div className={`${d.pad} flex-1`}>
        <div className={`${d.name} font-semibold text-ink-50 leading-snug line-clamp-2`} title={name}>
          {name}
        </div>
        {badges.length > 0 && (
          <div className={`${d.gap} flex flex-wrap gap-1`}>
            {badges.map(b => (
              <span
                key={b}
                className="text-10 px-1.5 py-0.5 rounded bg-ink-800 border border-ink-700 text-ink-300"
              >
                {b}
              </span>
            ))}
          </div>
        )}
        {summary.length > 0 && (
          <dl className="mt-2 space-y-1">
            {summary.map(s => (
              <div key={s.key} className="text-11 leading-snug">
                <dt className="text-ink-500">{s.label}</dt>
                <dd className="text-ink-300 line-clamp-2" title={s.value}>{s.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </button>
  )
}
