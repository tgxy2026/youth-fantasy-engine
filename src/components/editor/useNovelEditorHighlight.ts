/**
 * 正文编辑器 · **引用名内联高亮**（从 `useNovelEditorModel.ts` 拆出来的，2026-09-19 D4-2）。
 *
 * 【职责】可用引用名的装载 → 120ms 防抖镜像 → 一次扫描同时产出「叠层 HTML」与「命中集合」
 *   → 叠层与 textarea 的滚动对齐（rAF 合并 + 尺寸变化 + 卸载清帧）。
 *
 * 🔴 三条不能丢的约束：
 *   · 叠层只走 `scanRefHighlight`（盒模型与 textarea 逐项一致的前提）；
 *   · 镜像值 120ms 防抖 —— 逐键全量重算长文会直接卡输入；
 *   · ⚠️ 叠层是 `dangerouslySetInnerHTML` 整块重建的，DOM 一换 scrollTop 就被重置为 0，
 *     凡是会让叠层重排/重建的因素（HTML / 切章 / 字号 / 页宽 / 专注 / 检索栏）都要在绘制前回填。
 *     （原实现把「ghost 叠层回填」也塞在同一 effect 里，拆出后归 `useNovelEditorGhost` 自己管 ——
 *      两者回填的都是同一来源 `textarea.scrollTop`，拆分不改变结果。）
 */
import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect, type RefObject } from 'react'
import * as db from '@/lib/db'
import { TABS } from '@/lib/schema'
import { readAliases } from '@/lib/settings/aliases'
import { scanRefHighlight, type RefName } from '@/components/editor/novelEditorHelpers'
import { usePersistedBool } from '@/lib/settings/uiPrefs'

type HighlightArgs = {
  /** 当前章正文（由调用方做 120ms 防抖镜像，见下方 deferredContent） */
  draftContent: string
  activeId: string | null
  fontSize: number
  pageWide: boolean
  focusMode: boolean
  showSearch: boolean
  /** 正文 textarea（滚动锚点） */
  taRef: RefObject<HTMLTextAreaElement>
  /** 伴写 ghost 叠层（与高亮层同层，必须同步滚动） */
  ghostRef: RefObject<HTMLDivElement>
  /** 编辑区滚动容器（ResizeObserver 观察对象） */
  scrollRef: RefObject<HTMLDivElement>
}

