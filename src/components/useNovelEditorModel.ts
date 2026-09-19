/**
 * 正文编辑器的**状态与生命周期**（从 `NovelEditor.tsx` 拆出来的，2026-09-19）。
 *
 * 【为什么这么拆】原文件 1764 行：逻辑 929 行 + 视图 652 行，JSX 直接用到 96 个
 *   组件作用域名字（全组件声明 152 个）。正文编辑器又是全项目最怕回归的地方
 *   （叠层盒模型、光标同步、卸载冲刷草稿都在这儿），所以拆法选**只搬不改**：
 *   把状态 / effect / 动作整体收进来，视图侧同名解构接回去 —— JSX 一个字不动。
 *
 * 【随之搬过来的模块级件】escapeHtml / scanRefHighlight / 卷章重排算法 / ghost 常量 ——
 *   它们只被逻辑用（视图侧只用到 STATUS_LIST，仍留在视图文件里）。
 *
 * 🔴 搬动时逐条保住的红线：
 *   · 高亮只走 `scanRefHighlight`（叠层与 textarea 盒模型逐项一致的前提）；
 *   · ghost 在**切章时必须清掉**（否则 Tab 会把上一章的建议插进新章 → 数据事故）；
 *   · 卸载时冲刷未保存草稿（`key={activeId}` 重挂时唯一可靠的落点）；
 *   · 界面缩放生效：量尺寸用 offsetHeight/clientWidth，绝不 getBoundingClientRect。
 */
import { useEffect, useState, useCallback, useRef, useMemo, useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Volume, Chapter, } from '../lib/types'
import * as db from '../lib/db'
import { uid } from '../lib/id'
import { countWords } from '../lib/textStats'
import { todayKey } from '../lib/date'
import { useResizable } from '../lib/useResizable'


// 导出模块（zip/EPUB/DOCX 打包器较重）——改为按需动态导入，避免拖入首屏主包







import { ADVICE_START, ADVICE_END } from './JieWenJi'
import { confirmDialog, showToast } from './dialogs'
import { TABS, type VisCtx, refreshVolumeTabs } from '../lib/schema'
import { chapterSeqOf, chapterSeqMap, flattenChapters } from '../lib/chapterSeq'
import { syncChapterMaster } from '../lib/chapterMaster'
import { readAliases } from '../lib/aliases'
import { useAIReady } from '../lib/useAIReady'
import { aiChapterSummary, aiInlineSuggest, type InlineSuggestLength } from '../lib/aiTasks'
import { buildInlineBriefing } from '../lib/aiContext'
import { isCancelled } from '../lib/ai'

const HTML_ESCAPE_RE = /[&<>]/g
const HTML_ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
function escapeHtml(s: string): string {
  HTML_ESCAPE_RE.lastIndex = 0
  return HTML_ESCAPE_RE.test(s) ? s.replace(HTML_ESCAPE_RE, c => HTML_ESCAPE_MAP[c]) : s
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 超长正文降级阈值：超过则只读纯文本（仍转义），避免逐千字 + 数百引用名的扫描拖垮输入 */
const HIGHLIGHT_MAX_LEN = 60_000

interface RefScan { html: string; hits: Set<string> }

/**
 * 一次正则扫描同时产出「命中的引用名」与「高亮 HTML」。
 *
 * ⚠️ 性能修复（2.0.1）：旧实现是两趟全量扫描——先在别处做
 *   `refNames.filter(r => text.includes(r.name))`（O(引用数 × 正文长度)），
 *   再用 `text.split(re)` 把所有片段摊成数组、逐段 escapeHtml 后 join。
 *   上百个引用名 + 上万字章节时，每 120ms 防抖就要跑几万次字符串操作，直接卡住输入，
 *   表现为「打开/切换到长章节明显变慢」。现改为一次 exec 循环流式拼接，命中集合用 Set。
 *
 * 引用名按长度降序拼接，避免「陈渊」抢在「陈渊清欢」之前匹配导致截断。
 */
function scanRefHighlight(text: string, names: string[]): RefScan {
  const dict = [...new Set(names)].filter(n => n && n.length >= 2).sort((a, b) => b.length - a.length)
  if (dict.length === 0 || text.length > HIGHLIGHT_MAX_LEN) return { html: escapeHtml(text), hits: new Set() }
  const re = new RegExp(`(${dict.map(escapeRe).join('|')})`, 'g')
  const hits = new Set<string>()
  let html = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue } // 防御零宽匹配导致死循环
    if (m.index > last) html += escapeHtml(text.slice(last, m.index))
    html += `<mark class="ref-mark">${escapeHtml(m[0])}</mark>`
    hits.add(m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) html += escapeHtml(text.slice(last))
  return { html, hits }
}

