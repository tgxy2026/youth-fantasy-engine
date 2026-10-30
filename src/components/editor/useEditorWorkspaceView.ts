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
  /**
   * 🔴 当前章的**数据侧**正文（`active.content`）。判「内容是不是还是那一份」必须以它为准，
   *    不能读 textarea —— 同页切章时受控值要等下一次提交才写回，effect 里读到的还是上一章的正文。
   *    只从 ref 读、**不进依赖**：自动保存会不断刷新它，进依赖会让恢复在作者打字时反复重跑。
   */
  content?: string | null
  /** Explicit position requests arbitrate before restoration begins; hook order is not priority. */
  skipRestore?: boolean
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

/**
 * 等「正文真的装上要恢复的那一章，且高度稳定两帧」（字体晚到 / 短窗保底 / 图片撑开都会改高度）。
 *
 * 🔴 为什么必须连值一起等：同页切章时受控 textarea 里仍是**上一章**的正文，要等 React 下一次提交
 *    才写回。只等高度稳定会在旧值上量出旧高度（两章行数接近时甚至第一帧就算稳定），
 *    接着按旧值判「内容变了」⇒ 每次切回原章都被降级成章首，现场照样丢（2026-10-28 定位）。
 *
 * @param expected 目标章正文；`null` 表示数据侧还没拿到，只能退回「值自洽」的旧判据
 */
async function settleEditor(el: HTMLTextAreaElement, expected: string | null, cancelled: () => boolean): Promise<boolean> {
  let last = -1
  let stable = 0
  for (let frame = 0; frame < STABLE_FRAMES; frame += 1) {
    if (cancelled()) return false
    const height = el.clientHeight
    const ready = height > 0 && (expected === null || el.value === expected)
    stable = ready && height === last ? stable + 1 : 0
    last = height
    if (stable >= 2) return true
    await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()) })
  }
  return false
}

export function useEditorWorkspaceView({ enabled, activeId, taRef, scrollRef, content = null, skipRestore = false }: EditorWorkspaceViewArgs): void {
  const epoch = useRef(0)
  /** 这个组件实例里见过的当前章 id：用来区分「切章」与「重新挂载回到同一章」 */
  const seenActiveId = useRef<string | null>(null)
  // 捕获可能在 React 之外被同步调用（离页点击那一刻），只能读 ref 里的最新值
  const live = useRef({ enabled, activeId, content })
  live.current = { enabled, activeId, content }

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
    const token = ++epoch.current
    if (!enabled || !activeId || skipRestore) return
    const ta = taRef.current
    if (!ta) return
    const projectId = db.getCurrentProjectId()
    if (!projectId) return
    const scope = currentWorkspaceScope(projectId, PAGE_ID)
    if (!scope) return
    const generation = workspaceViews.generation()
    const record = workspaceViews.get(scope, activeId)
    const expected = live.current.content

    const cancelled = () => token !== epoch.current || workspaceViews.generation() !== generation
    /**
     * 3.3.1（主人 2026-10-30）：**点开任何一章都落到该章末尾**，光标也放到文末 —— 作者点章节是接着写。
     *
     * 🔴 但「切章」和「回到同一章」必须分开，否则会把 2.6.1 的现场记忆一起废掉：
     *   · `switched`（这个组件里见过别的章）⇒ 作者刚点了另一章 ⇒ **一律尾部**；
     *   · 首次运行（组件刚挂载，`seen` 还是空）⇒ 是「打开项目 / 换页签回来」⇒ **按记录恢复**上次光标与位置；
     *   · 首次运行但该章没记录 ⇒ 也是尾部（不是停在开头）。
     *   于是「重开项目接着写上一处」和「点哪章都到末尾」两件事都成立，互不吃掉对方。
     */
    const switched = seenActiveId.current !== null && seenActiveId.current !== activeId
    seenActiveId.current = activeId
    if (switched || !record || record.kind !== 'editor' || record.objectId !== activeId) {
      void (async () => {
        if (!(await settleEditor(ta, expected, cancelled)) || cancelled()) return
        ta.scrollTop = ta.scrollHeight
        // 光标也放到文末：否则一打字就从旧光标处跳回去，"到末尾"就成了看一眼而已
        const end = ta.value.length
        try { ta.setSelectionRange(end, end) } catch { /* 只读/不可聚焦时只保证滚动 */ }
        const outer = scrollRef.current
        if (outer) outer.scrollTop = Math.max(0, outer.scrollHeight - outer.clientHeight)
      })().catch(() => { /* 可选能力，失败不影响编辑 */ })
      return
    }
    // 存储被清（换身份 / 换后端 / 整库替换）⇒ 立刻作废，别让旧会话的现场落到新上下文里
    const offInvalidate = workspaceViews.subscribeInvalidation(() => { epoch.current += 1 })
    /** 内容确实变了：只回章首，旧选区一律不套（它指向的已不是同一句话） */
    const degrade = () => {
      ta.scrollTop = 0
      const outer = scrollRef.current
      if (outer) outer.scrollTop = 0
    }
    void (async () => {
      if (expected != null) {
        // 🔴 判据落在**数据**上（见 settleEditor 头注）：拿切章瞬间的 textarea 值比，等于拿上一章比这一章。
        if (contentRevision(expected) !== record.revision) { degrade(); return }
        if (!(await settleEditor(ta, expected, cancelled)) || cancelled()) return
      } else {
        // 数据侧还没拿到（冷启动加载中）：只能等值自洽后再用旧判据兜底
        if (!(await settleEditor(ta, null, cancelled)) || cancelled()) return
        if (contentRevision(ta.value) !== record.revision) { degrade(); return }
      }
      const text = ta.value
      const outer = scrollRef.current
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
    return () => { epoch.current++; offInvalidate() }
  }, [enabled, activeId, taRef, scrollRef, skipRestore])
}
