/**
 * 正文编辑器的**状态与生命周期**（从 `NovelEditor.tsx` 拆出来的，2026-09-19；D4-2 二次拆分）。
 *
 * 【为什么这么拆】原文件 1764 行：逻辑 929 行 + 视图 652 行，JSX 直接用到 96 个
 *   组件作用域名字（全组件声明 152 个）。正文编辑器又是全项目最怕回归的地方
 *   （叠层盒模型、光标同步、卸载冲刷草稿都在这儿），所以拆法选**只搬不改**：
 *   把状态 / effect / 动作整体收进来，视图侧同名解构接回去 —— JSX 一个字不动。
 *
 * 【D4-2 二次拆分（2026-09-19）】本文件一度 1132 行，按「不碰 React 的 / 只服务一个功能的 / 其余」
 *   三层切开，同样只搬不改、同名解构接回：
 *   · `novelEditorHelpers.ts`    — 纯函数与常量（含 🔴 `scanRefHighlight`、卷章重排、ghost 阈值）；
 *   · `useNovelEditorHighlight.ts` — 引用名高亮：扫描 + 叠层滚动对齐；
 *   · `useNovelEditorGhost.ts`     — AI 伴写：防抖 / 缓存 / 熔断 / 采纳；
 *   · 本文件保留章节·卷·字数主链路与装配。
 *
 * 🔴 搬动时逐条保住的红线：
 *   · 高亮只走 `scanRefHighlight`（叠层与 textarea 盒模型逐项一致的前提）；
 *   · ghost 在**切章时必须清掉**（否则 Tab 会把上一章的建议插进新章 → 数据事故）；
 *   · 卸载时冲刷未保存草稿（`key={activeId}` 重挂时唯一可靠的落点）；
 *   · 界面缩放生效：量尺寸用 offsetHeight/clientWidth，绝不 getBoundingClientRect。
 */
import { useEffect, useState, useCallback, useRef, useMemo, useLayoutEffect } from 'react'
import type { Volume, Chapter } from '@/lib/types'
import * as db from '@/lib/db'
import { uid } from '@/lib/app/id'
import { countWords } from '@/lib/editor/textStats'
import { registerEditorDraftFlush, flushEditorDraftNow } from '@/lib/editor/draftFlush'
import { useEditorLeaveBarrier } from '@/components/editor/useEditorLeaveBarrier'
import { useShortWritingArea } from '@/components/editor/useShortWritingArea'
import { captureWorkspaceView } from '@/lib/settings/workspaceRuntime'
import { todayKey } from '@/lib/app/date'
import { useResizable } from '@/lib/app/useResizable'
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import { saveFailureMessage } from '@/lib/app/saveFailureHint'
import { foldPendingAi, type AiSourceKind, type PendingAiNote } from '@/lib/ai/aiAssist'

// 导出模块（zip/EPUB/DOCX 打包器较重）——改为按需动态导入，避免拖入首屏主包

import { ADVICE_START, ADVICE_END } from '@/components/jiewenji/JieWenJi'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { type VisCtx, refreshVolumeTabs } from '@/lib/schema'
import { chapterSeqOf, chapterSeqMap, flattenAll } from '@/lib/outline/chapterSeq'
import { syncChapterMaster } from '@/lib/outline/chapterMaster'
import { useAIReady } from '@/lib/ai/useAIReady'
import { readSetPref, writeSetPref, readStringPref, writeStringPref, usePersistedBool, usePersistedEnum } from '@/lib/settings/uiPrefs'
import { DEFAULT_INDENT_UNIT, INDENT_UNIT_IDS, type IndentUnit } from '@/lib/editor/indent'
import { aiChapterSummary } from '@/lib/ai/aiTasks'
import { useTaskRunner } from '@/lib/ai/aiTaskCenter'
import { DESKTOP, getDesktopState, subscribeDesktop } from '@/lib/app/desktop'
import { getPortableState, subscribePortable } from '@/lib/storage/fileBackend'
import { autoIndexChapter, chapterFingerprint } from '@/lib/semantic/indexer'
import {
  reorderVolumes, reorderChapters, moveChapterToVolume, resyncChapterMasterNumbers,
  GHOST_CONTEXT_CHARS, orderedChapters,
} from '@/components/editor/novelEditorHelpers'
import { isFreeVolume, realVolumes, ensureFreeVolume, findFreeVolume, nextVolumeOrder } from '@/lib/outline/freeVolume'
import { useEditorChapterTarget } from '@/components/editor/useEditorChapterTarget'
import { runRegenSummaries, regenSummaryText, type RegenOutcome } from '@/components/editor/regenSummaries'
import { createEditorKeyboardReorder } from '@/components/editor/editorKeyboardReorder'
import { useNovelEditorHighlight } from '@/components/editor/useNovelEditorHighlight'
import { useNovelEditorGhost } from '@/components/editor/useNovelEditorGhost'

type Args = {
  /** 项目名（导出文件名 / 提示词里用） */
  projectName: string
  /** 可见性上下文：lite 形态与跨表引用范围 */
  ctx: VisCtx
  /** 顶层要求打开的章（跨页签跳转带下来） */
  openChapterId?: string | null
  openRequestId?: number
  /** 字数变化上报 */
  onStatsChange?: () => void
}

