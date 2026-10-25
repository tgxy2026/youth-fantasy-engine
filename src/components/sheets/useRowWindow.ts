/**
 * 表格行窗口化（3.2.3 · P2）：只挂视口附近的行。
 *
 * 为什么要有它：实测（`scripts/verify/table-hotpath.mjs` + `table-performance.mjs`）
 *   300 行 × 74 列 = 22,200 个单元格全量挂进 DOM ⇒ 首屏 12.7 s、125,340 个节点；
 *   1000 行（large）要 254.7 s。取数放大已在 P1 前奏修掉，剩下的瓶颈就是**渲染**。
 *
 * 做法：外层仍是普通的 `<table>`，只在 tbody 首尾各放一个「撑高度」的空行，
 * 中间只渲染窗口内的真实行。这样 sticky 表头、`table-fixed` 列宽、横向拖拽平移、
 * `divide-y` 分隔线全都不受影响 —— 不需要把表格改成绝对定位（`<tr>` 做绝对定位在浏览器里不可靠）。
 *
 * 🔴 四条硬约束：
 *   ① 行高是**变的**（正文格会自动长高到 78px），所以高度必须实测缓存，不能写死；
 *   ② 量高度一律 `offsetHeight` —— 界面缩放（`<html>` 的 zoom）下 `getBoundingClientRect`
 *      会按缩放折算，拿去算位移会错位（项目里同口径的坑见 MEMORY 的「界面缩放」条）；
 *   ③ 跳转聚焦（`focusRowId`）要能落到**还没挂载**的行上：调用方把目标行传成 `pinnedId`，
 *      只要它还在高亮期就强制留在窗口里，`scrollIntoView` 才不会扑空；
 *   ④ 行数少时不启用（阈值在调用方）—— 小表保持原行为，减少回归面。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

export interface RowWindowOptions {
  /** 参与排列的行 id（已按显示顺序） */
  ids: string[]
  /** 行元素登记表（`TableSheetRow` 挂进去的那份），用来实测高度 */
  rowRefs: React.MutableRefObject<Record<string, HTMLTableRowElement | null>>
  /** 滚动容器（就是那个 `data-table-scroll`） */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** false ⇒ 全量渲染，返回值退化成「全部行」 */
  enabled: boolean
  /** 尚未测到高度的行先按这个值占位（实测中位数优先） */
  estimate?: number
  /** 视口上下各多挂几行，减少快速滚动时的空白 */
  overscan?: number
  /** 强制留在窗口里的行（跳转聚焦用） */
  pinnedId?: string | null
}

export interface RowWindowInput {
  /** 行数 */
  count: number
  /** 第 i 行的高度（未实测的行由调用方给估值） */
  heightAt: (index: number) => number
  /** 滚动容器当前 scrollTop 与可视高度（CSS 像素） */
  viewportTop: number
  viewportHeight: number
  /** 视口上下各多挂几行 */
  overscan?: number
  /** 必须留在窗口里的行下标（-1 / 省略 = 没有） */
  pinnedIndex?: number
  /** 钉住行允许拉伸的最大行数（默认 60 行，约两屏多） */
  pinLimit?: number
}

export interface RowWindowRange {
  start: number
  end: number
  topPad: number
  bottomPad: number
}

/**
 * 纯计算：给定行高与视口，算出要渲染的区间和上下占位高度。
 * 🔴 单独抽出来是为了能被单测钉住（末行、钉住行、占位合计这三处最容易回归）。
 */
export function computeRowWindow({ count, heightAt, viewportTop, viewportHeight, overscan = 4, pinnedIndex = -1, pinLimit = 60 }: RowWindowInput): RowWindowRange {
  if (!Number.isInteger(count) || count <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 }
  const offsets: number[] = new Array(count)
  let acc = 0
  for (let i = 0; i < count; i++) { offsets[i] = acc; acc += Math.max(0, heightAt(i)) }
  const totalHeight = acc

  // 二分：第一个「行底边越过视口顶」的行
  let lo = 0, hi = count - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] + Math.max(0, heightAt(mid)) < viewportTop) lo = mid + 1
    else hi = mid
  }
  let start = Math.max(0, lo - overscan)
  let end = lo
  const limit = viewportTop + Math.max(viewportHeight, 1)
  while (end < count && offsets[end] < limit) end++
  end = Math.min(count, end + overscan)

  /**
   * 钉住行（跳转聚焦）：只在**近处**拉伸窗口。
   * 🔴 跨几百行也拉的话，等于把上千行重新挂回 DOM —— 虚拟化就白做了（实测过这个坑：
   *    指针在第 3 行、视口在第 800 行时会挂 809 行）。远处的情形由调用方先滚动到目标，
   *    再由高亮轮询接住；这里只负责「滚到附近之后别让它立刻被卸掉」。
   */
  if (pinnedIndex >= 0 && pinnedIndex < count) {
    if (pinnedIndex < start && start - pinnedIndex <= pinLimit) start = pinnedIndex
    if (pinnedIndex >= end && pinnedIndex - end <= pinLimit) end = pinnedIndex + 1
  }

  let topPad = 0
  for (let i = 0; i < start; i++) topPad += Math.max(0, heightAt(i))
  let bottomPad = 0
  for (let i = end; i < count; i++) bottomPad += Math.max(0, heightAt(i))
  return { start, end, topPad: Math.min(topPad, totalHeight), bottomPad: Math.min(bottomPad, totalHeight) }
}

