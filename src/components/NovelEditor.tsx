import { foldVh } from '../lib/theme'
import { Z } from '../lib/zLayer'
import { useEffect, useState, useCallback, useRef, useMemo, useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Volume, Chapter, ChapterStatus } from '../lib/types'
import * as db from '../lib/db'
import { uid } from '../lib/id'
import { countWords } from '../lib/textStats'
import { todayKey } from '../lib/date'
import { useResizable } from '../lib/useResizable'
import SettingSearch from './SettingSearch'
import { SensitiveCheck, VersionHistory, TrashBin, GlobalSearch, FocusLock, ProofreadCheck } from './EditorModals'
import { ForeshadowBoard, ContinuityCheck, StyleAudit } from './AuditModals'
// 导出模块（zip/EPUB/DOCX 打包器较重）——改为按需动态导入，避免拖入首屏主包
import { formatNovelText } from '../lib/textTools'
import {
  BookMarked, FilePlus2, FolderPlus, Trash2, PenLine, ChevronRight, ChevronDown,
  Save, ArrowLeft, ArrowRight, Maximize2, Minimize2, PanelRightClose, PanelRightOpen,
  ShieldAlert, History, Search, Lock, AlignLeft, Upload, Hash, AlignCenter, Flame,
  GitBranch, Link2, SpellCheck, Feather, PanelsTopLeft,
  Command, Highlighter, BookOpen, Users, X, GripVertical, Sparkles, Loader2, Wand2, Layers, PenTool
} from 'lucide-react'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import PromptModal from './PromptModal'
import JieWenJi, { ADVICE_START, ADVICE_END } from './JieWenJi'
import { confirmDialog, showToast } from './dialogs'
import { TABS, type VisCtx, refreshVolumeTabs } from '../lib/schema'
import { chapterSeqOf, chapterSeqMap, flattenChapters } from '../lib/chapterSeq'
import { syncChapterMaster } from '../lib/chapterMaster'
import { readAliases } from '../lib/aliases'
import { useAIReady } from '../lib/useAIReady'
import { aiChapterSummary, aiInlineSuggest, INLINE_SUGGEST_LIMITS, type InlineSuggestLength } from '../lib/aiTasks'
import { buildInlineBriefing } from '../lib/aiContext'
import { isCancelled } from '../lib/ai'
import { Button } from './Button'
import { LoadingState } from './LoadingState'

interface Props {
  onStatsChange?: () => void
  onNavigate?: (id: string) => void
  /** v1.3：唤起全文检索命令面板 */
  onOpenSearch?: () => void
  projectName?: string
  /** 可见性上下文：自定义项目（未启用相应功能时）隐藏伏笔闭环 / 连续性校验入口，按启用功能集过滤 */
  ctx: VisCtx
  /** 从其他页签（如章节总表）跳转进来时，要直接打开的章节 id */
  openChapterId?: string | null
}

const STATUS_META: Record<ChapterStatus, { label: string; cls: string }> = {
  '构思': { label: '构思', cls: 'badge-gray' },
  '细纲': { label: '细纲', cls: 'badge-blue' },
  '草稿': { label: '草稿', cls: 'badge-amber' },
  '修改': { label: '修改', cls: 'badge-amber' },
  '完稿': { label: '完稿', cls: 'badge-green' },
  '已发布': { label: '已发布', cls: 'badge-green' },
}
const STATUS_LIST = Object.keys(STATUS_META) as ChapterStatus[]

/** 章节树状态圆点颜色 */
const STATUS_DOT: Record<ChapterStatus, string> = {
  '构思': 'bg-ink-500',
  '细纲': 'bg-sky-400',
  '草稿': 'bg-amber',
  '修改': 'bg-orange-400',
  '完稿': 'bg-emerald-400',
  '已发布': 'bg-emerald-500',
}

/** HTML 转义（防止引用名高亮注入）。先探测再替换：绝大多数正文片段不含 <>&，可省掉多次全量 replace */
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

