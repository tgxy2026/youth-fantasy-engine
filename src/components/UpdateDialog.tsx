import { useEffect, useRef, useState } from 'react'
import { foldVh } from '../lib/theme'
import { Download, Copy, ExternalLink, FolderOpen, Loader2, Power, RotateCw } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'
import { showToast, copyText } from './dialogs'
import {
  openExternalUrl,
  downloadInstallerPackage,
  cancelInstallerDownload,
  launchInstallerPackage,
  revealInstallerFile,
  quitAppForInstall,
  onUpdateDownloadProgress,
} from '../lib/desktop'
import { parseMarkdownBlocks } from '../lib/mdLite'
import { setSkippedVersion } from '../lib/versionCheck'
import { QUARK_CODE, QUARK_TOKEN, QUARK_URL } from '../lib/downloadLinks'
import type { LatestRelease } from '../lib/versionCheck'

/**
 * 「发现新版本」弹窗（2.6.3 起；2.9.0 把「开浏览器」升级成「应用内下载」）。
 *
 * 🔴 设计约束（2026-10-07 口径修订，主人拍板）：
 *   ① **只有作者点「下载安装包」才联网取包** —— 自动检查只查版本号，绝不顺带下载；
 *   ② **不静默下载、不静默安装** —— 下载有进度条、可随时取消；安装向导由作者自己点完；
 *   ③ 下载与安装都**不带任何用户数据**（主进程只发 GET，不附加项目名/机器信息/统计）；
 *   ④ 更新说明原样来自 Gitee Release body，经 mdLite 切块后用 **React 文本节点**渲染
 *      （外部输入，绝不用 innerHTML）。
 *
 * 下载落点 = 系统「下载」文件夹（目录由主进程钉死）；完整性按**文件大小**校验
 * （Gitee 的 assets 不提供 sha256 —— 界面文案如实写明，不假装有摘要校验）。
 */

/** 下载后的四种状态（外加一个「正在拉起安装器」的过渡态） */
type Phase =
  | { kind: 'idle' }
  | { kind: 'downloading'; received: number; total: number; percent: number }
  | { kind: 'launching' }
  | { kind: 'launched'; path: string; size: number }
  | { kind: 'error'; message: string }

const mb = (n: number) => (n / 1048576).toFixed(1) + ' MB'

