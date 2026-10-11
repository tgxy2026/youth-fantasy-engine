/**
 * 正文批量导入弹窗（3.0.1 · 方案 B）。
 *
 * ## 它解决什么问题
 * 作者在别处已经写了大量正文，想整批搬进正文编辑 —— 不用一章章复制。
 * 全程**纯本地**，不接 AI、不联网、不烧额度。
 *
 * ## 三条路径（同一套预览与落库）
 *   ① 选文件 / 拖拽 —— `.txt` / `.md` / `.docx` / `.json`，可一次多选（多份首尾相接）
 *   ② 粘贴原文     —— 整段贴进来，自动切卷章
 *   ③ JSON         —— 本项目定义的导入格式，可无损往返（见 `lib/storage/chapterImport.ts`）
 *
 * 🔴 纪律：
 *   · **预览确认才落库** —— 切出来什么先给作者看，卷名 / 章名可改、可逐章剔除；
 *   · **只追加不覆盖** —— 落库接在已有卷章之后，已有内容分毫不动（复用拆书落库口径）；
 *   · **诚实告知** —— .doc 劝退、docx 读不到的内容列出来、没识别到章节时明说。
 */
import { useMemo, useRef, useState } from 'react'
import { FileText, FilePlus2, Loader2, Trash2, Import, AlertTriangle, Check, ChevronDown, ChevronRight, CheckSquare, Square, Package } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import AutoTextarea from '@/components/common/AutoTextarea'
import { showToast } from '@/components/dialogs/dialogs'
import { foldVh } from '@/lib/settings/theme'
import {
  readImportFile, previewFromText, previewFromJson, mergePreviews, commitImportPreview,
  isAcceptedImportFile, MAX_IMPORT_FILES,
  type ImportPreview, type PreviewVolume,
} from '@/lib/storage/chapterImport'

type Mode = 'file' | 'paste'

interface Props {
  /** 库里已有的书名（仅用于提示，不写库） */
  projectName: string
  /** 落库成功后的收尾（父组件刷新卷章列表） */
  onDone: () => void
  onClose: () => void
  /** 跨页签跳转（引导去「一键拆书」用 AI 按标题样式识别） */
  onNavigate?: (id: string) => void
}

/** 把一份文件读成预览（含错误处理），返回 null 表示失败已提示 */
async function fileToPreview(f: File): Promise<ImportPreview | null> {
  try {
    const raw = await readImportFile(f)
    if (raw.kind === 'json' && raw.json) {
      const p = previewFromJson(raw.json, f.name)
      if (raw.skipped.length) p.notes.push(...raw.skipped)
      return p
    }
    const p = previewFromText(raw.text, f.name)
    if (raw.kind === 'docx' && raw.skipped.length) {
      p.notes.push(`「${f.name}」里未读取：${raw.skipped.join('、')}`)
    }
    return p
  } catch (e) {
    showToast(e instanceof Error ? e.message : `读取「${f.name}」失败`, 'error')
    return null
  }
}