export function useNovelEditorModel({ ctx, openChapterId, openRequestId, onStatsChange }: Args) {
  const isLite = ctx.type !== 'full'
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // ---- 卷展开/折叠态的持久化（2.6.1 社区反馈：新增章节会把已折叠的卷强制展开）----
  // 现状病灶：load() 每次都 setExpanded(全部卷)，而增删卷章 / 改名都走 load()，
  // 用户手动折叠的卷会被整体掀开；切页签（编辑器卸载重挂）也一样中招。
  // 修法：折叠偏好按项目存 localStorage（uiPrefs 红线：存「偏离默认的那一侧」＝已折叠集合），
  // 重载只并入新出现的卷，绝不整体重置。
  const expandedRef = useRef<Set<string>>(new Set())
  const volumesRef = useRef<Volume[]>([])
  volumesRef.current = volumes
  /** 见过的卷 id 集合：区分「新出现的卷」（应默认展开）与「用户手动折叠的卷」（必须保留折叠）。
   *  null = load 首跑还没完成，展开态初始化交给 load。 */
  const seenVolIdsRef = useRef<Set<string> | null>(null)
  // 挂载即锁定项目 id（App.tsx 以 key={proj-${projectId}} 挂整树，切项目必重挂 ⇒ 键不会串项目）
  const projectId = db.getCurrentProjectId()
  const collapsedPrefKey = `editor-vol-collapsed:${projectId}`
  const lastChapterPrefKey = `editor-last-chapter:${projectId}`
  /** 把最终展开态写回持久化（写的是补集＝已折叠集合，死卷 id 顺手清掉） */
  const persistCollapsed = useCallback((next: Set<string>, allVolIds: string[]) => {
    writeSetPref(collapsedPrefKey, allVolIds.filter(id => !next.has(id)))
  }, [collapsedPrefKey])
  /** setExpanded 的持久化包装：签名保持 Dispatch 兼容，树组件的折叠按钮零改动。
   *  用 expandedRef 镜像而非 updater 内写盘 —— load 场景下 volumes state 尚未提交，拿不到全集。 */
  const setExpandedPersist = useCallback((action: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof action === 'function' ? action(expandedRef.current) : action
    expandedRef.current = next
    setExpanded(next)
    persistCollapsed(next, volumesRef.current.map(v => v.id))
  }, [persistCollapsed])
  // 拖拽排序状态：分卷 / 章节拖动时记录源与目标位置（v1.6.3）
  const [dragKind, setDragKind] = useState<null | 'vol' | 'ch'>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<null | { kind: 'vol' | 'ch'; id: string; pos: 'before' | 'after' }>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  /**
   * 🔴 3.2.2 · 审计 D4（P2）：底部状态栏**不能只看"内存提交成功"就说「已保存」**。
   *
   * 现场：把数据文件设为只读后，全局存储栏显示「保存出错」（EPERM），而正文底部仍亮着绿色
   * 「已保存」—— 同一个界面两种结论，作者不知道信哪个。根因是这两处读的不是同一个事实：
   * `savedFlash` 只代表「已交给存储层（内存/IDB）」，真正落盘是之后的防抖写。
   * ⇒ 这里订阅**真实落盘状态**：有错就压过「已保存」，还在写就显示「正在写入」。
   */
  const [diskError, setDiskError] = useState('')
  const [diskPending, setDiskPending] = useState(false)
  useEffect(() => {
    const sync = () => {
      if (DESKTOP) {
        const s = getDesktopState()
        setDiskError(s.lastError || (s.writeLocked ? s.writeLockReason : ''))
        setDiskPending(s.dirty || s.saving)
      } else {
        const s = getPortableState()
        setDiskError(s.lastError || (s.writeLocked ? s.writeLockReason : ''))
        setDiskPending(s.dirty || s.saving)
      }
    }
    sync()
    return DESKTOP ? subscribeDesktop(sync) : subscribePortable(sync)
  }, [])
  const [focusMode, setFocusMode] = useState(false)
  /**
   * 设定检索栏显隐（编辑器右上「面板」按钮）。
   *
   * 🔴 3.0.4：从 `useState(true)` 改成**持久化**（走 uiPrefs 的 `yfe-ui:` 命名空间）。
   *    原先它只是内存 state，而编辑器会随**页签切换**整体卸载 ⇒ 作者点「隐藏检索栏」后，
   *    一旦切到别的页签再回来，那一栏又冒出来了（社区反馈）。
   *    这里存的语义是「检索栏**是否显示**」，默认显示；与同文件 `editor-paste-normalize`
   *    等偏好同一套读写法（localStorage，只服务本机这个人的界面习惯，不进项目数据、
   *    不随导出 / 云同步走）。
   *    ⚠️ 默认值必须给 `true`：老用户没有这条记录时要落到「显示」，
   *    不能因为"记录里没有"就变成隐藏。
   */
  const [showSearch, setShowSearch] = usePersistedBool('editor-show-search', true)
  const [loaded, setLoaded] = useState(false)
  const [modal, setModal] = useState<null | 'sensitive' | 'history' | 'trash' | 'search' | 'lock' | 'foreshadow' | 'continuity' | 'typo' | 'style' | 'format'>(null)
  /**
   * 编辑器的缩进单位（2.4.0 · A5）：按 Tab 缩进一级、回车继承缩进、粘贴归一、以及
   * 「统一为段首缩进」都用它。走 uiPrefs（`yfe-ui:` 命名空间）⇒ 只服务"这台机器上这个人的排版习惯"，
   * 不进项目数据、不随导出 / 云同步走。
   */
  const [indentUnit, setIndentUnit] = usePersistedEnum<IndentUnit>('editor-indent-unit', INDENT_UNIT_IDS, DEFAULT_INDENT_UNIT)
  // 粘贴归一开关（A5 遗留补全）：默认开 —— 从网页 / Word 粘进来的 2 空格会按当前单位归一；
  // 关掉则**原样保留**（总有作者希望粘贴内容一字不动，尤其是要贴代码或表格时）。
  const [pasteNormalize, setPasteNormalize] = usePersistedBool('editor-paste-normalize', true)
  // 段首缩进参考线（A5 遗留补全）：默认关 —— 它只是视觉辅助，多数时候写作不需要；
  // 开启后在每级缩进处画一条极淡的竖线，方便对齐多级缩进（对白 / 补充说明那一类）。
  const [indentGuides, setIndentGuides] = usePersistedBool('editor-indent-guides', false)

  /** 光标位置（state 版）：点击/按键把光标挪到新位置时也要重新触发一次伴写 */
  const [caret, setCaret] = useState(0)
  const ghostRef = useRef<HTMLDivElement>(null)

  /**
   * Esc 丢弃后记下「光标位置 + 当时正文长度」。
   * 为什么需要它（2026-09-17 实机验证抓到）：自动保存在停笔 2 秒后提交，`chapters` 一更新
   * `active` 就是新对象 → 伴写 effect 重跑 → 刚被 Esc 拒掉的建议又被弹回来。作者会觉得"Esc 根本没用"。
   * 只有光标真的动了、或正文真的变了（长度变化）才允许再次自动请求。
   */
  const ghostDismissed = useRef<{ at: number; len: number } | null>(null)

  // draftContent：当前章节的未保存内容（draftRef 同步镜像，供自动保存定时器读取最新值，防止 2 秒防抖期间 updateContent 的改动被旧值覆盖）
  const [draftContent, setDraftContent] = useState<string>('')
  const draftRef = useRef('')

  const [saving, setSaving] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  /** C6（2.4.2）：导出格式弹窗（'platform' 粘贴版 / 'markdown'），null = 关闭 */
  const [exportFormatTab, setExportFormatTab] = useState<'platform' | 'markdown' | 'docx' | null>(null)
  /** 3.0.1：正文批量导入弹窗开合（独立 state，不塞进 modal 联合类型） */
  const [importOpen, setImportOpen] = useState(false)
  /** 导出操作统一收口：按需动态加载 exporter 模块（含 zip/EPUB/DOCX 打包器），避免拖入首屏主包 */
  const runExport = useCallback(async (fn: (m: typeof import('@/lib/storage/exporter')) => void) => {
    const m = await import('@/lib/storage/exporter')
    fn(m)
    setExportOpen(false)
  }, [])
  // 码字体验：字号 / 打字机模式 / 今日码字
  const [fontSize, setFontSize] = useState<number>(() => {
    const v = Number(localStorage.getItem('novel-font-size'))
    return Number.isFinite(v) && v >= 14 && v <= 28 ? v : 17
  })
  const [typewriter, setTypewriter] = useState(() => localStorage.getItem('novel-typewriter') === '1')
  // 页宽：'1' = 码字区铺满窗口（默认）；'0' = 限制为舒适阅读宽度
  const [pageWide, setPageWide] = useState(() => localStorage.getItem('novel-page-wide') !== '0')
  const [todayWords, setTodayWords] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout>>()
  const flashTimer = useRef<ReturnType<typeof setTimeout>>()
  const metaTimer = useRef<ReturnType<typeof setTimeout>>()
  // 🔴 待冲刷的元信息（标题/摘要）落库任务，**按章节 id 分别记账**（审计 2026-09-18 P2-8）。
  //    原先只存一个「最新那笔」的 metaFlush：改本章标题后 600ms 内切到别章再改标题，
  //    clearTimeout 会把前一次待落库的补丁**直接丢掉** —— 它只活在 chapters 状态里，
  //    重载即失（切章改标题是很常见的动作，不是极端场景）。
  //    按 id 记账后：同一章的补丁互相覆盖（保住防抖），跨章的各存一份，到点一起冲。
  const metaPending = useRef(new Map<string, () => Promise<void>>())
  /**
   * 把所有待落库的元信息补丁一起冲刷（防抖到点、组件卸载、离页屏障都走它；引用稳定，
   * 卸载 effect 依赖为空也不怕）。
   *
   * 🔴 3.3.0 · UX06：原来的实现是 `j().catch(() => {})` —— **单笔失败被吞、队列照样清空**。
   *    配上「清完就没人知道这笔记账」⇒ 标题/摘要的落库失败是**完全静默**的：界面显示新标题，
   *    库里还是旧的，重启即回退。现在改成：
   *      · 逐笔收集失败并**返回成败**，由调用方决定是否放行离页 / 是否提示；
   *      · 失败的那笔记账**放回队列**（同章覆盖语义不变），下一轮编辑或下一次离页会重试，
   *        而不是「报一次就算了、这一笔从此消失」。
   *    仍然保持「单笔失败不阻断其余」——省得一个坏章节把别的章一起卡住。
   */
  const metaFlush = useRef<() => Promise<{ ok: boolean; errors: unknown[] }>>(async () => {
    const jobs = [...metaPending.current.entries()]
    metaPending.current.clear()
    const errors: unknown[] = []
    await Promise.all(jobs.map(async ([id, job]) => {
      try {
        await job()
      } catch (e) {
        errors.push(e)
        // 期间又有新编辑入账时，以新那笔为准（新的补丁含旧补丁的全部键，重试不会回退）
        if (!metaPending.current.has(id)) metaPending.current.set(id, job)
      }
    }))
    return { ok: errors.length === 0, errors }
  })
  // 章节树 / 设定检索栏宽度可拖拽调整（持久化）
  // 🔴 3.1.2 视觉巡检 A 条：1440 视口下「章节树 320 + 检索栏 480」把正文列挤到只剩 317px（一行约 25 字）。
  //    两栏默认值同步收窄（检索栏 360→320 / 大屏 480→400；章节树大屏 300→280），先把码字区还回来。
  const chapterPane = useResizable({ key: 'yfe-chapter-w', initial: 224, initialWide: 280, min: 200, max: 560, side: 'right' })
  const searchPane = useResizable({ key: 'yfe-search-w', initial: 320, initialWide: 400, min: 280, max: 760, side: 'right' })

  /**
   * 正文列保底（A 条真正的一劳永逸解法）：
   *   只改默认值对**已经拖过/存过宽度的老用户不生效**（localStorage 里躺着 480），
   *   所以这里按「三栏容器实测宽度」给检索栏算一个**可用额度**：
   *     检索栏实际宽度 = min(用户设定值, max(检索栏下限 280, 容器宽 − 章节树 − 正文保底 560))
   *   宽屏下额度充裕 ⇒ 与用户设定值逐像素一致（**不改任何人的既有布局**）；
   *   窄屏下才把检索栏压回去，优先保住码字区不被挤成一条缝。
   * ⚠️ 压的只是**渲染宽度**，不写回 localStorage —— 用户拖出来的偏好原样留着，窗口一放大它自己就回来了。
   */
  const MAIN_MIN_W = 560
  const SEARCH_MIN_W = 280
  const [wrapW, setWrapW] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  // 🔴 依赖必须带 `loaded`：本组件的 JSX 在 `!loaded` 时走 LoadingState，**那时 wrapRef 还没挂上**
  //    （.current === null）。依赖写成 [] 的话，effect 只在挂载时白跑一趟、之后再也不重跑
  //    ⇒ wrapW 恒为 0 ⇒ 正文列保底与铺满开关判断全部失效（2026-10-18 实测踩到）。
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const read = () => setWrapW(el.clientWidth)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loaded])
  const { shortBody, minHeight: BODY_MIN_H } = useShortWritingArea(scrollRef, loaded) // 🔴 量正文壳，不是三栏区
  const sideW = focusMode ? 0 : chapterPane.size
  const chapterCompact = wrapW > 0 && wrapW < 760
  const searchFits = wrapW === 0 || wrapW - (chapterCompact ? 0 : sideW) >= MAIN_MIN_W + SEARCH_MIN_W
  const searchPaneW = (focusMode || !showSearch)
    ? 0
    : (wrapW > 0
      ? Math.min(searchPane.size, Math.max(SEARCH_MIN_W, wrapW - sideW - MAIN_MIN_W))
      : searchPane.size)
  /** 正文列实际宽度（用于判断「铺满 / 限宽」开关是否还有意义） */
  const mainColW = wrapW > 0 ? Math.max(0, wrapW - sideW - searchPaneW) : 0
  /**
   * 「铺满 / 限宽」开关是否显示：
   *   限宽的实现是给正文列挂 `max-w-3xl`(768px) / `max-w-5xl`(1024px) ——
   *   **正文列本身就窄于 768px 时这个上限根本不生效**，点了界面纹丝不动（死开关，只会让人以为坏了）。
   *   故只在正文列 ≥ 900px（比 768 留一档余量，保证切换看得出差别）时才把它显示出来；
   *   其余情况一律「默认铺满」——与主人拍板的方向一致，且不砍掉宽屏用户的能力。
   */
  const showPageWide = mainColW >= 900

  // ---- 引用名内联高亮（D4-2 拆出，同名解构接回；下游代码一个字没改）----
  const {
    showRefs, setShowRefs, highlightOn, setHighlightOn, highlightRef, setDeferredContent,
    highlightHTML, referenced, syncHighlightScroll, scheduleHighlightSync,
  } = useNovelEditorHighlight({
    draftContent, activeId, fontSize, pageWide, focusMode, showSearch, taRef, ghostRef, scrollRef,
  })


  // 重载卷与章节（初始化与跨视图卷变更事件共用）；返回最新数据供调用方做额外处理
  const reloadVolumes = useCallback(async (): Promise<[Volume[], Chapter[]]> => {
    const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    setVolumes(vols)
    setChapters(chs)
    await refreshVolumeTabs() // 同步卷台账缓存，让侧栏「章节总表」下的各卷子项保持最新
    return [vols, chs]
  }, [])

  /** 打开项目时的落点章：上次编辑位置 > 最近更新的章 > null（调用方兜底第一卷第一章）。
   *  2.6.1 社区反馈：每次打开项目都落在第一卷第一章，写到第三卷的作者每次都得手动翻回去。 */
  const pickInitialChapter = useCallback((chs: Chapter[]): Chapter | null => {
    if (chs.length === 0) return null
    const remembered = readStringPref(lastChapterPrefKey)
    if (remembered) {
      const hit = chs.find(c => c.id === remembered)
      if (hit) return hit
    }
    let latest = chs[0]
    for (const c of chs) if (c.updatedAt > latest.updatedAt) latest = c
    return latest
  }, [lastChapterPrefKey])

  const load = useCallback(async () => {
    const [vols, chs] = await reloadVolumes()
    if (vols.length > 0) {
      const allVolIds = vols.map(v => v.id)
      const targetCh = pickInitialChapter(chs)
      const targetVolId = targetCh?.volumeId ?? null
      // 🔴 展开态分两条路（2.6.1 社区反馈：新增章节会把已折叠的卷强制展开）：
      //   · 首次加载（挂载后第一跑）→ 以持久化的「已折叠集合」为准（没记录 = 全展开，
      //     与旧版首次行为一致）；落点章所在卷强制展开，保证树上看得到高亮；
      //   · 后续重载（增删卷章 / 改名都会走这里）→ **保留当前展开态**，只把新出现的卷
      //     默认展开，绝不整体重置 —— 否则用户手动折叠的卷会被 load 无条件掀开。
      if (!seenVolIdsRef.current) {
        const collapsed = new Set(readSetPref(collapsedPrefKey) ?? [])
        const next = new Set(allVolIds.filter(id => !collapsed.has(id)))
        if (targetVolId) next.add(targetVolId)
        expandedRef.current = next
        setExpanded(next)
        persistCollapsed(next, allVolIds)
      } else {
        // 重载只展开「新出现的卷」；落点章所在卷**不**在此处强制展开 ——
        // 否则「折叠当前编辑章所在卷 → 改名别的卷 → load」会把刚折叠的卷又掀开（同一 bug 换入口复发）。
        // 需要定位展开的场景（新建章 / 跨页签跳转）由各自入口显式处理。
        const seen = seenVolIdsRef.current
        const fresh = allVolIds.filter(id => !seen.has(id))
        if (fresh.length > 0) {
          const next = new Set(expandedRef.current)
          for (const id of fresh) next.add(id)
          expandedRef.current = next
          setExpanded(next)
          persistCollapsed(next, allVolIds)
        }
      }
      seenVolIdsRef.current = new Set(allVolIds)
      if (chs.length > 0) {
        // 函数式更新：避免闭包中的过期 activeId 导致新增卷后当前章节被重置
        setActiveId(cur => cur ?? targetCh?.id ?? null)
      }
    }
    setLoaded(true)
  }, [reloadVolumes, pickInitialChapter, collapsedPrefKey, persistCollapsed])

  // 跨视图联动：在「章节总表」侧栏增/删/改卷后，本编辑器章节管理需同步刷新卷列表
  useEffect(() => {
    const onVol = () => {
      void reloadVolumes().then(([vols]) => {
        // 总表侧新增的卷在树里默认展开（seen 里没有 = 新卷）。用 seen 而非 expandedRef 判定，
        // 否则「用户在树里折叠了卷 → 总表改个名」会把折叠的卷误判成新卷再掀开。
        const seen = seenVolIdsRef.current
        if (!seen) return // load 首跑还没完成，初始化交给 load
        const fresh = vols.filter(v => !seen.has(v.id))
        if (fresh.length > 0) {
          for (const v of fresh) seen.add(v.id)
          setExpandedPersist(prev => {
            const n = new Set(prev)
            for (const v of fresh) n.add(v.id)
            return n
          })
        }
      })
    }
    window.addEventListener('yfe:volumes-changed', onVol)
    return () => window.removeEventListener('yfe:volumes-changed', onVol)
  }, [reloadVolumes, setExpandedPersist])

  // 今日码字量（保存后刷新）
  const loadTodayWords = useCallback(async () => {
    const stats = await db.getDailyStats()
    setTodayWords(stats.find(s => s.date === todayKey())?.words ?? 0)
  }, [])

  // load / loadTodayWords 均为「依赖链上全是空依赖」的稳定 useCallback
  // （load → reloadVolumes → []），补进依赖数组不会引发重复执行，仅让 lint 有据可依。
  useEffect(() => { load(); loadTodayWords() }, [load, loadTodayWords])


  // 从其他页签跳转进来时，直接打开目标章节
  // 🔴 只消费一次（2026-10-17 审计 P2）：依赖数组带 `chapters` 会让每次保存都重跑并无条件
  //    setActiveId(openChapterId)，把作者手动切到的章弹回目标章。按 id 记账只消费一次；
  //    章还没加载出来时保留 `chapters` 依赖做一次重试（不消费就不会被弹回）。
  /** A deleted chapter must not be flushed back into storage. */
  const skipFlushRef = useRef<string | null>(null)
  useEditorChapterTarget({ loaded, chapters, chapterId: openChapterId, requestId: openRequestId,
    setActiveId, expandedRef, setExpanded: setExpandedPersist })

  // 记住上次编辑位置：下次打开项目直接回到这里（2.6.1 社区反馈）。null 不写——
  // 删章置空后保留旧记录，读回时本来就有存在性校验。
  useEffect(() => {
    if (activeId) writeStringPref(lastChapterPrefKey, activeId)
  }, [activeId, lastChapterPrefKey])

  const active = useMemo(() => chapters.find(c => c.id === activeId) ?? null, [chapters, activeId])
  const { ready: aiReady } = useAIReady()
  // P0-2：用 ref 镜像最新 state，供卸载/切章冲刷（useEffect 闭包拿不到最新 state）
  const chaptersRef = useRef(chapters); chaptersRef.current = chapters
  const activeRef = useRef<Chapter | null>(null); activeRef.current = active
  const onStatsChangeRef = useRef(onStatsChange); onStatsChangeRef.current = onStatsChange
  const prevActiveIdRef = useRef<string | null>(null)
  const [summarizing, setSummarizing] = useState(false)

  /** 计算章节的全局序号与所属卷名（用于总表同步） */
  /** 章节 id → 全局派生序号（0 = 不计入序号）。侧栏显示与保存同步共用同一份，避免各自算一套。 */
  const chapterSeqs = useMemo(() => chapterSeqMap(volumes, chapters), [volumes, chapters])
  /** 下一个正文序号（供「新建章节」预填标题） */
  const nextChapterNo = useMemo(() => {
    let max = 0
    for (const v of chapterSeqs.values()) if (v > max) max = v
    return max + 1
  }, [chapterSeqs])

  // ============ 2.4.1 · B3 补做：编辑器内的 AI 产出记账 ============
  //
  // 「伴写采纳」（acceptGhost）与「选区改稿」（insertAdvice）都不直接写正文库，
  // 而是改草稿 → 由本文件各条保存路径统一落库。所以在**采纳那一刻**先把账挂起（带章节 id），
  // 到保存这一章时再用 withAiAssist 合并进去。
  //
  // 🔴 口径＝「本次 AI 产出的字数」，不是"当前正文里有多少 AI 字"：
  //    作者随后怎么删改无法反推 —— 与整章改写 / 续写同一口径，界面上也如实写明。
  const aiPendingRef = useRef<PendingAiNote[]>([])

  /**
   * 章节 → 上次自动索引时的内容指纹（台账 #013「保存后自动更新本章索引」用）。
   * 🔴 存**哈希**不存正文：这个 map 会随项目章节数一直长（几千章），存原文就是几 MB 常驻内存。
   * 🔴 也不是"记住已索引状态"的权威 —— 真权威在索引库里（`autoIndexChapter` 会逐块比对哈希）。
   *    这里只是**省一次查库**的首道闸：没变就压根不发起。
   */
  const indexedFpRef = useRef(new Map<string, string>())

  /** 挂一笔 AI 产出（供伴写采纳 / 选区改稿调用） */
  const noteAiAssist = (kind: AiSourceKind, chars: number) => {
    const id = activeRef.current?.id
    if (!id || chars <= 0) return
    aiPendingRef.current.push({ chapterId: id, kind, chars })
  }

  /**
   * 落库章节 —— **本文件所有保存路径都走它**（原先 10 处 `db.saveChapter` 已统一改名）。
   * 顺手把该章挂起的 AI 记账合并进去并消费掉。
   * 🔴 之所以包一层而不是各处手写：以后新增保存路径也自动带上记账，
   *    不会出现"新增一条路忘了记"的静默漏账。
   * 2.8.0 起还在这里顺带触发「保存后自动更新本章索引」（默认关，见 `autoIndexChapter`）。
   */
  const saveChapterWithAi = (ch: Chapter): Promise<void> => {
    const { chapter, rest } = foldPendingAi(aiPendingRef.current, ch)
    // 只在真的消费掉了记账时才换数组（没消费就保持原引用，省一次分配）
    if (rest.length !== aiPendingRef.current.length) aiPendingRef.current = rest
    const p = db.saveChapter(chapter)

    // 自动索引：先记指纹再发起（同一份内容只在第一次发起，防抖窗口内的重复保存不重复触发）。
    // 🔴 必须挂在 `db.saveChapter` **之后** —— `autoIndexChapter` 是从库里回读这一章的，
    //    抢在落库前跑会读到改动前的旧正文，索引就停在上一版。
    // 🔴 绝不 await：索引是"顺手做的事"，让它拖慢甚至阻断存稿是本末倒置；
    //    发生任何差错都由 `autoIndexChapter` 内部吞掉（只留一行 console.warn）。
    const fp = chapterFingerprint(chapter)
    if (indexedFpRef.current.get(chapter.id) !== fp) {
      indexedFpRef.current.set(chapter.id, fp)
      void p.then(() => autoIndexChapter(chapter.id)).catch(() => { /* 存稿失败由调用方提示，这里不重复报 */ })
    }
    return p
  }

  /**
   * 🔴 章保存串行队列（2026-10-17 全量审计 P1/P2）：
   *   同一章的多次落库按**调用顺序**执行。正文自动保存（2s 防抖）、标题/摘要防抖（600ms）、
   *   Ctrl+S、切章冲刷可能同刻触发，原先并发读-改-写同一行 ⇒ 后写者用旧快照覆盖前者：
   *   · 改标题后 2s 内自动保存 ⇒ 标题跳回旧值；
   *   · 反向则正文倒回旧稿（且界面仍显示新稿 ⇒ 库与界面分叉，重启即丢）；
   *   · 当日码字增量双计/少计（另在 `addDailyWords` 内做全局串行）。
   */
  const saveChain = useRef(new Map<string, Promise<unknown>>())
  const enqueueSave = useCallback(<T,>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = saveChain.current.get(id) ?? Promise.resolve()
    // 前一笔失败也要继续跑这一笔（用同一个回调当 onRejected）
    const run = prev.then(fn, fn)
    // 链上存「已消化失败」的版本，避免一次写库失败把该章后续保存全部堵死
    saveChain.current.set(id, run.then(() => undefined, () => undefined))
    return run
  }, [])

  /** 章节定位：序号取全局派生序号（与标题无关），0 = 不计入序号 */
  const locate = (ch: Chapter) => {
    const vol = volumes.find(v => v.id === ch.volumeId)
    return { volTitle: vol?.title ?? '', no: chapterSeqs.get(ch.id) ?? 0 }
  }

  /** 切换「不计入序号」（序章 / 番外 / 后记不占正文号，但仍按真实位置参与排序） */
  const toggleExcludeNumbering = async (ch: Chapter) => {
    const next: Chapter = { ...ch, excludeFromNumbering: !ch.excludeFromNumbering, updatedAt: Date.now() }
    const nextChs = chapters.map(c => (c.id === ch.id ? next : c))
    setChapters(nextChs)
    await saveChapterWithAi(next)
    // 一章进出计数会牵动其后所有章的号，故全量重排
    await resyncChapterMasterNumbers(volumes, nextChs)
    showToast(
      next.excludeFromNumbering
        ? `「${ch.title}」已设为不计入序号，后续章节号已重排`
        : `「${ch.title}」已恢复计号，章节号已重排`,
      'success',
    )
  }

  // 切到某章节时，先冲刷"正在离开那一章"在 2 秒防抖窗口内尚未落库的正文，再初始化新章草稿
  useEffect(() => {
    const prevId = prevActiveIdRef.current
    if (prevId && prevId !== activeId) {
      // 取消离开章挂起的防抖保存，改由下方立即冲刷，避免旧的 setTimeout 后用新章内容错写
      clearTimeout(autosaveTimer.current)
      const leaving = chaptersRef.current.find(c => c.id === prevId)
      // 🔴 刚删除的章不许冲刷（2026-10-17 全量审计 P2）：`removeChapter` 里 setActiveId(null) 会
      //    触发本 effect，而此时 chapters 状态可能还留着这一章（load 未刷新）⇒ 冲刷把它写回正文库，
      //    结果「回收站一份 + 正文一份」。删除流程会在 load 之后清掉标记。
      if (leaving && skipFlushRef.current !== leaving.id && draftRef.current !== leaving.content) {
        const text = draftRef.current
        // 先同步内存态（快速切回时读到的是最新稿），落库走该章的串行队列
        const optimistic: Chapter = { ...leaving, content: text, wordCount: countWords(text), updatedAt: Date.now() }
        setChapters(prev => prev.map(c => (c.id === leaving.id ? optimistic : c)))
        // 🔴 切章冲刷失败必须可见（2026-09-19 六维审计 P2-10）：原先没有 catch，
        //    落库失败时这段稿子静默丢失，作者只看到字数没变。
        void enqueueSave(leaving.id, async () => {
          const cur = chaptersRef.current.find(c => c.id === leaving.id) ?? optimistic
          const next: Chapter = { ...cur, content: text, wordCount: countWords(text), updatedAt: Date.now() }
          await saveChapterWithAi(next)
          return next
        })
          .then(() => onStatsChangeRef.current?.())
          .catch((e: unknown) => showToast(saveFailureMessage('自动保存失败：', e), 'error'))
      }
    }
    prevActiveIdRef.current = activeId
    const ch = chaptersRef.current.find(c => c.id === activeId)
    if (ch) {
      draftRef.current = ch.content ?? ''
      setDraftContent(ch.content ?? '')
      // ⚠️ 必须与上面同步、不走防抖（2.0.1）：若在 120ms 后才更新镜像，切章瞬间叠层渲染的仍是
      // 上一章正文，视觉上就是「切换/加载缓慢且内容显示异常」。这里直接同帧对齐。
      setDeferredContent(ch.content ?? '')
    }
  }, [activeId, setDeferredContent, enqueueSave])

  // 🔴 关窗前冲刷草稿（2026-10-17 全量审计 P1）：
  //   1) 向 App 注册「立刻落草稿」的通道（beforeunload/pagehide 时先调它、再写盘）；
  //   2) 自己再挂 pagehide / visibilitychange(hidden)：切走应用 / 最小化时也主动落一次，
  //      「打字 → 立刻关窗」不再丢最后 ≤2 秒的正文（原先只有 React 卸载才冲刷，关窗不触发卸载）。
  useEffect(() => {
    const flush = () => { void flushEditorDraftNow() }
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    registerEditorDraftFlush(async () => {
      const ch = activeRef.current
      if (!ch || draftRef.current === ch.content) return
      const text = draftRef.current
      const id = ch.id
      await enqueueSave(id, async () => {
        const cur = chaptersRef.current.find(c => c.id === id) ?? ch
        const next: Chapter = { ...cur, content: text, wordCount: countWords(text), updatedAt: Date.now() }
        await saveChapterWithAi(next)
        return next
      })
    })
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      registerEditorDraftFlush(null)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [enqueueSave])

  // 卸载时清理全部定时器，防止组件卸载后仍触发 setState（内存泄漏）
  useEffect(() => () => {
    clearTimeout(autosaveTimer.current)
    clearTimeout(flashTimer.current)
    clearTimeout(metaTimer.current)
    // 冲刷未落库的标题/摘要修改
    metaFlush.current?.()
    // P0-2：卸载前冲刷尚未落库的正文（2 秒防抖窗口内输入），防止切走 / 关项目丢稿
    const ch = activeRef.current
    if (ch && draftRef.current !== ch.content) {
      const text = draftRef.current
      const id = ch.id
      // 卸载后仍可入队（闭包持有 ref）；同一章的队列保证与在途保存不互相覆盖
      void enqueueSave(id, async () => {
        const cur = chaptersRef.current.find(c => c.id === id) ?? ch
        const next: Chapter = { ...cur, content: text, wordCount: countWords(text), updatedAt: Date.now() }
        await saveChapterWithAi(next)
        return next
      }).catch(() => showToast('自动保存失败：' + '离开编辑器时仍有未落库的正文，请回到该章确认', 'error'))
    }
  }, [enqueueSave])

  // Ctrl/Cmd+S 保存（2.7.3：收敛到 useSaveHotkey）
  useSaveHotkey(
    () => { if (active && draftContent !== active.content) void commitContent() },
    !!active && draftContent !== active.content,
  )

  /**
   * 手动保存（可传入内容，自动保存时用，避免闭包中的过期 state）。
   * 🔴 3.3.0 · UX06：**必须返回成败**。原先 catch 里只 toast、函数返回 void，于是
   *    `openChapter` 的 `await commitContent(...)` 无论写盘成败都会继续切章 —— 失败时
   *    作者已在下一章，原稿只剩内存快照，一刷新就没。`{ ok: true }` 也包含「本来没东西可存」，
   *    调用方只需判 `ok === false`。
   */
  const commitContent = async (content?: string): Promise<{ ok: boolean; error?: unknown }> => {
    // 🔴 基准必须**现读 chaptersRef**：渲染闭包里的 active 可能是旧快照（见 enqueueSave 头注）
    const base = activeId ? chaptersRef.current.find(c => c.id === activeId) : null
    if (!base) return { ok: true }
    const text = content ?? draftRef.current
    if (text === base.content) return { ok: true }
    setSaving(true)
    try {
      const written = await enqueueSave(base.id, async () => {
        // 队列内再读一次：前一笔（标题补丁）刚落库/落状态时，这里能拿到最新标题与状态
        const cur = chaptersRef.current.find(c => c.id === base.id) ?? base
        const next: Chapter = { ...cur, content: text, wordCount: countWords(text), updatedAt: Date.now() }
        const { no } = locate(next)
        await Promise.all([saveChapterWithAi(next), syncChapterMaster(next, no)])
        return next
      })
      // 字段级合并回状态：只覆盖正文相关字段，**绝不**把旧标题/状态/摘要写回界面
      setChapters(prev => prev.map(c => (c.id === written.id
        ? { ...c, content: written.content, wordCount: written.wordCount, updatedAt: written.updatedAt }
        : c)))
      setSavedFlash(true)
      clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setSavedFlash(false), 1500)
      onStatsChange?.()
      loadTodayWords()
      return { ok: true }
    } catch (e) {
      // 🔴 落库失败必须复位 saving 并如实报错 —— 原先没有 try/finally，一旦抛错按钮会永久停在
      //    「保存中…」，还会产生未捕获 rejection（2026-09-19 六维审计 P1-5）。
      showToast(saveFailureMessage('保存失败：', e), 'error')
      return { ok: false, error: e }
    } finally {
      setSaving(false)
    }
  }

  // 打字机模式：用镜像层测量光标纵向位置，让输入行始终保持在可视区中部
  const syncTypewriter = useCallback((text: string) => {
    if (!typewriter || !taRef.current || !mirrorRef.current) return
    const ta = taRef.current
    const mirror = mirrorRef.current
    const pos = ta.selectionStart ?? 0
    mirror.textContent = text.slice(0, pos)
    const marker = document.createElement('span')
    marker.textContent = '\u200b'
    mirror.appendChild(marker)
    ta.scrollTop = Math.max(0, marker.offsetTop - ta.clientHeight / 2)
  }, [typewriter])

  // 内容变化：更新草稿 + 2 秒无输入自动保存（自动保存，防丢稿）
  const onContentChange = (v: string) => {
    draftRef.current = v
    setDraftContent(v)
    // 正文真的变了 → 解除「Esc 抑制」（抑制只管"没动过内容的重渲染"，不能管住作者的下一次落笔）
    ghostDismissed.current = null
    // 🔴 光标必须在这里同步一次，不能只靠 onKeyUp：**输入法上屏、粘贴、程序化插入都不产生 keyup**，
    //    只靠 keyUp 会让 caret/selRef 停在旧偏移；伴写据此误判"光标后还有正文"→ 永远不再出建议
    //    （2026-09-17 实机验证抓到：敲字后 30s 无建议，埋点显示 at=4617 而正文已 4618 字）
    if (taRef.current) {
      selRef.current = { start: taRef.current.selectionStart, end: taRef.current.selectionEnd }
      setCaret(taRef.current.selectionStart)
    }
    clearTimeout(autosaveTimer.current)
    autosaveTimer.current = setTimeout(() => commitContent(draftRef.current), 2000)
    syncTypewriter(v)
    syncHighlightScroll()
  }

  /**
   * 切换章节：先冲刷未保存的正文与标题/摘要，**两样都成功才真的切**；失败返回 false，
   * 原章、原 DOM、原草稿一律留在原地（UX06）。另有 `captureWorkspaceView()` 在切换前记现场。
   */
  const openChapter = async (id: string): Promise<boolean> => {
    // 先记下「离开这一章时的光标/滚动」，再进保存屏障（屏障失败留在原地，现场仍有效）
    captureWorkspaceView()
    const cur = activeRef.current
    if (cur && draftRef.current !== cur.content) {
      const r = await commitContent(draftRef.current)
      if (!r.ok) {
        showToast('切换章节已取消：本章正文还没存上，请重试后再切', 'error')
        return false
      }
    }
    if (metaPending.current.size > 0) {
      const m = await metaFlush.current()
      if (!m.ok) {
        showToast(saveFailureMessage('切换章节已取消：本章标题或摘要还没存上：', m.errors[0]), 'error')
        return false
      }
    }
    clearTimeout(autosaveTimer.current)
    setActiveId(id)
    return true
  }

  // 🔴 3.3.0 · UX06 离页屏障：换页签 / 退出项目前先「存成功再走」（判定在 useEditorLeaveBarrier）。
  //    绝不复用 flushEditorDraftNow —— 那个是关窗兜底、故意吞失败。
  const commitContentRef = useRef(commitContent)
  commitContentRef.current = commitContent
  useEditorLeaveBarrier({ activeRef, draftRef, commitContentRef, metaPending, metaFlush, autosaveTimer })

  /** 正文字号调节（14~28px，本地记忆） */
  const changeFontSize = (delta: number) => {
    setFontSize(prev => {
      const v = Math.min(28, Math.max(14, prev + delta))
      localStorage.setItem('novel-font-size', String(v))
      return v
    })
  }

  const updateContent = (content: string) => {
    // 兼容外部调用（如敏感词替换、FocusLock 退出、时光机恢复等）：直接落库
    // 注意：必须立即落库，不能用防抖——否则在 600ms 内切换章节 / 退出项目会导致本次修改丢失
    // 🔴 基准现读 chaptersRef + 只写正文相关字段（字段级 patch）：
    //    整章写回会用闭包里过期的标题/状态覆盖别的保存路径刚落库的值（2026-10-17 审计 P1）
    const base = activeId ? chaptersRef.current.find(c => c.id === activeId) : null
    if (!base) return
    const wc = countWords(content)
    setChapters(prev => prev.map(c => (c.id === base.id
      ? { ...c, content, wordCount: wc, updatedAt: Date.now() }
      : c)))
    draftRef.current = content
    setDraftContent(content)
    void enqueueSave(base.id, async () => {
      const cur = chaptersRef.current.find(c => c.id === base.id) ?? base
      const merged = await db.patchChapter(base.id, { content, wordCount: wc })
      const row = merged ?? { ...cur, content, wordCount: wc, updatedAt: Date.now() }
      const { no } = locate(row)
      await syncChapterMaster(row, no)
      return row
    })
      .then(() => {
        setSavedFlash(true)
        clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => setSavedFlash(false), 1200)
        onStatsChange?.()
      })
      .catch((err) => {
        console.error('章节保存失败', err)
        showToast('章节保存失败：' + (err instanceof Error ? err.message : String(err)), 'error')
      })
  }

  /** 标题/摘要等元信息更新：UI 即时更新，落库做 600ms 防抖（避免每个按键都写 IndexedDB + 同步总表） */
  const updateMeta = (patch: Partial<Chapter>) => {
    // 🔴 基准现读 chaptersRef（闭包 active 可能是旧快照）；落库走**字段级 patch**，
    //    只写 patch 里出现的键 —— 整章写回会把快照里过期的正文覆盖掉刚由自动保存落库的新稿
    const base = activeId ? chaptersRef.current.find(c => c.id === activeId) : null
    if (!base) return
    const next = { ...base, ...patch, updatedAt: Date.now() }
    setChapters(prev => prev.map(c => (c.id === next.id ? next : c)))
    const { no } = locate(next)
    const run = () => enqueueSave(base.id, async () => {
      const merged = await db.patchChapter(base.id, { ...patch, updatedAt: next.updatedAt })
      const row = merged ?? next
      await syncChapterMaster(row, no)
      onStatsChange?.()
      return row
    }).then(() => { /* metaFlush 只关心完成，不关心返回值 */ })
    // 🔴 P2-8：按章节 id 入账（同章覆盖、跨章共存），不再共用一个"最新那笔"
    metaPending.current.set(next.id, run)
    clearTimeout(metaTimer.current)
    metaTimer.current = setTimeout(() => {
      // 🔴 UX06：防抖到点的这笔也要**报失败**（原先是静默吞掉）。这一笔记账已被放回队列，
      //    作者下一次编辑、切章或离页都会再试，所以这里只提示、不额外造重试循环。
      void metaFlush.current().then(r => {
        if (!r.ok) showToast(saveFailureMessage('标题/摘要保存失败：', r.errors[0]), 'error')
      })
    }, 600)
  }

  /** AI 一键生成「章节压缩摘要」：基于正文按 ~1/10 压缩回填到 active.summary（自动同步章节总表） */
  const genSummary = async () => {
    if (!aiReady || !active || summarizing) return
    setSummarizing(true)
    try {
      const s = await aiChapterSummary(draftContent)
      updateMeta({ summary: s })
      showToast('已用 AI 生成章节压缩摘要', 'success')
    } catch (e) {
      showToast('摘要生成失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setSummarizing(false)
    }
  }

  /**
   * 批量重生成全书各章压缩摘要（约原文 1/10，覆盖现有摘要），用于把旧的一句式摘要刷新为内容摘要。
   *
   * 🔴 状态**必须放任务中心（模块级 store）**，不能是组件内 useState（2026-10-04 六维审计 P1）：
   *    切页签 = 卸载本组件 ⇒ 组件里的「正在跑」标记跟着消失，切回来按钮又是可点的 ——
   *    同一批章节于是被两个循环同时重生成（白烧额度；且两边各自 `syncChapterMaster` 互相覆盖，
   *    最后落库的是谁取决于谁后跑完）。`startTask` 对同 (ownerTab, kind) 的 running
   *    天然忽略重复发起，任务还跨页签存活、可中止。
   */
  const regenT = useTaskRunner<RegenOutcome>({
    ownerTab: 'editor', kind: 'regen-summaries', title: '批量重生成章节摘要', writes: ['chapters'],
  })
  /** 视图侧仍叫 `regenAll`（按钮禁用 + 转圈）—— 语义没变，只是来源换成了任务中心的 running */
  const regenAll = regenT.running
  /** 上一批逐章失败清单（页面据此显示「哪几章还是旧摘要」；新一批发起时自然被替换） */
  const regenFailures = regenT.result?.failed ?? []
  /** 中止批量重生成（UX13：长等待必须能由作者叫停，已更新的章节保持已更新） */
  const stopRegenAll = () => regenT.stop()
  const regenAllSummaries = async () => {
    if (!aiReady || regenT.running) return
    const ok = await confirmDialog({
      title: '批量重生成章节摘要',
      message: '将对全书所有「有正文」的章节，用 AI 重新生成约 1/10 长度的压缩摘要（覆盖现有摘要）。章节较多时耗时较长、会消耗较多调用，确定继续吗？',
    })
    if (!ok) return
    regenT.run(async ctx => {
      const all = await db.getAllChapters()
      const vols = await db.getAllVolumes()
      // 🔴 逐章计账抽到 `regenSummaries.ts`：原先单章失败被 `catch {}` 静默跳过、结果只报 {done,total}，
      //    完成提示却写「全书…完成（共 total 章）」⇒ 部分失败被说成全部成功（UX09 生成部分失败）。
      const outcome = await runRegenSummaries(all, {
        signal: ctx.signal,
        isAborted: () => ctx.isAborted(),
        summarize: (text, opts) => aiChapterSummary(text, opts),
        // 两步分开传：写章节与同步总表**各自**记账（摘要落库了但总表没跟上，也得如实说）
        save: async next => { await saveChapterWithAi(next) },
        syncMaster: async next => { await syncChapterMaster(next, chapterSeqOf(vols, all, next.id)) },
        onProgress: (attempted, total) => ctx.progress({ attempted, total }),
        onBatch: (attempted, total) => showToast(`已重生成摘要 ${attempted}/${total}`, 'info'),
      })
      return outcome
    }, info => {
      if (info.status === 'done' && info.result) return regenSummaryText(info.result)
      if (info.status === 'aborted') return { text: '批量重生成已中止 —— 已完成的部分保持已更新', kind: 'info' as const }
      return { text: '批量重生成失败：' + (info.error || '未知原因'), kind: 'error' as const }
    })
  }

  // 摘要框自适应高度：内容变多时自动展开，完整显示 AI 压缩摘要（不再是一行窄框）
  const summaryRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = summaryRef.current
    if (!el) return
    el.style.boxSizing = 'border-box'
    el.style.height = 'auto'
    const maxH = 180
    const h = Math.min(el.scrollHeight, maxH)
    el.style.height = h + 'px'
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden'
  }, [active?.summary])

  // ---- 卷/章操作 ----
  // v1.6：新建/改名改走应用内 PromptModal（浏览器 prompt 在 Electron 桌面端无实现、点击无反应）
  const [namePrompt, setNamePrompt] = useState<null | { kind: 'addVol' | 'addCh' | 'addFreeCh' | 'renVol' | 'renCh'; title: string; def: string; payload?: unknown }>(null)

  // ============ 颉文姬 · AI 编辑（v1.6 收官功能） ============
  const [jieWenJiOpen, setJieWenJiOpen] = useState(false)
  // 全局精灵点击唤起（JieWenJiSprite 派发事件，编辑器页打开完整面板）
  useEffect(() => {
    const onOpen = () => setJieWenJiOpen(o => !o)
    window.addEventListener('jiewenji:open', onOpen)
    return () => window.removeEventListener('jiewenji:open', onOpen)
  }, [])
  // 选区缓存：textarea 的 onSelect/onMouseUp/onKeyUp 时同步，面板聚焦后仍可读取
  const selRef = useRef<{ start: number; end: number } | null>(null)
  const syncSel = () => {
    const ta = taRef.current
    if (ta) {
      selRef.current = { start: ta.selectionStart, end: ta.selectionEnd }
      // 伴写：光标位置进 state —— 点击/按键把光标挪到新位置时才可能产出新建议
      setCaret(ta.selectionStart)
    }
  }
  const getSelText = () => {
    const s = selRef.current
    if (!s || s.end <= s.start) return null
    return draftContent.slice(s.start, s.end) || null
  }

  // ---- AI 伴写（D4-2 拆出，同名解构接回；下游代码一个字没改）----
  // 上一章末尾（≤2000 字，全书卷章顺序的前一章；跨卷＝上一卷最后一章）——伴写前文不足
  // GHOST_CONTEXT_CHARS 时拿它补齐（2026-09-28 · 章首语境）。章节列表含正文本就在内存，
  // 同步派生零读库；产出是字符串，上一章内容没变时 useMemo 引用稳定，不会让 ghost effect 白跑。
  const prevChapterTail = useMemo(() => {
    const ordered = orderedChapters(volumes, chapters)
    const idx = ordered.findIndex(c => c.id === activeId)
    return idx > 0 ? (ordered[idx - 1].content || '').slice(-GHOST_CONTEXT_CHARS) : ''
  }, [volumes, chapters, activeId])
  const {
    companion, setCompanion, companionLen, setCompanionLen, companionDeAi, setCompanionDeAi,
    companionStyleNote, setCompanionStyleNote, companionStyleDims, setCompanionStyleDims,
    companionStyleSpec, setCompanionStyleSpec,
    styleNotePrompt, setStyleNotePrompt, ghost, ghostBusy, dismissGhost, onEditorKeyDown,
  } = useNovelEditorGhost({
    activeId, draftContent, aiReady, caret, setCaret, selRef, taRef, ghostRef, ghostDismissed, draftRef, onContentChange,
    // B3 补做：采纳即挂账一笔「续写」产出，随本章下次落库写进 aiAssist
    onAiAssist: (chars: number) => noteAiAssist('continued', chars),
    // 章首语境：当前章前文不足 2000 字时，伴写拿上一章末尾补齐
    prevChapterTail,
  })

  /** 建议段模式：AI 改稿以标记块写入原文下方，绝不动原文；作者自行取舍 */
  const insertAdvice = (rewritten: string, sel: { start: number; end: number } | null) => {
    const base = draftContent
    const rng = sel && sel.start >= 0 && sel.end >= sel.start ? sel : null
    let insertAt = base.length
    if (rng) {
      // 定位选区所在段落的末尾（段落 = 以空行分隔的块）
      const paraEnd = base.indexOf('\n\n', rng.end)
      insertAt = paraEnd === -1 ? base.length : paraEnd
    }
    // 防重复：同一位置紧邻已有建议段则提示（避免同一改稿连点两次插两份）
    const near = base.slice(Math.max(0, insertAt - 3), insertAt + ADVICE_START.length + 3)
    if (near.includes(ADVICE_START)) {
      showToast('该位置已有建议段，请先处理或清除后再写入', 'info')
      return
    }
    const block = `\n\n${ADVICE_START}\n${rewritten.trim()}\n${ADVICE_END}`
    const next = base.slice(0, insertAt) + block + base.slice(insertAt)
    updateContent(next)
    // 🔴 B3 补做：选区改稿的产出也计入 —— 算**建议段正文**的字数（不含两端标记行）。
    //    这段是 AI 生成的，作者采不采用由他定，但"产出过"这件事要如实记（口径同其它来源）。
    noteAiAssist('polished', rewritten.trim().length)
    showToast('已写入建议段：请自行取舍，可用面板「清除全部建议段」一键清理', 'success')
  }
  const clearAdvice = () => {
    // 标记不成对时拒绝清除（避免孤立「开始」标记跨正文误删到下一个「结束」）
    const starts = (draftContent.match(/【颉文姬建议·开始】/g) ?? []).length
    const ends = (draftContent.match(/【颉文姬建议·结束】/g) ?? []).length
    if (starts !== ends) {
      showToast(`建议段标记不配对（开始 ${starts} / 结束 ${ends}），请先手动修复异常标记`, 'error')
      return
    }
    const re = /\n{0,2}【颉文姬建议·开始】[\s\S]*?【颉文姬建议·结束】\n{0,2}/g
    const next = draftContent.replace(re, '')
    if (next === draftContent) { showToast('未找到建议段', 'info'); return }
    updateContent(next)
    showToast('已清除全部建议段', 'success')
  }
  // 作品开头（前 3 章）正文，供「黄金三章检查」使用
  const openingText = useMemo(() => {
    // 🔴 走唯一真源：原先手写版没给卷排序（volumes 顺序不作数），且把孤儿章整章丢掉
    const flat = flattenAll(volumes, chapters)
    return flat.slice(0, 3).map(c => `${c.title}\n${c.content}`).join('\n\n')
  }, [volumes, chapters])

  const doAddVolume = async (title: string) => {
    if (!title) return
    // 🔴 order 只数真卷：自由卷不占号，否则「第N卷」的默认名会被它挤偏一位（见 lib/freeVolume.ts）
    const vol: Volume = { id: uid(), projectId: db.getCurrentProjectId(), order: nextVolumeOrder(volumes), title, description: '', createdAt: Date.now() }
    await db.saveVolume(vol)
    await load()
    window.dispatchEvent(new Event('yfe:volumes-changed')) // 通知章节总表侧栏同步新增
  }

  const doAddChapter = async (volumeId: string, title: string) => {
    if (!title) return
    const volChs = chapters.filter(c => c.volumeId === volumeId)
    const ch: Chapter = {
      id: uid(), projectId: db.getCurrentProjectId(), volumeId, order: volChs.length, title, content: '', summary: '',
      status: '构思', wordCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
    }
    await saveChapterWithAi(ch)
    // 目标卷可能是折叠状态下点的「新建章」：展开它，否则 load 后树上找不到新章高亮
    //（2.6.1 修复配套：load 不再无条件展开所有卷，这里要显式补上定位展开）
    setExpandedPersist(prev => new Set(prev).add(volumeId))
    await load()
    setActiveId(ch.id)
    // 新章登记到对应卷的章节台账。序号取全局派生值——新章 order 为卷内最大值，
    // 通常排在卷末，但作者随后拖拽到任意位置时会由 resyncChapterMasterNumbers 重排。
    // ⚠️ 这里必须现读库：上方 setChapters 是异步的，闭包里的 chapters 还不含新章，
    // 用旧 state 算出的序号恒为 0，台账会被误标「不计入序号」（章节号留空、行序错乱）。
    const [lv, lc] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    await syncChapterMaster(ch, chapterSeqOf(lv, lc, ch.id))
  }

  /**
   * 新建「自由章节」—— 作者不必先建卷：托管卷不存在时自动建（lazy，不预建空卷），
   * 随后复用 doAddChapter 的完整链路（展开该分组 / 定位高亮 / 登记章节台账 / 派生正文序号）。
   */
  const doAddFreeChapter = async (title: string) => {
    if (!title) return
    const wasMissing = !findFreeVolume(volumes)
    const vol = await ensureFreeVolume(volumes)
    await doAddChapter(vol.id, title)
    // 托管卷是本次新建的才算「多了一个卷」，要通知章节总表侧栏同步（已存在时不必）
    if (wasMissing) window.dispatchEvent(new Event('yfe:volumes-changed'))
  }

  const doRenameVolume = async (vol: Volume, title: string) => {
    if (!title || title === vol.title) return
    await db.saveVolume({ ...vol, title })
    await load()
    window.dispatchEvent(new Event('yfe:volumes-changed')) // 通知章节总表侧栏同步改名
  }

  const doRenameChapter = async (ch: Chapter, title: string) => {
    if (!title || title === ch.title) return
    const next = { ...ch, title }
    setChapters(prev => prev.map(x => (x.id === ch.id ? next : x)))
    const { no } = locate(next)
    await Promise.all([saveChapterWithAi(next), syncChapterMaster(next, no)])
  }

  const submitNamePrompt = async (v: string) => {
    const p = namePrompt
    setNamePrompt(null)
    if (!v || !p) return
    if (p.kind === 'addVol') await doAddVolume(v)
    else if (p.kind === 'addCh') await doAddChapter(p.payload as string, v)
    else if (p.kind === 'addFreeCh') await doAddFreeChapter(v)
    else if (p.kind === 'renVol') await doRenameVolume(p.payload as Volume, v)
    else if (p.kind === 'renCh') await doRenameChapter(p.payload as Chapter, v)
  }

  const removeVolume = async (vol: Volume) => {
    // 🔴 自由卷是系统保留的托管卷：删它会级联把里面的自由章节全推进回收站（卷删除在存储层是级联的）
    if (isFreeVolume(vol)) { showToast('「自由章节」是托管未归类章节的系统保留卷，不能删除', 'error'); return }
    const count = chapters.filter(c => c.volumeId === vol.id).length
    if (!await confirmDialog({ title: '删除分卷', message: `此操作会同时删除【正文编辑·章节管理】与【章节总表】两处的分卷「${vol.title}」及其全部 ${count} 章，数据将移入回收站（可恢复）。确定要删除吗？`, danger: true })) return
    await db.deleteVolume(vol.id)  // 内部级联移入回收站、删除总表联动行
    if (active && active.volumeId === vol.id) setActiveId(null)
    await load()
    window.dispatchEvent(new Event('yfe:volumes-changed')) // 通知章节总表侧栏同步删除
    onStatsChange?.()
  }

  const removeChapter = async (ch: Chapter) => {
    if (!await confirmDialog({ title: '删除章节', message: `删除「${ch.title}」？会移入回收站，可随时恢复。`, danger: true })) return
    // 标记「这一章正在被删」：下面置空 activeId 会触发切章冲刷，必须跳过它（见切章 effect 的注释）
    skipFlushRef.current = ch.id
    await db.deleteChapter(ch.id)
    if (activeId === ch.id) setActiveId(null)
    await load()
    skipFlushRef.current = null
    onStatsChange?.()
  }

  /** 时光机恢复：先把当前内容快照（标成"手动回滚前的留档"），再套用历史版本 */
  const restoreSnapshot = async (content: string) => {
    if (!active) return
    await db.createSnapshot(active, 'manual-restore')
    updateContent(content)
  }

  /** 全文替换后的回写（只同步内存态与草稿镜像；落库由调用方 `db.patchChapter` 统一负责） */
  const applyChapterContent = (id: string, content: string) => {
    const ch = chaptersRef.current.find(c => c.id === id)
    if (!ch) return
    const wc = countWords(content)
    const next = { ...ch, content, wordCount: wc, updatedAt: Date.now() }
    setChapters(prev => prev.map(c => (c.id === id ? next : c)))
    // 🔴 活动章的草稿镜像必须同步（2026-10-17 审计 P2）：原先只改 chapters state，
    //    draftRef 仍是替换前的文本 ⇒ 下一条保存路径比较 draftRef !== content 成立，
    //    把**替换前**的稿子整章写回（界面提示 N 处已替换，当前章一处没生效）。
    if (activeId === id) {
      draftRef.current = content
      setDraftContent(content)
      setDeferredContent(content)
    }
    const { no } = locate(next)
    syncChapterMaster(next, no)
    onStatsChange?.()
  }

  // ---- v1.6.3：卷/章拖拽排序 ----
  const resetDrag = () => { setDragKind(null); setDragId(null); setOverKey(null) }

  const handleDrop = async () => {
    if (!dragKind || !dragId || !overKey) { resetDrag(); return }
    let dirty = false
    try {
      if (dragKind === 'vol' && overKey.kind === 'vol') {
        // 🔴 自由卷不参与卷序重排：它的 order 是哨兵值，而 reorderVolumes 会把传入的卷重编成 0..n-1，
        //    一并传进去就会把哨兵冲掉、自由章节被排进正文序列中段（导出 / 正文序号 / 上下章全乱）
        // 🔴 自由卷恒排最前（2.6.4 起）：先拼自由卷，再接重排后的真卷
        const next = [
          ...volumes.filter(v => isFreeVolume(v)),
          ...reorderVolumes(realVolumes(volumes), dragId, overKey.id, overKey.pos),
        ]
        dirty = next.some(v => v.order !== (volumes.find(x => x.id === v.id)?.order ?? -1))
        setVolumes(next)
        if (dirty) {
          await Promise.all(next.map(v => db.saveVolume(v)))
          await resyncChapterMasterNumbers(next, chapters)
        }
      } else if (dragKind === 'ch') {
        const ch = chapters.find(c => c.id === dragId)
        if (!ch) { resetDrag(); return }
        let nextChapters: Chapter[] = chapters
        if (overKey.kind === 'ch') {
          const overCh = chapters.find(c => c.id === overKey.id)
          if (!overCh) { resetDrag(); return }
          if (overCh.volumeId === ch.volumeId) {
            const reordered = reorderChapters(chapters.filter(c => c.volumeId === ch.volumeId), dragId, overKey.id, overKey.pos)
            nextChapters = chapters.map(c => { const r = reordered.find(x => x.id === c.id); return r ? r : c })
          } else {
            const moved = moveChapterToVolume(ch, overCh.volumeId, chapters.filter(c => c.volumeId === overCh.volumeId), overKey.id, overKey.pos)
            const srcChs = chapters.filter(c => c.volumeId === ch.volumeId && c.id !== ch.id).sort((a, b) => a.order - b.order).map((c, i) => ({ ...c, order: i }))
            nextChapters = chapters.map(c => { const m = moved.find(x => x.id === c.id); if (m) return m; const s = srcChs.find(x => x.id === c.id); if (s) return s; return c })
          }
        } else {
          // overKey.kind === 'vol'：把章追加到该卷末尾（含空卷「+ 新建第一章」占位区）
          const moved = moveChapterToVolume(ch, overKey.id, chapters.filter(c => c.volumeId === overKey.id), null, 'after')
          if (ch.volumeId === overKey.id) {
            nextChapters = chapters.map(c => { const m = moved.find(x => x.id === c.id); return m ? m : c })
          } else {
            const srcChs = chapters.filter(c => c.volumeId === ch.volumeId && c.id !== ch.id).sort((a, b) => a.order - b.order).map((c, i) => ({ ...c, order: i }))
            nextChapters = chapters.map(c => { const m = moved.find(x => x.id === c.id); if (m) return m; const s = srcChs.find(x => x.id === c.id); if (s) return s; return c })
          }
        }
        setChapters(nextChapters)
        const changed = nextChapters.filter((c, i) => c.order !== chapters[i].order || c.volumeId !== chapters[i].volumeId)
        dirty = changed.length > 0
        if (dirty) {
          await Promise.all(changed.map(c => saveChapterWithAi(c)))
          await resyncChapterMasterNumbers(volumes, nextChapters)
        }
      }
      if (dirty) showToast('排序已保存', 'success')
    } catch (err) {
      console.error('拖拽排序失败', err)
      showToast('排序失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    }
    resetDrag()
  }

  // UX12 键盘替代入口：Alt+↑/↓ 在同卷内移动章节、在真卷之间移动分卷（拖拽仍保留）
  const { moveByKeyboard } = createEditorKeyboardReorder({ volumes, chapters, setVolumes, setChapters, saveChapter: saveChapterWithAi })

  // 相邻章导航（全书叙事序：卷序 → 章序 → 孤儿章垫底，唯一真源）
  const flat = flattenAll(volumes, chapters)
  const activeIdx = flat.findIndex(c => c.id === activeId)

  return {
    // 结构数据（卷 / 章 / 当前章 / 序号）
    isLite, loaded, volumes, chapters, activeId, active, flat, activeIdx, nextChapterNo, chapterSeqs,
    // 章节树交互（改名 / 增删 / 拖拽重排）；setExpanded 已是持久化包装（签名兼容 Dispatch）
    expanded, setExpanded: setExpandedPersist, dragKind, setDragKind, setDragId, overKey, setOverKey, openChapter, submitNamePrompt, removeVolume, removeChapter, restoreSnapshot, applyChapterContent, resetDrag, handleDrop, toggleExcludeNumbering, moveByKeyboard,
    // 正文与保存（diskError/diskPending = 真实落盘状态，见 savedFlash 附近的说明）
    draftContent, commitContent, onContentChange, updateContent, updateMeta, saving, savedFlash, diskError, diskPending, todayWords, load,
    // 引用名高亮叠层（只走 scanRefHighlight，盒模型与 textarea 对齐）
    highlightHTML, referenced, highlightRef, scheduleHighlightSync,
    // 编辑区 refs 与光标同步
    scrollRef, taRef, mirrorRef, ghostRef, selRef, syncSel, getSelText, syncTypewriter,
    // AI 伴写（ghost 叠层 / 钢笔设置 / 采纳）
    companion, setCompanion, companionLen, setCompanionLen, companionDeAi, setCompanionDeAi, companionStyleNote, setCompanionStyleNote, companionStyleDims, setCompanionStyleDims, companionStyleSpec, setCompanionStyleSpec, ghost, ghostBusy, dismissGhost, onEditorKeyDown, insertAdvice, clearAdvice, openingText,
    // 摘要（本章摘要 / 批量重算）
    summarizing, genSummary, regenAllSummaries, regenAll, stopRegenAll, regenFailures, summaryRef,
    // 面板与尺寸（专注 / 检索栏 / 字号 / 页宽 / 打字机）
    focusMode, setFocusMode, showSearch, setShowSearch, fontSize, changeFontSize, typewriter, setTypewriter, pageWide, setPageWide, chapterPane, searchPane,
    // 三栏容器 ref + 正文列保底后的检索栏实际宽度 + 「铺满/限宽」开关显示与否
    wrapRef, searchPaneW, showPageWide, chapterCompact, searchFits, shortBody, BODY_MIN_H,
    // 本章引用侧栏
    showRefs, setShowRefs, highlightOn, setHighlightOn,
    // 弹窗与抽屉
    modal, setModal, exportOpen, setExportOpen, styleNotePrompt, setStyleNotePrompt, namePrompt, setNamePrompt, jieWenJiOpen, setJieWenJiOpen,
    // C6 导出格式弹窗
    exportFormatTab, setExportFormatTab,
    // 3.0.1 正文批量导入弹窗
    importOpen, setImportOpen,
    // 编辑器缩进（2.4.0 · A5）：单位是偏好，缩进动作本身在 NovelEditor 的键盘处理里
    indentUnit, setIndentUnit, pasteNormalize, setPasteNormalize, indentGuides, setIndentGuides,
    // AI 就绪与导出
    aiReady, runExport,
  }
}
