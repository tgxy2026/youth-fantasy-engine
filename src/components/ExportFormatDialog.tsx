/**
 * 导出格式弹窗（C6 · 2.4.2）
 *
 * 「平台粘贴版」从一键直出升级为**可配置格式**：章节标题样式 / 段落间距 / 卷标题 / 附设定集；
 * 「Markdown」补上标题层级整体下移。选项按人记忆（settingsKV，跨项目共享）。
 *
 * 🔴 口径：只提供「格式怎么排」的开关，**不断言某平台必须怎样** —— 平台规则随时会变。
 * 🔴 纯本地操作，不涉 AI。
 */
import { useEffect, useMemo, useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { showToast } from './dialogs'
import * as db from '../lib/db'
import type { Chapter, Volume } from '../lib/types'
import type { PlatformTextOptions } from '../lib/exporter'

type Tab = 'platform' | 'markdown'

interface ExportPrefs {
  tab: Tab
  platform: Required<Pick<PlatformTextOptions, 'chapterTitle' | 'paragraphGap' | 'includeVolumeTitle'>> & { includeAppendix: boolean }
  headingOffset: 0 | 1 | 2 | 3
}

const DEFAULT_PREFS: ExportPrefs = {
  tab: 'platform',
  platform: { chapterTitle: 'as-is', paragraphGap: 'blank', includeVolumeTitle: true, includeAppendix: false },
  headingOffset: 0,
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
  // 🔴 exporter 按需动态加载（与 useNovelEditorModel.runExport 同一约定：别把打包器拖进首屏主包）
  const [mod, setMod] = useState<typeof import('../lib/exporter') | null>(null)
  useEffect(() => {
    if (!open) return
    void import('../lib/exporter').then(setMod).catch(() => setMod(null))
  }, [open])

  // 打开时读一次偏好（跨项目共享，跟人走）
  useEffect(() => {
    if (!open || loaded) return
    void (async () => {
      const saved = await db.getSetting<Partial<ExportPrefs>>(PREFS_KEY, {})
      setPrefs({
        tab: initialTab,
        platform: { ...DEFAULT_PREFS.platform, ...(saved.platform ?? {}) },
        headingOffset: saved.headingOffset ?? DEFAULT_PREFS.headingOffset,
      })
      setLoaded(true)
    })()
  }, [open, loaded, initialTab])

  const patch = (p: Partial<ExportPrefs>) => setPrefs(prev => {
    const next = { ...prev, ...p }
    void db.setSetting(PREFS_KEY, next).catch(() => {}) // 记不住也不挡导出
    return next
  })
  const patchPlatform = (p: Partial<ExportPrefs['platform']>) => patch({ platform: { ...prefs.platform, ...p } })

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

  const doExport = async () => {
    if (busy || !mod) return
    setBusy(true)
    try {
      if (prefs.tab === 'platform') {
        await mod.exportBookPlatformText(projectName, volumes, chapters, platformOpts, prefs.platform.includeAppendix)
        showToast(`已导出 ${projectName}-粘贴版.txt`)
      } else {
        mod.exportBookMD(projectName, volumes, chapters, { headingOffset: prefs.headingOffset })
        showToast(`已导出 ${projectName}-全书.md`)
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
          <Button variant="primary" size="sm" onClick={() => void doExport()} disabled={busy || !hasContent}
            title={hasContent ? undefined : '还没有任何章节内容'}>
            {busy ? '导出中…' : prefs.tab === 'platform' ? '导出粘贴版' : '导出 Markdown'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-13">
        {/* 范式切换 */}
        <SegGroup<Tab> value={prefs.tab} onChange={v => patch({ tab: v })} options={[
          { label: '平台粘贴版（TXT）', value: 'platform' },
          { label: 'Markdown', value: 'markdown' },
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
