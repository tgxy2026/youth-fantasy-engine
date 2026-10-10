/**
 * 《AI 使用情况申报说明》弹窗（2.4.1 · B3）
 *
 * 🔴 **立场（产品红线）**：这是**如实申报**的辅助工具 —— 只把软件**自动记录**的操作日志
 *    汇总成一份说明，供作者在平台申报时如实填写 / 留档。
 *    它**不做**任何"怎么讲更容易过审"的话术加工，也**不提供**规避检测的建议。
 *    文案里连"命中率""规避"这类词都不出现（`tests/aiAssist.test.ts` 有断言盯着）。
 *
 * 【数据来源】章节的 `aiAssist` 字段（由 `lib/aiAssist.ts` 的 `withAiAssist()` 在 AI 产出时记账）。
 * 数字来自真实记录，**不靠手填** —— 这正是它可核验的前提。
 */
import { useMemo, useState } from 'react'
import { Copy, Download, Check } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { showToast, copyText } from '@/components/dialogs'
import { downloadText } from '@/lib/zip'
import {
  buildAiDisclosureDraft, AI_SOURCE_LABELS, AI_SOURCE_KINDS,
  type AiAssistSummary,
} from '@/lib/aiAssist'

export default function AiDisclosureDialog({
  open, onClose, summary, bookName,
}: {
  open: boolean
  onClose: () => void
  summary: AiAssistSummary
  bookName: string
}) {
  const [copied, setCopied] = useState(false)

  // 每次打开重算一次（时间戳跟着当前时刻走）
  const draft = useMemo(
    () => buildAiDisclosureDraft(summary, { bookName, generatedAt: Date.now() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary, bookName, open],
  )

  const used = AI_SOURCE_KINDS.filter(k => summary.chars[k] > 0)

  const copy = async () => {
    // 🔴 走统一入口（2026-09-22 六维审计 P2）：原先裸调 `navigator.clipboard`，
    //    非安全上下文（file:// 便携版）下它直接不可用 ⇒ 「复制申报说明」失败，
    //    而该功能的定位正是「可直接粘贴到平台申报入口」，失败等于整块作废。
    //    copyText 内部有 execCommand 兜底 + 统一 toast，失败也不静默。
    await copyText(draft, '申报说明已复制到剪贴板')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const saveTxt = () => {
    try {
      downloadText(`AI使用情况说明-${(bookName || '本书').trim()}.txt`, draft)
    } catch {
      showToast('导出失败', 'error')
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI 使用情况申报说明"
      width="lg"
      subheader={
        <span className="text-11 text-ink-400">
          依据软件自动记录生成，可直接粘贴到平台的申报入口；数字非手填
        </span>
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
          <Button variant="secondary" size="sm" onClick={saveTxt}><Download size={12} /> 存为 TXT</Button>
          <Button variant="primary" size="sm" onClick={copy}>
            {copied ? <><Check size={12} /> 已复制</> : <><Copy size={12} /> 复制全文</>}
          </Button>
        </div>
      }
    >
      {/* 概览：与轨迹页一致的口径，避免两处数字看起来"打架" */}
      <div className="mb-3 grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-ink-700 bg-ink-850/40 px-3 py-2">
          <div className="text-10 text-ink-500">全书正文</div>
          <div className="mt-0.5 text-14 font-bold text-ink-100 tabular-nums">
            {summary.totalChars.toLocaleString('zh-CN')} <span className="text-10 font-normal text-ink-500">字</span>
          </div>
        </div>
        <div className="rounded-lg border border-ink-700 bg-ink-850/40 px-3 py-2">
          <div className="text-10 text-ink-500">AI 辅助产出</div>
          <div className="mt-0.5 text-14 font-bold text-ink-100 tabular-nums">
            {summary.aiChars.toLocaleString('zh-CN')} <span className="text-10 font-normal text-ink-500">字</span>
          </div>
        </div>
        <div className="rounded-lg border border-ink-700 bg-ink-850/40 px-3 py-2">
          <div className="text-10 text-ink-500">占当前正文</div>
          <div className="mt-0.5 text-14 font-bold text-amber tabular-nums">{summary.ratioPct}%</div>
        </div>
      </div>

      {/* 分类明细（有哪类才列哪类） */}
      {used.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {used.map(k => (
            <span key={k} className="rounded-md border border-ink-700 bg-ink-850/40 px-2 py-1 text-11 text-ink-300">
              {AI_SOURCE_LABELS[k]} · {summary.chars[k].toLocaleString('zh-CN')} 字 · {summary.times[k]} 次
            </span>
          ))}
        </div>
      )}

      {/* 🔴 口径提示：把"可能偏高"这件事写在最显眼处，而不是藏起来 */}
      {summary.cappedChapters > 0 && (
        <div className="mb-3 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-11 leading-relaxed text-amber">
          有 {summary.cappedChapters} 章出现「AI 累计产出多于现存正文」—— 说明你对 AI 产出做过大幅删改，
          这些章的实际留存比例低于上表数字。说明正文里已如实注明这一点。
        </div>
      )}

      <div className="rounded-lg border border-ink-700 bg-ink-950/60 p-3">
        <pre className="whitespace-pre-wrap break-words font-sans text-12 leading-relaxed text-ink-200">{draft}</pre>
      </div>
    </Modal>
  )
}
