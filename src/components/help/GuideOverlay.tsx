// ============ 页签聚焦引导层（3.3.1 · P2） ============
//
// 规划 §3.4：淡化背景 + 描边高亮 + 说明卡片；**讲解模式**只允许操作卡片，
// 背景点击不能误触真实删除/生成/写入；Tab 可遍历、Esc 等同跳过、步骤变化读屏可感知；
// 结束后焦点回到原处；小窗口降级为底部卡片并保持退出可达。
//
// 🔴 层级：`Z.modal - 100` —— 引导必须**低于**模态。保存失败提示、确认对话框、既有弹窗优先，
//    它们一出现就盖在我们上面（规划 §3.4：保存失败、确认对话框和既有模态窗口优先）。
// 🔴 几何：只用 `getBoundingClientRect()` 的原样视口坐标，**不再乘缩放的百分比**
//    （应用缩放已经反映在布局里，重复乘会错位）。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, X } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Z } from '@/lib/app/zLayer'
import { guideArticle, type PageGuide } from '@/lib/help/guides'
import { requestHelpArticle } from '@/lib/help/helpNav'
import { computeGuideLayout, guideMasks, type GuidePoint } from '@/lib/help/guideLayout'

const GUIDE_Z = Z.modal - 100

export type GuideCloseReason = 'done' | 'skip' | 'interrupt'

interface Props {
  guide: PageGuide
  /** 从第几步开始（重看时用 0） */
  startStep?: number
  onClose: (reason: GuideCloseReason) => void
  /** 「查看完整手册」：交给上层打开手册文章（同时按「中断」记录，不算完成） */
  onOpenArticle?: (articleId: string) => void
  /** 首步的「以后不再自动弹出」 */
  onDisableAuto?: () => void
}

/** 找一个**可见**的锚点：同页可能有隐藏实例（抽屉未展开、移动端折叠），不能聚焦看不见的那个 */
function findVisibleTarget(anchor: string | undefined): HTMLElement | null {
  if (!anchor) return null
  const nodes = document.querySelectorAll<HTMLElement>(`[data-guide="${anchor}"]`)
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return node
  }
  return null
}

/**
 * 当前界面缩放系数（根节点 `zoom`）。
 *
 * 🔴 为什么必须换算：应用缩放是给根节点设 `zoom`，此时
 *   · `getBoundingClientRect()` 返回**屏幕像素**（已含缩放）；
 *   · 而 `position: fixed` 元素的 `top/left/width` 是**布局单位**，会被 root zoom 再放大一次。
 *   直接把 rect 写进 style 就等于乘了两遍 —— 实测 1.04 倍时高亮框比目标宽 46px、左上角偏 3px。
 *   统一「除以缩放」换算到布局单位之后，两者才在同一坐标系里。
 */
function layoutZoom(): number {
  const raw = getComputedStyle(document.documentElement).zoom
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : 1
}

