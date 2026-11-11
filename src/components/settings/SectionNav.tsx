import { useEffect, useRef, useState } from 'react'
import { Z } from '@/lib/app/zLayer'

/** 长页分节导航的锚点（3.5.1 · A3） */
export type SectionAnchor = { id: string; label: string }

/**
 * 长页吸顶子导航（3.5.1 · A3）。
 *
 * 为什么需要：模型设置这类页面六个板块叠起来 3000px+，滚到中段就不知道自己在第几块、
 * 也回不到上面。顶栏随滚动走后，页内缺少「现在在哪 + 一键跳过去」的定位。
 *
 * 约定：
 * - 锚点目标必须是页面里的 `id`，并带 `scroll-mt-[52px]`（= 本导航高度），否则跳过去会被导航盖住。
 * - 滚动容器取最近的 `main`（项目内内容区）；找不到就不接管滚动，只保留点击跳转。
 * - `prefers-reduced-motion` 时跳转不用平滑滚动。
 */
export default function SectionNav({ sections }: { sections: SectionAnchor[] }) {
  const navRef = useRef<HTMLElement | null>(null)
  const [active, setActive] = useState(sections[0]?.id ?? '')

  useEffect(() => {
    const nav = navRef.current
    const main = nav?.closest('main')
    if (!main) return
    const read = () => {
      // 导航底边往下一小段，避免「标题刚冒头」就抢走高亮
      const line = (nav?.getBoundingClientRect().bottom ?? 52) + 12
      let current = sections[0]?.id ?? ''
      for (const s of sections) {
        const el = document.getElementById(s.id)
        if (!el) continue
        if (el.getBoundingClientRect().top <= line) current = s.id
      }
      setActive(current)
    }
    read()
    main.addEventListener('scroll', read, { passive: true })
    window.addEventListener('resize', read)
    return () => {
      main.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
    }
  }, [sections])

  const jump = (id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  }

  return (
    <nav
      ref={navRef}
      aria-label="本页分节"
      data-section-nav
      className="sticky top-0 mb-5 flex gap-1 overflow-x-auto border-b border-ink-700/60 bg-ink-900/95 py-2 backdrop-blur"
      style={{ zIndex: Z.pageBase }}
    >
      {sections.map(s => {
        const on = active === s.id
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => jump(s.id)}
            aria-current={on ? 'true' : undefined}
            className={`shrink-0 rounded-md px-2.5 py-1 text-11 transition-colors ${on ? 'bg-amber/15 font-medium text-amber' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100'}`}
          >
            {s.label}
          </button>
        )
      })}
    </nav>
  )
}
