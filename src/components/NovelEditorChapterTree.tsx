import { Z } from '../lib/zLayer'
import { Button } from './Button'
import HelpPopover from './HelpPopover'
import type { Volume, Chapter, ChapterStatus } from '../lib/types'
import { BookMarked, Upload, FolderPlus, GripVertical, ChevronDown, ChevronRight, FilePlus2, Trash2, Hash, Inbox } from 'lucide-react'
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react'
import { isFreeVolume, realVolumes, nextVolumeNo } from '../lib/freeVolume'
import { useEffect, useRef } from 'react'
import { foldVh } from '../lib/theme'
import { flattenChapters } from '../lib/chapterSeq'

/**
 * 正文编辑页的**左侧章节树**（2026-09-19 从 NovelEditor.tsx 抽出，原 1113~1287 行）。
 *
 * 抽它的理由：这是编辑器里唯一「自成一体」的大块 —— 卷/章渲染 + 拖拽重排 +
 * 宽度拖拽 + 导出/新建入口都在这一棵子树里；搬出去之后父组件只剩「顶部工具栏 +
 * 编辑区叠层 + 弹窗调度」，读起来才像三件事而不是一团。
 *
 * 🔴 状态**一件都没搬**：拖拽态（dragKind / dragId / overKey）、展开态（expanded）、
 *    章节序号（chapterSeqs）全部留在父组件，以 props 传进来 ——
 *    因为父组件里还有别的地方在读它们（拖拽落点判定、状态栏、导出）。这是「搬视图不搬状态」。
 */

/** 章节树状态圆点颜色 */
const STATUS_DOT: Record<ChapterStatus, string> = {
  '构思': 'bg-ink-500',
  '细纲': 'bg-sky-400',
  '草稿': 'bg-amber',
  '修改': 'bg-orange-400',
  '完稿': 'bg-emerald-400',
  '已发布': 'bg-emerald-500',
}

interface Props {
  /** 栏目宽度与拖拽手柄（useResizable 的返回值，整体传进来） */
  pane: { size: number; onDragStart: (e: ReactMouseEvent) => void }
  projectName: string
  volumes: Volume[]
  chapters: Chapter[]
  expanded: Set<string>
  setExpanded: Dispatch<SetStateAction<Set<string>>>
  overKey: null | { kind: 'vol' | 'ch'; id: string; pos: 'before' | 'after' }
  setOverKey: Dispatch<SetStateAction<null | { kind: 'vol' | 'ch'; id: string; pos: 'before' | 'after' }>>
  dragKind: null | 'vol' | 'ch'
  setDragKind: Dispatch<SetStateAction<null | 'vol' | 'ch'>>
  setDragId: Dispatch<SetStateAction<string | null>>
  resetDrag: () => void
  handleDrop: () => void
  setNamePrompt: Dispatch<SetStateAction<null | { kind: 'addVol' | 'addCh' | 'addFreeCh' | 'renVol' | 'renCh'; title: string; def: string; payload?: unknown }>>
  nextChapterNo: number
  activeId: string | null
  openChapter: (id: string) => void
  chapterSeqs: Map<string, number>
  removeVolume: (vol: Volume) => void
  removeChapter: (ch: Chapter) => void
  toggleExcludeNumbering: (ch: Chapter) => void
  runExport: (fn: (m: typeof import('../lib/exporter')) => void) => void
  /** 导出菜单开合 —— 状态留在 useNovelEditorModel（`runExport` 里要顺手关掉），此处只读用 */
  exportOpen: boolean
  setExportOpen: Dispatch<SetStateAction<boolean>>
  /** 打开「导出全书（Markdown / Word / 平台粘贴版）」格式弹窗 —— 弹窗本体挂在 NovelEditor 上 */
  setExportFormatTab: (t: 'platform' | 'markdown' | 'docx' | null) => void
}