export default function NovelEditor({ onStatsChange, onNavigate, onOpenSearch, projectName = '我的小说', openChapterId, ctx = { type: 'full', features: [] } }: Props) {
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
        void db.saveChapter(next).then(() => onStatsChangeRef.current?.())
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
    const { no } = locate(next)
    await Promise.all([db.saveChapter(next), syncChapterMaster(next, no)])
    setChapters(prev => prev.map(c => (c.id === next.id ? next : c)))
    setSaving(false)
    setSavedFlash(true)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1500)
    onStatsChange?.()
    loadTodayWords()
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

  if (!loaded) return <LoadingState />

  return (
    <div className="flex h-full page-enter overflow-hidden">
      {/* 章节树 */}
      {!focusMode && (
        <div
          className="relative shrink-0 border-r border-ink-700 bg-ink-900 flex flex-col"
          style={{ width: chapterPane.size, minWidth: chapterPane.size }}
        >
          {/* 拖拽调整章节树宽度 */}
          <div
            onMouseDown={chapterPane.onDragStart}
            className="absolute top-0 right-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-amber/40 transition-colors"
style={{ zIndex: Z.pageHandle }}
            title="拖拽调整章节栏宽度"
          />
          <div className="flex items-center justify-between px-3.5 h-11 border-b border-ink-700 shrink-0">
            <span className="text-[12px] font-semibold text-ink-200 flex items-center gap-1.5">
              <BookMarked size={13} className="text-amber" /> 章节
              <HelpPopover title="卷章目录怎么用" width="22rem" side="right">
                {'全书的卷 / 章结构树，也是章节间切换的入口。\n\n· 右上「新建卷」建卷，卷名右侧悬停出现「＋」新建该卷下的章；\n· 悬停出现「⋮⋮」拖把，按住可拖动分卷/章节重排，章节可拖到其他卷（拖到空卷的「+ 新建第一章」处可加入该卷）；\n· 单击章节打开正文；双击章名可改名；单击卷名可改卷名；\n· 章前小圆点是状态色：灰=构思、蓝=细纲、黄=草稿、橙=修改、绿=完稿/已发布；\n· 圆点右侧的小数字是「正文序号」：由卷序与章序自动生成，跨卷连续，改名不会影响它，拖拽重排后会自动重算；\n· 悬停出现「＃」可把某章设为「不计入序号」（序章 / 番外 / 后记不占号），设后该图标变琥珀色常驻，再点一次恢复；\n· 悬停出现垃圾桶可删除，删除的卷章进回收站，可在工具栏「回收站」里恢复；\n· 右上「下载」图标一键导出全书 TXT。\n\n新建章节会自动登记进该卷的「章节台账」，字数与摘要保存时同步。'}
              </HelpPopover>
            </span>
            <div className="flex gap-1">
              <Button variant="icon-amber"
                onClick={() => runExport(m => m.exportWholeBook(projectName, volumes, chapters))}
                className="p-1 shrink-0"
                title="导出全书 TXT">
                <Upload size={14} />
              </Button>
              <Button variant="icon-amber" onClick={() => setNamePrompt({ kind: 'addVol', title: '新建卷', def: `第${volumes.length + 1}卷` })} title="新建卷" className="p-1 shrink-0">
                <FolderPlus size={13} />
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-2 px-2">
            {volumes.length === 0 && (
              <div className="text-center py-14 text-ink-500 text-[12px] border border-dashed border-ink-700 rounded-lg mx-1">
                <FolderPlus size={18} className="mx-auto mb-2 text-ink-600" />
                点击右上角新建第一卷
              </div>
            )}
            {volumes.map(vol => {
              const chs = chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)
              const open = expanded.has(vol.id)
              const volWords = chs.reduce((s, c) => s + c.wordCount, 0)
              return (
                <div key={vol.id} className="mb-1.5">
                  <div
                    className={`group flex items-center gap-1 px-2 py-1.5 rounded-md hover:bg-ink-800 transition-colors ${overKey?.kind === 'vol' && overKey.id === vol.id ? 'ring-1 ring-amber/70 bg-amber/5' : ''}`}
                    onDragOver={e => {
                      if (!dragKind) return
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      const pos: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                      setOverKey({ kind: 'vol', id: vol.id, pos })
                    }}
                    onDrop={e => { e.preventDefault(); handleDrop() }}
                  >
                    <span
                      draggable
                      onDragStart={e => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', vol.id); setDragKind('vol'); setDragId(vol.id) }}
                      onDragEnd={() => resetDrag()}
                      className="opacity-40 group-hover:opacity-100 cursor-grab active:cursor-grabbing text-ink-500 hover:text-amber transition-opacity shrink-0"
                      title="拖动重排分卷"
                    >
                      <GripVertical size={12} />
                    </span>
                    <Button variant="icon-muted"
                      onClick={() => {
                        const next = new Set(expanded)
                        if (next.has(vol.id)) next.delete(vol.id); else next.add(vol.id)
                        setExpanded(next)
                      }}>
                      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </Button>
                    <span
                      onClick={() => setNamePrompt({ kind: 'renVol', title: '修改卷名', def: vol.title, payload: vol })}
                      className="text-[12.5px] font-semibold text-ink-100 cursor-pointer hover:text-amber transition-colors flex-1 truncate"
                      title="点击改卷名"
                    >
                      {vol.title}
                    </span>
                    <span className="text-[9px] text-ink-600">{chs.length}章·{(volWords / 10000).toFixed(1)}万</span>
                    <Button variant="bare" iconOnly size="sm"
                      onClick={() => setNamePrompt({ kind: 'addCh', title: '新建章节', def: `第${nextChapterNo}章`, payload: vol.id })}
                      className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all"
                      title="新建章"
                    >
                      <FilePlus2 size={12} />
                    </Button>
                    <Button variant="icon-danger"
                      onClick={() => removeVolume(vol)}
                      className="opacity-40 group-hover:opacity-100 p-0.5 transition-all">
                      <Trash2 size={12} />
                    </Button>
                  </div>
                  {open && (
                    <div className="ml-3 border-l border-ink-700 pl-1 mt-0.5 space-y-0.5">
                      {chs.map(ch => {
                        const isActive = activeId === ch.id
                        return (
                          <div
                            key={ch.id}
                            onClick={() => openChapter(ch.id)}
                            className={`group flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer transition-colors
                              ${isActive ? 'bg-amber/10 text-amber' : 'text-ink-300 hover:bg-ink-800'}
                              ${overKey?.kind === 'ch' && overKey.id === ch.id ? (overKey.pos === 'before' ? 'shadow-[inset_0_2px_0_0_rgba(245,158,11,0.7)]' : 'shadow-[inset_0_-2px_0_0_rgba(245,158,11,0.7)]') : ''}`}
                            onDragOver={e => {
                              if (dragKind !== 'ch') return
                              e.preventDefault(); e.stopPropagation()
                              const rect = e.currentTarget.getBoundingClientRect()
                              const pos: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                              setOverKey({ kind: 'ch', id: ch.id, pos })
                            }}
                            onDrop={e => { e.preventDefault(); e.stopPropagation(); handleDrop() }}
                          >
                            <span
                              draggable
                              onDragStart={e => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ch.id); setDragKind('ch'); setDragId(ch.id) }}
                              onDragEnd={() => resetDrag()}
                              className="opacity-40 group-hover:opacity-100 cursor-grab active:cursor-grabbing text-ink-500 hover:text-amber transition-opacity shrink-0"
                              title="拖动重排 / 移到其他卷"
                            >
                              <GripVertical size={12} />
                            </span>
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[ch.status]}`} title={ch.status} />
                              {/* 系统派生的正文序号：与章名无关，改名字它也不会变 */}
                              <span
                                className="text-[9px] text-ink-600 shrink-0 tabular-nums w-4 text-right"
                                title={ch.excludeFromNumbering ? '不计入序号（序章 / 番外 / 后记）' : '正文序号（由卷序与章序派生）'}
                              >
                                {chapterSeqs.get(ch.id) || ''}
                              </span>
                              <span className="text-[12px] truncate flex-1" onDoubleClick={() => setNamePrompt({ kind: 'renCh', title: '修改章名', def: ch.title, payload: ch })} title={`双击改章名 · 状态：${ch.status}`}>
                                {ch.title}
                              </span>
                              <span className="text-[9px] text-ink-600 group-hover:hidden">{ch.wordCount > 0 ? `${ch.wordCount}字` : ''}</span>
                              <Button variant="bare"
                                onClick={e => { e.stopPropagation(); toggleExcludeNumbering(ch) }}
                                className={`p-0.5 transition-colors ${
                                  ch.excludeFromNumbering
                                    ? 'text-amber'
                                    : 'hidden group-hover:block text-ink-500 hover:text-amber'
                                }`}
                                title={ch.excludeFromNumbering
                                  ? '已设为「不计入序号」（序章 / 番外 / 后记），点击恢复计号'
                                  : '设为「不计入序号」：序章 / 番外 / 后记不占正文号'}
                              >
                                <Hash size={12} />
                              </Button>
                              <Button variant="icon-danger"
                                onClick={e => { e.stopPropagation(); removeChapter(ch) }}
                                className="hidden group-hover:block p-0.5">
                                <Trash2 size={12} />
                              </Button>
                          </div>
                        )
                      })}
                      {chs.length === 0 && (
                        <Button variant="bare"
                          onClick={() => setNamePrompt({ kind: 'addCh', title: '新建章节', def: `第${nextChapterNo}章`, payload: vol.id })}
                          onDragOver={e => { if (dragKind !== 'ch') return; e.preventDefault(); e.stopPropagation(); setOverKey({ kind: 'vol', id: vol.id, pos: 'after' }) }}
                          onDrop={e => { e.preventDefault(); e.stopPropagation(); handleDrop() }}
                          className={`w-full text-left px-2 py-1.5 text-[11px] transition-colors ${overKey?.kind === 'vol' && overKey.id === vol.id ? 'text-amber bg-amber/5 ring-1 ring-amber/70' : 'text-ink-500 hover:text-amber'}`}
                          title="拖动章节到此可加入本卷"
                        >
                          + 新建第一章
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 左侧 1/3：设定检索栏 */}
      {!focusMode && showSearch && (
        <div
          className="relative shrink-0 flex flex-col"
          style={{ width: searchPane.size, minWidth: searchPane.size }}
        >
          {/* 拖拽调整设定检索栏宽度 */}
          <div
            onMouseDown={searchPane.onDragStart}
            className="absolute top-0 right-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-amber/40 transition-colors"
style={{ zIndex: Z.pageHandle }}
            title="拖拽调整检索栏宽度"
          />
          <SettingSearch onNavigate={onNavigate} ctx={ctx} />
        </div>
      )}

      {/* 右侧 2/3：编辑区 */}
      <div className="flex-1 flex flex-col min-w-0 bg-ink-950/92 relative">
        {active ? (
          <>
            {/* 工具栏：按钮较多（22 个），窄窗口下原本会溢出到屏幕外点不到（实测溢出 618px）。
                改为横向可滚动 + 收紧间距，保证任何窗口宽度下按钮都可达 */}
            {/* 🔴 菜单打开时要放开纵向裁剪：`overflow-x-auto` 会连 `overflow-y` 一起变成裁剪容器，
                而导出菜单是工具栏内的绝对定位元素（`top-full`）—— 不放开的话它只在工具栏
                那 44px 里可见，实际等于「点了不出现」。菜单本身不宽，放开后仍能回到横滚。 */}
            <div className={`flex items-center gap-1.5 px-5 h-11 border-b border-ink-700 shrink-0 bg-ink-900/50 ${exportOpen ? 'overflow-visible' : 'overflow-x-auto overflow-y-hidden'}`}>
              <div className="flex items-center gap-1">
                <Button variant="ghost" disabled={activeIdx <= 0} onClick={() => openChapter(flat[activeIdx - 1].id)} iconOnly size="sm" className="p-1 disabled:opacity-30 transition-colors shrink-0" title="上一章">
                  <ArrowLeft size={14} />
                </Button>
                <Button variant="ghost"
                  disabled={activeIdx >= flat.length - 1}
                  onClick={() => openChapter(flat[activeIdx + 1].id)}
                  iconOnly size="sm"
                  className="p-1 text-ink-400 hover:text-ink-100 disabled:opacity-30 transition-colors shrink-0"
                  title="下一章"
                >
                  <ArrowRight size={14} />
                </Button>
              </div>
              <input
                value={active.title}
                onChange={e => updateMeta({ title: e.target.value })}
                className="!bg-transparent !border-transparent !px-1 text-[14px] font-semibold text-ink-50 flex-1 min-w-0 hover:!border-ink-600 focus:!border-amber/50 font-serif"
              />
              <select
                value={active.status}
                onChange={e => updateMeta({ status: e.target.value as ChapterStatus })}
                className="!py-0.5 !px-1.5 text-[11px] shrink-0"
                title={`章节状态：${active.status}`}
              >
                {STATUS_LIST.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <div className="w-px h-4 bg-ink-700" />
              {/* 工具组：敏感词 / 排版 / 导出 / 时光机 / 回收站 / 全文搜索 / 小黑屋 */}
              <Button variant="bare" iconOnly size="sm" onClick={() => setModal('sensitive')} className="text-ink-400 hover:text-red-400 transition-colors shrink-0" title="敏感词检测（本章）">
                <ShieldAlert size={14} />
              </Button>
              <Button variant="icon-amber"
                onClick={async () => { if (await confirmDialog({ title: '一键排版', message: '统一段落首行缩进（两个全角空格）并规范空行？' })) updateContent(formatNovelText(draftContent)) }}
                className="p-1 shrink-0"
                title="一键排版（首行缩进+空行规范）">
                <AlignLeft size={14} />
              </Button>
              <div className="w-px h-4 bg-ink-700" />
              {/* 审计工具组：伏笔闭环 / 连续性校验 / 错别字 / 文风体检 */}
              {!isLite && (
              <Button variant="icon-amber" onClick={() => setModal('foreshadow')} className="p-1 shrink-0" title="伏笔闭环看板（全局）">
                <GitBranch size={14} />
              </Button>
              )}
              {!isLite && (
              <Button variant="icon-amber" onClick={() => setModal('continuity')} className="p-1 shrink-0" title="连续性校验器（全局）">
                <Link2 size={14} />
              </Button>
              )}
              <Button variant="bare" iconOnly size="sm" onClick={() => setModal('typo')} className="text-ink-400 hover:text-red-400 transition-colors shrink-0" title="校对（本章）：本地错别字直接查；语病 / 逻辑 / 设定矛盾需接入 AI 模型">
                <SpellCheck size={14} />
              </Button>
              {!isLite && (
              <Button variant="icon-amber" onClick={() => setModal('style')} className="p-1 shrink-0" title="文风体检（本章）">
                <Feather size={14} />
              </Button>
              )}
              <div className="w-px h-4 bg-ink-700" />
              <Button variant="bare" iconOnly size="sm"
                onClick={() => setJieWenJiOpen(o => !o)}
                className={`p-1 transition-colors shrink-0 ${jieWenJiOpen ? 'text-amber' : 'text-ink-400 hover:text-amber'}`}
                title="颉文姬 · AI 编辑：深度校对 / 综合诊断 / 选区改稿 / 审读 / 写作简报 / 本章设定补登（AI 增强需配置模型）"
              >
                <Wand2 size={14} />
              </Button>
              {/* 导出菜单：本章 / 按卷 / 按章节 / 全本（图标化，节省工具栏空间） */}
              <div className="relative shrink-0">
                <Button variant="bare" iconOnly size="sm"
                  onClick={() => setExportOpen(o => !o)}
                  className={`flex items-center p-1 rounded transition-colors ${exportOpen ? 'text-amber bg-amber/10' : 'text-ink-400 hover:text-amber'}`}
                  title="导出 TXT（本章 / 按卷 / 按章 / 全本）"
                >
                  <Upload size={14} />
                  <ChevronDown size={9} className="ml-0.5 opacity-70" />
                </Button>
                {exportOpen && (
                  <>
                    {/* 全屏透明遮罩：本页「点击外部关闭」就靠它（没有额外的 document 监听），
                        故有意 fixed inset-0。z 取页内局部层号 —— 与 JieWenJi:417 / 本文件 :1386 /
                        Sidebar:135 的页内面板同一约定；不取 Z 是因为这些是**页内**面板、非全站常驻角标。 */}
                    <div className="fixed inset-0" style={{ zIndex: Z.pagePanel }} onClick={() => setExportOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 min-w-[220px] bg-ink-800 border border-ink-600 rounded-lg shadow-2xl py-1.5 overflow-y-auto"
style={{ zIndex: Z.pagePanelTop, maxHeight: foldVh('60vh') }}>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportChapter(projectName, active))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-[12px] text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出本章（{active.title}）
                      </Button>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportWholeBook(projectName, volumes, chapters))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-[12px] text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出全本（一卷一章）
                      </Button>
                      <div className="my-1 mx-2 border-t border-ink-700" />
                      <div className="px-3 py-1 text-[10px] text-ink-500">导出全文（多格式）</div>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportBookMD(projectName, volumes, chapters))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-[12px] text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出全书（Markdown）
                      </Button>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportEPUB(projectName, volumes, chapters))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-[12px] text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出全书（EPUB）
                      </Button>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportDOCX(projectName, volumes, chapters))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-[12px] text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出全书（DOCX）
                      </Button>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportBookPlatformText(projectName, volumes, chapters))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-[12px] text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                        title="干净纯文本，适配起点 / 番茄等网文平台粘贴"
                      >
                        <Upload size={11} className="text-amber" /> 导出全书（平台粘贴版）
                      </Button>
                      <div className="my-1 mx-2 border-t border-ink-700" />
                      <div className="px-3 py-1 text-[10px] text-ink-500">按卷导出</div>
                      {volumes.length === 0 ? (
                        <div className="px-3 py-1.5 text-[11px] text-ink-500">暂无分卷</div>
                      ) : volumes.map(vol => (
                        <Button variant="bare"
                          key={vol.id}
                          onClick={() => runExport(m => m.exportVolume(projectName, vol, chapters))}
                          className="w-full text-left !justify-start pl-5 pr-3 py-1 text-[12px] text-ink-200 hover:bg-ink-700 truncate"
                          title={`导出「${vol.title}」`}
                        >
                          {vol.title}（{chapters.filter(c => c.volumeId === vol.id).length} 章）
                        </Button>
                      ))}
                      <div className="my-1 mx-2 border-t border-ink-700" />
                      <div className="px-3 py-1 text-[10px] text-ink-500">按章节导出</div>
                      <Button variant="bare"
                        onClick={async () => {
                          // 每章一个文件——使用循环 setTimeout 避免浏览器拦截多个下载
                          const m = await import('../lib/exporter')
                          let i = 0
                          const all = flattenChapters(volumes, chapters)
                          const tick = () => {
                            if (i >= all.length) return
                            m.exportChapter(projectName, all[i++])
                            setTimeout(tick, 250)
                          }
                          tick()
                          setExportOpen(false)
                        }}
                        className="w-full text-left !justify-start px-3 py-1.5 text-[12px] text-ink-200 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} /> 全部章节逐一导出（{chapters.length} 个文件）
                      </Button>
                      <div className="max-h-40 overflow-y-auto">
                        {flattenChapters(volumes, chapters).map(ch => (
                          <Button variant="bare"
                            key={ch.id}
                            onClick={() => runExport(m => m.exportChapter(projectName, ch))}
                            className="w-full text-left !justify-start pl-5 pr-3 py-0.5 text-[11px] text-ink-300 hover:bg-ink-700 truncate"
                            title={ch.title}
                          >
                            {ch.title}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="w-px h-4 bg-ink-700" />
              {/* 保存：图标化，有未保存修改时琥珀高亮+圆点 */}
              <Button variant="bare" iconOnly size="sm"
                onClick={() => commitContent()}
                disabled={saving || draftContent === active.content}
                className={`relative p-1 rounded transition-colors shrink-0
                  ${draftContent !== active.content
                    ? 'text-amber hover:bg-amber/15'
                    : 'text-ink-500 cursor-not-allowed'}`}
                title={saving ? '保存中…' : draftContent !== active.content ? '保存（Ctrl+S）' : '已全部保存'}
              >
                <Save size={14} />
                {draftContent !== active.content && !saving && (
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
                )}
              </Button>
              <Button variant="icon-amber" onClick={() => setModal('history')} className="p-1 shrink-0" title="时光机 · 版本历史">
                <History size={14} />
              </Button>
              <Button variant="icon-amber" onClick={() => setModal('trash')} className="p-1 shrink-0" title="回收站（恢复误删章节）">
                <Trash2 size={14} />
              </Button>
              <Button variant="icon-amber" onClick={() => onOpenSearch?.()} className="p-1 shrink-0" title="全文检索（Ctrl/Cmd+K）：搜章节正文 / 角色 / 设定">
                <Command size={14} />
              </Button>
              <Button variant="bare" iconOnly size="sm" onClick={() => setShowRefs(o => !o)} className={`p-1 transition-colors shrink-0 ${showRefs ? 'text-amber' : 'text-ink-400 hover:text-amber'}`} title="本章引用侧栏：列出本章提到的角色 / 设定条目（可点击直达）">
                <Users size={14} />
              </Button>
              <Button variant="bare" iconOnly size="sm" onClick={() => setHighlightOn(o => !o)} className={`p-1 transition-colors shrink-0 ${highlightOn ? 'text-amber' : 'text-ink-400 hover:text-amber'}`} title="引用名内联高亮：正文中标记已登记的角色 / 设定条目名称（开 / 关）">
                <Highlighter size={14} />
              </Button>
              {/* 2.2.0 AI 伴写：**点钢笔直接弹出「说明 + 设置 + 开关」**，总开关放在设置下方。
                  为什么不再单设一个开关图标 + 一个并列的问号：同一件事有两个入口既重复、又难扫；
                  作者点这个键时想做的事无非「看看它怎么用」和「改一下 / 关掉它」——都收进这一个窗里。
                  pin：设置类弹窗不许"鼠标移出即关"，否则手往窗里的控件上一挪就误关。 */}
              <HelpPopover
                title="AI 伴写"
                width="24rem"
                size={13}
                className="shrink-0"
                pin
                triggerIconBox
                trigger={ghostBusy ? <Loader2 size={14} className="animate-spin" /> : <PenTool size={14} />}
                // ⚠️ 刻意**不**把触发键设成 disabled：弹窗里既有开关也有说明，
                //    禁用掉就变成"没配模型时连它怎么用都看不到"。真正的 AI 入口（弹窗里的总开关）
                //    仍然是 disabled —— 符合「无模型不调用 AI」这条红线，但把说明留给人读。
                triggerClassName={`p-1 transition-colors shrink-0 ${!aiReady ? 'text-ink-600' : companion ? 'text-amber' : 'text-ink-400 hover:text-amber'}`}
                triggerTitle={!aiReady
                  ? 'AI 伴写：未配置 AI 模型（点击可看说明与设置）'
                  : companion
                    ? 'AI 伴写：已开启（点击查看说明、档位与开关）'
                    : 'AI 伴写：已关闭（点击查看说明、档位与开关）'}
              >
                {'停笔约 0.8 秒后自动感知前文，在光标处透出一句「浅灰色」续写建议。\n· Tab 采纳 → 文字正式落进正文（→ 在末尾时也可采纳）；\n· 继续打字 / Esc / 移动光标 → 建议悄悄消失，正文一个字都没被改过；\n· Alt+\\ 可随时手动触发一次。\n\n文风不靠「选风格」，而是三层自动锚定：①光标前约 2000 字正文（最准的风格样本）②《写作规范》里你登记的坏习惯词 / 标点偏好（可关）③下面这句自定义补充。\n\n'}
                <AIDataSourceNote feature="inline-suggest" />
                <div className="mt-1.5 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-ink-400 shrink-0">建议长度</span>
                    {(['short', 'sentence', 'two'] as InlineSuggestLength[]).map(k => (
                      <Button variant="toggle" size="xs" key={k} selected={companionLen === k}
                        onClick={() => { setCompanionLen(k); localStorage.setItem('novel-companion-len', k) }}
                        title={`不超过 ${INLINE_SUGGEST_LIMITS[k].chars} 字`}>
                        {INLINE_SUGGEST_LIMITS[k].label}
                      </Button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-ink-400 shrink-0">去 AI 味</span>
                    <Button variant="toggle" size="xs" selected={companionDeAi}
                      onClick={() => { const v = !companionDeAi; setCompanionDeAi(v); localStorage.setItem('novel-companion-deai', v ? '1' : '0') }}
                      title="约束模型不用「仿佛 / 不禁 / 然而」这类套话开头、不堆四字成语与排比、不写空泛升华（默认开）">
                      {companionDeAi ? '已开启' : '已关闭'}
                    </Button>
                    <span className="text-ink-500 text-[10px]">压制套话与排比，默认开</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-ink-400 shrink-0">参考写作规范</span>
                    <Button variant="toggle" size="xs" selected={companionStyleSpec}
                      onClick={() => { const v = !companionStyleSpec; setCompanionStyleSpec(v); localStorage.setItem('novel-companion-stylespec', v ? '1' : '0') }}
                      title="把《写作规范》里登记的坏习惯词 / 标点偏好 / 视角规则锚进伴写；关掉后只靠前文样本与下面的文风补充">
                      {companionStyleSpec ? '已开启' : '已关闭'}
                    </Button>
                    <span className="text-ink-500 text-[10px]">负面清单，默认开</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-ink-400 shrink-0">文风补充</span>
                    <Button variant="toggle" size="xs" selected={!!companionStyleNote}
                      onClick={() => setStyleNotePrompt(true)}
                      className="max-w-[13rem]"
                      title={companionStyleNote || '点一句话描述你想要的文风，例如"冷硬白描，少心理活动，多用短对白"'}>
                      <span className="truncate">{companionStyleNote || '未设置（点击填写）'}</span>
                    </Button>
                  </div>
                  {/* 总开关：按老大要求放在设置下面，并掉与它重复的那个独立开关图标 */}
                  <div className="flex items-center gap-2 mt-1 pt-2 border-t border-ink-700">
                    <span className="text-ink-200 shrink-0">总开关</span>
                    <Button variant="toggle" size="xs" selected={companion} disabled={!aiReady}
                      onClick={() => setCompanion(o => { const v = !o; localStorage.setItem('novel-companion', v ? '1' : '0'); if (!v) dismissGhost(); return v })}
                      title={!aiReady ? '未配置 AI 模型' : companion ? '点击关闭 AI 伴写（默认关闭）' : '点击开启 AI 伴写'}>
                      {companion ? '已开启' : '已关闭'}
                    </Button>
                    <span className="text-ink-500 text-[10px]">{!aiReady ? '需先接入 AI 模型' : companion ? '停笔即续写一句话' : '默认关闭'}</span>
                  </div>
                  <div className="text-ink-500 text-[10px] leading-relaxed">
                    全部为本机记忆，换章不重置。伴写只用本地/你配置的模型，正文不外发。
                  </div>
                </div>
              </HelpPopover>
              <Button variant="icon-amber" onClick={() => onNavigate?.('chapter-outline')} className="p-1 shrink-0" title="前往本章大纲（章节细纲）">
                <BookOpen size={14} />
              </Button>
              <Button variant="icon-amber" onClick={() => setModal('search')} className="p-1 shrink-0" title="全文搜索替换（本书）">
                <Search size={14} />
              </Button>
              <Button variant="icon-amber" onClick={() => setModal('lock')} className="p-1 shrink-0" title="小黑屋 · 强制码字">
                <Lock size={14} />
              </Button>
              <div className="w-px h-4 bg-ink-700" />
              <Button variant="icon-amber"
                onClick={() => setShowSearch(!showSearch)}
                className="p-1 shrink-0"
                title={showSearch ? '隐藏设定检索栏' : '显示设定检索栏'}>
                {showSearch ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
              </Button>
              <Button variant="icon-amber"
                onClick={() => setFocusMode(!focusMode)}
                className="p-1 shrink-0"
                title={focusMode ? '退出专注模式' : '专注模式'}>
                {focusMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </Button>
              {/* 工具栏总说明：逐个按钮讲清用途 */}
              <HelpPopover title="工具栏按钮速查" width="27rem" size={14} className="shrink-0">
                {'从左到右：\n\n【导航】← →：上一章 / 下一章（切章会先自动保存当前草稿）。\n【标题】中间输入框：改本章标题；右侧下拉：章节状态（构思/细纲/草稿/修改/完稿/已发布），会同步到章节总表与写作面板统计。\n\n【文本工具】\n· 盾牌：敏感词检测（本章），命中可直接替换；\n· 对齐图标：一键排版，统一段落首行缩进两个全角空格并规范空行；\n· 拼写图标：校对（本章），本地错别字直接查，语病/逻辑/设定矛盾需接入 AI。\n\n【审计工具】（仅完整项目）\n· 分支图标：伏笔闭环看板（全局），挖坑/填坑总账（埋设中/进行中/已回收/孤儿，含跨度与状态未同步预警）；\n· 链条图标：连续性校验（全局），查时间线倒流、人物状态与设定冲突；\n· 羽毛图标：文风体检（本章），坏习惯词 / 省略号误用 / 视角规则（详见《写作规范》）。\n\n【AI 与导出】\n· 魔杖：颉文姬·AI 编辑（深度校对/综合诊断/选区改稿/审读/简报/设定补登，需接入模型）；\n· 上传箭头：导出菜单（本章 / 全本 / 按卷 / 按章，支持 TXT / Markdown / EPUB / DOCX / 平台粘贴版）。\n\n【文件】\n· 保存：手动保存（Ctrl+S），有未保存修改时变琥珀色并带呼吸圆点；\n· 时钟：时光机，按时间点回滚本章历史版本；\n· 垃圾桶：回收站，恢复误删的卷 / 章；\n· ⌘ 图标（Ctrl/Cmd+K）：全文检索，搜章节正文 / 角色 / 设定；\n· 人像：本章引用侧栏，列出本章提到的角色 / 设定可直达；\n· 荧光笔：引用名内联高亮开关（默认关闭）；\n· 钢笔：AI 伴写（默认关闭）。点它会弹出「说明 + 设置 + 总开关」这一整个窗 —— 窗里有建议长度 / 去 AI 味 / 文风补充，最下面是总开关，不再另设开关图标。开启后停笔会在光标处透出一句浅灰续写建议：Tab 采纳才落进正文，继续打字 / Esc / 移动光标即忽略，正文不会被改；Alt+\\ 可手动触发（需接入模型）；\n· 书本：前往本章大纲（章节细纲）；\n· 搜索：全书搜索替换；\n· 锁：小黑屋强制码字（达标前不许退出）。\n\n【视图】\n· 面板图标：显示 / 隐藏左侧设定检索栏；\n· 全屏图标：专注模式，隐藏目录与检索栏只留正文。'}
              </HelpPopover>
            </div>

            {/* 摘要行：自适应高度，内容多时自动展开完整显示 AI 压缩摘要 */}
            <div className="px-5 py-1.5 border-b border-ink-700/50 bg-ink-900/30 shrink-0 flex items-start gap-1.5">
              <textarea
                ref={summaryRef}
                value={active.summary}
                onChange={e => updateMeta({ summary: e.target.value })}
                placeholder="章节压缩摘要（AI 约 1/10，供综合诊断/推演简略模式）…"
                rows={1}
                className="!bg-transparent !border-transparent !px-0 py-1 text-[11px] leading-relaxed text-ink-300 hover:!border-ink-600 focus:!border-amber/50 flex-1 min-w-0 resize-none overflow-hidden box-border appearance-none"
              />
              <Button onClick={genSummary}
                disabled={!aiReady || summarizing || !active}
                title={!aiReady ? '未配置 AI 模型' : '让 AI 根据正文自动生成压缩摘要（约原文 1/10）'} variant="secondary" size="md" className="shrink-0">
                {summarizing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              </Button>
              <Button onClick={regenAllSummaries}
                disabled={!aiReady || regenAll || !active}
                title={!aiReady ? '未配置 AI 模型' : '批量重生成全书各章压缩摘要（约原文 1/10，覆盖现有摘要）'} variant="secondary" size="md" className="shrink-0">
                {regenAll ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />}
              </Button>
              <HelpPopover title="章节压缩摘要" width="22rem" size={12} className="shrink-0 mt-0.5">
                {'用 AI 把本章正文压缩成约 1/10 长度的连贯摘要（保留关键情节/人物/伏笔/转折/设定），例如"陈渊借雷劫破境，引动青铜小塔吞噬雷池，被苍澜宗执法长老察觉，妹妹陈瑶以桂花糖安抚其经脉反噬"。\n\n· 输入即自动同步到「章节总表」的一句话事件列；\n· 它是「综合诊断 / 情节推演」的【简略模式】数据源——用它能大幅加快 AI 调用、省 token；想让 AI 看完整正文时，在这些功能的「完整（正文）」模式里切换即可；\n· 连续性校验与伏笔看板也会读取它来做提示。'}
                <AIDataSourceNote feature="chapter-summary" />
              </HelpPopover>
            </div>

            {/* 正文：码字区始终填满工具栏与状态栏之间的全部空间，宽高都随窗口自适应 */}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden" ref={scrollRef}>
              {/* 页宽：默认铺满窗口；关闭"铺满"时回到舒适阅读宽度（隐藏检索栏/专注模式下更宽） */}
              <div className={`${pageWide ? 'w-full' : focusMode || !showSearch ? 'max-w-5xl' : 'max-w-3xl'} w-full mx-auto px-6 md:px-8 pt-6 pb-3 relative flex-1 min-h-0 flex flex-col overflow-hidden transition-[max-width] duration-300`}>
                {/* 打字机模式测量层（不可见，用于计算光标纵向位置；内容起点与 textarea 严格一致：top-6 + px-6/8，无纵向 padding，否则光标纵向偏移） */}
                <div
                  ref={mirrorRef}
                  aria-hidden
                  className="novel-textarea absolute left-0 right-0 top-6 px-6 md:px-8 border border-transparent pointer-events-none"
                  style={{ visibility: 'hidden', height: 'auto', overflow: 'hidden', fontSize: `${fontSize}px`, lineHeight: 1.9, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                />
                {/* v1.3 引用名高亮叠层：与 textarea 内容区完全对齐（top-6/bottom-3 + px-6/8，无纵向 padding）；
                    overflow 必须 hidden（inline 压制），否则会冒出一条不可操作的幽灵滚动条 */}
                {/* 引用名高亮叠层：盒模型必须与 textarea 逐项一致（inset-0 + 同一套 px/pt/pb），否则两图层错位 */}
                {highlightOn && active && (
                  <div
                    ref={highlightRef}
                    aria-hidden
                  className="novel-textarea absolute inset-0 z-0 overflow-hidden pointer-events-none border border-transparent px-6 md:px-8 pt-6"
                  style={{ fontSize: `${fontSize}px`, lineHeight: 1.9, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'rgb(var(--ink-100))', paddingBottom: foldVh('40vh') }}
                    dangerouslySetInnerHTML={{ __html: highlightHTML }}
                  />
                )}
                {/* 2.2.0 AI 伴写 ghost 叠层：与高亮层同层（z-0）、盒模型逐项照抄（inset-0 + 同一套 px/pt/pb +
                    同一字号行高），否则 ghost 文字会与光标位置错位。
                    before / after 两段全透明（真字由上面的 textarea 或高亮层显色），只有建议段着色，
                    因此**只在光标后无正文时显示** —— 否则建议会压到后面的字上糊成一片。 */}
                {companion && ghost && (
                  <div
                    ref={ghostRef}
                    aria-hidden
                    className="novel-textarea absolute inset-0 z-0 overflow-hidden pointer-events-none border border-transparent px-6 md:px-8 pt-6"
                    style={{ fontSize: `${fontSize}px`, lineHeight: 1.9, whiteSpace: 'pre-wrap', wordBreak: 'break-word', paddingBottom: foldVh('40vh') }}
                  >
                    {/* 三段必须分行写：JSX 会吃掉"含换行的空白"，不会插入多余空格而把 ghost 挤偏一个字宽 */}
                    <span style={{ color: 'transparent' }}>{draftContent.slice(0, ghost.at)}</span>
                    <span className="ai-ghost">{ghost.text}</span>
                    <span style={{ color: 'transparent' }}>{draftContent.slice(ghost.at)}</span>
                  </div>
                )}
                {/* textarea 绝对铺满编辑区（inset-0）：滚动条天然贴最外缘（铺满=窗口右缘 / 限宽=文本块右缘），
                    自身 padding（pt-6 pb-[40vh] px-6/8）撑出死区，滚动条落在 padding 里不压文字；全编辑区唯一滚动元素。
                    ⚠️ pb-[40vh] 是「滚过结尾」留白（2.0.1）：末尾留出约四成视口的可滚动空间，写最后一行时能把它
                    推到屏幕中上部，不再被底边压掉半截——即老大反馈的「编辑页面不会自动延展」。
                    高亮叠层必须用同一套 padding，否则两图层内容总高不一致，滚动同步必然错位。 */}
                <textarea
                  ref={taRef}
                  value={draftContent}
                  onChange={e => onContentChange(e.target.value)}
                  onKeyUp={() => { syncTypewriter(draftContent); syncSel() }}
                  onKeyDown={onEditorKeyDown}
                  onClick={() => { syncTypewriter(draftContent); syncSel() }}
                  onSelect={syncSel}
                  onMouseUp={syncSel}
                  onScroll={scheduleHighlightSync}
                  placeholder="落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）"
                  className="novel-textarea absolute inset-0 z-10 overflow-y-auto px-6 md:px-8 pt-6"
                  style={{ fontSize: `${fontSize}px`, lineHeight: 1.9, color: highlightOn ? 'transparent' : undefined, caretColor: highlightOn ? 'rgb(var(--amber))' : undefined, paddingBottom: foldVh('40vh') }}
                  spellCheck={false}
                />
              </div>
            </div>

            {/* 底部状态栏：实时字数 / 今日码字 / 保存状态 / 打字机模式 / 字号 */}
            <div className="h-8 shrink-0 border-t border-ink-700 bg-ink-900/70 flex items-center gap-4 px-5 text-[11px] text-ink-400">
              <span className="flex items-center gap-1">
                <Hash size={10} />{countWords(draftContent)} 字
              </span>
              <span className="flex items-center gap-1 text-amber/80" title="今日码字量（自动统计）">
                <Flame size={10} />今日 {todayWords} 字
              </span>
              <span className={`flex items-center gap-1 transition-colors ${savedFlash ? 'text-emerald-400' : ''}`}>
                <Save size={10} />{saving ? '保存中…' : savedFlash ? '已保存' : '自动保存已开启'}
              </span>
              <div className="flex-1" />
              <Button variant="bare"
                onClick={() => { const v = !pageWide; setPageWide(v); localStorage.setItem('novel-page-wide', v ? '1' : '0') }}
                className={`flex items-center gap-1 px-2 py-0.5 rounded border transition-colors whitespace-nowrap
                  ${pageWide ? 'bg-amber/15 text-amber border-amber/30' : 'text-ink-400 border-ink-700 hover:text-ink-200'}`}
                title={pageWide ? '当前：码字区铺满窗口（点击改为限宽阅读）' : '当前：限宽阅读（点击改为铺满窗口）'}
              >
                <PanelsTopLeft size={11} /> {pageWide ? '铺满' : '限宽'}
              </Button>
              <Button variant="bare"
                onClick={() => { const v = !typewriter; setTypewriter(v); localStorage.setItem('novel-typewriter', v ? '1' : '0') }}
                className={`flex items-center gap-1 px-2 py-0.5 rounded border transition-colors whitespace-nowrap
                  ${typewriter ? 'bg-amber/15 text-amber border-amber/30' : 'text-ink-400 border-ink-700 hover:text-ink-200'}`}
                title="打字机模式：输入行自动保持在屏幕中部"
              >
                <AlignCenter size={11} /> 打字机
              </Button>
              <div className="flex items-center gap-0.5 px-1 py-0.5 rounded-md border border-ink-700 bg-ink-800/60">
                <Button variant="bare"
                  onClick={() => changeFontSize(-1)}
                  className="w-5 flex items-center justify-center rounded text-ink-400 hover:text-amber transition-colors"
                  title="减小字号">
                  −
                </Button>
                <span className="w-6 text-center text-ink-300 tabular-nums text-[11px]">{fontSize}</span>
                <Button variant="bare"
                  onClick={() => changeFontSize(1)}
                  className="w-5 flex items-center justify-center rounded text-ink-400 hover:text-amber transition-colors"
                  title="增大字号">
                  +
                </Button>
              </div>
              <HelpPopover title="状态栏 · 码字体验设置" width="23rem" size={12} className="shrink-0">
                {'左侧三项是实时状态：\n· 字数：本章当前字数（中文按字计，不含空格换行）；\n· 今日 xx 字：今天的净产出，按增删自动累计，写作面板的码字日历用的就是它；\n· 自动保存已开启：停止输入 2 秒自动保存，也可 Ctrl+S 立即保存。\n\n右侧三项是可调设置（本机记忆，换章不重置）：\n· 铺满 / 限宽：铺满 = 码字区宽度跟随窗口铺满；限宽 = 回到舒适阅读宽度居中显示；\n· 打字机：开启后当前输入行始终保持在屏幕中部，眼睛不用一直往下追；\n· 字号 −/＋：正文字号 14–28px。'}
              </HelpPopover>
            </div>

            {/* v1.3 本章引用侧栏（抽屉式）：列出本章正文里出现的已登记角色 / 术语，点击直达 */}
            {showRefs && active && (
              <div className="absolute right-3 top-14 bottom-10 w-72 z-20 bg-ink-850 border border-ink-700 rounded-xl shadow-2xl flex flex-col">
                <div className="flex items-center gap-2 px-3 h-10 border-b border-ink-700 shrink-0">
                  <Users size={13} className="text-amber" />
                  <span className="text-[12px] font-semibold text-ink-200 flex-1">本章引用</span>
                  <span className="text-[10px] text-ink-500">{referenced.length} 处</span>
                  <Button variant="icon-muted" onClick={() => setShowRefs(false)} className="p-1" title="收起"><X size={16} /></Button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                  {referenced.length === 0 ? (
                    <div className="text-ink-500 text-[11px] p-3 leading-relaxed">
                      本章正文未匹配到已登记的角色名 / 设定条目名。<br />
                      先在「主要角色」「世界构建」各设定表（国家 / 地理 / 种族 / 物品 / 历史 / 术语…）登记，写作时用到会自动出现在这里，并可一键直达。
                    </div>
                  ) : (
                    (['character', 'setting'] as const).map(t => {
                      const items = referenced.filter(r => r.type === t)
                      if (!items.length) return null
                      return (
                        <div key={t}>
                          <div className="text-[10px] text-ink-500 px-1 py-1">{t === 'character' ? '角色' : '设定'} · {items.length}</div>
                          {items.map(r => (
                            <Button variant="bare"
                              key={r.name + (r.aliasOf ?? '')}
                              onClick={() => onNavigate?.(r.tabId)}
                              className="w-full text-left !justify-start px-2 py-1.5 rounded hover:bg-ink-800 flex items-center gap-2 text-ink-100 text-[12px] transition-colors"
                              title={`直达「${r.tabId}」`}
                            >
                              <span className="truncate flex-1">
                                {r.name}
                                {r.aliasOf && <span className="text-ink-500 text-[10px] ml-1.5">（{r.aliasOf} 的别称）</span>}
                              </span>
                              <span className="text-[9px] text-ink-500">→</span>
                            </Button>
                          ))}
                        </div>
                      )
                    })
                  )}
                </div>
                <div className="px-3 py-2 border-t border-ink-700 text-[10px] text-ink-500 leading-relaxed">
                  点击条目直达对应角色卡 / 设定表；高亮开关在工具栏（<Highlighter size={10} className="inline" />）。
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-ink-500">
            <PenLine size={32} className="text-ink-700" />
            <div className="text-sm">选择左侧章节，或新建一卷开始创作</div>
            {volumes.length === 0 && (
              <Button variant="primary" onClick={() => setNamePrompt({ kind: 'addVol', title: '新建卷', def: `第${volumes.length + 1}卷` })} className="px-4 py-2 rounded-lg text-[13px] transition-colors">
                <FolderPlus size={14} className="inline mr-1.5" />新建第一卷
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ============ 功能弹窗 ============ */}
      {modal === 'sensitive' && active && (
        <SensitiveCheck content={draftContent} onApply={updateContent} onClose={() => setModal(null)} />
      )}
      {modal === 'history' && active && (
        <VersionHistory chapterId={active.id} onRestore={restoreSnapshot} onClose={() => setModal(null)} />
      )}
      {modal === 'trash' && (
        <TrashBin onChanged={() => { load(); onStatsChange?.() }} onClose={() => setModal(null)} />
      )}
      {modal === 'search' && (
        <GlobalSearch
          chapters={chapters}
          onOpenChapter={id => openChapter(id)}
          onReplaced={applyChapterContent}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'lock' && active && (
        <FocusLock
          chapter={active}
          initialContent={draftContent}
          onSave={content => updateContent(content)}
          onExit={() => setModal(null)}
        />
      )}
      {modal === 'foreshadow' && !isLite && (
        <ForeshadowBoard onNavigateTab={id => onNavigate?.(id)} onClose={() => setModal(null)} />
      )}
      {modal === 'continuity' && !isLite && (
        <ContinuityCheck
          onNavigateTab={id => onNavigate?.(id)}
          onOpenChapter={id => openChapter(id)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'typo' && active && (
        <ProofreadCheck content={draftContent} onApply={updateContent} onClose={() => setModal(null)} />
      )}
      {modal === 'style' && active && !isLite && (
        <StyleAudit content={draftContent} onClose={() => setModal(null)} />
      )}
      {/* 颉文姬 · AI 编辑抽屉（v1.6 收官功能） */}
      {jieWenJiOpen && active && (
          <JieWenJi
            content={draftContent}
            openingText={openingText}
            focusChapterId={active.id}
          summary={active?.summary ?? ''}
          chapterTitle={active?.title ?? ''}
          onClose={() => setJieWenJiOpen(false)}
          getSelectionText={getSelText}
          getSelectionRange={() => selRef.current}
          onApplyAdvice={insertAdvice}
          onClearAdvice={clearAdvice}
          onApplyContent={updateContent}
        />
      )}
      {/* v1.6：应用内输入弹窗（替代浏览器 prompt，桌面端可用） */}
      <PromptModal
        open={!!namePrompt}
        title={namePrompt?.title ?? ''}
        defaultValue={namePrompt?.def ?? ''}
        onSubmit={submitNamePrompt}
        onCancel={() => setNamePrompt(null)}
      />
      {/* 2.2.0 伴写：自定义文风补充（本机记忆，只影响 AI 伴写的建议口吻） */}
      <PromptModal
        open={styleNotePrompt}
        title="伴写文风补充"
        label="用一句话描述你想要的文风（留空 = 只用前文与《写作规范》锚定）"
        defaultValue={companionStyleNote}
        placeholder="例如：冷硬白描，少心理活动，多用短对白"
        allowEmpty
        confirmText="保存"
        onSubmit={v => {
          const val = (v || '').trim()
          setCompanionStyleNote(val)
          if (val) localStorage.setItem('novel-companion-style', val)
          else localStorage.removeItem('novel-companion-style')
          setStyleNotePrompt(false)
          showToast(val ? '已设置伴写文风补充' : '已清空伴写文风补充', 'success')
        }}
        onCancel={() => setStyleNotePrompt(false)}
      />
    </div>
  )
}