export interface RowWindow {
  start: number
  end: number
  /** 窗口之前那些行的高度合计（塞进上方占位行） */
  topPad: number
  /** 窗口之后那些行的高度合计（塞进下方占位行） */
  bottomPad: number
  /** 是否真的在窗口化（供调试/证据用） */
  active: boolean
  /** 把某一行滚进视口（目标行可能还没挂载） */
  revealId: (id: string) => void
}

export function useRowWindow({ ids, rowRefs, scrollRef, enabled, estimate = 56, overscan = 4, pinnedId }: RowWindowOptions): RowWindow {
  const heights = useRef<Map<string, number>>(new Map())
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const [tick, setTick] = useState(0)

  /** 实测当前已挂载行的高度；只有真变了才触发重算（否则会和 layoutEffect 互相打转） */
  const measure = useCallback(() => {
    const known = heights.current
    let changed = false
    for (const [id, node] of Object.entries(rowRefs.current)) {
      if (!node) continue
      const h = node.offsetHeight
      if (h > 0 && known.get(id) !== h) { known.set(id, h); changed = true }
    }
    if (changed) setTick(t => t + 1)
  }, [rowRefs])

  useLayoutEffect(() => { if (enabled) measure() })

  // 行集合「内容」变了（筛选/换页签/增删行）⇒ 之前缓存的偏移作废，等重新实测。
  // 🔴 用 join 出来的键而不是数组引用：`bodyRows` 在改草稿时也会换新数组，
  //    拿引用当依赖会把高度缓存每次按键清一遍（视口跳动 + 反复重算）。
  const idsKey = useMemo(() => ids.join('\u0001'), [ids])
  useEffect(() => { heights.current.clear(); setTick(t => t + 1) }, [idsKey])
  useEffect(() => { heights.current.clear(); setTick(t => t + 1) }, [enabled])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !enabled) return
    const read = () => {
      setViewport(prev => {
        const next = { top: el.scrollTop, height: el.clientHeight }
        return prev.top === next.top && prev.height === next.height ? prev : next
      })
    }
    // 🔴 不用 requestAnimationFrame 节流：滚动到位后要**当帧**就能重算窗口，
    //    否则「滚到底再读最后一行」这类断言会差一帧（取证工具只用 2 帧等待）。
    //    单次计算是 O(行数) 次加法，1000 行也只有微秒级，不需要节流。
    const onScroll = read
    read()
    el.addEventListener('scroll', onScroll, { passive: true })
    // 容器尺寸变化（窗口缩放 / 界面缩放 / 侧栏拖拽）也要重算
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onScroll)
    observer?.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [enabled, scrollRef])

  const window = useMemo<RowWindow>(() => {
    // tick 只是「高度实测更新了」的失效信号，下面靠它触发重算（读一下避免 lint 判成多余依赖）
    void tick
    if (!enabled || ids.length === 0) return { start: 0, end: ids.length, topPad: 0, bottomPad: 0, active: false, revealId: () => {} }
    const known = heights.current
    // 估高优先用实测中位数：拿它当未测行的占位，滚动条长度才不会离谱
    const measured = [...known.values()].filter(h => h > 0).sort((a, b) => a - b)
    const unit = measured.length ? measured[Math.floor(measured.length / 2)] : estimate
    const pinnedIndex = pinnedId ? ids.indexOf(pinnedId) : -1
    const range = computeRowWindow({
      count: ids.length,
      heightAt: i => known.get(ids[i]) ?? unit,
      viewportTop: viewport.top,
      viewportHeight: viewport.height,
      overscan,
      pinnedIndex,
    })
    return { ...range, active: true, revealId: () => {} }
    // tick 参与依赖：高度实测更新后必须重算
  }, [enabled, ids, viewport.top, viewport.height, overscan, estimate, pinnedId, tick])

  /**
   * 把某一行滚进视口（用于「跨组件跳转聚焦」到还没挂载的行）。
   * 高度优先用实测值，未实测的按中位数估；不需要精确到像素 —— 滚到附近后
   * 高亮逻辑自己会 `scrollIntoView` 做最后对位。
   */
  const revealId = useCallback((id: string) => {
    const el = scrollRef.current
    if (!el) return
    const at = ids.indexOf(id)
    if (at < 0) return
    const known = heights.current
    const measured = [...known.values()].filter(h => h > 0).sort((a, b) => a - b)
    const unit = measured.length ? measured[Math.floor(measured.length / 2)] : estimate
    let offset = 0
    for (let i = 0; i < at; i++) offset += known.get(ids[i]) ?? unit
    el.scrollTop = Math.max(0, offset - Math.floor(el.clientHeight / 3))
  }, [ids, estimate, scrollRef])

  return { ...window, revealId }
}
