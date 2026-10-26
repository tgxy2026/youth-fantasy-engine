/**
 * 「跳到正文的某一段」（UX05 段落级定位）。
 *
 * 【为什么不是只打开章】
 *   作者从角色页看到「这一章提到过他 7 次」，点进去落在**第 1 行**，还得自己翻——
 *   命中位置检索侧其实算得出来（`MentionHit.contentOffset`），只要跳过去时把光标放到那儿。
 *
 * 🔴 三条约束：
 *   ① **不抢 DOM**：只对现成 textarea 调 `setSelectionRange` / `scrollTop` / `focus`，
 *      不换节点、不改内容；正文值必须已经装载好（长度 ≥ 目标偏移）才动手。
 *   ② **一次性**：同一组（章 + 偏移）只应用一次，之后的切换不再重复套。
 *   ③ **人一动手就放弃**：键入 / 输入法开始 / 滚轮 / 指针按下都视为"作者已经在自己找位置"，
 *      在途定位立刻作废 —— 跟 UX06 的现场恢复同一条纪律。
 */
import { useEffect, useRef, type RefObject } from 'react'

/** 等正文装载/布局稳定的上限帧数（60fps 下约 0.6s） */
const STABLE_FRAMES = 36

export interface EditorOpenOffsetArgs {
  /** 章节数据是否已就绪 */
  enabled: boolean
  /** 当前章 */
  activeId: string | null
  /** 本次进入正文时显式指定的章（与 activeId 相等才认为"这次是为它跳来的"） */
  openChapterId: string | null
  /** 目标字符偏移（相对正文）；null 表示不定位 */
  offset: number | null
  /** 命中词长度：把它选中，作者一眼看到落在哪 */
  matchLength?: number | null
  taRef: RefObject<HTMLTextAreaElement>
}

const lineHeightOf = (el: HTMLTextAreaElement): number => {
  const style = getComputedStyle(el)
  const parsed = Number.parseFloat(style.lineHeight)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  const size = Number.parseFloat(style.fontSize)
  return Number.isFinite(size) && size > 0 ? size * 1.6 : 24
}

/**
 * 把「字符偏移」换算成滚动目标：数前面有几个换行 → 乘行高 → 让目标行落在视口上三分之一处。
 * 纯函数（行高/尺寸都传进来），这样能单测；DOM 读取留在 hook 里。
 * 🔴 只对 `white-space: pre-wrap` 的 textarea 近似成立：硬换行才算行，自动折行不计 ——
 *    长段落会偏一点，所以定位后再由浏览器把光标滚进视野（`setSelectionRange` + 手动 scrollTop）。
 */
export function scrollTopForOffset(
  value: string, start: number, lineHeight: number, clientHeight: number, scrollHeight: number,
): number {
  const safeStart = Math.max(0, Math.min(value.length, Math.trunc(Number.isFinite(start) ? start : 0)))
  let lines = 0
  for (let i = 0; i < safeStart; i += 1) if (value.charCodeAt(i) === 10) lines += 1
  const max = Math.max(0, scrollHeight - clientHeight)
  const height = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24
  return Math.max(0, Math.min(max, Math.round(lines * height - clientHeight / 3)))
}

export function useEditorOpenOffset({ enabled, activeId, openChapterId, offset, matchLength, taRef }: EditorOpenOffsetArgs): void {
  const applied = useRef<string>('')
  const epoch = useRef(0)

  // 作者一动手就作废在途定位
  useEffect(() => {
    const ta = taRef.current
    if (!ta || !enabled) return
    const cancel = () => { epoch.current += 1 }
    const events = ['input', 'compositionstart', 'keydown', 'pointerdown', 'wheel'] as const
    for (const name of events) ta.addEventListener(name, cancel, { capture: true, passive: true })
    return () => { for (const name of events) ta.removeEventListener(name, cancel, { capture: true }) }
  }, [enabled, taRef])

  useEffect(() => {
    if (!enabled || !activeId || offset == null) return
    // 只对「这次跳转指定的那一章」生效；作者自己切章不该被旧偏移拽走
    if (openChapterId !== activeId) return
    const key = `${activeId}:${offset}:${matchLength ?? 0}`
    if (applied.current === key) return

    const ta = taRef.current
    if (!ta) return
    const token = epoch.current + 1
    epoch.current = token
    const cancelled = () => token !== epoch.current

    void (async () => {
      // 等正文装载 + 布局稳定：装载前后 clientHeight 会跳，太早算的滚动位置会偏
      let last = -1
      for (let frame = 0; frame < STABLE_FRAMES; frame += 1) {
        if (cancelled()) return
        const ready = ta.value.length >= offset && ta.clientHeight > 0
        if (ready && ta.clientHeight === last) break
        last = ta.clientHeight
        await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()) })
      }
      if (cancelled()) return
      // 章节内容比记录短（被改短/换稿）⇒ 不硬指过去，安静放弃
      if (ta.value.length < offset) return
      const start = Math.max(0, Math.min(ta.value.length, Math.trunc(offset)))
      const end = matchLength && matchLength > 0 ? Math.min(ta.value.length, start + Math.trunc(matchLength)) : start
      try { ta.setSelectionRange(start, end, 'forward') } catch { /* 只读/未挂载时放弃选区 */ }
      ta.scrollTop = scrollTopForOffset(ta.value, start, lineHeightOf(ta), ta.clientHeight, ta.scrollHeight)
      // 跳过来是为了看/改这一段，把焦点交回正文（不滚走，位置已算好）
      const active = document.activeElement
      if (!document.querySelector('[role="dialog"]') && (!active || active === document.body)) ta.focus({ preventScroll: true })
      applied.current = key
    })().catch(() => { /* 定位是可选能力，失败不影响阅读 */ })
  }, [enabled, activeId, openChapterId, offset, matchLength, taRef])
}
