import { foldVh } from '../lib/theme'
import { Z } from '../lib/zLayer'

import type { ChapterStatus } from '../lib/types'
import { countWords } from '../lib/textStats'
import SettingSearch from './SettingSearch'
import { SensitiveCheck, VersionHistory, TrashBin, GlobalSearch, FocusLock, ProofreadCheck } from './EditorModals'
import { ForeshadowBoard, ContinuityCheck, StyleAudit } from './AuditModals'
// 导出模块（zip/EPUB/DOCX 打包器较重）——改为按需动态导入，避免拖入首屏主包
import { formatNovelText } from '../lib/textTools'
import {
  FolderPlus, Trash2, PenLine, ChevronDown,
  Save, ArrowLeft, ArrowRight, Maximize2, Minimize2, PanelRightClose, PanelRightOpen,
  ShieldAlert, History, Search, Lock, AlignLeft, Upload, Hash, AlignCenter, Flame,
  GitBranch, Link2, SpellCheck, Feather, PanelsTopLeft,
  Command, Highlighter, BookOpen, Users, X, Sparkles, Loader2, Wand2, Layers, PenTool
} from 'lucide-react'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import PromptModal from './PromptModal'
import JieWenJi, { } from './JieWenJi'
import { confirmDialog, showToast } from './dialogs'
import { type VisCtx, } from '../lib/schema'
import { flattenChapters } from '../lib/chapterSeq'
import { INLINE_SUGGEST_LIMITS, type InlineSuggestLength } from '../lib/aiTasks'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import NovelEditorChapterTree from './NovelEditorChapterTree'

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


/** HTML 转义（防止引用名高亮注入）。先探测再替换：绝大多数正文片段不含 <>&，可省掉多次全量 replace */

import { useNovelEditorModel } from './useNovelEditorModel'

