/**
 * 正文编辑器 · **AI 伴写 ghost 逐句续写**（从 `useNovelEditorModel.ts` 拆出来的，2026-09-19 D4-2）。
 *
 * 【交互】对齐 WPS AI 伴写：停笔 800ms → 光标后透出一句浅灰建议 → Tab / → 采纳，打字或 Esc 丢弃。
 *
 * 【三条工程约束（原文照录）】
 *   · 采纳之前**正文一个字都没被改过**（ghost 只是画在叠层上的字），所以拒绝永远零破坏；
 *   · ghost 叠层与高亮叠层同层（均 z-0 + 透明基），盒模型逐项照抄高亮层，否则两图层必然错位；
 *   · **光标后已有正文时不显示** —— ghost 没有"宽度"，压到后面的字上会糊成一片。
 *
 * 🔴 最难踩的两条：
 *   ① **切章必须清 ghost**（`[activeId]` 那个 effect）—— 跨章残留会让 Tab 把上一章的建议插进新章的
 *      同一偏移处，属数据事故；
 *   ② **`ghostDismissed`**（Esc 抑制）—— 自动保存一提交 `chapters` 就换新对象、effect 白跑一轮，
 *      没有它刚被 Esc 拒掉的建议会立刻弹回来（作者会觉得"Esc 根本没用"）。
 *
 * 【与调用方的接缝】`caret` / `selRef` / `ghostRef` / `ghostDismissed` / `draftRef` 由
 *   `useNovelEditorModel` 持有并传进来 —— 它们同时被正文链路（光标同步、切章冲刷、Esc 抑制解除）
 *   使用，只能有一个所有者。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import * as db from '../lib/db'
import { showToast } from './dialogs'
import { aiInlineSuggest, type InlineSuggestLength } from '../lib/aiTasks'
import { buildInlineBriefing } from '../lib/aiContext'
import { isCancelled } from '../lib/ai'
import {
  GHOST_DEBOUNCE_MS, GHOST_CONTEXT_CHARS, GHOST_MAX_FAILS, GHOST_CACHE_MAX,
} from './novelEditorHelpers'

type GhostArgs = {
  activeId: string | null
  /** 当前章正文（未保存草稿的最新值由 draftRef 提供，避免闭包读到旧值） */
  draftContent: string
  aiReady: boolean
  caret: number
  setCaret: Dispatch<SetStateAction<number>>
  /** 选区缓存（textarea 的 onSelect/onKeyUp 时同步，面板聚焦后仍可读取） */
  selRef: MutableRefObject<{ start: number; end: number } | null>
  taRef: RefObject<HTMLTextAreaElement>
  /** ghost 叠层容器（与高亮叠层同层，必须同步滚动） */
  ghostRef: RefObject<HTMLDivElement>
  /** Esc 抑制：记下「光标位置 + 当时正文长度」，只有真的动了才允许再次自动请求 */
  ghostDismissed: MutableRefObject<{ at: number; len: number } | null>
  /** 最新草稿镜像（ghost 取前文 / 记长度都读它，保证拿到本帧最新值） */
  draftRef: MutableRefObject<string>
  /** 采纳建议的唯一写入口：走受控组件的 onContentChange，保住自动保存链路 */
  onContentChange: (v: string) => void
}