/** 工作区可用的引用名（角色卡 + 世界构建设定表条目），用于本章引用侧栏与内联高亮。
 *  别称条目也在此登记（aliasOf 指向原本名称），正文出现别称时高亮并归入原名条目。 */
interface RefName { name: string; type: 'character' | 'setting'; tabId: string; aliasOf?: string }

// ---- AI 伴写（2.2.0）常量 ----
/** 停笔多久才请求。本地 27B 出一句话约 1~3s，太快会在正常停顿处疯狂起请求 */
const GHOST_DEBOUNCE_MS = 800
/** 取光标前多少字作前文：两三千字足够带稳语气、人称与专名，再多是浪费上下文窗口 */
const GHOST_CONTEXT_CHARS = 2000
/** 连续失败多少次自动静默禁用（避免每次停笔都白等一轮超时） */
const GHOST_MAX_FAILS = 3
/** 同前文缓存上限（LRU） */
const GHOST_CACHE_MAX = 20


/**
 * v1.6.3：卷/章拖拽排序的纯计算函数（不触碰状态/存储，便于复用）。
 * order 字段决定排序；跨卷移动章节须同时改 volumeId + order。
 */
function reorderVolumes(vols: Volume[], dragId: string, overId: string, pos: 'before' | 'after'): Volume[] {
  if (dragId === overId) return vols
  const sorted = [...vols].sort((a, b) => a.order - b.order)
  const fromIdx = sorted.findIndex(v => v.id === dragId)
  if (fromIdx < 0) return vols
  const [moved] = sorted.splice(fromIdx, 1)
  let toIdx = sorted.findIndex(v => v.id === overId)
  if (toIdx < 0) return vols
  if (pos === 'after') toIdx++
  sorted.splice(toIdx, 0, moved)
  return sorted.map((v, i) => ({ ...v, order: i }))
}

function reorderChapters(chs: Chapter[], dragId: string, overId: string, pos: 'before' | 'after'): Chapter[] {
  if (dragId === overId) return chs
  const sorted = [...chs].sort((a, b) => a.order - b.order)
  const fromIdx = sorted.findIndex(c => c.id === dragId)
  if (fromIdx < 0) return chs
  const [moved] = sorted.splice(fromIdx, 1)
  let toIdx = sorted.findIndex(c => c.id === overId)
  if (toIdx < 0) return chs
  if (pos === 'after') toIdx++
  sorted.splice(toIdx, 0, moved)
  return sorted.map((c, i) => ({ ...c, order: i }))
}

/** 把章节移动（或追加）到目标卷；overId 为 null 表示追加到卷尾 */
function moveChapterToVolume(ch: Chapter, targetVolId: string, targetChs: Chapter[], overId: string | null, pos: 'before' | 'after'): Chapter[] {
  const sorted = [...targetChs].sort((a, b) => a.order - b.order)
  const moved: Chapter = { ...ch, volumeId: targetVolId }
  if (overId == null) {
    sorted.push(moved)
  } else {
    let toIdx = sorted.findIndex(c => c.id === overId)
    if (toIdx < 0) { sorted.push(moved) }
    else { if (pos === 'after') toIdx++; sorted.splice(toIdx, 0, moved) }
  }
  return sorted.map((c, i) => ({ ...c, volumeId: targetVolId, order: i }))
}

