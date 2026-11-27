import type { CSSProperties } from 'react'
import { normalizeGenrePack, type GenrePack } from '@/lib/schemaTemplates'

/**
 * 没有上传封面时的**自动字封**（3.5.1 · A1）。
 *
 * 为什么不做 AI 绘图 / 内置图片：纸张、字体、留白就能撑起「这是我的书」的观感，
 * 且零下载、零网络、九套主题自动跟随（只用 ink/amber 令牌 + 一点低透明度色晕）。
 *
 * 🔴 题材色只做**低透明度氛围**（径向色晕 + 内框），文字与小字仍走 ink/amber ——
 *    若拿题材色直接画文字，暗夜 / 青花等主题下的对比度会失控（全站只有 ink/amber 有对比度测试）。
 * 🔴 竖排长书名会从封面底边溢出：按字数**降字号 + 截断**（完整书名在卡片标题与 aria-label 里）。
 */

/** 十个题材的色相（只用于色晕，不参与文字对比度） */
const GENRE_HUE: Record<GenrePack, number> = {
  东方修真: 38,   // 金
  西方奇幻: 268,  // 紫罗兰
  都市异能: 196,  // 青蓝
  都市现实: 158,  // 青绿
  历史古代: 24,   // 赭石
  科幻末世: 212,  // 钢青
  武侠江湖: 8,    // 赤
  悬疑灵异: 285,  // 幽紫
  游戏竞技: 122,  // 荧绿
  女频言情: 332,  // 玫红
}

/** 竖排空间约 150px（sm）/ 240px（lg）：超过这个字数就降字号，再多就截断 */
function coverTitle(name: string, size: 'xs' | 'sm' | 'lg'): { text: string; size: number } {
  const chars = [...name.trim()]
  if (size === 'xs') {
    return { text: chars[0] || '书', size: 13 }
  }
  if (size === 'lg') {
    if (chars.length <= 4) return { text: name, size: 28 }
    if (chars.length <= 7) return { text: name, size: 24 }
    if (chars.length <= 10) return { text: name, size: 20 }
    if (chars.length <= 12) return { text: name, size: 17 }
    return { text: chars.slice(0, 11).join('') + '…', size: 16 }
  }
  if (chars.length <= 4) return { text: name, size: 17 }
  if (chars.length <= 7) return { text: name, size: 15 }
  if (chars.length <= 10) return { text: name, size: 13 }
  if (chars.length <= 12) return { text: name, size: 11 }
  return { text: chars.slice(0, 11).join('') + '…', size: 11 }
}

export default function ProjectAutoCover({
  name, genre, size = 'sm', className = '',
}: {
  name: string
  genre?: string
  size?: 'xs' | 'sm' | 'lg'
  className?: string
}) {
  const pack = normalizeGenrePack(genre)
  const title = coverTitle(name || '未命名', size)
  const hue = GENRE_HUE[pack] ?? GENRE_HUE['东方修真']

  if (size === 'xs') {
    return (
      <div
        role="img"
        aria-label={`《${name}》自动生成封面（题材：${pack}）`}
        data-auto-cover={pack}
        className={`relative overflow-hidden rounded-r-md rounded-l-[3px] border border-ink-700/80 bg-ink-900 shrink-0 flex items-center justify-center ${className}`}
        style={{ '--cover-hue': String(hue) } as CSSProperties}
      >
        <div
          aria-hidden
          className="absolute inset-0"
          style={{ background: 'radial-gradient(125% 90% at 80% 8%, hsl(var(--cover-hue) 46% 58% / 0.24), transparent 65%)' }}
        />
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 w-[5px] bg-gradient-to-r from-ink-950/35 via-ink-50/10 to-transparent"
        />
        <div aria-hidden className="absolute inset-[2px] rounded-[2px] border border-amber/20" />
        <span aria-hidden className="relative font-serif font-bold text-ink-100 leading-none select-none" style={{ fontSize: title.size }}>
          {title.text}
        </span>
      </div>
    )
  }

  const isLg = size === 'lg'

  // 🔴 sm 下 aspect-[2/3] 不可省：卡片窄屏换行后封面独占一行、没有可拉伸的行高，
  //    而内部全是绝对定位（无固有高度）⇒ 没有它高度会塌成 0，竖排书名溢出到卡片标题上。
  return (
    <div
      role="img"
      aria-label={`《${name}》自动生成封面（题材：${pack}）`}
      data-auto-cover={pack}
      className={`relative overflow-hidden border border-ink-600 bg-ink-900 shrink-0 ${
        isLg ? 'rounded-r-xl rounded-l-[5px]' : 'rounded-md self-stretch aspect-[2/3]'
      } ${className}`}
      style={{ '--cover-hue': String(hue) } as CSSProperties}
    >
      {/* 题材色晕：只铺右上角，避免整块变成彩色卡片 */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: 'radial-gradient(130% 85% at 82% 4%, hsl(var(--cover-hue) 46% 58% / 0.22), transparent 64%)' }}
      />
      {/* 左侧书脊压痕与高光层 */}
      <div
        aria-hidden
        className={`absolute inset-y-0 left-0 ${isLg ? 'w-3.5' : 'w-2'} bg-gradient-to-r from-ink-950/35 via-ink-50/10 to-transparent pointer-events-none`}
      />
      {isLg && (
        <div
          aria-hidden
          className="absolute inset-y-0 left-3.5 w-px bg-ink-700/45 pointer-events-none"
        />
      )}
      {/* 书封内框（双线感的细边） */}
      <div aria-hidden className={`absolute ${isLg ? 'inset-[10px] rounded-[4px] border border-amber/25' : 'inset-[5px] rounded-[3px] border border-amber/25'}`} />
      {isLg && (
        <div aria-hidden className="absolute inset-[14px] rounded-[2px] border border-amber/12" />
      )}

      <div aria-hidden className={`absolute inset-x-0 flex justify-center ${isLg ? 'top-6 bottom-12 items-center' : 'top-2.5 bottom-7'}`}>
        <span
          className="font-serif font-semibold leading-none tracking-[0.16em] text-ink-50"
          style={{ writingMode: 'vertical-rl', fontSize: title.size }}
        >
          {title.text}
        </span>
      </div>

      <div aria-hidden className={`absolute inset-x-0 flex flex-col items-center ${isLg ? 'bottom-4 gap-1.5' : 'bottom-2 gap-1'}`}>
        <span className={`h-px bg-amber/40 ${isLg ? 'w-10' : 'w-6'}`} />
        <span className={isLg ? 'text-11 tracking-[0.18em] text-amber/85' : 'text-9 tracking-[0.12em] text-amber/85'}>{pack}</span>
      </div>
    </div>
  )
}
