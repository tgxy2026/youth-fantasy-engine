import ResizeHandle from '@/components/common/ResizeHandle'
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ClipboardEvent as ReactClipboardEvent } from 'react'
import { foldVh } from '@/lib/settings/theme'
import { Z } from '@/lib/app/zLayer'

import type { ChapterStatus } from '@/lib/types'
import { countWords } from '@/lib/editor/textStats'
import { useWordCountWithPunct, wordCountModeOf } from '@/lib/editor/wordCountMode'
import SettingSearch from '@/components/settings/SettingSearch'
import { auxiliaryLeaveGuardDirty, runAuxiliaryLeaveGuards } from '@/lib/editor/leaveBarrier'
import { SensitiveCheck, VersionHistory, TrashBin, GlobalSearch, FocusLock, ProofreadCheck } from '@/components/editor/EditorModals'
import { ForeshadowBoard, ContinuityCheck, StyleAudit } from '@/components/audit/AuditModals'
// 导出模块（zip/EPUB/DOCX 打包器较重）——改为按需动态导入，避免拖入首屏主包
// 排版（含缩进单位设置）收进独立弹窗；缩进纯函数在 lib/indent.ts（有单测）
import FormatModal from '@/components/dialogs/FormatModal'
import { Modal } from '@/components/dialogs/Modal'
import { INDENT_UNITS, indentBlock, outdentBlock, indentForNewLine, normalizePastedText } from '@/lib/editor/indent'
// 3.2.0：中文标点自动配对（原先完全依赖输入法 ⇒ 微信有、搜狗没有，见 punctPair 文件头）
import { planPunctPair, planPunctPairAtCaret, planPunctPairFromClose, planPunctPairFromCloseAtCaret } from '@/lib/editor/punctPair'
import { nextVolumeNo } from '@/lib/outline/freeVolume'
import {
  FolderPlus, Trash2, PenLine,
  Save, ArrowLeft, ArrowRight, Maximize2, Minimize2, PanelRightClose, PanelRightOpen,
  ShieldAlert, History, Search, Lock, AlignLeft, Hash, AlignCenter, Flame,
  GitBranch, Link2, SpellCheck, Feather, PanelsTopLeft,
  Command, Highlighter, BookOpen, Users, Sparkles, Loader2, Wand2, Layers, PenTool,
  Undo2, Redo2, FilePlus2, ChevronDown
} from 'lucide-react'
import HelpPopover from '@/components/common/HelpPopover'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import PromptModal from '@/components/dialogs/PromptModal'
import JieWenJi, { } from '@/components/jiewenji/JieWenJi'
import { showToast } from '@/components/dialogs/dialogs'
import { type VisCtx, } from '@/lib/schema'
import { INLINE_SUGGEST_LIMITS, type InlineSuggestLength } from '@/lib/ai/aiTasks'
import { Button } from '@/components/common/Button'
import { LoadingState } from '@/components/common/LoadingState'
import NovelEditorChapterTree from '@/components/editor/NovelEditorChapterTree'
import ExportFormatDialog from '@/components/dialogs/ExportFormatDialog'
import ChapterImportDialog from '@/components/editor/ChapterImportDialog'
import { CompanionStyleDialog } from '@/components/tavern/CompanionStyleDialog'
import { dimLabels } from '@/lib/tavern/companionStyle'

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
  openRequestId?: number
  /**
   * 段落级定位（UX05）：跳进来时要落到的正文内字符偏移。
   * 🔴 只对 `openChapterId` 指定的那一章有效；偏移由检索侧按「正文内」算好，不是整章拼接串的偏移。
   */
  openOffset?: { offset: number; matchLength?: number; revision?: string } | null
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


/** HTML 转义（防止引用名高亮注入）。先探测再替换：绝大多数正文片段不含 <>&，可省掉多次全量 replace */

import { useNovelEditorModel } from '@/components/editor/useNovelEditorModel'
import { useEditorWorkspaceView } from '@/components/editor/useEditorWorkspaceView'
import { useEditorOpenOffset } from '@/components/editor/useEditorOpenOffset'
import { useMonoTheme } from '@/lib/settings/useMonoTheme'
import ChapterContextPanel from '@/components/editor/ChapterContextPanel'
import * as db from '@/lib/db'