/**
 * 重排后按**全局连续**重算「章节号」（1.9.2 起）。
 * 序号由 (卷序, 章序) 派生，与章节标题无关；标了「不计入序号」的章不占号。
 * 各章仍分别 resync 到自己所在卷的 chapter-vol-<vid> 台账表。
 */
async function resyncChapterMasterNumbers(vols: Volume[], chs: Chapter[]) {
  const seqs = chapterSeqMap(vols, chs)
  const tasks: Promise<void>[] = []
  flattenChapters(vols, chs).forEach((c, i) => {
    tasks.push(syncChapterMaster(c, seqs.get(c.id) ?? 0, i))
  })
  await Promise.all(tasks)
}

type Args = {
  /** 项目名（导出文件名 / 提示词里用） */
  projectName: string
  /** 可见性上下文：lite 形态与跨表引用范围 */
  ctx: VisCtx
  /** 顶层要求打开的章（跨页签跳转带下来） */
  openChapterId?: string | null
  /** 字数变化上报 */
  onStatsChange?: () => void
}

export function useNovelEditorModel({ ctx, openChapterId, onStatsChange }: Args) {
  const isLite = ctx.type !== 'full'
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // 拖拽排序状态：分卷 / 章节拖动时记录源与目标位置（v1.6.3）
  const [dragKind, setDragKind] = useState<null | 'vol' | 'ch'>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<null | { kind: 'vol' | 'ch'; id: string; pos: 'before' | 'after' }>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [showSearch, setShowSearch] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [modal, setModal] = useState<null | 'sensitive' | 'history' | 'trash' | 'search' | 'lock' | 'foreshadow' | 'continuity' | 'typo' | 'style'>(null)
  // v1.3 编辑器体验：本章引用侧栏 + 内联高亮
  const [showRefs, setShowRefs] = useState(false)
  // 2.2.0：引用名内联高亮改为**默认关闭**（长章节全量着色太吵视线，需要时手动开）
  const [highlightOn, setHighlightOn] = useState(false)
  const [refNames, setRefNames] = useState<RefName[]>([])
  const highlightRef = useRef<HTMLDivElement>(null)
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
  /** 光标位置（state 版）：点击/按键把光标挪到新位置时也要重新触发一次伴写 */
  const [caret, setCaret] = useState(0)
  const ghostRef = useRef<HTMLDivElement>(null)
  const ghostAbort = useRef<AbortController | null>(null)
  const ghostTimer = useRef<number | null>(null)
  /** 同前文 key → 建议（LRU 上限 20）：在同一位置反复停笔时不重复烧 token */
  const ghostCache = useRef(new Map<string, string>())
  /** 连续失败计数：满 GHOST_MAX_FAILS 次自动静默禁用（避免每次停笔都白等一轮超时） */
  const ghostFail = useRef(0)
  /**
   * Esc 丢弃后记下「光标位置 + 当时正文长度」。
   * 为什么需要它（2026-09-17 实机验证抓到）：自动保存在停笔 2 秒后提交，`chapters` 一更新
   * `active` 就是新对象 → 伴写 effect 重跑 → 刚被 Esc 拒掉的建议又被弹回来。作者会觉得"Esc 根本没用"。
   * 只有光标真的动了、或正文真的变了（长度变化）才允许再次自动请求。
   */
  const ghostDismissed = useRef<{ at: number; len: number } | null>(null)
  /** 设定资料 + 《写作规范》缓存（按章节失效）：ghost 请求要低延迟，不能每次重读全库 */
  // styleSpecOn 一并入缓存键：开关一翻，旧缓存里那份 styleSpec 就不能再用了
  const ghostCtxCache = useRef<{ chapterId: string; projectContext: string; styleSpec: string; styleSpecOn: boolean } | null>(null)
  // draftContent：当前章节的未保存内容（draftRef 同步镜像，供自动保存定时器读取最新值，防止 2 秒防抖期间 updateContent 的改动被旧值覆盖）
  const [draftContent, setDraftContent] = useState<string>('')
  const draftRef = useRef('')
  // 高亮叠层/引用命中等重计算与正文输入解耦：用 120ms 防抖的镜像值，避免每次按键全量重算长文卡顿
  const [deferredContent, setDeferredContent] = useState<string>('')
  useEffect(() => {
    const t = setTimeout(() => setDeferredContent(draftContent), 120)
    return () => clearTimeout(t)
  }, [draftContent])
  const [saving, setSaving] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  /** 导出操作统一收口：按需动态加载 exporter 模块（含 zip/EPUB/DOCX 打包器），避免拖入首屏主包 */
  const runExport = useCallback(async (fn: (m: typeof import('../lib/exporter')) => void) => {
    const m = await import('../lib/exporter')
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
  /** 把所有待落库的元信息补丁一起冲刷（防抖到点、组件卸载都走它；引用稳定，卸载 effect 依赖为空也不怕） */
  const metaFlush = useRef<() => Promise<void>>(async () => {
    const jobs = [...metaPending.current.values()]
    metaPending.current.clear()
    // 单笔失败不阻断其余（下一轮编辑会再次入账并重试）
    await Promise.all(jobs.map(j => j().catch(() => { /* 忽略单笔失败 */ })))
  })
  // 章节树 / 设定检索栏宽度可拖拽调整（持久化）
  const chapterPane = useResizable({ key: 'yfe-chapter-w', initial: 224, initialWide: 300, min: 200, max: 560, side: 'right' })
  const searchPane = useResizable({ key: 'yfe-search-w', initial: 360, initialWide: 480, min: 280, max: 760, side: 'right' })

  // 重载卷与章节（初始化与跨视图卷变更事件共用）；返回最新数据供调用方做额外处理
  const reloadVolumes = useCallback(async (): Promise<[Volume[], Chapter[]]> => {
    const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    setVolumes(vols)
    setChapters(chs)
    await refreshVolumeTabs() // 同步卷台账缓存，让侧栏「章节总表」下的各卷子项保持最新
    return [vols, chs]
  }, [])

  const load = useCallback(async () => {
    const [vols, chs] = await reloadVolumes()
    if (vols.length > 0) {
      setExpanded(new Set(vols.map(v => v.id)))
      if (chs.length > 0) {
        // 函数式更新：避免闭包中的过期 activeId 导致新增卷后当前章节被重置回第一章
        setActiveId(cur => cur ?? chs.filter(c => c.volumeId === vols[0].id)[0]?.id ?? null)
      }
    }
    setLoaded(true)
  }, [reloadVolumes])

  // 跨视图联动：在「章节总表」侧栏增/删/改卷后，本编辑器章节管理需同步刷新卷列表
  useEffect(() => {
    const onVol = () => { void reloadVolumes() }
    window.addEventListener('yfe:volumes-changed', onVol)
    return () => window.removeEventListener('yfe:volumes-changed', onVol)
  }, [reloadVolumes])

  // 今日码字量（保存后刷新）
  const loadTodayWords = useCallback(async () => {
    const stats = await db.getDailyStats()
    setTodayWords(stats.find(s => s.date === todayKey())?.words ?? 0)
  }, [])

  // load / loadTodayWords 均为「依赖链上全是空依赖」的稳定 useCallback
  // （load → reloadVolumes → []），补进依赖数组不会引发重复执行，仅让 lint 有据可依。
  useEffect(() => { load(); loadTodayWords() }, [load, loadTodayWords])

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
  const syncHighlightScroll = () => {
    if (!taRef.current) return
    const top = taRef.current.scrollTop
    if (highlightRef.current) highlightRef.current.scrollTop = top
    if (ghostRef.current) ghostRef.current.scrollTop = top
  }
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
  useLayoutEffect(() => {
    syncHighlightScroll()
    // ghost 也在这里回填：它的叠层是新挂载的 div，scrollTop 恒为 0，不回填会与正文错位
  }, [highlightHTML, activeId, fontSize, pageWide, focusMode, showSearch, ghost])

  /** 编辑区尺寸变化（窗口缩放、检索栏开合）时同样需要对齐叠层 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => syncHighlightScroll())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 卸载时清理尚未执行的同步帧，避免在已卸载的 ref 上写值 */
  useEffect(() => () => {
    if (scrollSyncRafRef.current) cancelAnimationFrame(scrollSyncRafRef.current)
  }, [])
  // 从其他页签跳转进来时，直接打开目标章节
  useEffect(() => {
    if (openChapterId && chapters.some(c => c.id === openChapterId)) {
      setActiveId(openChapterId)
    }
  }, [openChapterId, chapters])

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
    await db.saveChapter(next)
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
      if (leaving && draftRef.current !== leaving.content) {
        const text = draftRef.current
        const next: Chapter = { ...leaving, content: text, wordCount: countWords(text), updatedAt: Date.now() }
        // 🔴 切章冲刷失败必须可见（2026-09-19 六维审计 P2-10）：原先没有 catch，
        //    落库失败时这段稿子静默丢失，作者只看到字数没变。
        void db.saveChapter(next)
          .then(() => onStatsChangeRef.current?.())
          .catch((e: unknown) => showToast('自动保存失败：' + (e instanceof Error ? e.message : String(e)), 'error'))
        // 同步内存态，避免快速切回时读到陈旧内容把刚落库的稿子覆盖掉
        setChapters(prev => prev.map(c => (c.id === leaving.id ? next : c)))
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
  }, [activeId])

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
      const next: Chapter = { ...ch, content: text, wordCount: countWords(text), updatedAt: Date.now() }
      void db.saveChapter(next)
    }
  }, [])

  // Ctrl/Cmd+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (active && draftContent !== active.content) commitContent()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, draftContent]) // eslint-disable-line

  // 手动保存（可传入内容，自动保存时用，避免闭包中的过期 state）
  const commitContent = async (content?: string) => {
    if (!active) return
    const text = content ?? draftContent
    if (text === active.content) return
    const next: Chapter = { ...active, content: text, wordCount: countWords(text), updatedAt: Date.now() }
    setSaving(true)
    try {
      const { no } = locate(next)
      await Promise.all([db.saveChapter(next), syncChapterMaster(next, no)])
      setChapters(prev => prev.map(c => (c.id === next.id ? next : c)))
      setSavedFlash(true)
      clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setSavedFlash(false), 1500)
      onStatsChange?.()
      loadTodayWords()
    } catch (e) {
      // 🔴 落库失败必须复位 saving 并如实报错 —— 原先没有 try/finally，一旦抛错按钮会永久停在
      //    「保存中…」，还会产生未捕获 rejection（2026-09-19 六维审计 P1-5）。
      showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
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

  /** 切换章节：先冲刷未保存的自动保存草稿，再切换 */
  const openChapter = async (id: string) => {
    if (active && draftContent !== active.content) await commitContent(draftRef.current)
    clearTimeout(autosaveTimer.current)
    setActiveId(id)
  }

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
    if (!active) return
    const next: Chapter = { ...active, content, wordCount: countWords(content), updatedAt: Date.now() }
    setChapters(prev => prev.map(c => (c.id === next.id ? next : c)))
    draftRef.current = content
    setDraftContent(content)
    const { no } = locate(next)
    Promise.all([db.saveChapter(next), syncChapterMaster(next, no)])
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
    if (!active) return
    const next = { ...active, ...patch, updatedAt: Date.now() }
    setChapters(prev => prev.map(c => (c.id === next.id ? next : c)))
    const { no } = locate(next)
    const run = async () => {
      await Promise.all([db.saveChapter(next), syncChapterMaster(next, no)])
      onStatsChange?.()
    }
    // 🔴 P2-8：按章节 id 入账（同章覆盖、跨章共存），不再共用一个"最新那笔"
    metaPending.current.set(next.id, run)
    clearTimeout(metaTimer.current)
    metaTimer.current = setTimeout(() => { void metaFlush.current?.() }, 600)
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

  /** 批量重生成全书各章压缩摘要（约原文 1/10，覆盖现有摘要），用于把旧的一句式摘要刷新为内容摘要 */
  const [regenAll, setRegenAll] = useState(false)
  const regenAllSummaries = async () => {
    if (!aiReady || regenAll) return
    const ok = await confirmDialog({
      title: '批量重生成章节摘要',
      message: '将对全书所有「有正文」的章节，用 AI 重新生成约 1/10 长度的压缩摘要（覆盖现有摘要）。章节较多时耗时较长、会消耗较多调用，确定继续吗？',
    })
    if (!ok) return
    setRegenAll(true)
    try {
      const all = await db.getAllChapters()
      const vols = await db.getAllVolumes()
      const targets = all.filter(c => (c.content || '').trim().length > 0)
      let done = 0
      for (const c of targets) {
        try {
          const s = await aiChapterSummary(c.content)
          if (s) {
            const next = { ...c, summary: s }
            await db.saveChapter(next)
            // 🔴 台账的「一句话事件」是章节总表/情节推演本在读的字段，摘要变了必须同步登记，
            //    否则总表还显示旧摘要，用户会以为重生成没生效。
            await syncChapterMaster(next, chapterSeqOf(vols, all, next.id))
          }
        } catch { /* 单章失败跳过，继续其余 */ }
        done++
        if (done % 8 === 0) showToast(`已重生成摘要 ${done}/${targets.length}`, 'info')
      }
      showToast(`全书摘要重生成完成（共 ${targets.length} 章）`, 'success')
    } catch (e) {
      showToast('批量重生成失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setRegenAll(false)
    }
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
  const [namePrompt, setNamePrompt] = useState<null | { kind: 'addVol' | 'addCh' | 'renVol' | 'renCh'; title: string; def: string; payload?: unknown }>(null)

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

  // ============ 2.2.0 AI 伴写（ghost 逐句续写）============
  //
  // 交互对齐 WPS AI 伴写：停笔 → 光标后透出一句浅灰建议 → Tab 采纳 / 打字即丢弃。
  // 三条工程约束：
  //   · 采纳之前**正文一个字都没被改过**（ghost 只是画在叠层上的字），所以拒绝永远零破坏；
  //   · ghost 叠层与高亮叠层同层（均 z-0 + 透明基），盒模型逐项照抄高亮层，否则两图层必然错位；
  //   · **光标后已有正文时不显示** —— ghost 没有"宽度"，压到后面的字上会糊成一片。

  /** 取光标前 GHOST_CONTEXT_CHARS 字作前文（从 draftRef 读最新内容，避免闭包拿到旧值） */
  const ghostBefore = (at: number) => draftRef.current.slice(Math.max(0, at - GHOST_CONTEXT_CHARS), at)

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
  }, [companion, companionLen, companionDeAi, companionStyleNote, aiReady, activeId, draftContent, caret, fireGhost, ghostKey])

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
    const flat = volumes.flatMap(v => chapters.filter(c => c.volumeId === v.id).sort((a, b) => a.order - b.order))
    return flat.slice(0, 3).map(c => `${c.title}\n${c.content}`).join('\n\n')
  }, [volumes, chapters])

  const doAddVolume = async (title: string) => {
    if (!title) return
    const vol: Volume = { id: uid(), projectId: db.getCurrentProjectId(), order: volumes.length, title, description: '', createdAt: Date.now() }
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
    await db.saveChapter(ch)
    await load()
    setActiveId(ch.id)
    // 新章登记到对应卷的章节台账。序号取全局派生值——新章 order 为卷内最大值，
    // 通常排在卷末，但作者随后拖拽到任意位置时会由 resyncChapterMasterNumbers 重排。
    // ⚠️ 这里必须现读库：上方 setChapters 是异步的，闭包里的 chapters 还不含新章，
    // 用旧 state 算出的序号恒为 0，台账会被误标「不计入序号」（章节号留空、行序错乱）。
    const [lv, lc] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    await syncChapterMaster(ch, chapterSeqOf(lv, lc, ch.id))
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
    await Promise.all([db.saveChapter(next), syncChapterMaster(next, no)])
  }

  const submitNamePrompt = async (v: string) => {
    const p = namePrompt
    setNamePrompt(null)
    if (!v || !p) return
    if (p.kind === 'addVol') await doAddVolume(v)
    else if (p.kind === 'addCh') await doAddChapter(p.payload as string, v)
    else if (p.kind === 'renVol') await doRenameVolume(p.payload as Volume, v)
    else if (p.kind === 'renCh') await doRenameChapter(p.payload as Chapter, v)
  }

  const removeVolume = async (vol: Volume) => {
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
    await db.deleteChapter(ch.id)
    if (activeId === ch.id) setActiveId(null)
    await load()
    onStatsChange?.()
  }

  /** 时光机恢复：先把当前内容快照，再套用历史版本 */
  const restoreSnapshot = async (content: string) => {
    if (!active) return
    await db.createSnapshot(active)
    updateContent(content)
  }

  /** 全文替换后的回写 */
  const applyChapterContent = (id: string, content: string) => {
    const ch = chapters.find(c => c.id === id)
    if (!ch) return
    const next = { ...ch, content, wordCount: countWords(content), updatedAt: Date.now() }
    setChapters(prev => prev.map(c => (c.id === id ? next : c)))
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
        const next = reorderVolumes(volumes, dragId, overKey.id, overKey.pos)
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
          await Promise.all(changed.map(c => db.saveChapter(c)))
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

  // 相邻章导航
  const flat = volumes.flatMap(v => chapters.filter(c => c.volumeId === v.id).sort((a, b) => a.order - b.order))
  const activeIdx = flat.findIndex(c => c.id === activeId)

  return {
    // 结构数据（卷 / 章 / 当前章 / 序号）
    isLite, loaded, volumes, chapters, activeId, active, flat, activeIdx, nextChapterNo, chapterSeqs,
    // 章节树交互（改名 / 增删 / 拖拽重排）
    expanded, setExpanded, dragKind, setDragKind, setDragId, overKey, setOverKey, openChapter, submitNamePrompt, removeVolume, removeChapter, restoreSnapshot, applyChapterContent, resetDrag, handleDrop, toggleExcludeNumbering,
    // 正文与保存
    draftContent, commitContent, onContentChange, updateContent, updateMeta, saving, savedFlash, todayWords, load,
    // 引用名高亮叠层（只走 scanRefHighlight，盒模型与 textarea 对齐）
    highlightHTML, referenced, highlightRef, scheduleHighlightSync,
    // 编辑区 refs 与光标同步
    scrollRef, taRef, mirrorRef, ghostRef, selRef, syncSel, getSelText, syncTypewriter,
    // AI 伴写（ghost 叠层 / 钢笔设置 / 采纳）
    companion, setCompanion, companionLen, setCompanionLen, companionDeAi, setCompanionDeAi, companionStyleNote, setCompanionStyleNote, companionStyleSpec, setCompanionStyleSpec, ghost, ghostBusy, dismissGhost, onEditorKeyDown, insertAdvice, clearAdvice, openingText,
    // 摘要（本章摘要 / 批量重算）
    summarizing, genSummary, regenAllSummaries, regenAll, summaryRef,
    // 面板与尺寸（专注 / 检索栏 / 字号 / 页宽 / 打字机）
    focusMode, setFocusMode, showSearch, setShowSearch, fontSize, changeFontSize, typewriter, setTypewriter, pageWide, setPageWide, chapterPane, searchPane,
    // 本章引用侧栏
    showRefs, setShowRefs, highlightOn, setHighlightOn,
    // 弹窗与抽屉
    modal, setModal, exportOpen, setExportOpen, styleNotePrompt, setStyleNotePrompt, namePrompt, setNamePrompt, jieWenJiOpen, setJieWenJiOpen,
    // AI 就绪与导出
    aiReady, runExport,
  }
}

export type NovelEditorModel = ReturnType<typeof useNovelEditorModel>
