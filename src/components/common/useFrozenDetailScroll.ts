/**
 * 左右分栏页签的「右栏冻结」（3.3.1 回归修复 · 主人 2026-10-30 反馈）。
 *
 * 【要恢复的行为】
 *   左栏滚到哪儿、右栏滚到哪儿，是**两件互不相干的事**：在左栏点第二张卡片，
 *   右栏该停在原处，不能「呼」地跳回顶部。
 *
 * 【为什么会被顶掉】
 *   UX06 给详情页加了「按对象记滚动位置」（`useDetailWorkspaceView`）。于是切到一张
 *   从没打开过的卡片时：展开组按默认值重算 ⇒ 内容高度变短 ⇒ 浏览器把 scrollTop 夹到 0；
 *   而那张卡没有记录可恢复 ⇒ 停在 0。作者看到的就是「跳回开头」。
 *
 * 【做法】
 *   · **只在容器真的可滚动时**记录位置（`max > 0`）—— 加载中/内容变短的那一瞬不覆盖，
 *     否则会把自己刚记下的中间位置改成 0（这是本 bug 的关键一环）；
 *   · 选中项变化时，在 DOM 换内容**之前**抓一次当前位置，换完等两帧布局稳定再放回去；
 *   · 新内容比原位置短时自然夹到它的底部，不会出现「停在半空」。
 *
 * 【红线】
 *   · 只读/写 `scrollTop`，不碰 DOM 结构、不碰字段值、不抢焦点；
 *   · 换页签 → 组件卸载 → 这个 hook 的记忆随之消失（那时由各自的「现场记忆」负责接回）。
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** 等两帧让新内容布局稳定（分组展开、字体晚到都会改高度） */
const SETTLE_FRAMES = 2

export function useFrozenDetailScroll(
  scrollRef: RefObject<HTMLElement | null>,
  selectionKey: string | null,
): void {
  /** 最近一次「可滚动状态下」的滚动位置 */
  const lastTop = useRef(0)
  const prevKey = useRef(selectionKey)
  const restoreToken = useRef(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onScroll = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        // 🔴 只在可滚动时记：内容换掉/加载中的那一瞬 `max` 会是 0，
        //    若把 0 记下来，后面就「恢复」到顶部了 —— 正是这个 bug 的成因。
        if (el.scrollHeight - el.clientHeight > 0) lastTop.current = el.scrollTop
      }, 120)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (timer) clearTimeout(timer)
    }
  }, [scrollRef])

  /**
   * 换选中项的那一刻抓当前位置。
   *
   * 🔴 必须在这里（render 期）抓，不能等 effect：`useEffect` 在**浏览器完成布局之后**才跑，
   *    那时新内容已经就位、scrollTop 已经被夹过了，抓到的就是被夹坏的值。
   *    这里只读一次 `scrollTop`，不改任何东西 —— 与「render 里禁止副作用」不冲突。
   */
  if (prevKey.current !== selectionKey) {
    const el = scrollRef.current
    if (el && el.scrollHeight - el.clientHeight > 0) lastTop.current = el.scrollTop
    prevKey.current = selectionKey
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const target = lastTop.current
    if (target <= 0) return
    const token = ++restoreToken.current
    let frame = 0
    let left = SETTLE_FRAMES
    const step = () => {
      if (token !== restoreToken.current) return
      if (left-- > 0) { frame = requestAnimationFrame(step); return }
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = Math.min(target, Math.max(0, max))
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [selectionKey, scrollRef])
}