export function useNovelEditorGhost({
  activeId, draftContent, aiReady, caret, setCaret, selRef, taRef, ghostRef, ghostDismissed, draftRef, onContentChange,
}: GhostArgs) {
  // ---- 2.2.0 AI 伴写（ghost 逐句续写）----
  // 默认关闭：写作者主导权优先。开启后停笔自动在光标后透出一句浅灰建议；Tab 采纳才落进正文，继续打字即丢弃。
  const [companion, setCompanion] = useState(() => localStorage.getItem('novel-companion') === '1')
  const [companionLen, setCompanionLen] = useState<InlineSuggestLength>(() => {
    const v = localStorage.getItem('novel-companion-len')
    return v === 'short' || v === 'two' ? v : 'sentence'
  })
  const [companionDeAi, setCompanionDeAi] = useState(() => localStorage.getItem('novel-companion-deai') !== '0')
  /** ③ 作者自定义风格补充（本机记忆，默认空）——不设文风枚举，只留这一个自由口子 */
  const [companionStyleNote, setCompanionStyleNote] = useState(() => localStorage.getItem('novel-companion-style') || '')
  /**
   * ② 是否把《写作规范》（坏习惯清单 / 标点规范 / 视角规则）锚进伴写。
   * 默认开 —— 它比任何「文风枚举」都准；但有的作者不希望对白被自己列的规矩绑住，所以给一个关的入口。
   * （审计 2026-09-18 P1-8：弹窗文案早就写着「可关」，开关却一直没做。）
   */
  const [companionStyleSpec, setCompanionStyleSpec] = useState(() => localStorage.getItem('novel-companion-stylespec') !== '0')
  const [styleNotePrompt, setStyleNotePrompt] = useState(false)
  /** 当前 ghost 建议：null = 无建议；at = 该建议针对的光标位置（防止错位插入） */
  const [ghost, setGhost] = useState<{ text: string; at: number } | null>(null)
  const [ghostBusy, setGhostBusy] = useState(false)

  const ghostAbort = useRef<AbortController | null>(null)
  const ghostTimer = useRef<number | null>(null)
  /** 同前文 key → 建议（LRU 上限 20）：在同一位置反复停笔时不重复烧 token */
  const ghostCache = useRef(new Map<string, string>())
  /** 连续失败计数：满 GHOST_MAX_FAILS 次自动静默禁用（避免每次停笔都白等一轮超时） */
  const ghostFail = useRef(0)

  /** 设定资料 + 《写作规范》缓存（按章节失效）：ghost 请求要低延迟，不能每次重读全库 */
  // styleSpecOn 一并入缓存键：开关一翻，旧缓存里那份 styleSpec 就不能再用了
  const ghostCtxCache = useRef<{ chapterId: string; projectContext: string; styleSpec: string; styleSpecOn: boolean } | null>(null)

  // ============ 2.2.0 AI 伴写（ghost 逐句续写）============
  //
  // 交互对齐 WPS AI 伴写：停笔 → 光标后透出一句浅灰建议 → Tab 采纳 / 打字即丢弃。
  // 三条工程约束：
  //   · 采纳之前**正文一个字都没被改过**（ghost 只是画在叠层上的字），所以拒绝永远零破坏；
  //   · ghost 叠层与高亮叠层同层（均 z-0 + 透明基），盒模型逐项照抄高亮层，否则两图层必然错位；
  //   · **光标后已有正文时不显示** —— ghost 没有"宽度"，压到后面的字上会糊成一片。

  /** 取光标前 GHOST_CONTEXT_CHARS 字作前文（从 draftRef 读最新内容，避免闭包拿到旧值） */
  const ghostBefore = useCallback((at: number) => draftRef.current.slice(Math.max(0, at - GHOST_CONTEXT_CHARS), at), [draftRef])

  /** 拼 ghost 用的请求 key：同前文 + 同参数才复用缓存（useCallback：它是唯一依赖 state 的取值函数，
   *  进 effect 依赖数组才不会让伴写闭包读到旧的档位/开关） */
  const ghostKey = useCallback(
    (before: string) => `${companionLen}|${companionDeAi}|${companionStyleNote}|${before.slice(-600)}`,
    [companionLen, companionDeAi, companionStyleNote],
  )

  /**
   * 懒加载 ghost 用的上下文：《写作规范》摘录 + 设定资料摘要，按章节缓存。
   * 不放在每次请求里读全库——本地模型本来就慢，再叠一次全量读盘会明显拖长等待。
   */
  const loadGhostContext = useCallback(async (chapterId: string) => {
    const hit = ghostCtxCache.current
    if (hit && hit.chapterId === chapterId && hit.styleSpecOn === companionStyleSpec) return hit
    let styleSpec = ''
    // 关掉「参考写作规范」时整段不注入 —— 只靠前文样本与作者的文风补充来锚定
    if (companionStyleSpec) try {
      // 复用《写作规范》表（运营维护组）：作者自己写的坏习惯清单 / 标点规范 / 视角规则，
      // 比任何"文风枚举标签"都准，且零新增数据模型。
      const style = await db.getFormData('style')
      const pick = (name: string) => {
        const key = Object.keys(style || {}).find(k => k.endsWith(`::${name}`))
        return key ? (style[key] || '').trim() : ''
      }
      styleSpec = ([
        ['已知坏习惯清单', pick('已知坏习惯清单')],
        ['标点规范', pick('标点规范')],
        ['视角切换规则', pick('视角切换规则')],
      ] as const).filter(([, v]) => v).map(([k, v]) => `${k}：${v}`).join('\n')
    } catch { /* 读不到规范不算错，伴写照常可用 */ }
    let projectContext = ''
    try {
      // 2.2.0：换成伴写专用切片 —— 关掉「章节清单（目录）」与"相关章节召回"，
      // 只带 作品定位/世界设定/主要角色/名词术语，预算 900。
      // 原先用 buildProjectContext({budget:2000}) 时，章节目录会吃掉大半预算，
      // 而伴写已经有光标前正文了、根本不需要目录，真正该给的设定反而挤不进来。
      projectContext = await buildInlineBriefing()
    } catch { /* 没有设定摘要时退化为纯前文续写 */ }
    const next = { chapterId, projectContext, styleSpec, styleSpecOn: companionStyleSpec }
    ghostCtxCache.current = next
    return next
  }, [companionStyleSpec])

  /** 发起一次伴写请求（防抖后调用）。连续失败到阈值即熔断，不再打扰作者 */
  const fireGhost = useCallback(async (before: string, at: number, key: string) => {
    ghostAbort.current?.abort()
    const ac = new AbortController()
    ghostAbort.current = ac
    setGhostBusy(true)
    try {
      const ctx = await loadGhostContext(activeId ?? '')
      if (ac.signal.aborted) return
      const text = await aiInlineSuggest(before, {
        projectContext: ctx.projectContext,
        styleSpec: ctx.styleSpec,       // ② 《写作规范》负面清单（可关时上面已置空）
        styleNote: companionStyleNote,  // ③ 作者自定义补充
        length: companionLen,
        deAiFlavor: companionDeAi,
        signal: ac.signal,
      })
      if (ac.signal.aborted) return
      ghostFail.current = 0
      ghostCache.current.set(key, text)
      if (ghostCache.current.size > GHOST_CACHE_MAX) {
        const oldest = ghostCache.current.keys().next()
        if (!oldest.done) ghostCache.current.delete(oldest.value)
      }
      // 空串 = 模型没给出合适建议 → 静默不显示（宁缺毋滥：显示烂建议比不显示更烦人）
      if (text) setGhost({ text, at })
    } catch (e) {
      if (ac.signal.aborted || isCancelled(e)) return
      ghostFail.current += 1
      if (ghostFail.current >= GHOST_MAX_FAILS) {
        showToast(`AI 伴写已连续失败 ${GHOST_MAX_FAILS} 次，已自动停用（点工具栏钢笔键，在弹窗里重新开启）`, 'error')
      }
    } finally {
      if (!ac.signal.aborted) setGhostBusy(false)
    }
  }, [activeId, companionLen, companionDeAi, companionStyleNote, loadGhostContext])

  /**
   * 伴写主循环：光标 / 正文变化 → 800ms 防抖 → 请求 → 透出 ghost。
   * 前置条件全部满足才发请求：已开启 · 模型就绪 · 无选区 · 光标后无正文 · 前文够长 · 未熔断。
   */
  useEffect(() => {
    if (!companion || !aiReady || !activeId) { setGhost(null); return }
    if (ghostFail.current >= GHOST_MAX_FAILS) { setGhost(null); return }
    // 光标位置必须夹到当前正文长度内：切章后旧光标值可能越界，不夹会算出"指向章外"的建议
    const at = Math.min(caret, draftContent.length)
    // 刚被 Esc 拒掉、且位置与正文都没变 → 不重新请求（否则自动保存引起的重渲染会把建议弹回来）
    const d = ghostDismissed.current
    if (d && d.at === at && d.len === draftContent.length) { setGhost(null); return }
    const s = selRef.current
    // 三种情况一律不显示、并中断在途请求：有选区（整段要改，不打扰）/ 光标后已有正文（ghost 无处安放）/ 前文太短
    const blocked = (!!s && s.end > s.start) || draftContent.slice(at).trim() !== '' || ghostBefore(at).trim().length < 12
    if (blocked) {
      ghostAbort.current?.abort()
      setGhost(null)
      return
    }
    // 位置变了就撤掉旧建议（避免"建议属于旧光标位置"造成错位插入）
    setGhost(g => (g && g.at === at ? g : null))
    const key = ghostKey(ghostBefore(at))
    const cached = ghostCache.current.get(key)
    if (cached !== undefined) {
      if (cached) setGhost({ text: cached, at })
      return
    }
    const timer = window.setTimeout(() => { void fireGhost(ghostBefore(at), at, key) }, GHOST_DEBOUNCE_MS)
    ghostTimer.current = timer
    return () => {
      window.clearTimeout(timer)
      if (ghostTimer.current === timer) ghostTimer.current = null
    }
    // deps 里用 activeId 而不是 active：active 是 chapters.find(...) 的产物，自动保存一提交就换新对象，
    // 会让本 effect 白跑一轮并弹回刚被丢弃的建议（依赖 activeId 就不会因无关的列表更新而重跑）
  }, [companion, companionLen, companionDeAi, companionStyleNote, aiReady, activeId, draftContent, caret, ghostBefore, ghostDismissed, selRef, fireGhost, ghostKey])

  /**
   * 切章 / 卸载时必须清干净：ghost 是「针对某一章某个位置」算出来的，
   * 跨章残留会让 Tab 把上一章的建议插进新章的同一偏移处 —— 属于数据事故，别删这段。
   */
  useEffect(() => () => {
    ghostAbort.current?.abort()
    if (ghostTimer.current) window.clearTimeout(ghostTimer.current)
  }, [])
  useEffect(() => {
    setGhost(null)
    ghostAbort.current?.abort()
  }, [activeId])

  /** 丢弃建议：中断在途请求并清空 ghost（打字/Esc/移动光标都会走到这里） */
  const dismissGhost = (at = caret) => {
    ghostAbort.current?.abort()
    ghostDismissed.current = { at, len: draftRef.current.length }
    setGhost(null)
  }

  /**
   * 采纳建议：把 ghost 文本插到它所属的光标位置。
   * 走 onContentChange（受控组件 + 保住自动保存链路），插入后把光标移到插入点之后。
   * @returns 是否真的采纳了（供按键处理决定要不要 preventDefault）
   */
  const acceptGhost = () => {
    if (!ghost) return false
    // 再夹一次：从"算出建议"到"按下 Tab"之间，正文理论上不会变（变了就会清掉 ghost），
    // 但夹一次的成本是零，换来的是绝不可能越界写入。
    const at = Math.min(ghost.at, draftContent.length)
    const next = draftContent.slice(0, at) + ghost.text + draftContent.slice(at)
    const pos = at + ghost.text.length
    setGhost(null)
    onContentChange(next)
    // 受控组件：要等 React 把新 value 写回 textarea 之后才能设光标位置
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.setSelectionRange(pos, pos)
      selRef.current = { start: pos, end: pos }
      setCaret(pos)
    })
    return true
  }

  /** 编辑器按键：先处理伴写的采纳/丢弃/手动触发，其余按键原样放行 */
  const onEditorKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && ghost) { dismissGhost(taRef.current?.selectionStart ?? caret); return }
    // Tab 采纳（必须 preventDefault，否则 textarea 默认会跳焦点）
    if (e.key === 'Tab' && ghost && !e.shiftKey && acceptGhost()) { e.preventDefault(); return }
    // → 采纳：仅当光标已在正文末尾（避免与"向右移光标"的日常操作打架）
    if (e.key === 'ArrowRight' && ghost) {
      const ta = taRef.current
      if (ta && ta.selectionStart === draftContent.length && acceptGhost()) { e.preventDefault(); return }
    }
    // 手动触发 Alt+\（复刻 WPS 的手动伴写键）：重置熔断并立即请求，不等防抖
    if (e.altKey && (e.key === '\\' || e.code === 'Backslash')) {
      e.preventDefault()
      ghostFail.current = 0
      const at = taRef.current?.selectionStart ?? caret
      const before = ghostBefore(at)
      if (before.trim().length >= 12) void fireGhost(before, at, ghostKey(before))
      return
    }
  }

  /**
   * ghost 叠层是新挂载的 div，scrollTop 恒为 0 —— 不回填就会与正文错位。
   * （原实现在编辑器的统一回填 effect 里、与高亮层共用一次 `syncHighlightScroll`；
   *   D4-2 拆出后由本 hook 自己负责 ghost 这一半，两侧回填来源同为 `textarea.scrollTop`。）
   */
  useLayoutEffect(() => {
    if (taRef.current && ghostRef.current) ghostRef.current.scrollTop = taRef.current.scrollTop
  }, [ghost, taRef, ghostRef])

  return {
    companion, setCompanion, companionLen, setCompanionLen, companionDeAi, setCompanionDeAi,
    companionStyleNote, setCompanionStyleNote, companionStyleSpec, setCompanionStyleSpec,
    styleNotePrompt, setStyleNotePrompt, ghost, ghostBusy, dismissGhost, onEditorKeyDown,
  }
}
