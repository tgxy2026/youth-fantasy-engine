/**
 * 正文工作现场的**捕获与恢复**（UX06）。
 *
 * 【它解决什么】
 *   作者写完一段去工作面板看一眼，回来时希望还是「那一章、那一段、那一行」。
 *   现在只做到「不丢稿」（离页屏障）；光标与滚动位置一换页签就没了。
 *
 * 【三条红线】
 *   ① **不存正文**：记录里只有长度、内容摘要、选区数字、滚动比例、排版尺寸 —— 见 editorViewMath。
 *   ② **不冒充保存成功**：捕获只是「记下现场」，离页是否放行仍由 `leaveBarrier` 决定；
 *      捕获失败（没有身份 / 没有项目 / 存储拒绝）一律静默跳过，绝不改变离页结论。
 *   ③ **不抢 DOM**：只对现成的 textarea 调 `setSelectionRange` / `scrollTop` / `focus`，
 *      不替换节点、不改内容、不重建章节 —— 组件卸载后的原生撤销栈本来也带不走，不做承诺。
 *
 * 【优先级】显式定位（报告 / 全文检索 / 「继续写作」跳章）> 返回来源 > 本次会话记忆。
 *   落地方式：**记录里的 objectId 必须等于当前章**才允许恢复 —— 显式定位指定的章永远不会被会话记忆覆盖。
 *   ⚠️ 显式跳转目前只带「哪一章」、不带「哪一段」，所以同一章内恢复光标并不与它冲突；
 *   将来若显式定位要指向具体段落，那个位置意图必须**优于**本恢复（届时在本 hook 里先判它）。
 *
 * 【过期就不许落地】下列任一发生即作废在途恢复（epoch 自增）：
 *   键入 / 输入法开始组合 / 按键 / 指针按下 / 滚轮（作者已经在自己找位置了）、
 *   换章（effect 重跑换 token）、身份或存储上下文代次变化（store 失效）、记录被清。
 */
import { useEffect, useRef, type RefObject } from 'react'
import * as db from '@/lib/db'
import { currentWorkspaceScope, registerWorkspaceCapture } from '@/lib/settings/workspaceRuntime'
import { workspaceViews, type EditorView } from '@/lib/settings/workspaceViewState'
import { clampSelection, contentRevision, scrollRatio, scrollTopFor, type LayoutBox } from '@/lib/editor/editorViewMath'

/** 正文页在视图存储里的页面标识（与其它页面分开命名空间） */
const PAGE_ID = 'editor'
/** 布局稳定判定的上限帧数：60fps 下约 0.7s，够字体/滚动条出来，又不会无限等 */
const STABLE_FRAMES = 45

export interface EditorWorkspaceViewArgs {
  /** 章节数据是否已就绪（未就绪时既不该捕获也不该恢复） */
  enabled: boolean
  /** 当前章 id */
  activeId: string | null
  taRef: RefObject<HTMLTextAreaElement>
  /** 正文壳（短窗时它才是滚动容器），用于外层的滚动位置 */
  scrollRef: RefObject<HTMLDivElement>
}

const directionOf = (value: string | null): EditorView['selection']['direction'] =>
  value === 'forward' || value === 'backward' ? value : 'none'

const measure = (el: HTMLTextAreaElement): LayoutBox => {
  const style = getComputedStyle(el)
  return {
    width: el.clientWidth,
    height: el.clientHeight,
    fontSize: Number.parseFloat(style.fontSize) || 0,
    lineHeight: Number.parseFloat(style.lineHeight) || 0,
  }
}

/** 等正文区高度稳定两帧（字体晚到 / 短窗保底 / 图片撑开都会改高度）——不靠固定 setTimeout 猜时机 */
async function settleLayout(el: HTMLTextAreaElement, cancelled: () => boolean): Promise<void> {
  let last = -1
  let stable = 0
  for (let frame = 0; frame < STABLE_FRAMES; frame += 1) {
    if (cancelled()) return
    const height = el.clientHeight
    if (height > 0 && height === last) {
      stable += 1
      if (stable >= 2) return
    } else {
      stable = 0
    }
    last = height
    await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()) })
  }
}