export function useNovelEditorHighlight({
  draftContent, activeId, fontSize, pageWide, focusMode, showSearch, taRef, ghostRef, scrollRef,
}: HighlightArgs) {
  // v1.3 编辑器体验：本章引用侧栏 + 内联高亮
  const [showRefs, setShowRefs] = usePersistedBool('editor-show-reference-sidebar', false)
  // 2.2.0：引用名内联高亮改为**默认关闭**（长章节全量着色太吵视线，需要时手动开）
  const [highlightOn, setHighlightOn] = usePersistedBool('editor-reference-highlight', false)
  const [refNames, setRefNames] = useState<RefName[]>([])
  const highlightRef = useRef<HTMLDivElement>(null)

  // 高亮叠层/引用命中等重计算与正文输入解耦：用 120ms 防抖的镜像值，避免每次按键全量重算长文卡顿
  const [deferredContent, setDeferredContent] = useState<string>('')
  useEffect(() => {
    const t = setTimeout(() => setDeferredContent(draftContent), 120)
    return () => clearTimeout(t)
  }, [draftContent])

  // v1.3：加载可用引用名（角色卡 + 世界构建各设定表的条目名称），供本章引用侧栏与内联高亮
  // v1.6：别称一并登记（aliasOf 指向原本名称）——正文出现别称时同样高亮，并归入原名条目
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const names: RefName[] = []
      for (const tabId of ['char-main', 'char-secondary', 'char-npc']) {
        const recs = await db.getCardRecords(tabId)
        for (const r of recs) {
          if (r.name && r.name.trim()) {
            const nm = r.name.trim()
            names.push({ name: nm, type: 'character', tabId })
            for (const a of readAliases(tabId, r.data)) {
              if (a !== nm) names.push({ name: a, type: 'character', tabId, aliasOf: nm })
            }
          }
        }
      }
      // 世界构建组下的全部设定表（国家/地理/种族/物品/历史/术语…）均以 displayCol 作为条目名称参与高亮
      for (const tab of TABS.filter(t => t.group === '世界构建' && t.type === 'table' && t.displayCol)) {
        const recs = await db.getTableRows(tab.id)
        for (const r of recs) {
          const v = r.data[tab.displayCol as string]
          if (v && v.trim()) {
            const nm = v.trim()
            names.push({ name: nm, type: 'setting', tabId: tab.id })
            for (const a of readAliases(tab.id, r.data)) {
              if (a !== nm) names.push({ name: a, type: 'setting', tabId: tab.id, aliasOf: nm })
            }
          }
        }
      }
      if (!cancelled) setRefNames(names)
    })()
    return () => { cancelled = true }
  }, [])

  /**
   * 高亮扫描：一次联动同时产出「叠层 HTML」与「命中集合」，基于 120ms 防抖镜像避免逐键重算。
   * （旧实现这里先 filter/include 全扫一遍、再拼 HTML 又扫一遍，长章节卡顿的根因）
   */
  const refScan = useMemo(
    () => scanRefHighlight(deferredContent, refNames.map(r => r.name)),
    [deferredContent, refNames]
  )
  const highlightHTML = refScan.html
  /** 当前章节正文里命中的引用名（用于侧栏）——直接取扫描结果，不再做第二次全文 includes */
  const referenced = useMemo(
    () => refNames.filter(r => refScan.hits.has(r.name)),
    [refNames, refScan]
  )

  /** 高亮叠层 / 伴写 ghost 叠层跟随 textarea 滚动（三者必须同滚动位置，否则文字与正文错位） */
  /**
   * 只读三个 ref 与常量 ⇒ 依赖为空也不会陈旧；改 useCallback 是为了能如实列进下面两个
   * effect 的依赖数组（拆分前它们是本地 useRef、规则能自动认定稳定，故无需显式声明）。
   */
  const syncHighlightScroll = useCallback(() => {
    if (!taRef.current) return
    const top = taRef.current.scrollTop
    if (highlightRef.current) highlightRef.current.scrollTop = top
    if (ghostRef.current) ghostRef.current.scrollTop = top
  }, [ghostRef, taRef])
  /** scroll 事件频率极高：用 rAF 合并同帧的多次同步，避免滚动时每个像素都写一次布局 */
  const scrollSyncRafRef = useRef(0)
  const scheduleHighlightSync = () => {
    if (scrollSyncRafRef.current) return
    scrollSyncRafRef.current = requestAnimationFrame(() => {
      scrollSyncRafRef.current = 0
      syncHighlightScroll()
    })
  }
  /**
   * ⚠️ 关键修复（2.0.1）：叠层是 dangerouslySetInnerHTML 整块重建的，DOM 一换 scrollTop 就被浏览器
   * 重置为 0，而 textarea 停在原位 → 画面与稿件错位，滚到中后段时可视区一片空白（老大反馈的
   * 「上下滑动查看时经常不显示文本」）。凡是会让叠层重排/重建的因素都要在绘制前回填一次。
   */

  /**
   * ⚠️ 关键修复（2.0.1）：叠层是 dangerouslySetInnerHTML 整块重建的，DOM 一换 scrollTop 就被浏览器
   * 重置为 0，而 textarea 停在原位 → 画面与稿件错位，滚到中后段时可视区一片空白（老大反馈的
   * 「上下滑动查看时经常不显示文本」）。凡是会让叠层重排/重建的因素都要在绘制前回填一次。
   *
   * （D4-2 拆出：原 deps 里还有 `ghost`，已移交 `useNovelEditorGhost` 自己的 layout effect。）
   */
  useLayoutEffect(() => {
    syncHighlightScroll()
    // 🔴 必须含 highlightOn：高亮层是**条件渲染**（`{highlightOn && …}`），从关到开时它才新挂载，
    //    而新 DOM 的 scrollTop 恒为 0。少了这个依赖，effect 不重跑 → 叠层停在顶部、与正文错位
    //    （正文滚在中后段时可视区一片空白，正是 2.0.1 修过的那个"上下滑动不显示文本"）。
  }, [highlightHTML, activeId, fontSize, pageWide, focusMode, showSearch, highlightOn, syncHighlightScroll])

  /** 编辑区尺寸变化（窗口缩放、检索栏开合）时同样需要对齐叠层 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => syncHighlightScroll())
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollRef, syncHighlightScroll])

  /** 卸载时清理尚未执行的同步帧，避免在已卸载的 ref 上写值 */
  useEffect(() => () => {
    if (scrollSyncRafRef.current) cancelAnimationFrame(scrollSyncRafRef.current)
  }, [])

  return {
    showRefs, setShowRefs, highlightOn, setHighlightOn, highlightRef, setDeferredContent,
    highlightHTML, referenced, syncHighlightScroll, scheduleHighlightSync,
  }
}
