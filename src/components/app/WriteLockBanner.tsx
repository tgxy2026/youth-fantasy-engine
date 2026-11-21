import { useState, type ReactNode } from 'react'
import { AlertTriangle, ClipboardCopy, Download, Loader2, RefreshCw, Unlock } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { confirmDialog, copyText, showToast } from '@/components/dialogs/dialogs'
import { Z } from '@/lib/app/zLayer'
import { writeLockUnlockPrompt } from '@/lib/app/lockBannerCopy'
import { collectDiagnosticsPack } from '@/lib/app/diagnostics'
import { diagnosticsFileName, renderDiagnosticsJson } from '@/lib/app/diagnosticsPack'
import { downloadBlob } from '@/lib/storage/zip'

/**
 * 「数据文件写盘已锁定」的常驻告警条 —— **桌面版与便携版的公共骨架**。
 *
 * 【什么时候出现】
 *   应用启动时**读不出**数据文件 —— 被云盘客户端/杀软短暂占用、权限不足、
 *   JSON 被同步过程截断，等等。这时内存里只有一份空库。
 *
 * 【为什么必须锁】
 *   一旦允许落盘，第一次写就会把磁盘上那份真实数据永久覆盖掉（不可逆）。
 *   所以引擎此时拒绝一切写操作 —— 数据这次用不了，但**还在**。
 *
 * 【为什么必须是常驻条而不是弹一次 toast】
 *   锁不解开，作者一个字都存不下来；而 toast 三秒后消失，
 *   作者只会觉得"软件坏了"，甚至反复重启 —— 每次都触发同样的锁定。
 *   所以这里给的是：说清楚 + 三条自救路径。
 *
 * 🔴 2026-10-13 六维审计（arch A2 判定重合度 39% → 抽公共骨架）：
 *   两端原先各写一份，**22 行逐字相同**（DOM 结构、类名、按钮排布、解锁确认的文案骨架）。
 *   差别只有四处，全部经 props 注入：
 *     · `subject`     标题前缀（桌面「数据文件」/ 便携「便携数据文件」）
 *     · `writeBackTo` 第三条提示的落点用词（桌面「磁盘」/ 便携「数据文件」）
 *     · `primary`     第一条自救路径（桌面＝打开资源管理器 / 便携＝复制路径）
 *     · `backupHint`  解锁确认里的备份指引（同上，两端能给的动作不同）
 *   两端各自只留「订阅哪份状态 + 传哪几个 props」。
 *
 * ⚠️ 别为了"更通用"把 `subject` 这类文案也做成拼装 —— 它们是**用户可见的成品句子**，
 *    拼装会让校对文案时读不出全句（本项目对文案的验收口径是"整句可读"）。
 */
interface WriteLockBannerProps {
  /** 标题前缀，成品词（桌面「数据文件」/ 便携「便携数据文件」） */
  subject: string
  /** 锁的原因（来自各平台状态源的 `writeLockReason`） */
  reason: string
  /** 第三条提示里「不会写回 XX」的落点用词 */
  writeBackTo: string
  /** 第一条自救路径（打开数据文件夹 / 复制数据文件路径） */
  primary: { label: string; icon: ReactNode; onClick: () => void }
  /** 解锁确认框里的备份指引整句 */
  backupHint: string
  /** 作者确认后真正解锁 */
  onUnlock: () => void
  /**
   * 「复制诊断信息」的落点（3.6.1）：拼出「版本 + 平台 + 数据路径 + 锁定原因」的成品文本。
   * 🔴 不含正文内容 —— 用户愿意发就能直接发，省掉"你是什么版本、文件在哪"的来回。
   */
  diagnosticsText: () => string
}

export function WriteLockBanner({
  subject, reason, writeBackTo, primary, backupHint, onUnlock, diagnosticsText,
}: WriteLockBannerProps) {
  const askUnlock = async () => {
    const ok = await confirmDialog(writeLockUnlockPrompt(backupHint))
    if (ok) onUnlock()
  }

  /**
   * 保存诊断包（3.6.2）：与关于页**同一份采集器**，只是这里不跳转页面也能导出。
   * 🔴 写锁中体检会明确标 `health.ok=false`（内存是空库，扫它得出的"没问题"是假象）。
   */
  const [savingPack, setSavingPack] = useState(false)
  const savePack = async () => {
    setSavingPack(true)
    try {
      const pack = await collectDiagnosticsPack()
      const name = diagnosticsFileName(pack)
      downloadBlob(name, new Blob([renderDiagnosticsJson(pack)], { type: 'application/json' }))
      showToast(`已保存 ${name}，可当附件发给作者`, 'success')
    } catch {
      showToast('保存诊断包失败，请改用「复制诊断信息」', 'error')
    } finally {
      setSavingPack(false)
    }
  }

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 flex items-start gap-3 border-b-2 border-danger/70 bg-red-700/97 px-4 py-2.5 text-white shadow-lg backdrop-blur-xs"
      style={{ zIndex: Z.banner }}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 text-12 leading-snug">
        <div className="font-semibold">
          {subject}读取失败，已暂停保存 —— 你原来的数据文件没有被改动
        </div>
        <div className="mt-0.5 text-white/85">{reason}</div>
        <div className="mt-0.5 text-white/70">
          解除之前，本次所有编辑都不会写回{writeBackTo}。请先备份数据文件，再选择下面的操作。
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
        <Button variant="secondary" size="xs" onClick={primary.onClick}>
          {primary.icon}
          {primary.label}
        </Button>
        <Button variant="secondary" size="xs"
          title="复制版本、平台、数据文件路径与锁定原因（不含正文），直接发给作者即可"
          onClick={() => { void copyText(diagnosticsText(), '诊断信息已复制，可直接粘贴发给作者（不含正文内容）') }}>
          <ClipboardCopy className="h-3.5 w-3.5" />
          复制诊断信息
        </Button>
        <Button variant="secondary" size="xs" disabled={savingPack}
          title="保存结构化诊断包（.json，含版本、形态、体检结果，不含正文与路径），可当附件发给作者"
          onClick={() => void savePack()}>
          {savingPack ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {savingPack ? '导出中…' : '保存诊断包'}
        </Button>
        <Button variant="secondary" size="xs" onClick={() => location.reload()}>
          <RefreshCw className="h-3.5 w-3.5" />
          重试读取
        </Button>
        {/* 3.6.1：旧按钮名容易被读成"继续用"（只是继续当前的会话）；现在把后果直接写进名字 */}
        <Button variant="danger" size="xs" onClick={() => void askUnlock()}
          title="会用当前的空库覆盖数据文件，原文件无法恢复（点击后会再确认一次）">
          <Unlock className="h-3.5 w-3.5" />
          放弃原文件继续
        </Button>
      </div>
    </div>
  )
}