export default function ChapterImportDialog({ projectName, onDone, onClose, onNavigate }: Props) {
  const [mode, setMode] = useState<Mode>('file')
  const [raw, setRaw] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [parsing, setParsing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)

  // 已勾选的章数（实时重算，供底部按钮显示）
  const pickedCount = useMemo(
    () => preview?.volumes.reduce((n, v) => n + v.chapters.filter(c => c.include).length, 0) ?? 0,
    [preview],
  )
  const pickedWords = useMemo(
    () => preview?.volumes.reduce((n, v) => n + v.chapters.filter(c => c.include).reduce((m, c) => m + countLoose(c.content), 0), 0) ?? 0,
    [preview],
  )

  /** 展示用的 notes：splitMode 为 chunks 时，那条「没识别到章节标题」已由上方琥珀提示条接管，去掉避免重复 */
  const previewNotes = useMemo(() => {
    const list = preview?.notes ?? []
    if (preview?.splitMode !== 'chunks') return list
    return list.filter(n => !n.startsWith('没有识别到章节标题'))
  }, [preview])

  /** 选文件（可多选）→ 逐个读 → 合并预览 */
  const onFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files).filter(f => isAcceptedImportFile(f.name))
    if (arr.length === 0) { showToast('没有可导入的文件（支持 .txt / .md / .docx / .json）', 'error'); return }
    if (arr.length > MAX_IMPORT_FILES) { showToast(`一次最多导入 ${MAX_IMPORT_FILES} 个文件`, 'error'); return }
    setParsing(true)
    try {
      const previews: ImportPreview[] = []
      for (const f of arr) {
        const p = await fileToPreview(f)
        if (p) previews.push(p)
      }
      if (previews.length === 0) { showToast('没有读到任何内容', 'error'); return }
      const merged = mergePreviews(previews)
      if (merged.totalChapters === 0) { showToast('没有读到任何章节内容', 'error'); return }
      setPreview(merged)
      setCollapsed(new Set())
      showToast(`已读取 ${arr.length} 个文件 · 共 ${merged.totalChapters} 章`, 'success')
    } finally {
      setParsing(false)
    }
  }

  /** 粘贴原文 → 切分预览 */
  const onParsePaste = () => {
    if (!raw.trim()) { showToast('请先粘贴正文', 'info'); return }
    const p = previewFromText(raw, '（粘贴）')
    if (p.totalChapters === 0) { showToast('没有读到任何内容', 'error'); return }
    setPreview(p)
    setCollapsed(new Set())
    showToast(`已切出 ${p.totalChapters} 章`, 'success')
  }

  /** 落库 */
  const onCommit = async () => {
    if (!preview || pickedCount === 0) { showToast('请至少勾选一章', 'info'); return }
    setCommitting(true)
    setProgress({ done: 0, total: pickedCount })
    try {
      const res = await commitImportPreview(preview, {
        onProgress: (done, total) => setProgress({ done, total }),
      })
      if (res.alreadyImported) {
        showToast('检测到同名卷与相同章节，这本书似乎已经导入过，已跳过（如需重导请先删除该卷）', 'info')
        onClose()
        return
      }
      const volTxt = res.volumes.map(v => `《${v.title}》${v.chapters}章`).join('、')
      showToast(
        `导入完成：新建 ${res.volumes.length} 卷 · ${res.chaptersCreated} 章 · ${fmtNum(res.words)} 字（${volTxt}）`
        + (res.aborted ? '　（中途中止，已导入的部分已保留）' : ''),
        'success',
      )
      onDone()
      onClose()
    } catch (e) {
      showToast(e instanceof Error ? e.message : '导入失败', 'error')
    } finally {
      setCommitting(false)
      setProgress(null)
    }
  }

  // ---------- 预览编辑动作（全部走不可变更新） ----------
  const patchVolTitle = (vKey: string, title: string) =>
    setPreview(p => p && ({ ...p, volumes: p.volumes.map(v => v.key === vKey ? { ...v, title } : v) }))
  const patchChTitle = (vKey: string, cKey: string, title: string) =>
    setPreview(p => p && ({
      ...p,
      volumes: p.volumes.map(v => v.key === vKey
        ? { ...v, chapters: v.chapters.map(c => c.key === cKey ? { ...c, title } : c) }
        : v),
    }))
  const toggleCh = (vKey: string, cKey: string) =>
    setPreview(p => p && ({
      ...p,
      volumes: p.volumes.map(v => v.key === vKey
        ? { ...v, chapters: v.chapters.map(c => c.key === cKey ? { ...c, include: !c.include } : c) }
        : v),
    }))
  const setVolAll = (vKey: string, include: boolean) =>
    setPreview(p => p && ({
      ...p,
      volumes: p.volumes.map(v => v.key === vKey ? { ...v, chapters: v.chapters.map(c => ({ ...c, include })) } : v),
    }))
  const dropVol = (vKey: string) =>
    setPreview(p => p && ({ ...p, volumes: p.volumes.filter(v => v.key !== vKey) }))
  const dropCh = (vKey: string, cKey: string) =>
    setPreview(p => p && ({
      ...p,
      volumes: p.volumes.map(v => v.key === vKey ? { ...v, chapters: v.chapters.filter(c => c.key !== cKey) } : v),
    }))
  const toggleFold = (vKey: string) =>
    setCollapsed(s => { const n = new Set(s); n.has(vKey) ? n.delete(vKey) : n.add(vKey); return n })

  const hasPreview = !!preview && preview.totalChapters > 0

  return (
    <Modal
      open
      title="批量导入正文"
      width="2xl"
      maxHeight="86vh"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between w-full gap-2">
          <span className="text-11 text-ink-400">
            {hasPreview
              ? <>已勾选 <b className="text-ink-100">{pickedCount}</b> / {preview!.totalChapters} 章 · 约 {fmtNum(pickedWords)} 字</>
              : '选择文件或粘贴原文后，会先切分预览'}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onClose} disabled={committing}>取消</Button>
            <Button variant="primary" size="md" onClick={onCommit} disabled={!hasPreview || pickedCount === 0 || committing}
              title={!hasPreview ? '先读取文件或粘贴原文' : (pickedCount === 0 ? '至少勾选一章' : '把勾选的卷章写入正文编辑')}>
              {committing
                ? <><Loader2 size={13} className="animate-spin" /> 导入中{progress ? ` ${progress.done}/${progress.total}` : ''}</>
                : <><FilePlus2 size={13} /> 导入 {pickedCount > 0 ? `${pickedCount} 章` : ''}</>}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {/* 说明 */}
        <div className="flex items-start gap-2 text-12 text-ink-400 leading-relaxed">
          <Package size={14} className="text-amber mt-0.5 shrink-0" />
          <p className="flex-1">
            把在别处写好的正文整批搬进《{projectName}》。切分与写入全部在本机完成，不联网、不消耗 AI 额度。
            卷名 / 章名可在下方预览里直接改，不需要的章取消勾选即可。
            <HelpPopover title="支持哪些格式 · 怎么切卷章" width="26rem" size={12} className="ml-0.5">
              {'【支持的格式】\n'
                + '· 纯文本 .txt / .md：直接读（UTF-8，自动剥 BOM）\n'
                + '· Word 文档 .docx：本机解析（表格里的段落也读得到；批注 / 脚注 / 页眉页脚 / 图片读不到，会如实列出）\n'
                + '· 结构化 .json：本项目定义的导入格式，可无损往返\n'
                + '· 旧版 .doc：二进制格式读不了，请在 Word 里「另存为」.docx 或 .txt\n\n'
                + '【怎么切成卷章】\n'
                + '· 识别「第1章 / 第一章 / 第12节 / Chapter 1 / 卷一 / 【序章】」这类标题行，按标题切章；\n'
                + '· 「卷一」这样的行会成为卷边界；\n'
                + '· 章名里的「第N章」编号会被自动剥掉（编号由本项目按全书顺序重新派生，避免与卷台账冲突）；\n'
                + '· 完全识别不到章节标题时，会按段落分成若干「第N段」，导入后可逐章改名。\n\n'
                + '【关于落库】\n'
                + '· 只追加：新卷接在现有卷之后，已有卷章分毫不动；\n'
                + '· 重复导入检测：同名卷 + 相同章节集合会被判定为「已导入过」而跳过（真要重导请先删除该卷）。'}
            </HelpPopover>
          </p>
        </div>

        {/* 输入区（未生成预览时占主导） */}
        <div className="rounded-xl border border-ink-700 bg-ink-850/40 p-3 space-y-3">
          <div className="flex gap-1">
            <Button variant={mode === 'file' ? 'primary' : 'secondary'} size="sm" onClick={() => setMode('file')}>
              <Import size={12} /> 选择文件
            </Button>
            <Button variant={mode === 'paste' ? 'primary' : 'secondary'} size="sm" onClick={() => setMode('paste')}>
              <FileText size={12} /> 粘贴原文
            </Button>
          </div>

          {mode === 'file' ? (
            <div
              onDragOver={e => { e.preventDefault() }}
              onDrop={e => { e.preventDefault(); if (e.dataTransfer.files?.length) void onFiles(e.dataTransfer.files) }}
              className="rounded-lg border border-dashed border-ink-600 bg-ink-900/40 px-4 py-6 text-center cursor-pointer hover:border-amber/60 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              {parsing
                ? <><Loader2 size={20} className="mx-auto mb-2 text-amber animate-spin" /><div className="text-12 text-ink-300">正在读取…</div></>
                : (
                  <>
                    <Import size={20} className="mx-auto mb-2 text-ink-500" />
                    <div className="text-12 text-ink-300">点此选择，或把文件拖到这里</div>
                    <div className="text-10 text-ink-500 mt-1">支持 .txt / .md / .docx / .json，可一次多选（多份首尾相接）</div>
                  </>
                )}
            </div>
          ) : (
            <div className="space-y-2">
              <AutoTextarea
                value={raw}
                onChange={setRaw}
                placeholder={'在此粘贴正文，例如：\n\n第一章 风起云州\n　　少年负剑出山门……\n\n第二章 剑鸣中州\n　　千里之外……'}
                className="text-12"
                minHeight={140}
                maxHeight={260}
              />
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" onClick={onParsePaste} disabled={!raw.trim()}>
                  切分预览
                </Button>
              </div>
            </div>
          )}
          <input ref={fileRef} type="file" multiple
            accept=".txt,.md,.markdown,.docx,.json,text/plain,application/json"
            className="hidden" onChange={e => { const fs = e.target.files; if (fs?.length) void onFiles(fs); e.target.value = '' }} />
        </div>

        {/* 预览树 */}
        {hasPreview && (
          <div className="space-y-2">
            {/* 切分状态提示 —— 识别成功给确认；未识别到章节标题则引导去「一键拆书」用 AI 纠偏 */}
            {preview!.splitMode === 'chapters' && (
              <div className="flex items-start gap-1.5 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-11 text-success">
                <Check size={12} className="mt-0.5 shrink-0" />
                <span>
                  已在本机按章节标题切出 <b>{preview!.totalChapters}</b> 章 —— 标题行认得出，无需其他处理。
                </span>
              </div>
            )}
            {preview!.splitMode === 'chunks' && (
              <div className="rounded-lg border border-amber/40 bg-amber/5 px-3 py-2 space-y-1.5">
                <div className="flex items-start gap-1.5 text-11 text-amber leading-relaxed">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>
                    没认出章节标题 —— 当前按段落分成了 <b>{preview!.totalChapters}</b> 块，卷名 / 章名都需要你自己改。
                    多半是原文的标题写法不标准（如「01|风起」「风起（一）」）本机规则认不出。
                  </span>
                </div>
                {onNavigate && (
                  <div className="flex items-center gap-2 pl-[18px]">
                    <Button variant="secondary" size="sm"
                      onClick={() => { onClose(); onNavigate('bookbreak') }}
                      title="打开「一键拆书」：可填「章节标题示例」，让 AI 照样式识别章节边界">
                      去「一键拆书」用 AI 识别
                    </Button>
                    <span className="text-10 text-ink-500">在那里照原文标题样式抄几行示例，AI 就能按章节切（会耗 AI 额度）。</span>
                  </div>
                )}
              </div>
            )}
            {previewNotes.length > 0 && (
              <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 space-y-1">
                {previewNotes.map((n, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-11 text-amber">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>{n}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="overflow-auto rounded-xl border border-ink-700" style={{ maxHeight: foldVh('44vh') }}>
              {preview!.volumes.map(v => (
                <VolumeRow key={v.key} vol={v}
                  collapsed={collapsed.has(v.key)}
                  onFold={() => toggleFold(v.key)}
                  onTitle={t => patchVolTitle(v.key, t)}
                  onChTitle={(ck, t) => patchChTitle(v.key, ck, t)}
                  onToggleCh={ck => toggleCh(v.key, ck)}
                  onSetAll={inc => setVolAll(v.key, inc)}
                  onDropVol={() => dropVol(v.key)}
                  onDropCh={ck => dropCh(v.key, ck)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** 单卷预览行（含其章列表） */
function VolumeRow({
  vol, collapsed, onFold, onTitle, onChTitle, onToggleCh, onSetAll, onDropVol, onDropCh,
}: {
  vol: PreviewVolume
  collapsed: boolean
  onFold: () => void
  onTitle: (t: string) => void
  onChTitle: (ck: string, t: string) => void
  onToggleCh: (ck: string) => void
  onSetAll: (inc: boolean) => void
  onDropVol: () => void
  onDropCh: (ck: string) => void
}) {
  const included = vol.chapters.filter(c => c.include).length
  const allOn = included === vol.chapters.length
  return (
    <div className="border-b border-ink-700 last:border-b-0">
      <div className="group flex items-center gap-1.5 px-3 py-2 bg-ink-850/60">
        <Button variant="icon-muted" onClick={onFold} title={collapsed ? '展开' : '收起'} aria-label={collapsed ? '展开' : '收起'}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </Button>
        <input value={vol.title} onChange={e => onTitle(e.target.value)}
          className="flex-1 min-w-0 bg-transparent border border-transparent hover:border-ink-600 focus:border-amber/50 rounded px-1.5 py-0.5 text-12 font-semibold text-ink-100"
          title="可改卷名" />
        <span className="text-10 text-ink-500 shrink-0 tabular-nums">{included}/{vol.chapters.length} 章</span>
        <Button variant="bare" size="sm" iconOnly onClick={() => onSetAll(!allOn)} className="text-ink-500 hover:text-amber shrink-0"
          title={allOn ? '本卷全部取消勾选' : '本卷全部勾选'}>
          {allOn ? <CheckSquare size={12} /> : <Square size={12} />}
        </Button>
        <Button variant="icon-danger" iconOnly size="sm" onClick={onDropVol} className="opacity-40 group-hover:opacity-100 shrink-0" title="移除整卷">
          <Trash2 size={12} />
        </Button>
      </div>
      {!collapsed && (
        <div className="py-0.5">
          {vol.chapters.map(c => (
            <div key={c.key} className="group flex items-center gap-1.5 pl-8 pr-3 py-1 hover:bg-ink-800/60">
              <Button variant="bare" size="sm" iconOnly onClick={() => onToggleCh(c.key)} className="shrink-0"
                title={c.include ? '取消勾选本章' : '勾选本章'}>
                {c.include ? <Check size={12} className="text-emerald-400" /> : <Square size={12} className="text-ink-600" />}
              </Button>
              <input value={c.title} onChange={e => onChTitle(c.key, e.target.value)}
                className={`flex-1 min-w-0 bg-transparent border border-transparent hover:border-ink-600 focus:border-amber/50 rounded px-1.5 py-0.5 text-12 ${c.include ? 'text-ink-200' : 'text-ink-500 line-through'}`}
                title="可改章名" />
              <span className="text-10 text-ink-600 shrink-0 tabular-nums">{fmtNum(countLoose(c.content))} 字</span>
              <span className="text-10 text-ink-600 shrink-0 max-w-[7rem] truncate" title={c.source}>{c.source}</span>
              <Button variant="icon-danger" iconOnly size="sm" onClick={() => onDropCh(c.key)} className="opacity-0 group-hover:opacity-100 shrink-0" title="移除本章">
                <Trash2 size={11} />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 轻量字数（预览用，口径与 chapterImport 内部一致） */
function countLoose(text: string): number {
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const en = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/[a-zA-Z0-9]+/g) || []).length
  return cn + en
}

function fmtNum(n: number): string { return n.toLocaleString('zh-CN') }
