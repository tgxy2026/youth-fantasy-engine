/**
 * 创作证据包 · 导出弹窗。
 *
 * 【为什么三种格式，而不是一个「导出」按钮】
 * 它们解决三件不同的事，合并不了：
 *   · **PDF**（桌面版）—— 最终交付形态。投稿 / 报名时最常被要的就是一份 PDF。
 *   · **单文件 HTML** —— PDF 的**真源**，也是便携版与浏览器的等价路径：
 *     自包含、双击就能看、能打印。将来 PDF 的排版要改，改的是它。
 *   · **JSON 原件** —— 给机器核验。含原始时间戳与各版全文，不经任何美化加工。
 *
 * 🔴 中文 PDF 只能走 Electron 的打印通道（见 main.cjs 的 export:pdf）——
 *    前端 PDF 库自带字体不含中文，硬套会输出豆腐块。桌面通道不可用时**如实退回**
 *    到 HTML + 打印，而不是悄悄失败。
 */
import { useState } from 'react'
import { FileText, Printer, Braces, Loader2 } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import { downloadBlob } from '@/lib/storage/zip'
import { renderDoc } from '@/lib/tavern/exportDoc'
import { exportPdfDocument, DESKTOP } from '@/lib/app/desktop'
import { WEB } from '@/lib/app/platform'
import {
  packToDocModel, packToJson, evidenceHtmlFileName, evidenceJsonFileName,
  evidenceSummary, dailyRange, DEFAULT_EVIDENCE_OPTIONS,
  type EvidencePack, type EvidenceViewOptions,
} from '@/lib/audit/evidencePack'
import {
  bookPackToDocModel, bookPackToJson, bookEvidenceHtmlFileName, bookEvidenceJsonFileName,
  bookEvidenceSummary, bookDailyRange, DEFAULT_BOOK_EVIDENCE_OPTIONS,
  type BookEvidencePack,
} from '@/lib/audit/bookEvidence'

