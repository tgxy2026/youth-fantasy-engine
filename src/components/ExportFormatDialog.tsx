/**
 * 导出格式弹窗（C6 · 2.4.2；E2 · 2.6.2 加入 DOCX 页签）
 *
 * 「平台粘贴版」从一键直出升级为**可配置格式**：章节标题样式 / 段落间距 / 卷标题 / 附设定集；
 * 「Markdown」补上标题层级整体下移；「DOCX」提供排版预设（字号 / 对齐 / 缩进 / 行距 / 字体）
 * 与投稿稿件导出（书名 + 简介 + 选定章节）。选项按人记忆（settingsKV，跨项目共享）。
 *
 * 🔴 口径：只提供「格式怎么排」的开关，**不断言某平台必须怎样** —— 平台规则随时会变。
 * 🔴 纯本地操作，不涉 AI。
 * 🔴 DOCX 排版选项选「跟随默认」时**不传 layout** —— exporter 端零渲染差异（结构性保证）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { showToast } from './dialogs'
import * as db from '../lib/db'
import type { Chapter, Volume } from '../lib/types'
import type { PlatformTextOptions, DocxLayoutOptions } from '../lib/exporter'

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
  open, onClose, projectName, volumes, chapters, initialTab,
}: {
  open: boolean
  onClose: () => void
  projectName: string
  volumes: Volume[]
  chapters: Chapter[]
  initialTab: Tab
}) {
  const [prefs, setPrefs] = useState<ExportPrefs>(DEFAULT_PREFS)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  // 投稿稿件：简介（每次打开按「作品定位·正式简介」预填，仅本次生效 —— 简介是项目数据，不进跨项目偏好）
  const [intro, setIntro] = useState('')
  // 投稿稿件：选中的章节 id（默认 = 有正文的章）
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  // 🔴 exporter 按需动态加载（与 useNovelEditorModel.runExport 同一约定：别把打包器拖进首屏主包）
  const [mod, setMod] = useState<typeof import('../lib/exporter') | null>(null)
  useEffect(() => {
    if (!open) return
    // 加载失败必须说出来 —— 静默 setMod(null) 会让「导出」点了没反应（审计 2026-09-28 修正）
    void import('../lib/exporter').then(setMod).catch(() => {
      setMod(null)
      showToast('导出模块加载失败，请重启软件后重试', 'error')
    })
  }, [open])

  // 打开时读一次偏好（跨项目共享，跟人走）——只读一次，避免每次开窗都从库拉一遍
  useEffect(() => {
    if (!open || loaded) return
    void (async () => {
      // 🔴 用 getMeta（全局 meta，键不带项目前缀）而非 getSetting（settingsKV 键是
      //    `projectId::key`，按项目隔离）——导出排版偏好是应用级偏好，跨项目共享（审计 2026-09-28 修正）
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

  // 投稿稿件数据：简介从〈作品定位〉的「正式简介」预填；章节默认勾选有正文的章。每次打开都重置。
  useEffect(() => {
    if (!open) return
    void db.getFormData('positioning').then(d => {
      // 🔴 表单数据的键是「模块::字段」形态（种子约定）——裸键『正式简介』取不到，
      //    按「字段名后缀」匹配兜底（模块名改动不炸），最后才试裸键。
      const entry = Object.entries(d).find(([k]) => k.endsWith('::正式简介'))
      setIntro((entry?.[1] || d['正式简介'] || '').trim())
    }).catch(() => { /* 表还没建过 / 无项目：简介留空，用户可手填 */ })
    setPicked(new Set(chapters.filter(c => (c.content || '').trim()).map(c => c.id)))
  }, [open, chapters])

  // 🔴 每次打开都按**入口**定位页签（2026-09-23 实机抓出的缺陷）：
  //    原先 tab 只在「首次读偏好」那一次被写上 initialTab，于是第二次从菜单点「Markdown」
  //    会**停在「平台粘贴版」**——用户点的入口与看到的页面对不上。
  //    选项（间距/标题/层级）仍按人记忆，只有"停在哪一页"跟随入口。
  useEffect(() => {
    if (!open) return
    setPrefs(prev => (prev.tab === initialTab ? prev : { ...prev, tab: initialTab }))
  }, [open, initialTab])

  const patch = (p: Partial<ExportPrefs>) => setPrefs(prev => {
    const next = { ...prev, ...p }
    void db.setMeta(PREFS_KEY, next).catch(() => {}) // 记不住也不挡导出
    return next
  })
  const patchPlatform = (p: Partial<ExportPrefs['platform']>) => patch({ platform: { ...prefs.platform, ...p } })

  /** 选预设：填充五个排版项；手动改单项会落到「自定义」 */
  const applyPreset = (p: DocxPreset) => {
    if (p === 'custom') { patch({ docxPreset: p }); return }
    if (p === 'default') { patch({ docxPreset: 'default' }); return }
    patch({ docxPreset: p, docxLayout: { ...DOCX_PRESET_LAYOUTS[p] } })
  }
  /** 改单个排版项 → preset 变「自定义」（对比预设值太绕，直接落 custom 最诚实） */
  const patchLayout = (p: Partial<DocxLayout>) =>
    patch({ docxPreset: 'custom', docxLayout: { ...prefs.docxLayout, ...p } })

  const platformOpts: PlatformTextOptions = useMemo(() => ({
    chapterTitle: prefs.platform.chapterTitle,
    paragraphGap: prefs.platform.paragraphGap,
    includeVolumeTitle: prefs.platform.includeVolumeTitle,
  }), [prefs.platform])

  // 预览：取第一个有正文的章所在上下文，按同参数算开头若干行
  const preview = useMemo(() => {
    if (!open || !mod) return ''
    const text = mod.bookToPlatformText(volumes, chapters, platformOpts)
    return text.split('\n').slice(0, 14).join('\n')
  }, [open, mod, volumes, chapters, platformOpts])

  const hasContent = chapters.some(c => (c.content || '').trim())

  // 投稿稿章节列表：全书顺序（卷 → 章序 → 未分卷章节垫底），与 chaptersToTxt 的口径一致
  const flattenAll = useMemo(() => [
    ...volumes.flatMap(vol => chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)),
    ...chapters.filter(c => !volumes.some(v => v.id === c.volumeId)),
  ], [volumes, chapters])

  const doExport = async () => {
    if (busy || !mod) return
    setBusy(true)
    try {
      if (prefs.tab === 'platform') {
        await mod.exportBookPlatformText(projectName, volumes, chapters, platformOpts, prefs.platform.includeAppendix)
        showToast(`已导出 ${projectName}-粘贴版.txt`)
      } else if (prefs.tab === 'markdown') {
        mod.exportBookMD(projectName, volumes, chapters, { headingOffset: prefs.headingOffset })
        showToast(`已导出 ${projectName}-全书.md`)
      } else {
        // DOCX：「跟随默认」= 不传 layout（exporter 端零渲染差异，结构性红线）
        const layout: DocxLayoutOptions | undefined = prefs.docxPreset === 'default' ? undefined : prefs.docxLayout
        if (prefs.docxKind === 'submission') {
          if (picked.size === 0) { showToast('请先选择要放进投稿稿的章节', 'error'); return }
          // 投稿稿必须有排版：预设停在「跟随默认」时按「网文投稿标准」兜底
          mod.exportSubmissionDocx(
            { bookTitle: projectName, intro, chapterIds: [...picked], layout: layout ?? DOCX_PRESET_LAYOUTS.submission },
            volumes, chapters,
          )
          showToast(`已导出 ${projectName}-投稿稿.docx`)
        } else {
          mod.exportDOCX(projectName, volumes, chapters, layout)
          showToast(`已导出 ${projectName}.docx`)
        }
      }
      onClose()
    } catch (e) {
      // 导出失败必须说出来 —— 静默失败时作者只会以为「点了没反应」
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
            disabled={busy || !mod || !hasContent || (prefs.tab === 'docx' && prefs.docxKind === 'submission' && picked.size === 0)}
            title={!mod ? '导出模块加载中，稍候片刻' : hasContent ? undefined : '还没有任何章节内容'}>
            {busy ? '导出中…' : prefs.tab === 'platform' ? '导出粘贴版'
              : prefs.tab === 'markdown' ? '导出 Markdown'
              : prefs.docxKind === 'submission' ? '导出投稿稿' : '导出 DOCX'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-13">
        {/* 范式切换 */}
        <SegGroup<Tab> value={prefs.tab} onChange={v => patch({ tab: v })} options={[
          { label: '平台粘贴版（TXT）', value: 'platform' },
          { label: 'Markdown', value: 'markdown' },
          { label: 'Word（DOCX）', value: 'docx', title: '可选排版预设，或一键导出投稿稿件（书名 + 简介 + 选定章节）' },
        ]} />

        {prefs.tab === 'platform' ? (
          <>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">段落间距</span>
                <SegGroup value={prefs.platform.paragraphGap} onChange={v => patchPlatform({ paragraphGap: v })} options={[
                  { label: '段间空行', value: 'blank' as const, title: '主流网文后台的常见预览效果' },
                  { label: '单换行（紧凑）', value: 'compact' as const, title: '部分平台后台段落间不空行' },
                ]} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">章节标题</span>
                <SegGroup value={prefs.platform.chapterTitle} onChange={v => patchPlatform({ chapterTitle: v })} options={[
                  { label: '原样', value: 'as-is' as const },
                  { label: '补「第N章」', value: 'numbered' as const, title: '按叙事顺序补全局序号；标记「不计入序号」的章保留原题' },
                  { label: '不带标题', value: 'none' as const },
                ]} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">卷标题行</span>
                <SegGroup value={prefs.platform.includeVolumeTitle} onChange={v => patchPlatform({ includeVolumeTitle: v })} options={[
                  { label: '包含', value: true as const },
                  { label: '不包含', value: false as const, title: '平台按章发布时通常用不到卷标题' },
                ]} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">附设定集</span>
                <SegGroup value={prefs.platform.includeAppendix} onChange={v => patchPlatform({ includeAppendix: v })} options={[
                  { label: '不附', value: false as const },
                  { label: '附在文末', value: true as const, title: '把「设定集导出」的全部内容转成纯文本接在正文后，便于投稿时备查' },
                ]} />
              </div>
            </div>
            <div>
              <div className="text-11 text-ink-500 mb-1">预览（开头几行）</div>
              <pre className="whitespace-pre-wrap text-11 text-ink-300 bg-ink-900/60 border border-ink-700 rounded-lg p-2.5 max-h-44 overflow-auto">{preview || '（暂无内容）'}</pre>
            </div>
            <p className="text-10 leading-relaxed text-ink-500">
              平台规则随时会变，这里只提供排版开关 —— 用哪个组合，以平台后台的实际预览为准。选项会记住，下次导出沿用。
            </p>
          </>
        ) : prefs.tab === 'docx' ? (
          <>
            <SegGroup value={prefs.docxKind} onChange={v => patch({ docxKind: v })} options={[
              { label: '全书导出', value: 'book' as const, title: '书名 → 各卷 → 各章，全部内容' },
              { label: '投稿稿件（书名 + 简介 + 选章）', value: 'submission' as const, title: '书名大号居中、简介、选定章节按全书顺序输出' },
            ]} />

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-200 text-12">排版预设</span>
                <SegGroup value={prefs.docxPreset} onChange={applyPreset} options={[
                  { label: '跟随默认', value: 'default' as const, title: '不附加任何排版，与旧版导出完全一致' },
                  { label: '网文投稿标准', value: 'submission' as const, title: '宋体小四 + 首行缩进 2 字 + 1.5 倍行距，标题黑体（起点 / 晋江等投稿通用口径）' },
                  { label: '紧凑阅读', value: 'compact' as const, title: '五号字 + 无缩进 + 单倍行距，适合自己打印阅读' },
                  ...(prefs.docxPreset === 'custom' ? [{ label: '自定义', value: 'custom' as const }] : []),
                ]} />
              </div>
              {prefs.docxPreset === 'default' ? (
                <p className="text-10 leading-relaxed text-ink-500">
                  当前不附加任何排版（与旧版导出观感完全一致）。选一个预设后可再逐项微调；投稿稿件即使停在这个档位也会按「网文投稿标准」排版。
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
                        onClick={() => setPicked(new Set(flattenAll.map(c => c.id)))}>全选</Button>
                      <Button variant="secondary" size="xs"
                        onClick={() => setPicked(new Set())}>清空</Button>
                    </span>
                  </div>
                  <div className="max-h-40 overflow-y-auto border border-ink-700 rounded-lg divide-y divide-ink-800">
                    {flattenAll.map(ch => (
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

            <p className="text-10 leading-relaxed text-ink-500">
              投稿口径参考：正文宋体小四、首行缩进 2 字、1.5 倍行距、标题黑体加粗 —— 主流平台编辑普遍要求，具体以目标平台最新征稿函为准。选项会记住，下次导出沿用。
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-200 text-12">标题层级</span>
              <SegGroup value={prefs.headingOffset} onChange={v => patch({ headingOffset: v })} options={[
                { label: '# 书名', value: 0 as const },
                { label: '## 书名', value: 1 as const },
                { label: '### 书名', value: 2 as const },
              ]} />
            </div>
            <p className="text-10 leading-relaxed text-ink-500">
              把导出稿并进别的文档时，整体下移一级可避免和对方标题层级打架。缩进与空行的既有约定不受影响。
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}
