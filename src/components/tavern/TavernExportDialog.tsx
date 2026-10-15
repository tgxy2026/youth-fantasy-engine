/**
 * 酒馆模式 · 导出文档弹窗（路线图第 7 批 B5）
 *
 * 三个页面（剧情推演 / 自由对话 / 推演报告）共用**同一个**弹窗 ——
 * 各写一份的话，「隐藏消息怎么算、导出说明怎么写」很快就会各自长歪。
 * 页面只负责给出「这份文档长什么样」（build 回调），格式与下载全在这里。
 *
 * 【为什么是两种格式，而不是一个「导出」按钮】
 * 两种格式解决的是两件事，合并不了：
 *   · Markdown —— **还要接着改**。粘进写作软件、笔记、Obsidian，继续加工。
 *   · 单文件 HTML —— **就是给人读的**。自带排版，双击就能看，能打印，能直接发出去
 *     而收件人不需要装任何东西、也不依赖本软件的 9 套预制主题。
 *
 * 【为什么默认含「已隐藏」的消息】
 * 隐藏的语义是「这段先别让 Ta 记得」（不进上下文），不是「销毁」。
 * 导出是给作者自己整理的稿子 —— 默认缺斤少两会让他以为对话丢了。
 */
import { useState } from 'react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { showToast, copyText } from '@/components/dialogs/dialogs'
import { downloadBlob } from '@/lib/storage/zip'
import { renderDoc, type DocModel, type ExportFormat } from '@/lib/tavern/exportDoc'
import { tavernExportSummaryText } from '@/lib/app/viewSelectors'

export type ExportBuildOptions = { includeHidden: boolean; withMeta: boolean }

export default function TavernExportDialog({
  open, onClose, docTitle, kindLabel, messageCount, hiddenCount = 0, summary, metaLabel, metaHint, build,
}: {
  open: boolean
  onClose: () => void
  /** 文档标题（让作者确认导的是哪一份） */
  docTitle: string
  /** 这一份是什么：「对话记录」/「推演报告」 */
  kindLabel: string
  /** 消息条数（报告这类没有对话的传 undefined，此时用 summary 或 metaLabel 说明） */
  messageCount?: number
  /** 其中已隐藏的条数 */
  hiddenCount?: number
  /** 自定义「将要导出什么」那行统计（随勾选变化；不传则按 messageCount 拼） */
  summary?: (o: ExportBuildOptions) => string
  /** 「附…信息」这一项的名字，默认「附角色与场景信息」 */
  metaLabel?: string
  /** 那一项下面的小字说明 */
  metaHint?: string
  build: (o: ExportBuildOptions) => DocModel
}) {
  const [includeHidden, setIncludeHidden] = useState(true)
  const [withMeta, setWithMeta] = useState(true)

  const opts = (): ExportBuildOptions => ({ includeHidden, withMeta })

  const exportAs = (format: ExportFormat) => {
    try {
      const f = renderDoc(build(opts()), format)
      downloadBlob(f.filename, new Blob([f.content], { type: f.mime }))
      showToast(`已导出 ${f.filename}`)
      onClose()
    } catch (e) {
      // 导出失败必须说出来 —— 静默失败时作者只会以为「点了没反应」
      showToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const copyMd = async () => {
    let content = ''
    try {
      content = renderDoc(build(opts()), 'markdown').content
    } catch (e) {
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      return
    }
    await copyText(content, '已复制 Markdown 源码 —— 可直接粘进写作软件')
  }

  const exportedCount = messageCount === undefined
    ? undefined
    : Math.max(0, messageCount - (includeHidden ? 0 : hiddenCount))
  const summaryText = summary
    ? summary(opts())
    : tavernExportSummaryText({ exportedCount, includeHidden, hiddenCount, withMeta, metaLabel })

  return (
    <Modal open={open} onClose={onClose} title="导出文档" width="lg">
      <p className="text-11 text-ink-400 leading-relaxed">
        把这份{kindLabel}变成可以带走、可以继续改、可以直接发出去的文档。导出只读，不改任何数据。
      </p>

      <div className="mt-3 rounded-lg border border-ink-700 bg-ink-850/40 p-3">
        <div className="text-12 text-ink-100">{docTitle || '（未命名）'}</div>
        <div className="mt-1 text-11 text-ink-400 leading-relaxed">{summaryText}</div>
      </div>

      {/* 导出选项：两条都默认开，关掉要出于明确意图 */}
      <div className="mt-3 space-y-2">
        {messageCount !== undefined && (
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox" className="mt-0.5 shrink-0 accent-amber"
              checked={includeHidden} onChange={e => setIncludeHidden(e.target.checked)}
            />
            <span className="text-11 text-ink-300 leading-relaxed">
              含已隐藏的对话{hiddenCount > 0 ? `（${hiddenCount} 条）` : ''}
              <span className="block text-10 text-ink-500">
                隐藏只是「不让 Ta 记得」，不是删除 —— 导出稿里标出来，方便你自己核对。
              </span>
            </span>
          </label>
        )}
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox" className="mt-0.5 shrink-0 accent-amber"
            checked={withMeta} onChange={e => setWithMeta(e.target.checked)}
          />
          <span className="text-11 text-ink-300 leading-relaxed">
            {metaLabel ?? '附角色与场景信息'}
            <span className="block text-10 text-ink-500">
              {metaHint ?? '标题下面那几行：模式、叙事锚点、谁演谁、开场场景 —— 过几个月再翻出来也知道这是哪一场。'}
            </span>
          </span>
        </label>
      </div>

      {/* 两种格式：各说清「什么时候用哪个」，别让人猜 */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => exportAs('markdown')}
          className="rounded-lg border border-ink-700 bg-ink-850/40 p-3 text-left transition-colors hover:border-amber/50 hover:bg-amber/5"
        >
          <div className="text-12 text-ink-100">Markdown（.md）</div>
          <div className="mt-1 text-11 text-ink-400 leading-relaxed">
            纯文本带轻量标记。要「继续改」就选它 —— 粘进写作软件、笔记都能接着编辑。
          </div>
        </button>
        <button
          type="button"
          onClick={() => exportAs('html')}
          className="rounded-lg border border-ink-700 bg-ink-850/40 p-3 text-left transition-colors hover:border-amber/50 hover:bg-amber/5"
        >
          <div className="text-12 text-ink-100">单文件 HTML（.html）</div>
          <div className="mt-1 text-11 text-ink-400 leading-relaxed">
            自带排版样式，双击就能看。要「给别人看、要打印、要存档」就选它 —— 不依赖本软件。
          </div>
        </button>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-ink-700 pt-3">
        <span className="text-10 text-ink-500 leading-relaxed">
          对白、（动作）、〔状态〕在两种格式里都会区分显示（v1.7 起已废止【环境】，环境描写与动作一样写在（ ）里）。
        </span>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="md" onClick={() => void copyMd()}>复制 Markdown</Button>
          <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
        </div>
      </div>
    </Modal>
  )
}
