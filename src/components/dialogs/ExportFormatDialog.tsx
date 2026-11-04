/**
 * 导出格式弹窗（C6 · 2.4.2；E2 · 2.6.2 加入 DOCX 页签；3.4.0 · E 具名导出方案与全格式范围选择）
 *
 * 「平台粘贴版」从一键直出升级为**可配置格式**：章节标题样式 / 段落间距 / 卷标题 / 附设定集；
 * 「Markdown」补上标题层级整体下移；「DOCX」提供排版预设（字号 / 对齐 / 缩进 / 行距 / 字体）
 * 与投稿稿件导出（书名 + 简介 + 选定章节）。选项按人记忆（settingsKV，跨项目共享）。
 *
 * 3.4.0 · E 增强：
 *   ① 增加「具名导出方案」保存与载入，按项目隔离，支持保存章节范围与排版意图；
 *   ② 平台粘贴版与 Markdown 同样支持自定义选定章节（默认全书，不选新选项行为零变化）；
 *   ③ 导出前清晰展示章节清单及失效章节提示；
 *   ④ 清楚说明稿件导出不是项目完整备份。
 *
 * 🔴 口径：只提供「格式怎么排」的开关，**不断言某平台必须怎样** —— 平台规则随时会变。
 * 🔴 纯本地操作，不涉 AI。
 * 🔴 DOCX 排版选项选「跟随默认」时**不传 layout** —— exporter 端零渲染差异（结构性保证）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import * as db from '@/lib/db'
import type { Chapter, Volume } from '@/lib/types'
import type { PlatformTextOptions, DocxLayoutOptions } from '@/lib/storage/exporter'
// 2.9.1 · E 档：导出即预检（能力来自「检查工具 → 分平台投稿预检」的同一套引擎）
import { scanByPlatform } from '@/lib/audit/platformCheck'
import type { PlatformId } from '@/lib/app/platformRules'
import { getCustomSensitiveWords } from '@/lib/editor/sensitiveWords'
import { flattenAll } from '@/lib/outline/chapterSeq'
import {
  loadSchemes,
  saveSchemes,
  createScheme,
  validateSchemeName,
  resolveSchemeChapters,
  updateScheme,
  type ExportScheme,
} from '@/lib/app/exportScheme'
import { FolderArchive, Trash2, Plus, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'

type Tab = 'platform' | 'markdown' | 'docx'
/** 预设档是 UI 层概念（exporter 只认五值对象）；'custom' = 手动改过任意单项 */
type DocxPreset = 'default' | 'submission' | 'compact' | 'custom'

interface DocxLayout {
  fontSizePt: number
  align: 'left' | 'justify'
  firstLineChars: number
  lineSpacing: 1 | 1.5
  bodyFont: string
}

interface ExportPrefs {
  tab: Tab
  platform: Required<Pick<PlatformTextOptions, 'chapterTitle' | 'paragraphGap' | 'includeVolumeTitle'>> & { includeAppendix: boolean }
  headingOffset: 0 | 1 | 2 | 3
  docxKind: 'book' | 'submission'
  docxPreset: DocxPreset
  docxLayout: DocxLayout
}

/** 预设档定义（与 exporter 的 DocxLayoutOptions 同构）：投稿标准 = 宋体小四 + 缩进 2 字 + 1.5 倍行距（起点 / 晋江等投稿通用口径）；紧凑 = 五号 + 无缩进 + 单倍 */
const DOCX_PRESET_LAYOUTS: Record<'submission' | 'compact', DocxLayout> = {
  submission: { fontSizePt: 12, align: 'left', firstLineChars: 2, lineSpacing: 1.5, bodyFont: '宋体' },
  compact: { fontSizePt: 10.5, align: 'left', firstLineChars: 0, lineSpacing: 1, bodyFont: '宋体' },
}

const DEFAULT_PREFS: ExportPrefs = {
  tab: 'platform',
  platform: { chapterTitle: 'as-is', paragraphGap: 'blank', includeVolumeTitle: true, includeAppendix: false },
  headingOffset: 0,
  docxKind: 'book',
  docxPreset: 'default',
  docxLayout: DOCX_PRESET_LAYOUTS.submission,
}

const PREFS_KEY = 'exportFormatPrefs'