export default function NovelEditor({ onStatsChange, onNavigate, onOpenSearch, projectName = '我的小说', openChapterId, openRequestId, openOffset, ctx = { type: 'full', features: [] } }: Props) {
  // 状态与生命周期全在 model 里；下面同名解构是刻意的 —— JSX 保持原样、零改动。
  const model = useNovelEditorModel({ projectName, ctx, openChapterId, openRequestId, onStatsChange })
  /** 纯黑白主题：正文缩进导向线要去掉 alpha（半透明黑=灰，违背严格二值） */
  const mono = useMonoTheme()

  const {
    // 结构数据（卷 / 章 / 当前章 / 序号）
    isLite, loaded, volumes, chapters, activeId, active, flat, activeIdx, nextChapterNo, chapterSeqs,
    // 章节树交互（改名 / 增删 / 拖拽重排）
    expanded, setExpanded, dragKind, setDragKind, setDragId, overKey, setOverKey, openChapter, submitNamePrompt, removeVolume, removeChapter, restoreSnapshot, applyChapterContent, resetDrag, handleDrop, toggleExcludeNumbering,
    // 正文与保存（diskError/diskPending = 真实落盘状态）
    draftContent, commitContent, onContentChange, updateContent, updateMeta, saving, savedFlash, diskError, diskPending, todayWords, load,
    // 引用名高亮叠层（只走 scanRefHighlight，盒模型与 textarea 对齐）
    highlightHTML, referenced, highlightRef, scheduleHighlightSync,
    // 编辑区 refs 与光标同步
    scrollRef, taRef, mirrorRef, ghostRef, selRef, syncSel, getSelText, syncTypewriter,
    // AI 伴写（ghost 叠层 / 钢笔设置 / 采纳）
    companion, setCompanion, companionLen, setCompanionLen, companionDeAi, setCompanionDeAi, companionStyleNote, setCompanionStyleNote, companionStyleDims, setCompanionStyleDims, companionStyleSpec, setCompanionStyleSpec, ghost, ghostBusy, dismissGhost, onEditorKeyDown, insertAdvice, clearAdvice, openingText,
    // 摘要（本章摘要 / 批量重算）
    summarizing, genSummary, regenAllSummaries, regenAll, summaryRef,
    // 面板与尺寸（专注 / 检索栏 / 字号 / 页宽 / 打字机）
    focusMode, setFocusMode, showSearch, setShowSearch, fontSize, changeFontSize, typewriter, setTypewriter, pageWide, setPageWide, chapterPane, searchPane,
    wrapRef, searchPaneW, showPageWide, chapterCompact, searchFits, shortBody, BODY_MIN_H,
    // 本章引用侧栏
    showRefs, setShowRefs, highlightOn, setHighlightOn,
    // 弹窗与抽屉
    modal, setModal, exportOpen, setExportOpen, styleNotePrompt, setStyleNotePrompt, namePrompt, setNamePrompt, jieWenJiOpen, setJieWenJiOpen,
    // C6 导出格式弹窗
    exportFormatTab, setExportFormatTab,
    // 3.0.1 正文批量导入弹窗
    importOpen, setImportOpen,
    // 编辑器缩进（2.4.0 · A5）：缩进单位偏好；缩进动作见下方 onIndentKeyDown / applyIndent
    indentUnit, setIndentUnit, pasteNormalize, setPasteNormalize, indentGuides, setIndentGuides,
    // AI 就绪与导出
    aiReady, runExport,
  } = model

  // UX06 · 正文工作现场：离页/切章时同步捕获，进章后按「内容摘要是否一致」决定要不要恢复光标与位置
  const ownsPosition = useEditorOpenOffset({ enabled: loaded, activeId, openChapterId: openChapterId ?? null,
    offset: openOffset?.offset ?? null, matchLength: openOffset?.matchLength ?? null, taRef, requestId: openRequestId,
    expectedRevision: openOffset?.revision, content: active?.content ?? null })
  useEditorWorkspaceView({ enabled: loaded, activeId, taRef, scrollRef, skipRestore: ownsPosition })

  // 本章资料抽屉打开时暂时收起设定检索列，避免正文和资料区挤成多列；关闭后恢复作者原有检索偏好。
  const [chapterDrawer, setChapterDrawer] = useState(false)
  const [searchDrawer, setSearchDrawer] = useState(false)
  const [dirtySearch, setDirtySearch] = useState<'inline' | 'drawer' | null>(null)
  const searchDraftPending = (origin: 'inline' | 'drawer', pending: boolean) => {
    setDirtySearch(previous => pending ? origin : previous === origin ? null : previous)
  }
  const searchVisible = !focusMode && showSearch && !showRefs && dirtySearch !== 'drawer' && (searchFits || dirtySearch === 'inline')
  const searchAction = useRef(0)
  const afterSearchSubmit = (action: () => void) => {
    const request = ++searchAction.current
    if (!auxiliaryLeaveGuardDirty()) { action(); return }
    void runAuxiliaryLeaveGuards().then(result => {
      if (result.ok && request === searchAction.current) action()
    })
  }

  // 字数口径（#004）：面板与编辑器**共用同一份偏好**（`lib/wordCountMode` 是单一来源）——
  // 在写作面板切了口径，这里立刻跟着变。只影响显示，落库 `wordCount` 不受影响。
  const [withPunct] = useWordCountWithPunct()
  // 段首缩进参考线的间距：按当前单位换算（全角 ≈ 1em / 半角 ≈ 0.5em / Tab ≈ 2em）
  const indentUnitEm = INDENT_UNITS.find(u => u.id === indentUnit)?.emWidth ?? 2

  if (!loaded) return <LoadingState />

  /**
   * 用「原生编辑命令」整体替换正文（一键排版这类整篇重写走它）。
   *
   * 🔴 为什么不直接 `updateContent(next)`：那是改 React state → 改 textarea 的 value，
   *    浏览器**不把程序化赋值记进撤销栈**，作者按 Ctrl+Z 回不来（还常会跳掉好几步）。
   *    先把选区铺成全文、再 `execCommand('insertText')` ⇒ 算一次真实编辑，Ctrl+Z 能整体撤销。
   *    ⚠️ 受控组件：插完必须主动把 DOM 里的新值同步回 state，
   *    否则 React 下次渲染会拿旧 state 把 DOM 改回去（正文"闪一下又变回来"）。
   */
  const replaceAllText = (next: string) => {
    const ta = taRef.current
    if (!ta) { updateContent(next); return }
    const caretBefore = ta.selectionStart ?? 0
    ta.focus()
    ta.setSelectionRange(0, ta.value.length)
    let ok = false
    try { ok = document.execCommand('insertText', false, next) } catch { ok = false }
    // 兜底：个别环境禁用了 execCommand —— 宁可牺牲撤销栈，也要保证内容真的写进去
    if (!ok) ta.setRangeText(next, 0, ta.value.length, 'end')
    // 光标尽量留在原处（排版后行首变化不大），并夹在新长度内
    const pos = Math.min(caretBefore, ta.value.length)
    ta.setSelectionRange(pos, pos)
    selRef.current = { start: pos, end: pos }
    onContentChange(ta.value)
  }

  /**
   * 缩进 / 反缩进（2.4.0 · A5）：Tab 进一级，Shift+Tab 退一级；选中多行时整块处理。
   *
   * 🔴 与伴写的分工：伴写键位已让开（采纳改 `Ctrl+Enter`），所以 Tab **无条件**归缩进 ——
   *    不再有"有建议时 Tab 是采纳、没建议时才是缩进"这种作者无法预判的双态。
   * 走 execCommand ⇒ 一次缩进 = 一次撤销单元，Ctrl+Z 整块回退、不跳段。
   */
  const applyIndent = (dir: 'in' | 'out') => {
    const ta = taRef.current
    if (!ta) return
    const v = ta.value
    const s0 = ta.selectionStart, s1 = ta.selectionEnd
    // 涉及的行范围：选区起点所在行的行首 → 选区终点所在行的行尾
    const blockStart = v.lastIndexOf('\n', s0 - 1) + 1
    let blockEnd = v.indexOf('\n', s1)
    if (blockEnd === -1) blockEnd = v.length
    // 选区终点正好落在某行行首时不带上那一行（与主流编辑器一致：选中到行尾不会多缩一行）
    if (s1 > s0 && v[s1 - 1] === '\n') blockEnd = s1 - 1
    const block = v.slice(blockStart, blockEnd)
    const next = dir === 'in' ? indentBlock(block, indentUnit) : outdentBlock(block, indentUnit)
    if (next === block) return   // 已经顶格，或已无缩进可删 —— 不白记一次撤销
    ta.focus()
    ta.setSelectionRange(blockStart, blockEnd)
    let ok = false
    try { ok = document.execCommand('insertText', false, next) } catch { ok = false }
    if (!ok) ta.setRangeText(next, blockStart, blockEnd, 'end')
    // 整块选中：便于连按 Tab 继续加深，也让作者看清这次动的是哪几行
    ta.setSelectionRange(blockStart, blockStart + next.length)
    selRef.current = { start: blockStart, end: blockStart + next.length }
    onContentChange(ta.value)
  }

  /**
   * 回车自动继承缩进（2.4.0 · A5）。
   * 判定只看**光标之前的那一段**（在缩进行中间回车，新行同样继承该级），
   * 而"当前行没有正文时回到段首层"的规则在 `indentForNewLine` 里（防止连按回车越缩越右）。
   */
  const insertNewlineWithIndent = () => {
    const ta = taRef.current
    if (!ta) return
    const v = ta.value
    const s0 = ta.selectionStart, s1 = ta.selectionEnd
    const lineStart = v.lastIndexOf('\n', s0 - 1) + 1
    const indent = indentForNewLine(v.slice(lineStart, s0))
    const text = '\n' + indent
    ta.focus()
    let ok = false
    try { ok = document.execCommand('insertText', false, text) } catch { ok = false }
    if (!ok) ta.setRangeText(text, s0, s1, 'end')
    onContentChange(ta.value)
  }

  /**
   * 粘贴归一（2.4.0 · A5）：多行粘贴时把行首空白按当前缩进单位统一，
   * 免得从网页 / Word 粘进来的 2 空格与作者自己的全角缩进混在一章里。
   * 单行不拦 —— 随手粘一句话不该被改动。
   */
  const handlePaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!pasteNormalize) return // 开关关掉 → 粘什么就是什么，一个字符都不动
    const text = e.clipboardData.getData('text/plain')
    if (!text || !text.includes('\n')) return
    const ta = taRef.current
    if (!ta) return
    const normalized = normalizePastedText(text, indentUnit)
    if (normalized === text) return
    e.preventDefault()
    let ok = false
    try { ok = document.execCommand('insertText', false, normalized) } catch { ok = false }
    if (!ok) ta.setRangeText(normalized, ta.selectionStart, ta.selectionEnd, 'end')
    onContentChange(ta.value)
  }

  /**
   * 编辑器按键总入口：**伴写先挑**（采纳 / 丢弃 / 手动触发，它处理时会 preventDefault），
   * 没被接手的键才轮到缩进。两层靠 `defaultPrevented` 分流，彼此不需要知道对方存在。
   */
  const handleEditorKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    onEditorKeyDown(e)
    if (e.defaultPrevented) return
    // 输入法选字期间不抢键（中文写作的常态，抢了会打断候选词上屏）
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Tab') {
      e.preventDefault()
      applyIndent(e.shiftKey ? 'out' : 'in')
      return
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      insertNewlineWithIndent()
    }
  }

  const chapterTree = (
        <NovelEditorChapterTree
          pane={chapterCompact ? { ...chapterPane, size: 280 } : chapterPane}
          projectName={projectName}
          volumes={volumes}
          chapters={chapters}
          expanded={expanded}
          setExpanded={setExpanded}
          overKey={overKey}
          setOverKey={setOverKey}
          dragKind={dragKind}
          setDragKind={setDragKind}
          setDragId={setDragId}
          resetDrag={resetDrag}
          handleDrop={handleDrop}
          setNamePrompt={setNamePrompt}
          nextChapterNo={nextChapterNo}
          activeId={activeId}
          openChapter={id => { openChapter(id); setChapterDrawer(false) }}
          chapterSeqs={chapterSeqs}
          removeVolume={removeVolume}
          removeChapter={removeChapter}
          toggleExcludeNumbering={toggleExcludeNumbering}
          runExport={runExport}
          exportOpen={exportOpen}
          setExportOpen={setExportOpen}
          setExportFormatTab={setExportFormatTab}
          setImportOpen={setImportOpen}
        />
  )
  const companionTools = (
    <details data-editor-companion className="space-y-1">
      <summary className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-12 text-ink-200 hover:bg-ink-700">
        {ghostBusy ? <Loader2 size={14} className="animate-spin" /> : <PenTool size={14} />}
        AI 伴写 <span className="ml-auto text-10 text-ink-500">{!aiReady ? '未配置模型' : companion ? '已开启' : '已关闭'}</span>
      </summary>
      <div className="whitespace-pre-wrap px-2 pb-2 text-11 leading-relaxed text-ink-200">
        <div className="mt-1.5 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-ink-400 shrink-0">建议长度</span>
            {(['short', 'sentence', 'two'] as InlineSuggestLength[]).map(k => (
              <Button variant="toggle" size="xs" key={k} selected={companionLen === k} aria-pressed={companionLen === k}
                onClick={() => { setCompanionLen(k); localStorage.setItem('novel-companion-len', k) }}
                title={`不超过 ${INLINE_SUGGEST_LIMITS[k].chars} 字`}>
                {INLINE_SUGGEST_LIMITS[k].label}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-ink-400 shrink-0">去 AI 味</span>
            <Button variant="toggle" size="xs" selected={companionDeAi} aria-pressed={companionDeAi}
              onClick={() => { const v = !companionDeAi; setCompanionDeAi(v); localStorage.setItem('novel-companion-deai', v ? '1' : '0') }}
              title="约束模型不用「仿佛 / 不禁 / 然而」这类套话开头、不堆四字成语与排比、不写空泛升华（默认开）">
              {companionDeAi ? '已开启' : '已关闭'}
            </Button>
            <span className="text-ink-500 text-10">压制套话与排比，默认开</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-ink-400 shrink-0">参考写作规范</span>
            <Button variant="toggle" size="xs" selected={companionStyleSpec} aria-pressed={companionStyleSpec}
              onClick={() => { const v = !companionStyleSpec; setCompanionStyleSpec(v); localStorage.setItem('novel-companion-stylespec', v ? '1' : '0') }}
              title="把《写作规范》里登记的坏习惯词 / 标点偏好 / 视角规则锚进伴写；关掉后只靠前文样本与下面的文风补充">
              {companionStyleSpec ? '已开启' : '已关闭'}
            </Button>
            <span className="text-ink-500 text-10">负面清单，默认开</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-ink-400 shrink-0">文风补充</span>
            <Button variant="toggle" size="xs" selected={!!companionStyleNote || companionStyleDims.length > 0}
              onClick={() => setStyleNotePrompt(true)}
              className="max-w-[13rem]"
              title={companionStyleDims.length
                ? `已选 ${companionStyleDims.length} 项：${dimLabels(companionStyleDims)}${companionStyleNote ? '\n原话：' + companionStyleNote : ''}`
                : (companionStyleNote || '点开勾选本次想补的方面（可多选），也可一句话描述，例如「冷硬白描，少心理活动，多用短对白」')}>
              <span className="truncate">{companionStyleDims.length
                ? `已选 ${companionStyleDims.length} 项${companionStyleNote ? ' + 原话' : ''}`
                : (companionStyleNote || '未设置（点击选择）')}</span>
            </Button>
          </div>
          {/* 总开关：按老大要求放在设置下面，并掉与它重复的那个独立开关图标 */}
          <div className="flex items-center gap-2 mt-1 pt-2 border-t border-ink-700">
            <span className="text-ink-200 shrink-0">总开关</span>
            <Button variant="toggle" size="xs" selected={companion} aria-pressed={companion} disabled={!aiReady}
              onClick={() => setCompanion(o => { const v = !o; localStorage.setItem('novel-companion', v ? '1' : '0'); if (!v) dismissGhost(); return v })}
              title={!aiReady ? '未配置 AI 模型' : companion ? '点击关闭 AI 伴写（默认关闭）' : '点击开启 AI 伴写'}>
              {companion ? '已开启' : '已关闭'}
            </Button>
            <span className="text-ink-500 text-10">{!aiReady ? '需先接入 AI 模型' : companion ? '停笔即续写一句话' : '默认关闭'}</span>
          </div>
          <div className="text-ink-500 text-10 leading-relaxed">
            全部为本机记忆，换章不重置。伴写正文只发给你当前选定的模型：本地不出本机，云端会上传到该服务商。
          </div>
        </div>
        <AIDataSourceNote feature="inline-suggest" />
        <details className="mt-2 border-t border-ink-700 pt-2">
          <summary className="cursor-pointer text-ink-400">伴写使用说明</summary>
          <div className="mt-1 whitespace-pre-wrap">
            {'停笔约 0.8 秒后自动感知前文，在光标处透出一句「浅灰色」续写建议。\n· Ctrl+Enter 采纳 → 文字正式落进正文（→ 在末尾时也可采纳）；\n· 继续打字 / Esc / 移动光标 → 建议悄悄消失，正文一个字都没被改过；\n· 对建议不满意 → 按 Alt+/ 换一句（会避开刚才那句，不会给你同一句）；\n· Alt+\\ 可随时手动触发一次；\n· Tab / Shift+Tab 归编辑器缩进，与伴写无关。\n\n文风不靠「选风格」，而是三层自动锚定：①光标前约 2000 字正文（最准的风格样本）②《写作规范》里你登记的坏习惯词 / 标点偏好（可关）③下面的文风补充（可勾选本次想补的方面，也可一句话描述）。\n\n'}
          </div>
        </details>

      </div>
    </details>
  )
  const secondaryTools = (
    <HelpPopover title="编辑工具" triggerTitle="编辑工具" triggerVariant="secondary" triggerClassName="shrink-0 aria-expanded:border-amber/50"
      trigger={<>工具 <ChevronDown size={12} /></>} pin focusOnOpen width="22rem">
      {(close: () => void) => <div role="group" aria-label="编辑工具选项" className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-12 font-semibold text-ink-100">整理与检查</h3>
          <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); setModal('format') }}><AlignLeft size={14} /> 排版与缩进</Button>
          <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); setModal('sensitive') }}><ShieldAlert size={14} /> 敏感词检测（本章）</Button>
          <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); setModal('typo') }}><SpellCheck size={14} /> 校对（本章）</Button>
          {!isLite && <>
            <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); setModal('foreshadow') }}><GitBranch size={14} /> 伏笔闭环看板</Button>
            <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); setModal('continuity') }}><Link2 size={14} /> 连续性校验</Button>
            <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); setModal('style') }}><Feather size={14} /> 文风体检（本章）</Button>
          </>}
        </div>
        <div className="space-y-1 border-t border-ink-700 pt-2">
          <h3 className="text-12 font-semibold text-ink-100">辅助创作</h3>
          {companionTools}
        </div>
        <div className="space-y-1 border-t border-ink-700 pt-2">
          <h3 className="text-12 font-semibold text-ink-100">版本与检索</h3>
          <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); setModal('history') }}><History size={14} /> 时光机 · 版本历史</Button>
          <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); setModal('trash') }}><Trash2 size={14} /> 回收站</Button>
          <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); onOpenSearch?.() }}><Command size={14} /> 全文检索</Button>
          <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); setModal('search') }}><Search size={14} /> 全书搜索替换</Button>
        </div>
        <div className="space-y-1 border-t border-ink-700 pt-2">
          <h3 className="text-12 font-semibold text-ink-100">写作视图</h3>
          <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); onNavigate?.('chapter-outline') }}><BookOpen size={14} /> 前往本章细纲</Button>
          <Button variant="ghost" size="sm" aria-pressed={highlightOn} className="w-full !justify-start" onClick={() => { close(); setHighlightOn(value => !value) }}><Highlighter size={14} /> 引用名内联高亮：{highlightOn ? '已开启' : '已关闭'}</Button>
          <Button variant="ghost" size="sm" className="w-full !justify-start" onClick={() => { close(); setModal('lock') }}><Lock size={14} /> 小黑屋 · 强制码字</Button>
        </div>
      </div>}
    </HelpPopover>
  )

  return (
    // 🔴 ref 供「正文列保底」测量容器宽度（检索栏压多少、铺满开关显示与否都按它算）
    <div ref={wrapRef} className="flex h-full page-enter overflow-hidden">
      {!focusMode && !chapterCompact && chapterTree}
      <Modal open={chapterCompact && chapterDrawer} onClose={() => setChapterDrawer(false)}
        title="章节目录" align="left" width={280} maxHeight="100vh"
        className="!rounded-none" bodyClassName="!p-0 min-h-0 !overflow-hidden flex [&>div]:flex-1">
        {chapterTree}
      </Modal>
      <Modal open={(!searchFits && searchDrawer) || dirtySearch === 'drawer'} onClose={() => afterSearchSubmit(() => setSearchDrawer(false))}
        title="设定检索" align="left" width={360} maxHeight="100vh"
        className="!rounded-none" bodyClassName="!p-0 min-h-0 !overflow-hidden flex flex-col">
        <SettingSearch onNavigate={onNavigate} ctx={ctx} onDraftPendingChange={pending => searchDraftPending('drawer', pending)} />
      </Modal>

      {/* 左侧 1/3：设定检索栏 */}
      {searchVisible && (
        <div
          className="relative shrink-0 flex flex-col"
          // 🔴 用**保底后的** searchPaneW（窄窗口下自动让位给码字区）；用户拖出来的偏好仍留在 localStorage 里
          style={dirtySearch === 'inline' && !searchFits
            ? { width: searchPaneW, minWidth: 0, maxWidth: '100%' }
            : { width: searchPaneW, minWidth: searchPaneW }}
        >
          {/* 拖拽调整设定检索栏宽度 */}
          {searchFits && <ResizeHandle pane={searchPane} label="检索栏宽度" layer={Z.pageHandle} />}
          {!searchFits && <div role="status" className="px-3 py-2 text-11 text-amber">设定尚未提交，暂时保留编辑面板；保存或取消后恢复布局。</div>}
          <SettingSearch onNavigate={onNavigate} ctx={ctx} onDraftPendingChange={pending => searchDraftPending('inline', pending)} />
        </div>
      )}

      {/* 右侧 2/3：编辑区 */}
      <div className="flex-1 flex flex-col min-w-0 bg-ink-950/92 relative">
        {chapterCompact && !active && <div className="shrink-0 border-b border-ink-700 p-2">
          <Button variant="secondary" size="sm" onClick={() => setChapterDrawer(true)} title="打开章节目录"><BookOpen size={14} />章节目录</Button>
        </div>}
        {active ? (
          <>
            {/* 标题/状态/保存常驻；次工具按用途收纳，行高随实际内容分配。 */}
            <div className="shrink-0 border-b border-ink-700 bg-ink-900/50" data-editor-toolbar>
            <div className="flex flex-wrap items-center gap-2 px-4 py-2" data-editor-primary>
              {chapterCompact && <Button variant="secondary" size="sm" className="shrink-0"
                title="打开章节目录" onClick={() => setChapterDrawer(true)}><BookOpen size={14} />章节</Button>}
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
                // 🔴 3.2.2（审计 U2）：这里的标题**视觉上就是输入框本身**，没有 label 可关联 ——
                //    给读屏软件一个准确名称，否则只念"编辑框"。
                aria-label="章节标题"
                className="!bg-transparent !border-transparent !px-1 text-14 font-semibold text-ink-50 flex-1 basis-40 min-w-32 hover:!border-ink-600 focus:!border-amber/50 font-serif"
              />
              <select
                value={active.status}
                onChange={e => updateMeta({ status: e.target.value as ChapterStatus })}
                className="!h-8 min-h-[var(--ui-control-sm,2rem)] !py-0.5 !px-1.5 text-11 shrink-0"
                aria-label="章节状态" title={`章节状态：${active.status}`}
              >
                {STATUS_LIST.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {/* 保存始终在标题行可见，按钮条件与提交机制沿用原逻辑。 */}
              <Button variant="primary" size="sm" aria-label="保存正文"
                onClick={() => commitContent()}
                disabled={saving || draftContent === active.content}
                className={`relative p-1 rounded transition-colors shrink-0
                  ${draftContent !== active.content
                    ? 'text-amber hover:bg-amber/15'
                    : 'text-ink-500 cursor-not-allowed'}`}
                title={diskError ? `尚未写入磁盘：${diskError}` : saving ? '保存中…' : diskPending ? '正在写入…' : draftContent !== active.content ? '保存（Ctrl+S）' : '当前正文无待保存改动'}
              >
                <Save size={14} /> {saving ? '保存中…' : '保存'}
                {draftContent !== active.content && !saving && (
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
                )}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 border-t border-ink-700/50 px-4 py-1.5" data-editor-utilities>
              {/* E1（2.6.2）撤销 / 恢复：直接调 execCommand 驱动**原生撤销栈** —— 与 Ctrl+Z / Ctrl+Y
                  完全同一栈，不另建自绘撤销栈（AI 插入 / 一键排版 / 缩进都走 execCommand('insertText')，
                  天然在栈里）。点击先把焦点还给正文 textarea：execCommand 的作用对象是聚焦的可编辑元素。 */}
              <Button variant="bare" iconOnly size="sm"
                onClick={() => { taRef.current?.focus(); document.execCommand('undo') }}
                className="text-ink-400 hover:text-ink-100 transition-colors shrink-0"
                title="撤销（与 Ctrl+Z 同一撤销栈）"
              >
                <Undo2 size={14} />
              </Button>
              <Button variant="bare" iconOnly size="sm"
                onClick={() => { taRef.current?.focus(); document.execCommand('redo') }}
                className="text-ink-400 hover:text-ink-100 transition-colors shrink-0"
                title="恢复（与 Ctrl+Y 同一撤销栈）"
              >
                <Redo2 size={14} />
              </Button>
              <Button variant="secondary" size="sm" aria-pressed={jieWenJiOpen}
                onClick={() => setJieWenJiOpen(o => !o)}
                className={`p-1 transition-colors shrink-0 ${jieWenJiOpen ? 'text-amber' : 'text-ink-400 hover:text-amber'}`}
                title="颉文姬 · AI 编辑：校对 / 综合诊断 / 选区改稿 / 审读 / 写作简报 / 本章设定补登（AI 增强需配模型）"
              >
                <Wand2 size={14} /> 颉文姬
              </Button>
              <div className="w-px h-4 bg-ink-700" />
              <Button variant="secondary" size="sm" aria-pressed={showRefs} onClick={() => afterSearchSubmit(() => setShowRefs(o => !o))} className={`p-1 transition-colors shrink-0 ${showRefs ? 'text-amber' : 'text-ink-400 hover:text-amber'}`} title="本章资料：查看细纲、固定资料与正文引用">
                <Users size={14} /> 本章资料
              </Button>
              {secondaryTools}
              <Button variant="secondary" size="sm" aria-pressed={searchVisible || searchDrawer}
                onClick={() => afterSearchSubmit(() => {
                  if (showRefs) setShowRefs(false)
                  else if (!searchFits) setSearchDrawer(true)
                  else setShowSearch(!showSearch)
                })}
                className="p-1 shrink-0"
                title={showRefs ? '收起本章资料并恢复设定检索栏' : !searchFits ? '打开设定检索' : showSearch ? '隐藏设定检索栏' : '显示设定检索栏'}>
                {searchVisible ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />} 设定检索
              </Button>
              <Button variant="secondary" size="sm" aria-pressed={focusMode}
                onClick={() => afterSearchSubmit(() => setFocusMode(!focusMode))}
                className="p-1 shrink-0"
                title={focusMode ? '退出专注模式' : '专注模式'}>
                {focusMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />} {focusMode ? '退出专注' : '专注'}
              </Button>
              {/* 工具栏总说明：逐个按钮讲清用途 */}
              <HelpPopover title="工具栏按钮速查" width="27rem" size={14} className="shrink-0">
                {'标题行保留章节导航、标题、状态与保存。\n工具行保留撤销/恢复、颉文姬、本章资料、设定检索与专注；AI 伴写收在「工具」内。其余操作在「工具」中按整理与检查、版本与检索、写作视图分组；都可点击或用键盘进入。\n\n【导航】← →：上一章 / 下一章（切章会先自动保存当前草稿）。\n【标题】中间输入框：改本章标题；右侧下拉：章节状态（构思/细纲/草稿/修改/完稿/已发布），会同步到章节总表与写作面板统计。\n\n【文本工具】\n· ↶ / ↷：撤销 / 恢复 —— 与 Ctrl+Z / Ctrl+Y 同一个原生撤销栈（AI 插入、一键排版、缩进都可撤销）；点击会把焦点交回正文；\n· 盾牌：敏感词检测（本章），命中可直接替换；\n· 对齐图标：排版 —— 可设缩进单位，一键排版默认「保留你已有的缩进」、只清理多余空行与行尾空白（另有「统一为段首缩进」用于整章版面严格对齐）；\n· 拼写图标：校对（本章），本地错别字直接查；AI 校对分「查错别字与语病」与「查逻辑与设定矛盾」两块，需接入模型。\n\n【审计工具】（仅完整项目）\n· 分支图标：伏笔闭环看板（全局），挖坑/填坑总账（埋设中/进行中/已回收/孤儿，含跨度与状态未同步预警）；\n· 链条图标：连续性校验（全局），查时间线倒流、人物状态与设定冲突；\n· 羽毛图标：文风体检（本章），坏习惯词 / 省略号误用 / 视角规则（详见《写作规范》）。\n\n【AI】\n· 魔杖：颉文姬·AI 编辑（校对·文字层/校对·逻辑层/综合诊断/选区改稿/审读/简报/设定补登，需接入模型）；\n\n\n【导出】（2.8.0 起不在本工具栏）\n· 全书导出的唯一入口是左侧「章节」栏右上角的「导出」图标：本章 / 全本 TXT / Markdown / EPUB / DOCX / 平台粘贴版 / 按卷 / 按章节逐一导出；其中 DOCX 在弹窗里可选排版预设（字号 / 对齐 / 首行缩进 / 行距 / 字体，或「跟随默认」保持原样），也能一键导出投稿稿件（书名大号居中 + 简介 + 选定章节，简介默认取〈作品信息〉的「正式简介」）。\n\n【文件】\n· 保存：手动保存（Ctrl+S），有未保存的改动时变琥珀色并带呼吸圆点；\n· 时钟：时光机，按时间点回滚本章历史版本；\n· 垃圾桶：回收站，恢复误删的卷 / 章；\n· ⌘ 图标（Ctrl/Cmd+K）：全文检索，搜章节正文 / 角色 / 设定；\n· 人像：本章引用侧栏，列出本章提到的角色 / 设定可直达；\n· 荧光笔：引用名内联高亮开关（默认关闭）；\n· AI 伴写（位于「工具」中，默认关闭）：展开后可调整建议长度 / 去 AI 味 / 文风补充及总开关。开启后停笔会在光标处透出一句浅灰续写建议：Ctrl+Enter 采纳才落进正文，继续打字 / Esc / 移动光标即忽略，正文不会被改；对建议不满意按 Alt+/ 换一句（避开刚才那句重新生成）；Alt+\\ 可手动触发（需接入模型）；\n· 书本：前往本章细纲；\n· 搜索：全书搜索替换；\n· 锁：小黑屋强制码字（达标前不许退出）。\n\n【视图】\n· 面板图标：显示 / 隐藏左侧设定检索栏；\n· 全屏图标：专注模式，隐藏目录与检索栏只留正文。'}
              </HelpPopover>
            </div>
            </div>

            {/* 摘要行：自适应高度，内容多时自动展开完整显示 AI 压缩摘要 */}
            <div className="px-5 py-1.5 border-b border-ink-700/50 bg-ink-900/30 shrink-0 flex items-start gap-1.5">
              <textarea
                ref={summaryRef}
                value={active.summary}
                onChange={e => updateMeta({ summary: e.target.value })}
                placeholder="章节压缩摘要（AI 约 1/10，供综合诊断/推演简略模式）…"
                rows={1}
                className="!bg-transparent !border-transparent !px-0 py-1 text-11 leading-relaxed text-ink-300 hover:!border-ink-600 focus:!border-amber/50 flex-1 min-w-0 resize-none overflow-hidden box-border appearance-none"
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
                {'用 AI 把本章正文压缩成约 1/10 长度的连贯摘要（保留关键情节/人物/伏笔/转折/设定），例如「陈渊借雷劫破境，引动青铜小塔吞噬雷池，被苍澜宗执法长老察觉，妹妹陈瑶以桂花糖安抚其经脉反噬」。\n\n· 输入即自动同步到「章节总表」的一句话事件列；\n· 摘要出现后还会回填《章节细纲》卡的本章事件（原本为空才填 —— 你手写过的计划不会被覆盖）；\n· 它是「综合诊断 / 情节推演」的【简略模式】数据源——用它能大幅加快 AI 调用、省 token；想让 AI 看完整正文时，在这些功能的「完整（正文）」模式里切换即可；\n· 连续性校验与伏笔看板也会读取它来做提示。'}
                <AIDataSourceNote feature="chapter-summary" />
              </HelpPopover>
            </div>

            {/* 正文：码字区始终填满工具栏与状态栏之间的全部空间，宽高都随窗口自适应。
                🔴 窗口「又窄又矮」（如 1000×640 + 160% 缩放）时工具栏会换行成三排，正文区会被压到
                几十像素且外面 overflow-hidden ⇒ 作者连滚都滚不到。此时改成正文壳可纵向滚动 + 正文保底。 */}
            <div className={`flex-1 min-h-0 flex flex-col ${shortBody ? 'overflow-y-auto' : 'overflow-hidden'}`} ref={scrollRef}>
              {/* 页宽：默认铺满窗口；关闭"铺满"时回到舒适阅读宽度（隐藏检索栏/专注模式下更宽） */}
              <div
                className={`${pageWide ? 'w-full' : focusMode || !showSearch || showRefs ? 'max-w-5xl' : 'max-w-3xl'} w-full mx-auto px-6 md:px-8 pt-6 pb-3 relative ${shortBody ? 'shrink-0' : 'flex-1 min-h-0'} flex flex-col overflow-hidden transition-[max-width] duration-300`}
                style={shortBody ? { minHeight: BODY_MIN_H } : undefined}
              >
                {/* 段首缩进参考线（2.4.0 · A5 遗留补全）：极淡竖线标出每级缩进的位置，方便对齐多级缩进。
                    纯视觉辅助 —— pointer-events:none + aria-hidden，不参与任何交互与朗读。
                    垫在最底层（z-0）：正文 textarea 背景透明，线能透出来又不会压住文字。
                    间距按当前缩进单位的视觉宽度换算（INDENT_UNITS.emWidth），与「缩进单位」设置联动。 */}
                {indentGuides && active && (
                  <div aria-hidden className="absolute inset-0 z-0 pointer-events-none overflow-hidden px-6 md:px-8 pt-6">
                    <div
                      className="h-full"
                      style={{
                        backgroundImage: mono
                          ? `repeating-linear-gradient(to right, rgb(var(--ink-100)) 0 1px, transparent 1px ${indentUnitEm}em)`
                          : `repeating-linear-gradient(to right, rgb(var(--ink-500) / 0.18) 0 1px, transparent 1px ${indentUnitEm}em)`,
                      }}
                    />
                  </div>
                )}
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
                  className="novel-textarea absolute inset-0 z-0 overflow-hidden pointer-events-none border border-transparent pl-6 md:pl-8 pr-[calc(1.5rem+8px)] md:pr-[calc(2rem+8px)] pt-6"
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
                    className="novel-textarea absolute inset-0 z-0 overflow-hidden pointer-events-none border border-transparent pl-6 md:pl-8 pr-[calc(1.5rem+8px)] md:pr-[calc(2rem+8px)] pt-6"
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
                  onChange={e => {
                    const ta = e.currentTarget
                    const next = ta.value
                    const ev = e.nativeEvent as InputEvent
                    // 🔴🔴 3.2.2（2026-10-23 读者反馈修复）：**组合态一律不碰 DOM**。
                    //
                    //    历史：3.2.1 的 T-13 为了修「搜狗/微软拼音打“不补右半边」，放行了组合态里的补标点。
                    //    那个放行是错的 —— 组合期间的 `input` 事件里，`value` 是**未提交的预览串**；
                    //    我们补上 `”` 并把光标移回中间后，输入法提交自己的 `“` 时会插到我们移动后的光标处。
                    //    实测（CDP 模拟输入法）：`“` ⇒ `““”`，再按一下 ⇒ `“““”`，越打越多。
                    //    正解不是"组合态也补"，而是**等提交之后再补**：提交那个 `input` 事件的
                    //    `isComposing` 已经是 false，且 `data` 就是被提交的字符 ⇒ 走下面同一条判据即可。
                    //    （这同时修好了 T-13 想修的问题，且不破坏输入法。）
                    if (ev.isComposing) { onContentChange(next); return }
                    // 判据看**这次输入事件自带的 data**，不再用「prev/next 长度差」——
                    // 长度差在组合态下从来对不上，是上一个 bug 的根源。
                    // 先按「左标点 ⇒ 补右」判；不成立再走**右标点兜底**——
                    // 搜狗在 `，` 之后会把引号上屏成 `”`（智能收尾规则），只认左标点就永远不配对。
                    const plan = planPunctPair(next, ta.selectionStart, ev.data)
                      ?? planPunctPairFromClose(next, ta.selectionStart, ev.data)
                    if (!plan) { onContentChange(next); return }
                    onContentChange(plan.value)
                    // 光标要落在两个标点中间。必须等 React 把新 value 写进 DOM 之后再设，
                    // 否则受控回写会把光标推到末尾（放在 rAF 里最稳）。
                    requestAnimationFrame(() => {
                      const el = taRef.current
                      if (el) el.setSelectionRange(plan.caret, plan.caret)
                    })
                  }}
                  onCompositionEnd={e => {
                    // 🔴 3.2.2：组合结束是**另一个合法时机**，必须也补 —— 有些输入法把字留在组合里
                    //    就不再发提交 input 事件（实测 CDP 模拟如此），只靠 onChange 会一直不补。
                    //    与 onChange 那条判据结果相同、且幂等（右侧已有右标点就返回 null）。
                    const ta = e.currentTarget
                    const plan = planPunctPairAtCaret(ta.value, ta.selectionStart)
                      ?? planPunctPairFromCloseAtCaret(ta.value, ta.selectionStart)
                    if (!plan) return
                    onContentChange(plan.value)
                    requestAnimationFrame(() => {
                      const el = taRef.current
                      if (el) el.setSelectionRange(plan.caret, plan.caret)
                    })
                  }}
                  onKeyUp={() => { syncTypewriter(draftContent); syncSel() }}
                  onKeyDown={handleEditorKeyDown}
                  onPaste={handlePaste}
                  onClick={() => { syncTypewriter(draftContent); syncSel() }}
                  onSelect={syncSel}
                  onMouseUp={syncSel}
                  onScroll={scheduleHighlightSync}
                  placeholder="落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）"
                  className="novel-textarea absolute inset-0 z-10 overflow-y-auto px-6 md:px-8 pt-6"
                  style={{ fontSize: `${fontSize}px`, lineHeight: 1.9, color: highlightOn ? 'transparent' : undefined, caretColor: highlightOn ? 'rgb(var(--amber))' : undefined, paddingBottom: chapterCompact ? '2rem' : foldVh('40vh') }}
                  spellCheck={false}
                />
              </div>
            </div>

            {/* 底部状态栏：实时字数 / 今日码字 / 保存状态 / 打字机模式 / 字号
                🔴 h-10 与检索栏底条（SettingSearch）/ 侧栏左下角把手（Sidebar）统一高度，三条上边框对齐 */}
            <div className="h-10 shrink-0 border-t border-ink-700 bg-ink-900/70 flex items-center gap-3 px-3 text-11 text-ink-400 overflow-x-auto overflow-y-hidden [&>*]:shrink-0 [&>*]:whitespace-nowrap">
              {/* 本章实时字数：跟随「字数口径」偏好（#004）—— 与写作面板共用同一个开关 */}
              <span className="flex items-center gap-1" title={`本章字数（${withPunct ? '汉字＋标点' : '只算汉字'}口径 · 可在写作面板的「字数口径」里切换）`}>
                <Hash size={10} />{countWords(draftContent, wordCountModeOf(withPunct))} 字
              </span>
              <span className="flex items-center gap-1 text-amber/80" title="今日码字量（按增删自动累计，固定「只算汉字」口径 —— 它记的是当天净增量，换口径也无法重算历史）">
                <Flame size={10} />今日 {todayWords} 字
              </span>
              {/**
                * 🔴 3.2.2（审计 D4）：**磁盘结论优先**。
                * 只有真落盘确认（或至少没有错误、没有待写）时才说「已保存」；
                * 有错就说「未写入磁盘」，还在写就说「正在写入」——
                * 不许再出现「全局栏说保存出错、这里还说已保存」的两种结论。
                */}
              <span
                className={`flex items-center gap-1 transition-colors ${diskError ? 'text-red-400' : savedFlash ? 'text-success' : ''}`}
                title={diskError ? `尚未写入磁盘：${diskError}` : undefined}
              >
                <Save size={10} />
                {diskError
                  ? '未写入磁盘'
                  : saving ? '保存中…' : diskPending ? '正在写入…' : savedFlash ? '已保存' : '自动保存已开启'}
              </span>
              <div className="flex-1" />
              {/* 「铺满 / 限宽」：只在正文列宽到能看出差别时才出现（窄列下 max-w 不生效 = 点了没反应） */}
              {showPageWide && (
              <Button variant="bare"
                onClick={() => { const v = !pageWide; setPageWide(v); localStorage.setItem('novel-page-wide', v ? '1' : '0') }}
                className={`flex items-center gap-1 px-2 py-0.5 rounded border transition-colors whitespace-nowrap
                  ${pageWide ? 'bg-amber/15 text-amber border-amber/30' : 'text-ink-400 border-ink-700 hover:text-ink-200'}`}
                title={pageWide ? '当前：码字区铺满窗口（点击改为限宽阅读）' : '当前：限宽阅读（点击改为铺满窗口）'}
              >
                <PanelsTopLeft size={11} /> {pageWide ? '铺满' : '限宽'}
              </Button>
              )}
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
                <span className="w-6 text-center text-ink-300 tabular-nums text-11">{fontSize}</span>
                <Button variant="bare"
                  onClick={() => changeFontSize(1)}
                  className="w-5 flex items-center justify-center rounded text-ink-400 hover:text-amber transition-colors"
                  title="增大字号">
                  +
                </Button>
              </div>
              <HelpPopover title="状态栏 · 码字体验设置" width="23rem" size={12} className="shrink-0">
                {'左侧三项是实时状态：\n· 字数：本章当前字数（中文按字计）；跟随「字数口径」设置 —— 默认「只算汉字」，可在写作面板切到「汉字＋标点」以对齐平台计费口径；\n· 今日 xx 字：今天的净产出，按增删自动累计（固定「只算汉字」口径，历史增量无法换口径重算），写作面板的码字日历用的就是它；\n· 自动保存已开启：停止输入 2 秒自动保存，也可 Ctrl+S 立即保存。\n\n右侧三项是可调设置（本机记忆，换章不重置）：\n· 铺满 / 限宽：铺满 = 码字区宽度跟随窗口铺满；限宽 = 回到舒适阅读宽度居中显示；\n· 打字机：开启后当前输入行始终保持在屏幕中部，眼睛不用一直往下追；\n· 字号 −/＋：正文字号 14–28px。'}
              </HelpPopover>
            </div>

            {/* A1 本章资料抽屉复用原右侧栏位置；层号走 zLayer，不遮挡弹窗层。 */}
            {showRefs && active && (
              <ChapterContextPanel
                key={`${db.getCurrentProjectId()}:${active.id}`}
                projectId={db.getCurrentProjectId()}
                chapterId={active.id}
                chapterTitle={active.title}
                chapterNo={chapterSeqs.get(active.id) ?? 0}
                bodyText={draftContent}
                referenced={referenced}
                ctx={ctx}
                onClose={() => setShowRefs(false)}
                onNavigate={id => onNavigate?.(id)}
                onOpenRecord={ref => window.dispatchEvent(new CustomEvent('yfe:navigate', {
                  detail: { tabId: ref.tabId, rowId: ref.id },
                }))}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-ink-500">
            <PenLine size={32} className="text-ink-700" />
            <div className="text-sm">选择左侧章节，或新建一卷开始创作</div>
            {volumes.length === 0 && (
              <div className="flex items-center gap-2">
                <Button variant="primary" onClick={() => setNamePrompt({ kind: 'addVol', title: '新建卷', def: `第${nextVolumeNo(volumes)}卷` })} className="transition-colors">
                  <FolderPlus size={14} className="inline mr-1.5" />新建第一卷
                </Button>
                <Button variant="secondary" onClick={() => setNamePrompt({ kind: 'addFreeCh', title: '新建自由章节', def: `第${nextChapterNo}章` })} className="transition-colors">
                  <FilePlus2 size={14} className="inline mr-1.5" />新建自由章节
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ============ 功能弹窗 ============ */}
      {modal === 'sensitive' && active && (
        <SensitiveCheck content={draftContent} onApply={updateContent} onClose={() => setModal(null)} />
      )}
      {modal === 'history' && active && (
        <VersionHistory chapterId={active.id} current={draftContent} onRestore={restoreSnapshot} onClose={() => setModal(null)} />
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
        <ProofreadCheck content={draftContent} chapterId={active.id} onApply={updateContent} onClose={() => setModal(null)} />
      )}
      {modal === 'style' && active && !isLite && (
        <StyleAudit content={draftContent} chapterId={active.id} onClose={() => setModal(null)} />
      )}
      {/* 排版：缩进单位设置 + 一键排版（2.4.0 · A5）。
          排版结果走 replaceAllText 而不是 updateContent —— 前者用原生编辑命令写回，
          作者按 Ctrl+Z 能整体撤销（后者直接改 state，撤销栈里没有这一步）。
          ⚠️ active 判空不能省：排版最终要写回正文。 */}
      {modal === 'format' && active && (
        <FormatModal
          content={draftContent}
          unit={indentUnit}
          onUnitChange={setIndentUnit}
          pasteNormalize={pasteNormalize}
          onPasteNormalizeChange={setPasteNormalize}
          indentGuides={indentGuides}
          onIndentGuidesChange={setIndentGuides}
          onApply={replaceAllText}
          onClose={() => setModal(null)}
        />
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
      {/* 2.6.4 伴写：文风补充 = 多维多选 + 一句话自定义（本机记忆，只影响 AI 伴写的建议口吻） */}
      <CompanionStyleDialog
        open={styleNotePrompt}
        value={{ dims: companionStyleDims, note: companionStyleNote }}
        onSave={v => {
          const note = v.note.trim()
          setCompanionStyleDims(v.dims)
          setCompanionStyleNote(note)
          if (note) localStorage.setItem('novel-companion-style', note)
          else localStorage.removeItem('novel-companion-style')
          setStyleNotePrompt(false)
          showToast(v.dims.length || note ? '已保存伴写文风补充' : '已清空伴写文风补充', 'success')
        }}
        onClose={() => setStyleNotePrompt(false)}
      />
      {/* C6（2.4.2）导出格式：平台粘贴版参数 + Markdown 标题层级 */}
      <ExportFormatDialog
        open={exportFormatTab !== null}
        onClose={() => setExportFormatTab(null)}
        projectName={projectName}
        volumes={volumes}
        chapters={chapters}
        initialTab={exportFormatTab ?? 'platform'}
      />
      {/* 3.0.1：正文批量导入。导入后 load() 重载卷章列表（与回收站恢复同一口径），
          并通知父级刷新统计。 */}
      {importOpen && (
        <ChapterImportDialog
          projectName={projectName}
          onDone={() => { void load(); onStatsChange?.() }}
          onClose={() => setImportOpen(false)}
          onNavigate={onNavigate}
        />
      )}
    </div>
  )
}