export default function NovelEditor({ onStatsChange, onNavigate, onOpenSearch, projectName = '我的小说', openChapterId, ctx = { type: 'full', features: [] } }: Props) {
  // 状态与生命周期全在 model 里；下面同名解构是刻意的 —— JSX 保持原样、零改动。
  const model = useNovelEditorModel({ projectName, ctx, openChapterId, onStatsChange })

  const {
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
  } = model

  if (!loaded) return <LoadingState />

  return (
    <div className="flex h-full page-enter overflow-hidden">
      {/* 章节树 */}
      {/* 章节树（已抽成独立组件，见 NovelEditorChapterTree.tsx） */}
      {!focusMode && (
        <NovelEditorChapterTree
          pane={chapterPane}
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
          openChapter={openChapter}
          chapterSeqs={chapterSeqs}
          removeVolume={removeVolume}
          removeChapter={removeChapter}
          toggleExcludeNumbering={toggleExcludeNumbering}
          runExport={runExport}
        />
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
                className="!bg-transparent !border-transparent !px-1 text-14 font-semibold text-ink-50 flex-1 min-w-0 hover:!border-ink-600 focus:!border-amber/50 font-serif"
              />
              <select
                value={active.status}
                onChange={e => updateMeta({ status: e.target.value as ChapterStatus })}
                className="!py-0.5 !px-1.5 text-11 shrink-0"
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
              <Button variant="bare" iconOnly size="sm" onClick={() => setModal('typo')} className="text-ink-400 hover:text-red-400 transition-colors shrink-0" title="校对（本章）：本地错别字直接查；AI 校对分「查错别字与语病」与「查逻辑与设定矛盾」两块，需接入模型">
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
                title="颉文姬 · AI 编辑：校对（文字层 / 逻辑层） / 综合诊断 / 选区改稿 / 审读 / 写作简报 / 本章设定补登（AI 增强需配置模型）"
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
                        className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出本章（{active.title}）
                      </Button>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportWholeBook(projectName, volumes, chapters))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出全本（一卷一章）
                      </Button>
                      <div className="my-1 mx-2 border-t border-ink-700" />
                      <div className="px-3 py-1 text-10 text-ink-500">导出全文（多格式）</div>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportBookMD(projectName, volumes, chapters))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出全书（Markdown）
                      </Button>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportEPUB(projectName, volumes, chapters))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出全书（EPUB）
                      </Button>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportDOCX(projectName, volumes, chapters))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出全书（DOCX）
                      </Button>
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportBookPlatformText(projectName, volumes, chapters))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                        title="干净纯文本，适配起点 / 番茄等网文平台粘贴"
                      >
                        <Upload size={11} className="text-amber" /> 导出全书（平台粘贴版）
                      </Button>
                      <div className="my-1 mx-2 border-t border-ink-700" />
                      <div className="px-3 py-1 text-10 text-ink-500">按卷导出</div>
                      {volumes.length === 0 ? (
                        <div className="px-3 py-1.5 text-11 text-ink-500">暂无分卷</div>
                      ) : volumes.map(vol => (
                        <Button variant="bare"
                          key={vol.id}
                          onClick={() => runExport(m => m.exportVolume(projectName, vol, chapters))}
                          className="w-full text-left !justify-start pl-5 pr-3 py-1 text-12 text-ink-200 hover:bg-ink-700 truncate"
                          title={`导出「${vol.title}」`}
                        >
                          {vol.title}（{chapters.filter(c => c.volumeId === vol.id).length} 章）
                        </Button>
                      ))}
                      <div className="my-1 mx-2 border-t border-ink-700" />
                      <div className="px-3 py-1 text-10 text-ink-500">按章节导出</div>
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
                        className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-200 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} /> 全部章节逐一导出（{chapters.length} 个文件）
                      </Button>
                      <div className="max-h-40 overflow-y-auto">
                        {flattenChapters(volumes, chapters).map(ch => (
                          <Button variant="bare"
                            key={ch.id}
                            onClick={() => runExport(m => m.exportChapter(projectName, ch))}
                            className="w-full text-left !justify-start pl-5 pr-3 py-0.5 text-11 text-ink-300 hover:bg-ink-700 truncate"
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
              {/* 保存：图标化，有未保存的改动时琥珀高亮+圆点 */}
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
                {'停笔约 0.8 秒后自动感知前文，在光标处透出一句「浅灰色」续写建议。\n· Tab 采纳 → 文字正式落进正文（→ 在末尾时也可采纳）；\n· 继续打字 / Esc / 移动光标 → 建议悄悄消失，正文一个字都没被改过；\n· 对建议不满意 → 按 Ctrl+Enter 换一句（会避开刚才那句，不会给你同一句）；\n· Alt+\\ 可随时手动触发一次。\n\n文风不靠「选风格」，而是三层自动锚定：①光标前约 2000 字正文（最准的风格样本）②《写作规范》里你登记的坏习惯词 / 标点偏好（可关）③下面这句自定义补充。\n\n'}
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
                    <span className="text-ink-500 text-10">压制套话与排比，默认开</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-ink-400 shrink-0">参考写作规范</span>
                    <Button variant="toggle" size="xs" selected={companionStyleSpec}
                      onClick={() => { const v = !companionStyleSpec; setCompanionStyleSpec(v); localStorage.setItem('novel-companion-stylespec', v ? '1' : '0') }}
                      title="把《写作规范》里登记的坏习惯词 / 标点偏好 / 视角规则锚进伴写；关掉后只靠前文样本与下面的文风补充">
                      {companionStyleSpec ? '已开启' : '已关闭'}
                    </Button>
                    <span className="text-ink-500 text-10">负面清单，默认开</span>
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
                    <span className="text-ink-500 text-10">{!aiReady ? '需先接入 AI 模型' : companion ? '停笔即续写一句话' : '默认关闭'}</span>
                  </div>
                  <div className="text-ink-500 text-10 leading-relaxed">
                    全部为本机记忆，换章不重置。伴写正文只发给你当前选定的模型：本地不出本机，云端会上传到该服务商。
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
                {'从左到右：\n\n【导航】← →：上一章 / 下一章（切章会先自动保存当前草稿）。\n【标题】中间输入框：改本章标题；右侧下拉：章节状态（构思/细纲/草稿/修改/完稿/已发布），会同步到章节总表与写作面板统计。\n\n【文本工具】\n· 盾牌：敏感词检测（本章），命中可直接替换；\n· 对齐图标：一键排版，统一段落首行缩进两个全角空格并规范空行；\n· 拼写图标：校对（本章），本地错别字直接查；AI 校对分「查错别字与语病」与「查逻辑与设定矛盾」两块，需接入模型。\n\n【审计工具】（仅完整项目）\n· 分支图标：伏笔闭环看板（全局），挖坑/填坑总账（埋设中/进行中/已回收/孤儿，含跨度与状态未同步预警）；\n· 链条图标：连续性校验（全局），查时间线倒流、人物状态与设定冲突；\n· 羽毛图标：文风体检（本章），坏习惯词 / 省略号误用 / 视角规则（详见《写作规范》）。\n\n【AI 与导出】\n· 魔杖：颉文姬·AI 编辑（校对·文字层/校对·逻辑层/综合诊断/选区改稿/审读/简报/设定补登，需接入模型）；\n· 上传箭头：导出菜单（本章 / 全本 / 按卷 / 按章，支持 TXT / Markdown / EPUB / DOCX / 平台粘贴版）。\n\n【文件】\n· 保存：手动保存（Ctrl+S），有未保存的改动时变琥珀色并带呼吸圆点；\n· 时钟：时光机，按时间点回滚本章历史版本；\n· 垃圾桶：回收站，恢复误删的卷 / 章；\n· ⌘ 图标（Ctrl/Cmd+K）：全文检索，搜章节正文 / 角色 / 设定；\n· 人像：本章引用侧栏，列出本章提到的角色 / 设定可直达；\n· 荧光笔：引用名内联高亮开关（默认关闭）；\n· 钢笔：AI 伴写（默认关闭）。点它会弹出「说明 + 设置 + 总开关」这一整个窗 —— 窗里有建议长度 / 去 AI 味 / 文风补充，最下面是总开关，不再另设开关图标。开启后停笔会在光标处透出一句浅灰续写建议：Tab 采纳才落进正文，继续打字 / Esc / 移动光标即忽略，正文不会被改；对建议不满意按 Ctrl+Enter 换一句（避开刚才那句重新生成）；Alt+\\ 可手动触发（需接入模型）；\n· 书本：前往本章大纲（章节细纲）；\n· 搜索：全书搜索替换；\n· 锁：小黑屋强制码字（达标前不许退出）。\n\n【视图】\n· 面板图标：显示 / 隐藏左侧设定检索栏；\n· 全屏图标：专注模式，隐藏目录与检索栏只留正文。'}
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
                {'用 AI 把本章正文压缩成约 1/10 长度的连贯摘要（保留关键情节/人物/伏笔/转折/设定），例如"陈渊借雷劫破境，引动青铜小塔吞噬雷池，被苍澜宗执法长老察觉，妹妹陈瑶以桂花糖安抚其经脉反噬"。\n\n· 输入即自动同步到「章节总表」的一句话事件列；\n· 摘要出现后还会回填《章节细纲》卡的本章事件（原本为空才填 —— 你手写过的计划不会被覆盖）；\n· 它是「综合诊断 / 情节推演」的【简略模式】数据源——用它能大幅加快 AI 调用、省 token；想让 AI 看完整正文时，在这些功能的「完整（正文）」模式里切换即可；\n· 连续性校验与伏笔看板也会读取它来做提示。'}
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
            <div className="h-8 shrink-0 border-t border-ink-700 bg-ink-900/70 flex items-center gap-4 px-5 text-11 text-ink-400">
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
                <span className="w-6 text-center text-ink-300 tabular-nums text-11">{fontSize}</span>
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

            {/* v1.3 本章引用侧栏（抽屉式）：列出本章正文里出现的已登记角色 / 术语，点击直达。
                层号走 zLayer 的 Z（禁裸 z-20）：与其它页内浮层同一套刻度。 */}
            {showRefs && active && (
              <div className="absolute right-3 top-14 bottom-10 w-72 bg-ink-850 border border-ink-700 rounded-xl shadow-2xl flex flex-col" style={{ zIndex: Z.pageBase }}>
                <div className="flex items-center gap-2 px-3 h-10 border-b border-ink-700 shrink-0">
                  <Users size={13} className="text-amber" />
                  <span className="text-12 font-semibold text-ink-200 flex-1">本章引用</span>
                  <span className="text-10 text-ink-500">{referenced.length} 处</span>
                  <Button variant="icon-muted" onClick={() => setShowRefs(false)} className="p-1" title="收起"><X size={16} /></Button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                  {referenced.length === 0 ? (
                    <div className="text-ink-500 text-11 p-3 leading-relaxed">
                      本章正文未匹配到已登记的角色名 / 设定条目名。<br />
                      先在「主要角色」「世界构建」各设定表（国家 / 地理 / 种族 / 物品 / 历史 / 术语…）登记，写作时用到会自动出现在这里，并可一键直达。
                    </div>
                  ) : (
                    (['character', 'setting'] as const).map(t => {
                      const items = referenced.filter(r => r.type === t)
                      if (!items.length) return null
                      return (
                        <div key={t}>
                          <div className="text-10 text-ink-500 px-1 py-1">{t === 'character' ? '角色' : '设定'} · {items.length}</div>
                          {items.map(r => (
                            <Button variant="bare"
                              key={r.name + (r.aliasOf ?? '')}
                              onClick={() => onNavigate?.(r.tabId)}
                              className="w-full text-left !justify-start px-2 py-1.5 rounded hover:bg-ink-800 flex items-center gap-2 text-ink-100 text-12 transition-colors"
                              title={`直达「${r.tabId}」`}
                            >
                              <span className="truncate flex-1">
                                {r.name}
                                {r.aliasOf && <span className="text-ink-500 text-10 ml-1.5">（{r.aliasOf} 的别称）</span>}
                              </span>
                              <span className="text-9 text-ink-500">→</span>
                            </Button>
                          ))}
                        </div>
                      )
                    })
                  )}
                </div>
                <div className="px-3 py-2 border-t border-ink-700 text-10 text-ink-500 leading-relaxed">
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
              <Button variant="primary" onClick={() => setNamePrompt({ kind: 'addVol', title: '新建卷', def: `第${volumes.length + 1}卷` })} className="px-4 py-2 rounded-lg text-13 transition-colors">
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