/** 安装包文件名：优先用直链里的原名，取不到就按版本拼一个（主进程还会再清洗一遍） */
function installerFileName(latest: LatestRelease): string {
  const tail = (latest.downloadUrl || '').split('?')[0].split('/').pop() || ''
  const decoded = (() => {
    try {
      return decodeURIComponent(tail)
    } catch {
      return tail
    }
  })()
  if (/\.exe$/i.test(decoded)) return decoded
  return `青春幻想引擎-Setup-${latest.version}.exe`
}

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
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /** 组件卸载守卫：下载是分钟级长任务，回来时组件可能已经不在了（见项目「cancelled 守卫」纪律） */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  /** 换版本 / 重开弹窗时把状态清回初始（否则上一个版本的「已下载」会残留在新版本上） */
  useEffect(() => {
    setPhase({ kind: 'idle' })
  }, [latest?.version, open])

  const downloading = phase.kind === 'downloading'
  const safeSet = (p: Phase) => {
    if (alive.current) setPhase(p)
  }

  const startDownload = async () => {
    if (!latest?.downloadUrl) return
    safeSet({ kind: 'downloading', received: 0, total: 0, percent: 0 })
    // 进度订阅与下载同生命周期：先订、拿到结果后立刻退订，避免残留监听
    const off = onUpdateDownloadProgress((p) => safeSet({ kind: 'downloading', ...p }))
    try {
      const r = await downloadInstallerPackage(latest.downloadUrl, installerFileName(latest))
      if (!r.ok) {
        if (r.cancelled) {
          safeSet({ kind: 'idle' })
          showToast('已取消下载', 'info')
        } else {
          safeSet({ kind: 'error', message: r.error })
        }
        return
      }
      // 下好了 → 自动拉起安装向导（closeApp=false：不擅自退出，由作者决定何时关本程序）
      safeSet({ kind: 'launching' })
      const lr = await launchInstallerPackage(r.path, false)
      if (lr.ok) safeSet({ kind: 'launched', path: r.path, size: r.size })
      else safeSet({ kind: 'error', message: `${lr.error}（安装包已下到「下载」文件夹，可手动双击安装）` })
    } finally {
      off()
    }
  }

  const cancelDownload = async () => {
    const stopped = await cancelInstallerDownload()
    if (!stopped) showToast('下载已经结束了', 'info')
  }

  const reveal = async (path: string) => {
    const r = await revealInstallerFile(path)
    if (!r.ok) showToast(r.error, 'error')
  }

  const openUrl = async (url: string, fallbackName: string) => {
    setBusy(true)
    try {
      const r = await openExternalUrl(url)
      if (!r.ok) {
        // 没有主进程桥（浏览器 dev）→ 降级 window.open，别让按钮点了没反应
        window.open(url, '_blank', 'noopener,noreferrer')
        showToast(`${fallbackName}：已在浏览器打开（当前环境无桌面桥）`, 'info')
      }
    } finally {
      setBusy(false)
    }
  }

  const blocks = latest ? parseMarkdownBlocks(latest.body) : []

  /* ---------------- 底部按钮：随阶段变化 ---------------- */
  const footer = () => {
    if (downloading) {
      return (
        <div className="flex w-full items-center gap-2">
          <span className="text-11 text-ink-500">下载会在本程序内完成，不经过浏览器</span>
          <Button variant="secondary" disabled={busy} onClick={() => void cancelDownload()} className="ml-auto">
            取消下载
          </Button>
        </div>
      )
    }
    if (phase.kind === 'launching') {
      return <span className="text-11 text-ink-500">正在打开安装向导…</span>
    }
    if (phase.kind === 'launched') {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => void quitAppForInstall()} className="gap-1.5">
            <Power size={14} /> 关闭本程序
          </Button>
          <Button variant="secondary" onClick={() => void reveal(phase.path)} className="gap-1.5">
            <FolderOpen size={14} /> 打开所在文件夹
          </Button>
          <Button variant="secondary" className="ml-auto" onClick={onClose}>稍后提醒</Button>
        </div>
      )
    }
    if (phase.kind === 'error') {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void startDownload()} className="gap-1.5">
            <RotateCw size={14} /> 重试
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void openUrl(QUARK_URL, '夸克网盘')} className="gap-1.5">
            <ExternalLink size={14} /> 夸克网盘
          </Button>
          <Button variant="secondary" className="ml-auto" onClick={onClose}>稍后提醒</Button>
          <Button
            variant="bare"
            onClick={() => {
              if (latest) setSkippedVersion(latest.version)
              onClose()
            }}
            className="text-11 text-ink-500 hover:text-ink-300"
          >
            跳过此版本
          </Button>
        </div>
      )
    }
    // idle
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={busy || !latest?.downloadUrl}
          onClick={() => void startDownload()}
          className="gap-1.5"
          title={latest?.downloadUrl ? '下载到「下载」文件夹，完成后自动打开安装向导' : '本次没取到安装包直链，请用下方网盘'}
        >
          <Download size={14} /> 下载安装包
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
    )
  }

  return (
    <Modal
      open={open}
      onClose={downloading ? () => {} : onClose}
      title={`发现新版本 v${latest?.version ?? ''}`}
      width="md"
      footer={footer()}
    >
      <div className="space-y-3">
        {/* 状态说明行：每阶段说清「现在在做什么、包去哪儿了」 */}
        {phase.kind === 'downloading' ? (
          <div className="space-y-2">
            <p className="text-12 text-ink-300 leading-relaxed">
              正在下载安装包到你的「下载」文件夹
              {phase.total > 0 ? `（${mb(phase.received)} / ${mb(phase.total)}）` : `（已下载 ${mb(phase.received)}）`}，
              完成后会自动打开安装向导。
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-ink-800">
              <div
                className="h-full rounded-full bg-amber transition-all"
                style={{ width: phase.total > 0 ? `${phase.percent}%` : '100%' }}
              />
            </div>
            <p className="text-11 text-ink-500">可以随时取消；取消不会留下半截文件。</p>
          </div>
        ) : phase.kind === 'launching' ? (
          <p className="flex items-center gap-2 text-12 text-ink-300">
            <Loader2 size={14} className="animate-spin" /> 安装包已就绪，正在打开安装向导…
          </p>
        ) : phase.kind === 'launched' ? (
          <div className="space-y-1.5 rounded-lg border border-amber/40 bg-amber/10 p-3">
            <p className="text-12 text-ink-100">
              安装向导已打开（安装包已下到「下载」文件夹，{mb(phase.size)}）。
            </p>
            <p className="text-12 text-ink-300 leading-relaxed">
              若向导提示「应用正在运行、无法覆盖文件」，请先点上面「关闭本程序」再继续安装。
              安装完成后重新打开即可，你的作品与设置都在，不受影响。
            </p>
          </div>
        ) : phase.kind === 'error' ? (
          <div className="space-y-1.5 rounded-lg border border-danger/40 bg-danger/10 p-3">
            <p className="text-12 text-ink-100">下载失败：{phase.message}</p>
            <p className="text-11 text-ink-400">可以点「重试」，或直接从夸克网盘下载。</p>
          </div>
        ) : (
          <p className="text-12 text-ink-300 leading-relaxed">
            当前版本已落后，下面是 Gitee 上的更新说明。点「下载安装包」会下载到你的「下载」文件夹并打开安装向导 ——
            <span className="text-ink-400">本程序不会在你没点之前下载，也不会替你点安装。</span>
          </p>
        )}

        {/* 更新说明：Gitee 原文经 mdLite 切块 —— 🔴 纯文本渲染，外部输入不走 innerHTML */}
        <div
          className="overflow-y-auto rounded-lg border border-ink-700 bg-ink-900/50 p-3 space-y-1.5"
          style={{ maxHeight: foldVh(phase.kind === 'idle' ? '46vh' : '30vh') }}
        >
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

        {(phase.kind === 'idle' || phase.kind === 'error') && (
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-ink-700">
            <span className="text-11 text-ink-500">网盘提取码</span>
            <code className="rounded bg-ink-900/60 border border-ink-700 px-2 py-0.5 text-xs text-ink-100 tracking-wider">
              {QUARK_CODE}
            </code>
            <Button variant="bare" size="xs" onClick={() => copyText(QUARK_TOKEN, '已复制 APP 口令，打开夸克 APP 即可识别')} className="gap-1 text-11 text-ink-400 hover:text-amber">
              <Copy size={12} /> 复制 APP 口令
            </Button>
            <span className="text-10 text-ink-600">网盘由作者手动同步，可能稍慢于 Gitee；直链下载不带校验摘要，只比对文件大小。</span>
          </div>
        )}
      </div>
    </Modal>
  )
}