export default function EvidenceExportDialog({ open, onClose, pack, bookPack }: {
  open: boolean
  onClose: () => void
  /** 本章证据包 */
  pack: EvidencePack
  /** 整书证据包（可选）：传了就在顶部出现「范围」切换（A4 遗留补全） */
  bookPack?: BookEvidencePack
}) {
  const [opts, setOpts] = useState<EvidenceViewOptions>(DEFAULT_EVIDENCE_OPTIONS)
  /** 导出范围（只有传了整书包时才能切）。整书模式不提供「附各版正文」—— 那会让文件大到没法用 */
  const [scope, setScope] = useState<'chapter' | 'book'>('chapter')
  const [pdfBusy, setPdfBusy] = useState(false)

  const isBook = scope === 'book' && !!bookPack
  /**
   * 两种范围共用的取值口 —— 下面所有导出动作都只认它，不再各自判断范围。
   * （这里刻意用一组函数：整书包与本章包的字段名不同，散在十来个地方判 scope 必然漏一处。）
   */
  const view = isBook
    ? {
      title: () => `${bookPack!.project.name} · 成书过程`,
      summary: () => bookEvidenceSummary(bookPack!),
      range: () => bookDailyRange(bookPack!),
      doc: () => bookPackToDocModel(bookPack!, DEFAULT_BOOK_EVIDENCE_OPTIONS),
      json: () => bookPackToJson(bookPack!),
      htmlName: () => bookEvidenceHtmlFileName(bookPack!),
      jsonName: () => bookEvidenceJsonFileName(bookPack!),
      lines: () => bookPack!.statement,
    }
    : {
      title: () => `${pack.project.name} · ${pack.chapter.title}`,
      summary: () => evidenceSummary(pack),
      range: () => dailyRange(pack),
      doc: () => packToDocModel(pack, opts),
      json: () => packToJson(pack),
      htmlName: () => evidenceHtmlFileName(pack),
      jsonName: () => evidenceJsonFileName(pack),
      lines: () => [...pack.statement, pack.retention.note],
    }

  const htmlFile = () => renderDoc(view.doc(), 'html')
  const range = view.range()

  const fail = (e: unknown) =>
    showToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error')

  const exportHtml = () => {
    try {
      const f = htmlFile()
      downloadBlob(f.filename, new Blob([f.content], { type: f.mime }))
      showToast(`已导出 ${f.filename} —— 双击打开后按 Ctrl+P 可另存为 PDF`)
      onClose()
    } catch (e) { fail(e) }
  }

  const exportJson = () => {
    try {
      const name = view.jsonName()
      downloadBlob(name, new Blob([view.json()], { type: 'application/json;charset=utf-8' }))
      showToast(`已导出 ${name}`)
      onClose()
    } catch (e) { fail(e) }
  }

  const exportPdf = async () => {
    setPdfBusy(true)
    try {
      const f = htmlFile()
      const res = await exportPdfDocument(f.content, view.htmlName().replace(/\.html$/, '.pdf'))
      if (res.ok) {
        showToast('已保存 PDF')
        onClose()
        return
      }
      if (res.cancelled) return // 用户自己按了取消，不该弹提示
      // 桌面通道不可用（便携版 / 浏览器 dev）→ 如实退回 HTML，并说清怎么拿到 PDF
      downloadBlob(f.filename, new Blob([f.content], { type: f.mime }))
      showToast('当前版本不能直接存 PDF，已改为下载 HTML —— 打开后按 Ctrl+P 就能另存为 PDF', 'info', 6000)
      onClose()
    } catch (e) { fail(e) } finally { setPdfBusy(false) }
  }

  const toggles: { key: keyof EvidenceViewOptions; label: string; hint: string }[] = [
    { key: 'includeVersions', label: '附各版完整正文', hint: '把每个历史版本的全文都放进去 —— 这是证据包里最实在的部分，篇幅也最大。' },
    { key: 'includeOutline', label: '附本章细纲', hint: '动笔前排的细纲。时间取卡片创建时间（2.4.0 起），老卡片没有则标为「未记录时间」——不编时间。' },
    { key: 'includeDaily', label: '附写作分布', hint: '逐日列出本项目当天写的字数，用于核对更新节奏。' },
  ]

  return (
    <Modal open={open} onClose={onClose} title="导出创作证据包" width="lg">
      <p className="text-11 text-ink-400 leading-relaxed">
        {isBook
          ? '把整本书的成书过程整理成可以带走、可以打印、可以交给别人的材料（不含各章全文）。导出是只读操作，不改任何数据。'
          : '把这一章的创作过程整理成可以带走、可以打印、可以交给别人的材料。导出是只读操作，不改任何数据。'}
      </p>

      {/* 范围切换（A4 遗留补全）：本章看过程细节，整书看规模与节奏 */}
      {bookPack && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-11 text-ink-500">范围</span>
          <Button variant="toggle" selected={!isBook} size="sm" onClick={() => setScope('chapter')}>本章</Button>
          <Button variant="toggle" selected={isBook} size="sm" onClick={() => setScope('book')}>整书</Button>
          <span className="text-10 text-ink-600">
            {isBook ? '含成书时间线、逐章一览与写作分布，不含各章全文' : '含细纲、各次改动与当前稿'}
          </span>
        </div>
      )}

      <div className="mt-3 rounded-lg border border-ink-700 bg-ink-850/40 p-3">
        <div className="text-12 text-ink-100">{view.title()}</div>
        <div className="mt-1 text-11 text-ink-400 leading-relaxed">
          {view.summary()}
          {range ? `　·　写作日期 ${range.from} ~ ${range.to}` : ''}
        </div>
      </div>

      {/* 展示选项：只影响 HTML / PDF 的篇幅，**JSON 永远是全量原件**。整书模式内容固定，不显示选项 */}
      {!isBook && (
        <div className="mt-3 space-y-2">
          {toggles.map(t => (
            <label key={t.key} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox" className="mt-0.5 shrink-0 accent-amber"
                checked={opts[t.key]} onChange={e => setOpts({ ...opts, [t.key]: e.target.checked })}
              />
              <span className="text-11 text-ink-300 leading-relaxed">
                {t.label}
                <span className="block text-10 text-ink-500">{t.hint}</span>
              </span>
            </label>
          ))}
          <p className="text-10 text-ink-500 leading-relaxed pl-6">
            以上选项只影响 PDF / HTML 的篇幅；JSON 原件始终是完整的，不受勾选影响。
          </p>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Button
          variant="primary" size="md" onClick={exportPdf} disabled={pdfBusy}
          className="flex flex-col items-start gap-1 h-auto py-3 px-3 text-left"
        >
          <span className="flex items-center gap-1.5 text-12 font-semibold">
            {pdfBusy ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />}
            存为 PDF
          </span>
          <span className="text-10 text-ink-400 font-normal leading-relaxed">
            {DESKTOP
              ? '一键保存到本机，中文排版由系统打印引擎渲染。'
              : WEB
                ? '网页版无法直接存 PDF：将下载 HTML，打开后按 Ctrl+P 另存为 PDF。'
                : '当前不是桌面版：将改为下载 HTML，打开后按 Ctrl+P 另存。'}
          </span>
        </Button>

        <Button
          variant="secondary" size="md" onClick={exportHtml}
          className="flex flex-col items-start gap-1 h-auto py-3 px-3 text-left"
        >
          <span className="flex items-center gap-1.5 text-12 font-semibold">
            <FileText size={13} />
            单文件 HTML
          </span>
          <span className="text-10 text-ink-400 font-normal leading-relaxed">
            自包含，双击即可阅读与打印；也是 PDF 的排版真源。
          </span>
        </Button>

        <Button
          variant="secondary" size="md" onClick={exportJson}
          className="flex flex-col items-start gap-1 h-auto py-3 px-3 text-left"
        >
          <span className="flex items-center gap-1.5 text-12 font-semibold">
            <Braces size={13} />
            JSON 原件
          </span>
          <span className="text-10 text-ink-400 font-normal leading-relaxed">
            {isBook ? '原始时间戳与逐章统计，供机器核验，不经美化加工。' : '原始时间戳与各版全文，供机器核验，不经美化加工。'}
          </span>
        </Button>
      </div>

      {/* 如实交代数据来源与边界 —— 这份东西是拿给别人看的，口径必须经得起追问 */}
      <div className="mt-4 rounded-lg border border-ink-700 bg-ink-850/30 p-3 space-y-1.5">
        {view.lines().map((line, i) => (
          <p key={i} className="text-10 text-ink-400 leading-relaxed">· {line}</p>
        ))}
      </div>
    </Modal>
  )
}
