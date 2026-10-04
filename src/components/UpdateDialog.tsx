import { useState } from 'react'
import { foldVh } from '../lib/theme'
import { Download, Copy, ExternalLink } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'
import { showToast, copyText } from './dialogs'
import { openExternalUrl } from '../lib/desktop'
import { parseMarkdownBlocks } from '../lib/mdLite'
import { setSkippedVersion } from '../lib/versionCheck'
import { QUARK_CODE, QUARK_TOKEN, QUARK_URL } from '../lib/downloadLinks'
import type { LatestRelease } from '../lib/versionCheck'

/**
 * 「发现新版本」弹窗（2.6.3）。
 *
 * 🔴 三条设计约束：
 *   ① **只提示、不下载、不安装** —— 点下载是打开浏览器让人自己下，程序绝不后台拉包。
 *   ② 更新说明原样来自 Gitee Release body，经 mdLite 切成块后用 **React 文本节点**渲染
 *      （外部输入，绝不用 innerHTML）。
 *   ③ 作者可以「稍后提醒」或「跳过此版本」，不阻断任何操作。
 */
export default function UpdateDialog({
  open,
  latest,
  onClose,
}: {
  open: boolean
  latest: LatestRelease | null
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)

  const openUrl = async (url: string, fallbackName: string) => {
    setBusy(true)
    try {
      const r = await openExternalUrl(url)
      if (!r.ok) {
        // 没有主进程桥（浏览器 dev / 便携版）→ 降级 window.open，别让按钮点了没反应
        window.open(url, '_blank', 'noopener,noreferrer')
        showToast(`${fallbackName}：已在浏览器打开（当前环境无桌面桥）`, 'info')
      }
    } finally {
      setBusy(false)
    }
  }

  const blocks = latest ? parseMarkdownBlocks(latest.body) : []

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`发现新版本 v${latest?.version ?? ''}`}
      width="md"
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={busy || !latest?.downloadUrl}
            onClick={() => latest && void openUrl(latest.downloadUrl, 'Gitee 下载')}
            className="gap-1.5"
            title={latest?.downloadUrl ? '在系统浏览器里打开安装包直链' : '本次没取到安装包直链，请用下方网盘'}
          >
            <Download size={14} /> Gitee 下载
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void openUrl(QUARK_URL, '夸克网盘')} className="gap-1.5">
            <ExternalLink size={14} /> 夸克网盘
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" disabled={busy} onClick={onClose}>稍后提醒</Button>
            <Button
              variant="bare"
              disabled={busy}
              onClick={() => {
                if (latest) setSkippedVersion(latest.version)
                onClose()
              }}
              className="text-11 text-ink-500 hover:text-ink-300"
            >
              跳过此版本
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-12 text-ink-300 leading-relaxed">
          当前版本已落后，下面是 Gitee 上的更新说明。安装包需你手动下载安装 ——
          <span className="text-ink-400">本程序不会后台下载或自动安装</span>。
        </p>

        {/* 更新说明：Gitee 原文经 mdLite 切块 —— 🔴 纯文本渲染，外部输入不走 innerHTML */}
        <div className="overflow-y-auto rounded-lg border border-ink-700 bg-ink-900/50 p-3 space-y-1.5" style={{ maxHeight: foldVh('46vh') }}>
          {blocks.length === 0 ? (
            <p className="text-12 text-ink-500">（这个版本没有填写更新说明）</p>
          ) : (
            blocks.map((b, i) => {
              if (b.type === 'h2') return <div key={i} className="text-13 font-semibold text-ink-100 pt-1">{b.text}</div>
              if (b.type === 'h3') return <div key={i} className="text-12 font-semibold text-amber/90 pt-1">{b.text}</div>
              if (b.type === 'li') {
                return (
                  <div key={i} className="flex gap-1.5 text-12 text-ink-300" style={{ paddingLeft: b.level * 12 }}>
                    <span className="text-ink-500">·</span>
                    <span className="flex-1 leading-relaxed">{b.text}</span>
                  </div>
                )
              }
              if (b.type === 'quote') return <div key={i} className="text-11 text-ink-500 border-l-2 border-ink-700 pl-2">{b.text}</div>
              return <div key={i} className="text-12 text-ink-300 leading-relaxed">{b.text}</div>
            })
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-ink-800">
          <span className="text-11 text-ink-500">网盘提取码</span>
          <code className="rounded bg-ink-900/60 border border-ink-700 px-2 py-0.5 text-xs text-ink-100 tracking-wider">
            {QUARK_CODE}
          </code>
          <Button variant="bare" size="xs" onClick={() => copyText(QUARK_TOKEN, '已复制 APP 口令，打开夸克 APP 即可识别')} className="gap-1 text-11 text-ink-400 hover:text-amber">
            <Copy size={12} /> 复制 APP 口令
          </Button>
          <span className="text-10 text-ink-600">网盘由作者手动同步，可能稍慢于 Gitee。</span>
        </div>
      </div>
    </Modal>
  )
}