export default function GuideOverlay({ guide, startStep = 0, onClose, onOpenArticle, onDisableAuto }: Props) {
  const [index, setIndex] = useState(Math.min(startStep, guide.steps.length - 1))
  const [rect, setRect] = useState<GuidePoint | null>(null)
  const [viewport, setViewport] = useState(() => {
    const zoom = layoutZoom()
    return { width: window.innerWidth / zoom, height: window.innerHeight / zoom }
  })
  /** 递增即触发一次「稳定测量」：窗口变化 / 滚动 / 界面缩放都靠它重置测量循环 */
  const [measureToken, setMeasureToken] = useState(0)
  const cardRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const step = guide.steps[index]
  const total = guide.steps.length
  const last = index === total - 1
  const article = useMemo(() => guideArticle(guide), [guide])

  const close = useCallback((reason: GuideCloseReason) => onClose(reason), [onClose])

  /**
   * 卡片上的「查看完整手册」。
   *
   * 🔴 默认行为就写在组件里（不靠每个接入方各写一遍）：
   *    先投递「打开这篇文章」的请求（App 会走既有 navigate 到「使用指南」），
   *    再按**中断**关闭本次引导 —— 打开手册既不是完成、也不是跳过，
   *    所以不写完成记录；下次进来还能再看。
   */
  const openManual = useCallback((articleId: string) => {
    if (onOpenArticle) { onOpenArticle(articleId); return }
    requestHelpArticle(articleId)
    close('interrupt')
  }, [onOpenArticle, close])

  // 打开时接管焦点，关闭后还给原来的元素（自动触发时是页面本身，手动触发时是「本页指引」按钮）
  useEffect(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusCard = () => cardRef.current?.focus({ preventScroll: true })
    // 🔴 只调用一次不够：页签入场动画与数据首帧都可能在这之后把焦点打回 body（实测 headless 下必现）。
    //    同步 + 一帧 + 60ms 各试一次，三次都只是「确保焦点在卡片」，不会打断作者输入。
    focusCard()
    const frame = requestAnimationFrame(focusCard)
    const timer = window.setTimeout(focusCard, 60)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      const previous = restoreFocus.current
      if (previous && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  /**
   * 步骤换人：先把目标滚进视野，再**连续多帧**测量到稳定为止，并持续盯着目标的盒子。
   *
   * 🔴 为什么不能只测一次：页签有入场动画（`page-enter`），而且**应用缩放是异步生效的**
   *    （首帧时根节点还没有 `zoom`，之后按窗口算出一个比例再套上）。实测一次性测量会得到
   *    「缩放前」的坐标：高亮框比目标宽 46px、左上角偏 3～10px，看起来像套歪了。
   *    这里连续两帧一致才停（上限 40 帧），再用 ResizeObserver 盯住目标盒子 ——
   *    缩放比例变化、字体加载、分栏拖动都会改盒子尺寸，一改就重新测。
   */
  useLayoutEffect(() => {
    let frameId = 0
    let cancelled = false
    let observer: ResizeObserver | null = null
    /** 规划 §3.5 的等待上限：3 秒还没等到锚点就降级为居中说明，不无限等 */
    const deadline = performance.now() + 3000

    const startStableMeasure = (target: HTMLElement) => {
      cancelAnimationFrame(frameId)
      let frame = 0, stable = 0, previous = ''
      const tick = () => {
        if (cancelled) return
        if (!target.isConnected) { setRect(null); return }
        const box = target.getBoundingClientRect()
        const zoom = layoutZoom()
        const signature = `${Math.round(box.top)}|${Math.round(box.left)}|${Math.round(box.width)}|${Math.round(box.height)}|${zoom}`
        if (signature !== previous) {
          previous = signature
          stable = 0
          // 统一换算成布局单位，与 fixed 定位的 top/left/width 同一坐标系
          setRect({ top: box.top / zoom, left: box.left / zoom, width: box.width / zoom, height: box.height / zoom })
        } else stable++
        if (stable < 2 && frame++ < 40) frameId = requestAnimationFrame(tick)
      }
      frameId = requestAnimationFrame(tick)
    }

    /**
     * 🔴 目标可能**还没渲染**：从手册点「重看引导」时，导航要过离页保存屏障，
     *    卡片先挂载、页面后到位 —— 只测一次就会拿到「没有锚点」，整步降级成居中说明（实测）。
     *    这里在 3 秒内逐帧等它出现。
     */
    const waitForTarget = () => {
      if (cancelled) return
      const target = findVisibleTarget(step.anchor)
      if (!target) {
        if (performance.now() < deadline) { frameId = requestAnimationFrame(waitForTarget); return }
        setRect(null)
        return
      }
      target.scrollIntoView({ block: 'center', inline: 'nearest' })
      startStableMeasure(target)
      observer = new ResizeObserver(() => startStableMeasure(target))
      observer.observe(target)
    }
    waitForTarget()

    return () => {
      cancelled = true
      cancelAnimationFrame(frameId)
      observer?.disconnect()
    }
  }, [step.anchor, measureToken])

  // 窗口变化 / 页面滚动 / 分栏拖动 / 界面缩放都会移动目标（目标可能已卸载，则降级为居中说明）
  useEffect(() => {
    const recompute = () => {
      const zoom = layoutZoom()
      setViewport({ width: window.innerWidth / zoom, height: window.innerHeight / zoom })
      setMeasureToken(value => value + 1)
    }
    window.addEventListener('resize', recompute)
    window.addEventListener('scroll', recompute, true)
    // 🔴 界面缩放（80%～160%）不一定会触发 resize：它是改根节点尺寸，必须显式订阅应用自己的缩放事件，
    //    否则高亮框会停在缩放前的位置（实测 130% 时下移约 10px）。
    window.addEventListener('yfe:zoom-changed', recompute)
    return () => {
      window.removeEventListener('resize', recompute)
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('yfe:zoom-changed', recompute)
    }
  }, [])

  /**
   * 步骤变化后兜住焦点。
   *
   * 🔴 真实会掉：在第 2 步点「上一步」回到第 1 步时，那个按钮本身被卸载 ——
   *    焦点会掉回 `body`，键盘用户和读屏用户当场失去位置（实测 headless 必现）。
   *    只在焦点**已经不在卡片里**时补救：用户正点在「下一步」上时不动它，免得每次翻页都重置 Tab 位置。
   */
  useEffect(() => {
    const active = document.activeElement
    if (!active || active === document.body || !cardRef.current?.contains(active)) {
      cardRef.current?.focus({ preventScroll: true })
    }
  }, [index])

  const layout = computeGuideLayout({
    target: rect,
    viewport,
    card: { width: 352, height: 210 },
  })
  const masks = guideMasks(layout.hole, viewport)

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // 输入法组合期间的 Escape 属于候选词，不当作退出（规划 §3.4 键盘要求）
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      close('skip')
      return
    }
    if (event.key !== 'Tab') return
    // 焦点锁在卡片内：背景虽然被遮罩挡住点击，但 Tab 若不拦就会跳进被遮住的页面
    const focusables = cardRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (!focusables || focusables.length === 0) return
    const first = focusables[0]
    const lastNode = focusables[focusables.length - 1]
    if (!event.shiftKey && document.activeElement === lastNode) { event.preventDefault(); first.focus() }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); lastNode.focus() }
  }

  return (
    <div data-guide-overlay="" onKeyDown={onKeyDown}>
      {/* 背景：四块遮罩把点击全部吃掉（讲解模式，不误触真实操作） */}
      {masks.map((mask, i) => (
        <div key={i} aria-hidden data-guide-mask=""
          className="fixed"
          style={{
            zIndex: GUIDE_Z, top: mask.top, left: mask.left, width: mask.width, height: mask.height,
            background: 'rgba(0, 0, 0, 0.55)',
          }} />
      ))}
      {/* 高亮描边：只画框、不吃事件；多主题下不只靠颜色区分 —— 用 2px 实线 + 外发光 */}
      {layout.hole && (
        <div aria-hidden data-guide-hole="" className="fixed pointer-events-none rounded-lg"
          style={{
            zIndex: GUIDE_Z + 1,
            top: layout.hole.top, left: layout.hole.left,
            width: layout.hole.width, height: layout.hole.height,
            border: '2px solid rgb(var(--amber))',
            boxShadow: '0 0 0 3px rgba(0,0,0,0.35), 0 0 18px 2px rgba(255, 193, 94, 0.35)',
          }} />
      )}
      {/* 说明卡片 */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-step-title"
        tabIndex={-1}
        data-guide-card={guide.id}
        className="fixed rounded-xl border border-amber/40 bg-ink-850 shadow-2xl p-4 outline-none"
        style={{
          zIndex: GUIDE_Z + 2,
          top: layout.card.top, left: layout.card.left,
          width: Math.min(352, viewport.width - 24),
          maxHeight: Math.max(160, viewport.height - 24),
          overflowY: 'auto',
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-10 px-1.5 py-0.5 rounded bg-amber/15 text-amber border border-amber/30">
            第 {index + 1} / {total} 步
          </span>
          <div className="flex-1" />
          <Button variant="icon-muted" onClick={() => close('skip')} className="p-1 shrink-0"
            aria-label="关闭本页指引" title="关闭（Esc）">
            <X size={14} />
          </Button>
        </div>
        <h3 id="guide-step-title" className="mt-2 text-13 font-semibold text-ink-50">{step.title}</h3>
        <p className="mt-1 text-12 text-ink-300 leading-relaxed">{step.body}</p>
        {article && (
          <Button variant="bare" onClick={() => openManual(article.id)}
            className="mt-2 px-2 py-1 rounded-md text-11 text-ink-200 border border-ink-700 hover:text-amber hover:border-amber/40 transition-colors">
            <BookOpen size={11} className="inline mr-1" /> 查看完整手册
          </Button>
        )}
        <div className="mt-3 flex items-center gap-2">
          {index > 0 && (
            <Button variant="secondary" size="sm" onClick={() => setIndex(value => Math.max(0, value - 1))}>上一步</Button>
          )}
          <div className="flex-1" />
          <Button variant="bare" onClick={() => close('skip')}
            className="px-2 py-1 rounded-md text-11 text-ink-400 hover:text-ink-200 transition-colors">跳过本页</Button>
          <Button variant="primary" size="sm"
            onClick={() => (last ? close('done') : setIndex(value => Math.min(total - 1, value + 1)))}>
            {last ? '完成' : '下一步'}
          </Button>
        </div>
        {index === 0 && onDisableAuto && (
          <Button variant="bare" onClick={onDisableAuto}
            className="mt-2 px-0 py-0 text-10 text-ink-500 underline decoration-dotted hover:text-ink-300 transition-colors">
            以后不再自动弹出（可在设置里恢复）
          </Button>
        )}
        {/* 读屏播报：步骤变化要能被感知，但不重复朗读整段正文 */}
        <div aria-live="polite" className="sr-only">第 {index + 1} 步，共 {total} 步：{step.title}</div>
      </div>
    </div>
  )
}