function schemePrefs(value: unknown): ExportPrefs | null {
  if (!value || typeof value !== 'object') return null
  const p = value as Partial<ExportPrefs>, platform = p.platform, layout = p.docxLayout
  if (!platform || !layout || !['platform', 'markdown', 'docx'].includes(p.tab ?? '') ||
    !['as-is', 'numbered', 'none'].includes(platform.chapterTitle) || !['blank', 'compact'].includes(platform.paragraphGap) ||
    typeof platform.includeVolumeTitle !== 'boolean' || typeof platform.includeAppendix !== 'boolean' ||
    ![0, 1, 2, 3].includes(p.headingOffset ?? -1) || !['book', 'submission'].includes(p.docxKind ?? '') ||
    !['default', 'submission', 'compact', 'custom'].includes(p.docxPreset ?? '') ||
    !Number.isFinite(layout.fontSizePt) || !['left', 'justify'].includes(layout.align) ||
    ![0, 2].includes(layout.firstLineChars) || ![1, 1.5].includes(layout.lineSpacing) || typeof layout.bodyFont !== 'string') return null
  return p as ExportPrefs
}

/** 分段开关（与全局 toggle 视觉约定一致：selected = 选中态） */
function SegGroup<T extends string | number | boolean>({ value, onChange, options }: {
  value: T
  onChange: (v: T) => void
  options: { label: string; value: T; title?: string }[]
}) {
  return (
    <div className="inline-flex rounded-lg border border-ink-700 overflow-hidden">
      {options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 text-11 transition-colors ${
            o.value === value ? 'bg-amber/15 text-amber' : 'bg-ink-900 text-ink-300 hover:bg-ink-800'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export default function ExportFormatDialog({
  open, onClose, projectName, volumes, chapters, initialTab, projectId,
}: {
  open: boolean
  onClose: () => void
  projectName: string
  volumes: Volume[]
  chapters: Chapter[]
  initialTab: Tab
  projectId?: string
}) {
  const currentPid = projectId || db.getCurrentProjectId()
  const [prefs, setPrefs] = useState<ExportPrefs>(DEFAULT_PREFS)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  // 投稿稿件：简介（每次打开按「作品信息·正式简介」预填，仅本次生效 —— 简介是项目数据，不进跨项目偏好）
  const [intro, setIntro] = useState('')
  // 选中的章节 id（默认 = 有正文的章）
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  // 平台粘贴版/Markdown 是否启用选定章节范围（默认 false = 全书导出）
  const [enableChapterRange, setEnableChapterRange] = useState(false)
  // 方案管理折叠状态
  const [schemesOpen, setSchemesOpen] = useState(false)
  const [schemes, setSchemes] = useState<ExportScheme[]>([])
  const [schemesReady, setSchemesReady] = useState(false)
  const [newSchemeName, setNewSchemeName] = useState('')
  const [savingScheme, setSavingScheme] = useState(false)
  const schemeBusy = useRef(false)
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters
  const schemeScope = useRef({ projectId: currentPid, open, generation: 0 })
  if (schemeScope.current.projectId !== currentPid || schemeScope.current.open !== open) {
    schemeScope.current = { projectId: currentPid, open, generation: schemeScope.current.generation + 1 }
  }

  // 🔴 exporter 按需动态加载（与 useNovelEditorModel.runExport 同一约定：别把打包器拖进首屏主包）
  const [mod, setMod] = useState<typeof import('@/lib/storage/exporter') | null>(null)
  // 2.9.1 · E 档：发布前预检 —— 在导出对话框里直接按平台档位扫一遍敏感词
  const [precheckPlatform, setPrecheckPlatform] = useState<PlatformId>('general')
  const [customWords, setCustomWords] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    // 加载失败必须说出来 —— 静默 setMod(null) 会让「导出」点了没反应（审计 2026-09-28 修正）
    void import('@/lib/storage/exporter').then(setMod).catch(() => {
      setMod(null)
      showToast('导出模块加载失败，请重启软件后重试', 'error')
    })
  }, [open])

  // 发布前预检用自定义词表（与「检查工具」共用同一份，含作者自己导入的词）；读失败静默空表
  useEffect(() => {
    if (!open) return
    void getCustomSensitiveWords().then(setCustomWords).catch(() => setCustomWords([]))
  }, [open])

  // 打开时加载项目导出方案
  useEffect(() => {
    if (!open || !currentPid) return
    let alive = true
    setSchemesReady(false)
    setSchemes([])
    void loadSchemes(currentPid).then(value => {
      if (alive) { setSchemes(value); setSchemesReady(true) }
    }).catch(() => {
      if (alive) showToast('导出方案读取失败，请重新打开后重试；未修改已有方案。', 'error')
    })
    return () => { alive = false }
  }, [open, currentPid])

  // 打开时读一次偏好（跨项目共享，跟人走）——只读一次，避免每次开窗都从库拉一遍
  useEffect(() => {
    if (!open || loaded) return
    void (async () => {
      const saved = await db.getMeta<Partial<ExportPrefs>>(PREFS_KEY, {})
      setPrefs(prev => ({
        ...prev,
        platform: { ...DEFAULT_PREFS.platform, ...(saved.platform ?? {}) },
        headingOffset: saved.headingOffset ?? DEFAULT_PREFS.headingOffset,
        docxKind: saved.docxKind === 'submission' ? 'submission' : 'book',
        docxPreset: saved.docxPreset ?? DEFAULT_PREFS.docxPreset,
        docxLayout: { ...DEFAULT_PREFS.docxLayout, ...(saved.docxLayout ?? {}) },
      }))
      setLoaded(true)
    })()
  }, [open, loaded])

  // 投稿稿件数据：简介从〈作品信息〉的「正式简介」预填；章节默认勾选有正文的章。每次打开都重置。
  useEffect(() => {
    if (!open) return
    let alive = true
    setIntro('')
    void db.getFormDataFor(currentPid, 'positioning').then(d => {
      if (!alive) return
      const entry = Object.entries(d).find(([k]) => k.endsWith('::正式简介'))
      setIntro((entry?.[1] || d['正式简介'] || '').trim())
    }).catch(() => {})
    setPicked(new Set(chaptersRef.current.filter(c => (c.content || '').trim()).map(c => c.id)))
    setEnableChapterRange(false)
    return () => { alive = false }
  }, [open, currentPid])

  // 每次打开都按入口定位页签
  useEffect(() => {
    if (!open) return
    setPrefs(prev => (prev.tab === initialTab ? prev : { ...prev, tab: initialTab }))
  }, [open, initialTab])

  const patch = (p: Partial<ExportPrefs>) => setPrefs(prev => {
    const next = { ...prev, ...p }
    void db.setMeta(PREFS_KEY, next).catch(() => {})
    return next
  })
  const patchPlatform = (p: Partial<ExportPrefs['platform']>) => patch({ platform: { ...prefs.platform, ...p } })

  /** 选预设：填充五个排版项；手动改单项会落到「自定义」 */
  const applyPreset = (p: DocxPreset) => {
    if (p === 'custom') { patch({ docxPreset: p }); return }
    if (p === 'default') { patch({ docxPreset: 'default' }); return }
    patch({ docxPreset: p, docxLayout: { ...DOCX_PRESET_LAYOUTS[p] } })
  }
  const patchLayout = (p: Partial<DocxLayout>) =>
    patch({ docxPreset: 'custom', docxLayout: { ...prefs.docxLayout, ...p } })

  const platformOpts: PlatformTextOptions = useMemo(() => ({
    chapterTitle: prefs.platform.chapterTitle,
    paragraphGap: prefs.platform.paragraphGap,
    includeVolumeTitle: prefs.platform.includeVolumeTitle,
  }), [prefs.platform])

  // 全书顺序
  const orderedAll = useMemo(() => flattenAll(volumes, chapters), [volumes, chapters])

  // 计算当前选定章节（如果启用了范围选择或在 DOCX 投稿稿模式）
  const activeChapterIds = useMemo(() => {
    if (prefs.tab === 'docx') return prefs.docxKind === 'submission' ? picked : null
    if (enableChapterRange) return picked
    return null // null 表示全量
  }, [prefs.tab, prefs.docxKind, enableChapterRange, picked])

  // 实际导出的章节列表（保持叙事顺序）
  const exportChapters = useMemo(() => {
    if (!activeChapterIds) return chapters
    return orderedAll.filter(c => activeChapterIds.has(c.id))
  }, [activeChapterIds, chapters, orderedAll])

  // 检查已选章节中是否存在已被删除的失效章节
  const invalidChapterIds = useMemo(() => {
    if (!activeChapterIds) return []
    const chapterIdSet = new Set(chapters.map(c => c.id))
    return Array.from(activeChapterIds).filter(id => !chapterIdSet.has(id))
  }, [activeChapterIds, chapters])

  // 预览：取前若干行
  const preview = useMemo(() => {
    if (!open || !mod) return ''
    const text = mod.bookToPlatformText(volumes, exportChapters, platformOpts)
    return text.split('\n').slice(0, 14).join('\n')
  }, [open, mod, volumes, exportChapters, platformOpts])

  // 全文检测敏感词
  const fullText = useMemo(() => exportChapters.map(c => c.content || '').join('\n'), [exportChapters])
  const precheck = useMemo(() => {
    if (!fullText.trim()) return null
    const hits = scanByPlatform(fullText, precheckPlatform, customWords)
    return { total: hits.length, focused: hits.filter(h => h.focused).length }
  }, [fullText, precheckPlatform, customWords])

  const hasContent = exportChapters.some(c => (c.content || '').trim())

  // 保存当前为方案
  const handleSaveScheme = async () => {
    if (schemeBusy.current) return
    if (!schemesReady) { showToast('导出方案尚未成功读取，无法保存。', 'error'); return }
    const check = validateSchemeName(newSchemeName)
    if (!check.ok) {
      showToast(check.reason, 'info')
      return
    }
    const currentChapterIds = activeChapterIds ? Array.from(activeChapterIds) : null
    const scheme = createScheme(newSchemeName, prefs.tab, currentChapterIds, { version: 1, prefs })
    schemeBusy.current = true
    const generation = schemeScope.current.generation
    setSavingScheme(true)
    const nextSchemes = [scheme, ...schemes]
    const res = await saveSchemes(currentPid, nextSchemes, schemes)
    schemeBusy.current = false
    setSavingScheme(false)
    if (generation !== schemeScope.current.generation) return
    if (res.ok) {
      setSchemes(nextSchemes)
      setNewSchemeName('')
      showToast(`已保存导出方案「${scheme.name}」`, 'success')
    } else {
      showToast(`保存方案失败：${res.error || '未知错误'}`, 'error')
    }
  }

  // 应用方案
  const handleApplyScheme = (s: ExportScheme) => {
    const allIds = new Set(chapters.map(c => c.id))
    const { valid, invalid } = resolveSchemeChapters(s, allIds)
    if (invalid.length > 0) {
      showToast(`方案中有 ${invalid.length} 个章节不可用，未应用；请检查方案。`, 'error')
      return
    }
    const savedPrefs = schemePrefs(s.layoutHint?.prefs)
    if (!savedPrefs || savedPrefs.tab !== s.format) {
      showToast('此方案缺少完整排版设置，请重新保存方案。', 'error')
      return
    }
    patch(savedPrefs)
    if (s.chapterIds === null) {
      setEnableChapterRange(false)
      setPicked(new Set(chapters.filter(c => (c.content || '').trim()).map(c => c.id)))
    } else {
      setEnableChapterRange(true)
      setPicked(new Set(valid))
    }
    showToast(`已应用方案「${s.name}」`, 'success')
  }

  // 删除方案
  const handleDeleteScheme = async (id: string, name: string) => {
    if (schemeBusy.current) return
    if (!schemesReady) { showToast('导出方案尚未成功读取，无法删除。', 'error'); return }
    schemeBusy.current = true
    const generation = schemeScope.current.generation
    setSavingScheme(true)
    const next = schemes.filter(s => s.id !== id)
    const res = await saveSchemes(currentPid, next, schemes)
    schemeBusy.current = false
    setSavingScheme(false)
    if (generation !== schemeScope.current.generation) return
    if (res.ok) {
      setSchemes(next)
      showToast(`已删除方案「${name}」`, 'info')
    } else {
      showToast('删除方案失败', 'error')
    }
  }

  const handleRemoveMissing = async (scheme: ExportScheme) => {
    if (!schemesReady || schemeBusy.current) return
    const { valid } = resolveSchemeChapters(scheme, new Set(chapters.map(c => c.id)))
    schemeBusy.current = true
    const generation = schemeScope.current.generation
    setSavingScheme(true)
    const next = schemes.map(item => item.id === scheme.id ? updateScheme(item, { chapterIds: valid }) : item)
    const result = await saveSchemes(currentPid, next, schemes)
    schemeBusy.current = false
    setSavingScheme(false)
    if (generation !== schemeScope.current.generation) return
    if (result.ok) { setSchemes(next); showToast('已从方案中移除不可用章节。', 'success') }
    else showToast(`保存方案失败：${result.error || '未知错误'}`, 'error')
  }

  const doExport = async () => {
    if (busy || !mod) return
    if (invalidChapterIds.length) { showToast('选定章节有不可用项，请重新选择后导出。', 'error'); return }
    setBusy(true)
    try {
      if (prefs.tab === 'platform') {
        await mod.exportBookPlatformText(projectName, volumes, exportChapters, platformOpts, prefs.platform.includeAppendix)
        showToast(`已导出 ${projectName}-粘贴版.txt`)
      } else if (prefs.tab === 'markdown') {
        mod.exportBookMD(projectName, volumes, exportChapters, { headingOffset: prefs.headingOffset })
        showToast(`已导出 ${projectName}-全书.md`)
      } else {
        const layout: DocxLayoutOptions | undefined = prefs.docxPreset === 'default' ? undefined : prefs.docxLayout
        if (prefs.docxKind === 'submission') {
          if (picked.size === 0) { showToast('请先选择要放进投稿稿的章节', 'error'); return }
          mod.exportSubmissionDocx(
            { bookTitle: projectName, intro, chapterIds: [...picked], layout: layout ?? DOCX_PRESET_LAYOUTS.submission },
            volumes, chapters,
          )
          showToast(`已导出 ${projectName}-投稿稿.docx`)
        } else {
          mod.exportDOCX(projectName, volumes, exportChapters, layout)
          showToast(`已导出 ${projectName}.docx`)
        }
      }
      onClose()
    } catch (e) {
      showToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="导出格式" width="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" onClick={() => void doExport()}
            disabled={busy || !mod || !hasContent || invalidChapterIds.length > 0 || (prefs.tab === 'docx' && prefs.docxKind === 'submission' && picked.size === 0)}
            title={!mod ? '导出模块加载中，稍候片刻' : hasContent ? undefined : '还没有任何章节内容'}>
            {busy ? '导出中…' : prefs.tab === 'platform' ? '导出粘贴版'
              : prefs.tab === 'markdown' ? '导出 Markdown'
              : prefs.docxKind === 'submission' ? '导出投稿稿' : '导出 DOCX'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-13">
        {/* 具名导出方案折叠区 */}
        <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-2.5">
          <button
            type="button"
            onClick={() => setSchemesOpen(!schemesOpen)}
            className="w-full flex items-center justify-between text-12 text-ink-200 hover:text-amber transition-colors"
          >
            <span className="flex items-center gap-1.5 font-medium">
              <FolderArchive size={14} className="text-amber" /> 具名导出方案（{schemes.length}）
            </span>
            {schemesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>

          {schemesOpen && (
            <div className="mt-3 space-y-3 pt-2 border-t border-ink-700">
              {/* 保存当前为方案 */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  disabled={savingScheme}
                  placeholder="新方案名称（如：前五章精选）"
                  value={newSchemeName}
                  onChange={e => setNewSchemeName(e.target.value)}
                  className="flex-1 bg-ink-950 border border-ink-700 rounded px-2.5 py-1 text-12 text-ink-100 placeholder:text-ink-600 focus:border-amber outline-none"
                />
                <Button variant="secondary" size="xs" disabled={!schemesReady || savingScheme || !newSchemeName.trim()} onClick={() => void handleSaveScheme()}>
                  <Plus size={12} className="mr-0.5" /> 保存当前
                </Button>
              </div>

              {/* 已存方案列表 */}
              {!schemesReady ? (
                <div className="text-11 text-ink-500 py-1">方案尚未读取成功；请重新打开重试。</div>
              ) : schemes.length === 0 ? (
                <div className="text-11 text-ink-500 py-1">暂无保存的导出方案</div>
              ) : (
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {schemes.map(s => {
                    const allIds = new Set(chapters.map(c => c.id))
                    const { invalid } = resolveSchemeChapters(s, allIds)
                    return (
                      <div key={s.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-ink-800/50 hover:bg-ink-800 text-12">
                        <button
                          type="button"
                          onClick={() => handleApplyScheme(s)}
                          className="flex-1 text-left truncate text-ink-200 hover:text-amber"
                          title={`点击应用：${s.name}（${s.format}，${s.chapterIds ? `${s.chapterIds.length} 章` : '全书'}）`}
                        >
                          <span className="font-medium mr-1.5">{s.name}</span>
                          <span className="text-10 text-ink-500">[{s.format} · {s.chapterIds ? `${s.chapterIds.length}章` : '全书'}]</span>
                          {invalid.length > 0 && (
                            <span className="ml-1 text-10 text-danger font-normal">（{invalid.length}章不可用）</span>
                          )}
                        </button>
                        {invalid.length > 0 && <Button variant="secondary" size="xs" disabled={savingScheme} onClick={() => void handleRemoveMissing(s)}>移除不可用项</Button>}
                        <button
                          type="button"
                          disabled={savingScheme}
                          onClick={() => void handleDeleteScheme(s.id, s.name)}
                          className="text-ink-500 hover:text-danger p-1"
                          title="删除此方案"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 范式切换 */}
        <SegGroup<Tab> value={prefs.tab} onChange={v => patch({ tab: v })} options={[
          { label: '平台粘贴版（TXT）', value: 'platform' },
          { label: 'Markdown', value: 'markdown' },
          { label: 'Word（DOCX）', value: 'docx', title: '可选排版预设，或一键导出投稿稿件（书名 + 简介 + 选定章节）' },
        ]} />

        {/* 失效章节提示 */}
        {invalidChapterIds.length > 0 && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-danger/10 border border-danger/30 text-11 text-danger">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <div>
              检测到选定范围中有 <b>{invalidChapterIds.length}</b> 个章节不可用，请重新选择后导出。
              <Button variant="secondary" size="xs" onClick={() => setPicked(previous => new Set([...previous].filter(id => !invalidChapterIds.includes(id))))}>移除不可用项</Button>
            </div>
          </div>
        )}

        {/* 平台粘贴版 */}
        {prefs.tab === 'platform' ? (
          <>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">段落间距</span>
                <SegGroup value={prefs.platform.paragraphGap} onChange={v => patchPlatform({ paragraphGap: v })} options={[
                  { label: '段间空行', value: 'blank' as const, title: '主流网文后台的常见预览效果' },
                  { label: '单换行', value: 'compact' as const, title: '部分平台后台段落间不空行' },
                ]} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">章节标题</span>
                <SegGroup value={prefs.platform.chapterTitle} onChange={v => patchPlatform({ chapterTitle: v })} options={[
                  { label: '原样', value: 'as-is' as const },
                  { label: '补序号', value: 'numbered' as const, title: '按叙事顺序补全局序号；标记「不计入序号」的章保留原题' },
                  { label: '不带标题', value: 'none' as const },
                ]} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">卷标题行</span>
                <SegGroup value={prefs.platform.includeVolumeTitle} onChange={v => patchPlatform({ includeVolumeTitle: v })} options={[
                  { label: '显示', value: true as const },
                  { label: '隐藏', value: false as const, title: '平台按章发布时通常用不到卷标题' },
                ]} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">附设定集</span>
                <SegGroup value={prefs.platform.includeAppendix} onChange={v => patchPlatform({ includeAppendix: v })} options={[
                  { label: '不附', value: false as const },
                  { label: '附在文末', value: true as const, title: '把「设定集导出」的全部内容转成纯文本接在正文后，便于投稿时备查' },
                ]} />
              </div>

              {/* 章节范围可选过滤 */}
              <div className="border-t border-ink-700 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-ink-200 text-12">导出章节范围</span>
                  <SegGroup value={enableChapterRange} onChange={v => setEnableChapterRange(v)} options={[
                    { label: '全书导出', value: false },
                    { label: '选定章节', value: true },
                  ]} />
                </div>
                {enableChapterRange && (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center justify-between text-11 text-ink-500">
                      <span>已选 {picked.size} / {chapters.length} 章</span>
                      <span className="flex items-center gap-1">
                        <Button variant="secondary" size="xs" onClick={() => setPicked(new Set(orderedAll.map(c => c.id)))}>全选</Button>
                        <Button variant="secondary" size="xs" onClick={() => setPicked(new Set())}>清空</Button>
                      </span>
                    </div>
                    <div className="max-h-36 overflow-y-auto border border-ink-700 rounded-lg divide-y divide-ink-700">
                      {orderedAll.map(ch => (
                        <label key={ch.id} className="flex items-center gap-2 px-2.5 py-1 text-12 text-ink-200 hover:bg-ink-800/60 cursor-pointer">
                          <input type="checkbox" className="accent-[rgb(var(--amber))]" checked={picked.has(ch.id)}
                            onChange={e => {
                              const next = new Set(picked)
                              if (e.target.checked) next.add(ch.id)
                              else next.delete(ch.id)
                              setPicked(next)
                            }} />
                          <span className="truncate" title={ch.title}>{ch.title}</span>
                          <span className="ml-auto text-10 text-ink-500 shrink-0">{(ch.content || '').trim() ? undefined : '（无正文）'}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 发布前预检 */}
            <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">发布前预检</span>
                <SegGroup value={precheckPlatform} onChange={setPrecheckPlatform} options={[
                  { label: '通用', value: 'general' as const, title: '不针对某一平台：全部类别同等对待，适合先过一遍再按目标平台细看' },
                  { label: '起点', value: 'qidian' as const },
                  { label: '晋江', value: 'jjwxc' as const },
                ]} />
              </div>
              {precheck && (
                <div className={`mt-1.5 text-11 ${precheck.total === 0 ? 'text-success' : precheck.focused > 0 ? 'text-danger' : 'text-amber'}`}>
                  {precheck.total === 0
                    ? '未命中内置敏感词 ✓'
                    : `命中 ${precheck.total} 处${precheck.focused > 0 ? `，其中 ${precheck.focused} 处属该平台重点关注类别` : ''} —— 建议发布前复核`}
                </div>
              )}
              <p className="mt-1 text-10 leading-relaxed text-ink-500">
                逐处上下文与观察见「检查工具 → 分平台投稿预检」。平台规则随时会变，这里只做提示、不构成任何判定。
              </p>
            </div>
            <div>
              <div className="text-11 text-ink-500 mb-1">预览（开头几行）</div>
              <pre className="whitespace-pre-wrap text-11 text-ink-300 bg-ink-900/60 border border-ink-700 rounded-lg p-2.5 max-h-44 overflow-auto">{preview || '（暂无内容）'}</pre>
            </div>
          </>
        ) : prefs.tab === 'docx' ? (
          <>
            <SegGroup value={prefs.docxKind} onChange={v => patch({ docxKind: v })} options={[
              { label: '全书导出', value: 'book' as const, title: '书名 → 各卷 → 各章，全部内容' },
              { label: '投稿稿件', value: 'submission' as const, title: '书名大号居中、简介、选定章节按全书顺序输出' },
            ]} />

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">排版预设</span>
                <SegGroup value={prefs.docxPreset} onChange={applyPreset} options={[
                  { label: '跟随默认', value: 'default' as const, title: '不附加任何排版，与旧版导出完全一致' },
                  { label: '投稿标准', value: 'submission' as const, title: '宋体小四 + 首行缩进 2 字 + 1.5 倍行距，标题黑体（起点 / 晋江等投稿通用口径）' },
                  { label: '紧凑阅读', value: 'compact' as const, title: '五号字 + 无缩进 + 单倍行距，适合自己打印阅读' },
                  ...(prefs.docxPreset === 'custom' ? [{ label: '自定义', value: 'custom' as const }] : []),
                ]} />
              </div>
              {prefs.docxPreset === 'default' ? (
                <p className="text-10 leading-relaxed text-ink-500">
                  当前不附加任何排版（与旧版导出观感完全一致）。选一个预设后可再逐项微调；投稿稿件即使停在这个档位也会按「投稿标准」排版。
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink-200 text-12">正文字号</span>
                    <SegGroup value={prefs.docxLayout.fontSizePt} onChange={v => patchLayout({ fontSizePt: v })} options={[
                      { label: '五号（10.5）', value: 10.5 },
                      { label: '小四（12）', value: 12 },
                      { label: '四号（14）', value: 14 },
                    ]} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink-200 text-12">正文对齐</span>
                    <SegGroup value={prefs.docxLayout.align} onChange={v => patchLayout({ align: v })} options={[
                      { label: '左对齐', value: 'left' as const },
                      { label: '两端对齐', value: 'justify' as const, title: '长段落右缘更整齐，纸质阅读更舒服' },
                    ]} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink-200 text-12">首行缩进</span>
                    <SegGroup value={prefs.docxLayout.firstLineChars} onChange={v => patchLayout({ firstLineChars: v })} options={[
                      { label: '两字符', value: 2, title: '起点 / 晋江等平台投稿的通行口径' },
                      { label: '不缩进', value: 0 },
                    ]} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink-200 text-12">行距</span>
                    <SegGroup value={prefs.docxLayout.lineSpacing} onChange={v => patchLayout({ lineSpacing: v })} options={[
                      { label: '单倍', value: 1 as const },
                      { label: '1.5 倍', value: 1.5 as const, title: '投稿稿件的主流要求' },
                    ]} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink-200 text-12">正文字体</span>
                    <SegGroup value={prefs.docxLayout.bodyFont} onChange={v => patchLayout({ bodyFont: v })} options={[
                      { label: '宋体', value: '宋体' },
                      { label: '黑体', value: '黑体' },
                    ]} />
                  </div>
                  <p className="text-10 leading-relaxed text-ink-500">标题不随以上选项变化：书名黑体大号居中，卷 / 章标题黑体加粗左对齐。</p>
                </>
              )}
            </div>

            {prefs.docxKind === 'submission' && (
              <>
                <div>
                  <div className="text-11 text-ink-500 mb-1">简介（默认取〈作品信息〉的「正式简介」，可在此临时修改）</div>
                  <textarea
                    value={intro}
                    onChange={e => setIntro(e.target.value)}
                    rows={3}
                    placeholder="还没有填写正式简介 —— 去〈作品信息〉表填一次，或直接在这里输入本次要用的简介。"
                    className="w-full text-12 leading-relaxed bg-ink-900/60 border border-ink-700 rounded-lg p-2.5 text-ink-100 focus:border-amber/50 outline-none resize-none"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-11 text-ink-500">选定章节（已选 {picked.size} / {chapters.length}）</span>
                    <span className="flex items-center gap-1">
                      <Button variant="secondary" size="xs"
                        onClick={() => setPicked(new Set(orderedAll.map(c => c.id)))}>全选</Button>
                      <Button variant="secondary" size="xs"
                        onClick={() => setPicked(new Set())}>清空</Button>
                    </span>
                  </div>
                  <div className="max-h-40 overflow-y-auto border border-ink-700 rounded-lg divide-y divide-ink-700">
                    {orderedAll.map(ch => (
                      <label key={ch.id} className="flex items-center gap-2 px-2.5 py-1 text-12 text-ink-200 hover:bg-ink-800/60 cursor-pointer">
                        <input type="checkbox" className="accent-[rgb(var(--amber))]" checked={picked.has(ch.id)}
                          onChange={e => {
                            const next = new Set(picked)
                            if (e.target.checked) next.add(ch.id)
                            else next.delete(ch.id)
                            setPicked(next)
                          }} />
                        <span className="truncate" title={ch.title}>{ch.title}</span>
                        <span className="ml-auto text-10 text-ink-500 shrink-0">{(ch.content || '').trim() ? undefined : '（无正文）'}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">标题层级</span>
                <SegGroup value={prefs.headingOffset} onChange={v => patch({ headingOffset: v })} options={[
                  { label: '# 书名', value: 0 as const },
                  { label: '## 书名', value: 1 as const },
                  { label: '### 书名', value: 2 as const },
                ]} />
              </div>
              <div className="border-t border-ink-700 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-ink-200 text-12">导出章节范围</span>
                  <SegGroup value={enableChapterRange} onChange={v => setEnableChapterRange(v)} options={[
                    { label: '全书导出', value: false },
                    { label: '选定章节', value: true },
                  ]} />
                </div>
                {enableChapterRange && (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center justify-between text-11 text-ink-500">
                      <span>已选 {picked.size} / {chapters.length} 章</span>
                      <span className="flex items-center gap-1">
                        <Button variant="secondary" size="xs" onClick={() => setPicked(new Set(orderedAll.map(c => c.id)))}>全选</Button>
                        <Button variant="secondary" size="xs" onClick={() => setPicked(new Set())}>清空</Button>
                      </span>
                    </div>
                    <div className="max-h-36 overflow-y-auto border border-ink-700 rounded-lg divide-y divide-ink-700">
                      {orderedAll.map(ch => (
                        <label key={ch.id} className="flex items-center gap-2 px-2.5 py-1 text-12 text-ink-200 hover:bg-ink-800/60 cursor-pointer">
                          <input type="checkbox" className="accent-[rgb(var(--amber))]" checked={picked.has(ch.id)}
                            onChange={e => {
                              const next = new Set(picked)
                              if (e.target.checked) next.add(ch.id)
                              else next.delete(ch.id)
                              setPicked(next)
                            }} />
                          <span className="truncate" title={ch.title}>{ch.title}</span>
                          <span className="ml-auto text-10 text-ink-500 shrink-0">{(ch.content || '').trim() ? undefined : '（无正文）'}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <p className="text-10 leading-relaxed text-ink-500">
              把导出稿并进别的文档时，整体下移一级可避免和对方标题层级打架。缩进与空行的既有约定不受影响。
            </p>
          </>
        )}

        {/* 清楚说明稿件导出不是完整备份 */}
        <div className="pt-2 border-t border-ink-700 text-10 text-ink-500 leading-relaxed">
          💡 稿件导出为格式化纯文本或文档，不包含版本快照与世界观设置，请勿当作项目完整备份。若需备份整部作品，请使用「项目管理 → 导出备份包」。
        </div>
      </div>
    </Modal>
  )
}