export default function NovelEditorChapterTree({
  pane, projectName, volumes, chapters, expanded, setExpanded,
  overKey, setOverKey, dragKind, setDragKind, setDragId, resetDrag, handleDrop,
  setNamePrompt, nextChapterNo, activeId, openChapter, chapterSeqs,
  removeVolume, removeChapter, toggleExcludeNumbering, runExport,
  exportOpen, setExportOpen, setExportFormatTab,
}: Props) {
  // 2.6.1 配套：打开项目恢复到上次章节（可能在很深的卷里）时，把高亮行滚进可视区，
  // 否则长列表里落点根本看不见。block:'nearest' 保证用户手动点选时（本就在可视区内）零滚动。
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!activeId || !listRef.current) return
    const el = listRef.current.querySelector(`[data-chapter-id="${CSS.escape(activeId)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeId])
  // 与 useNovelEditorModel 的 `active` 同一派生（同一份 chapters / activeId）：`active` 那边是
  // `chapters.find(c => c.id === activeId) ?? null`。此处自带一份，省得再往这棵树里传一个 prop。
  const activeChapter = chapters.find(c => c.id === activeId) ?? null
  return (
      <div
        className="relative shrink-0 border-r border-ink-700 bg-ink-900 flex flex-col"
        style={{ width: pane.size, minWidth: pane.size }}
      >
        {/* 拖拽调整章节树宽度 */}
        <div
          onMouseDown={pane.onDragStart}
          className="absolute top-0 right-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-amber/40 transition-colors"
  style={{ zIndex: Z.pageHandle }}
          title="拖拽调整章节栏宽度"
        />
        <div className="flex items-center justify-between px-3.5 h-11 border-b border-ink-700 shrink-0">
          <span className="text-12 font-semibold text-ink-200 flex items-center gap-1.5">
            <BookMarked size={13} className="text-amber" /> 章节
            <HelpPopover title="卷章目录怎么用" width="22rem" side="right">
              {'全书的卷 / 章结构树，也是章节间切换的入口。\n\n· 右上「新建卷」建卷，卷名右侧悬停出现「＋」新建该卷下的章；\n· 不想归卷的章节走右上「新建自由章节」—— 它们统一收进「自由章节」托管卷（默认折叠、不可删除、排全书最后），随时可拖进任意卷；\n· 悬停出现「⋮⋮」拖把，按住可拖动分卷/章节重排，章节可拖到其他卷（拖到空卷的「+ 新建第一章」处可加入该卷）；\n· 单击章节打开正文；双击章名可改名；单击卷名可改卷名；\n· 章前小圆点是状态色：灰=构思、蓝=细纲、黄=草稿、橙=修改、绿=完稿/已发布；\n· 圆点右侧的小数字是「正文序号」：由卷序与章序自动生成，跨卷连续，改名不会影响它，拖拽重排后会自动重算；\n· 悬停出现「＃」可把某章设为「不计入序号」（序章 / 番外 / 后记不占号），设后该图标变琥珀色常驻，再点一次恢复；\n· 悬停出现垃圾桶可删除，删除的卷章进回收站，可在工具栏「回收站」里恢复；\n· 右上「导出」图标是全书导出的唯一入口：本章 / 全本 TXT / Markdown / EPUB / Word（可排版、可导投稿稿）/ 平台粘贴版 / 按卷 / 按章节逐一导出。\n\n新建章节会自动登记进该卷的「章节台账」，字数与摘要保存时同步。'}
            </HelpPopover>
          </span>
          <div className="flex gap-1">
            {/* 导出：本章 / 全本 / 多格式 / 按卷 / 按章节 —— 全书导出的**唯一入口**。
                2.8.0 从编辑器工具栏迁来：原先工具栏与本处各挂一个导出按钮、功能重叠且不一致
                （本处只导全本 TXT），现统一收在这里的富功能版。
                按钮用 `bare` + 显式 `h-8`：要让「图标 + 折叠箭头」并排，不能用 icon-amber
                （它是定宽 w-8，会被箭头挤破）；h-8 与同排两个 icon-amber 键等高。 */}
            <div className="relative shrink-0">
              <Button variant="bare"
                onClick={() => setExportOpen(o => !o)}
                className={`flex items-center p-1 h-8 shrink-0 rounded-lg transition-colors ${exportOpen ? 'text-amber bg-amber/15' : 'text-ink-400 hover:text-amber'}`}
                title="导出全书：本章 / 全本 TXT / Markdown / EPUB / Word（可排版·投稿稿）/ 平台粘贴版 / 按卷 / 按章节"
              >
                <Upload size={14} />
                <ChevronDown size={9} className="ml-0.5 opacity-70" />
              </Button>
              {exportOpen && (
                <>
                  {/* 点外部关闭的遮罩：纯装饰性，给 aria-hidden 让朗读器忽略
                      （关闭功能本身由 Esc / 再点按钮提供，见 2026-09-22 六维审计 U5） */}
                  <div className="fixed inset-0" style={{ zIndex: Z.pagePanel }} onClick={() => setExportOpen(false)} aria-hidden />
                  {/* left-0 而非 right-0：章节栏最窄只有 200px、菜单 min-w 220px，右对齐会越过屏幕左缘 */}
                  <div className="absolute left-0 top-full mt-1 min-w-[220px] bg-ink-800 border border-ink-600 rounded-lg shadow-2xl py-1.5 overflow-y-auto"
style={{ zIndex: Z.pagePanelTop, maxHeight: foldVh('60vh') }}>
                    {activeChapter && (
                      <Button variant="bare"
                        onClick={() => runExport(m => m.exportChapter(projectName, activeChapter))}
                        className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      >
                        <Upload size={11} className="text-amber" /> 导出本章（{activeChapter.title}）
                      </Button>
                    )}
                    <Button variant="bare"
                      onClick={() => runExport(m => m.exportWholeBook(projectName, volumes, chapters))}
                      className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                    >
                      <Upload size={11} className="text-amber" /> 导出全本（一卷一章）
                    </Button>
                    <div className="my-1 mx-2 border-t border-ink-700" />
                    <div className="px-3 py-1 text-10 text-ink-500">导出全文（多格式）</div>
                    <Button variant="bare"
                      onClick={() => { setExportOpen(false); setExportFormatTab('markdown') }}
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
                      onClick={() => { setExportOpen(false); setExportFormatTab('docx') }}
                      className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      title="Word（DOCX）：可选排版（字号 / 对齐 / 缩进 / 行距 / 字体），也可一键导出投稿稿（书名 + 简介 + 选定章节）"
                    >
                      <Upload size={11} className="text-amber" /> 导出全书（Word · 可排版 / 投稿稿）
                    </Button>
                    <Button variant="bare"
                      onClick={() => { setExportOpen(false); setExportFormatTab('platform') }}
                      className="w-full text-left !justify-start px-3 py-1.5 text-12 text-ink-100 hover:bg-ink-700 flex items-center gap-2"
                      title="干净纯文本，可配章节标题样式 / 段落间距 / 卷标题 / 附设定集"
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
            <Button variant="icon-amber" onClick={() => setNamePrompt({ kind: 'addVol', title: '新建卷', def: `第${nextVolumeNo(volumes)}卷` })} title="新建卷" className="p-1 shrink-0">
              <FolderPlus size={13} />
            </Button>
            <Button variant="icon-amber" onClick={() => setNamePrompt({ kind: 'addFreeCh', title: '新建自由章节', def: `第${nextChapterNo}章` })} title="新建自由章节（不归入任何卷，收进「自由章节」托管卷）" className="p-1 shrink-0">
              <FilePlus2 size={13} />
            </Button>
          </div>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-2 px-2">
          {realVolumes(volumes).length === 0 && (
            <div className="text-center py-14 text-ink-500 text-12 border border-dashed border-ink-700 rounded-lg mx-1">
              <FolderPlus size={18} className="mx-auto mb-2 text-ink-600" />
              点击右上角「新建卷」开始，或直接「新建自由章节」
            </div>
          )}
          {volumes.map(vol => {
            const chs = chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)
            // 自由卷＝托管「未归类章节」的系统保留卷：不可拖、不可删，样式与真卷区分（见 lib/freeVolume.ts）
            const free = isFreeVolume(vol)
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
                    draggable={!free}
                    onDragStart={e => { if (free) { e.preventDefault(); return } e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', vol.id); setDragKind('vol'); setDragId(vol.id) }}
                    onDragEnd={() => resetDrag()}
                    className={free ? 'opacity-25 shrink-0 text-ink-600' : 'opacity-40 group-hover:opacity-100 cursor-grab active:cursor-grabbing text-ink-500 hover:text-amber transition-opacity shrink-0'}
                    title={free ? '「自由章节」卷固定在全书最前，不参与重排' : '拖动重排分卷'}
                  >
                    <GripVertical size={12} />
                  </span>
                  <Button variant="icon-muted"
                    title={open ? '收起本卷章节' : '展开本卷章节'}
                    aria-label={open ? '收起本卷章节' : '展开本卷章节'}
                    onClick={() => {
                      const next = new Set(expanded)
                      if (next.has(vol.id)) next.delete(vol.id); else next.add(vol.id)
                      setExpanded(next)
                    }}>
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </Button>
                  {free && <Inbox size={11} className="text-ink-500 shrink-0" />}
                  <span
                    onClick={() => setNamePrompt({ kind: 'renVol', title: '修改卷名', def: vol.title, payload: vol })}
                    className={`text-12 font-semibold cursor-pointer hover:text-amber transition-colors flex-1 truncate ${free ? 'text-ink-400' : 'text-ink-100'}`}
                    title={free ? '「自由章节」：托管未归类章节的系统保留卷（可改名，不可删除）' : '点击改卷名'}
                  >
                    {vol.title}
                  </span>
                  <span className="text-9 text-ink-600">{chs.length}章·{(volWords / 10000).toFixed(1)}万</span>
                  <Button variant="bare" iconOnly size="sm"
                    onClick={() => setNamePrompt({ kind: 'addCh', title: '新建章节', def: `第${nextChapterNo}章`, payload: vol.id })}
                    className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all"
                    title="新建章"
                  >
                    <FilePlus2 size={12} />
                  </Button>
                  {!free && (
                    <Button variant="icon-danger"
                      title="删除该卷"
                      aria-label="删除该卷"
                      onClick={() => removeVolume(vol)}
                      className="opacity-40 group-hover:opacity-100 p-0.5 transition-all">
                      <Trash2 size={12} />
                    </Button>
                  )}
                </div>
                {open && (
                  <div className="ml-3 border-l border-ink-700 pl-1 mt-0.5 space-y-0.5">
                    {chs.map(ch => {
                      const isActive = activeId === ch.id
                      return (
                        <div
                          key={ch.id}
                          data-chapter-id={ch.id}
                          onClick={() => openChapter(ch.id)}
                          className={`group flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer transition-colors
                            ${isActive ? 'bg-amber/15 text-amber' : 'text-ink-300 hover:bg-ink-800'}
                            ${overKey?.kind === 'ch' && overKey.id === ch.id ? (overKey.pos === 'before' ? 'shadow-[inset_0_2px_0_0_rgb(var(--amber)/0.7)]' : 'shadow-[inset_0_-2px_0_0_rgb(var(--amber)/0.7)]') : ''}`}
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
                              className="text-9 text-ink-600 shrink-0 tabular-nums w-4 text-right"
                              title={ch.excludeFromNumbering ? '不计入序号（序章 / 番外 / 后记）' : '正文序号（由卷序与章序派生）'}
                            >
                              {chapterSeqs.get(ch.id) || ''}
                            </span>
                            <span className="text-12 truncate flex-1" onDoubleClick={() => setNamePrompt({ kind: 'renCh', title: '修改章名', def: ch.title, payload: ch })} title={`双击改章名 · 状态：${ch.status}`}>
                              {ch.title}
                            </span>
                            <span className="text-9 text-ink-600 group-hover:hidden">{ch.wordCount > 0 ? `${ch.wordCount}字` : ''}</span>
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
                              title="删除该章节"
                              aria-label="删除该章节"
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
                        className={`w-full text-left px-2 py-1.5 text-11 transition-colors ${overKey?.kind === 'vol' && overKey.id === vol.id ? 'text-amber bg-amber/5 ring-1 ring-amber/70' : 'text-ink-500 hover:text-amber'}`}
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
  )
}