export function useEditorWorkspaceView({ enabled, activeId, taRef, scrollRef }: EditorWorkspaceViewArgs): void {
  const epoch = useRef(0)
  // 捕获可能在 React 之外被同步调用（离页点击那一刻），只能读 ref 里的最新值
  const live = useRef({ enabled, activeId })
  live.current = { enabled, activeId }

  // ---------- 捕获：登记到 workspaceRuntime（App 离页前、模型切章前都会调） ----------
  useEffect(() => registerWorkspaceCapture(() => {
    const { enabled: ready, activeId: chapterId } = live.current
    if (!ready || !chapterId) return
    const ta = taRef.current
    if (!ta) return
    const projectId = db.getCurrentProjectId()
    if (!projectId) return
    const scope = currentWorkspaceScope(projectId, PAGE_ID)
    if (!scope) return
    // 🔴 以 textarea.value 为准：它在 DOM 里，永远比 state 新一拍（切章/离页都是同步读）
    const text = ta.value
    const max = ta.scrollHeight - ta.clientHeight
    const outer = scrollRef.current
    const outerMax = outer ? outer.scrollHeight - outer.clientHeight : 0
    const layout = measure(ta)
    workspaceViews.put(scope, {
      version: 1,
      kind: 'editor',
      objectId: chapterId,
      revision: contentRevision(text),
      length: text.length,
      selection: { start: ta.selectionStart, end: ta.selectionEnd, direction: directionOf(ta.selectionDirection) },
      scroll: { top: ta.scrollTop, ratio: scrollRatio(ta.scrollTop, max), outerTop: outer?.scrollTop ?? 0, outerRatio: scrollRatio(outer?.scrollTop ?? 0, outerMax) },
      layout,
      focused: document.activeElement === ta,
    })
  }), [taRef, scrollRef])

  // ---------- 作者自己动手 ⇒ 作废在途恢复（绝不把光标拽回去） ----------
  useEffect(() => {
    if (!enabled) return
    const cancel = () => { epoch.current += 1 }
    const targets: (HTMLElement | null)[] = [taRef.current, scrollRef.current]
    const events = ['input', 'compositionstart', 'keydown', 'pointerdown', 'wheel'] as const
    for (const el of targets) {
      if (!el) continue
      for (const name of events) el.addEventListener(name, cancel, { capture: true, passive: true })
    }
    return () => {
      for (const el of targets) {
        if (!el) continue
        for (const name of events) el.removeEventListener(name, cancel, { capture: true })
      }
    }
  }, [enabled, taRef, scrollRef])

  // ---------- 恢复：进章 / 回编辑器时，内容还是那一份才恢复选区与位置 ----------
  useEffect(() => {
    if (!enabled || !activeId) return
    const ta = taRef.current
    if (!ta) return
    const projectId = db.getCurrentProjectId()
    if (!projectId) return
    const scope = currentWorkspaceScope(projectId, PAGE_ID)
    if (!scope) return
    const generation = workspaceViews.generation()
    const record = workspaceViews.get(scope, activeId)
    if (!record || record.kind !== 'editor' || record.objectId !== activeId) return

    const token = epoch.current + 1
    epoch.current = token
    const cancelled = () => token !== epoch.current || workspaceViews.generation() !== generation
    // 存储被清（换身份 / 换后端 / 整库替换）⇒ 立刻作废，别让旧会话的现场落到新上下文里
    const offInvalidate = workspaceViews.subscribeInvalidation(() => { epoch.current += 1 })
    void (async () => {
      await settleLayout(ta, cancelled)
      if (cancelled()) return
      const text = ta.value
      const outer = scrollRef.current
      if (contentRevision(text) !== record.revision) {
        // 内容变了：只回章首，旧选区一律不套（它指向的已不是同一句话）
        ta.scrollTop = 0
        if (outer) outer.scrollTop = 0
        return
      }
      const selection = clampSelection(record.selection.start, record.selection.end, text.length, record.selection.direction)
      const max = ta.scrollHeight - ta.clientHeight
      const plan = scrollTopFor(record.scroll, record.layout, measure(ta), max)
      try { ta.setSelectionRange(selection.start, selection.end, selection.direction) } catch { /* 只读/不可聚焦时放弃选区，不影响滚动 */ }
      ta.scrollTop = plan.top
      if (outer) outer.scrollTop = Math.max(0, Math.min(record.scroll.outerTop, Math.max(0, outer.scrollHeight - outer.clientHeight)))
      // 不抢焦点：只有原本就聚焦在正文（且没有弹窗）时才还回焦点
      const active = document.activeElement
      if (record.focused && !document.querySelector('[role="dialog"]') && (!active || active === document.body || active === ta)) {
        ta.focus({ preventScroll: true })
      }
    })().catch(() => { /* 恢复是可选能力，失败不能影响编辑本身 */ })
    return offInvalidate
  }, [enabled, activeId, taRef, scrollRef])
}
