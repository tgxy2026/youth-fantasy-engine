import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'
import { WEB } from '../lib/env'
import { isWebFileSyncOn } from '../lib/serverStore'
import { CONTACT_LINKS } from './AboutPage'

// 网页体验版本地数据提醒：每次打开网页（App 挂载）且未开启任何云端同步时弹出。
// #032：云端同步有两条路径——①服务器模式（凭同步邀请码）、②云盘文件模式（选目录即开，无需码）。
// 任一开启，数据即有云端兜底，不再每次打扰。按需求每次打开都弹，故不做 localStorage 「已读」抑制。
const SYNC_KEY = 'yfe-sync-code'

/**
 * 本组件本次启动是否会弹出（网页版且未开启任何云端同步时恒为 true）。
 * 供 BackupReminder 让位：本提醒每次打开都弹、且正文已含导出备份指引，
 * 两者同时弹出会叠成两层弹窗，用户得关两次。
 */
export function isLocalDataNoticeActive(): boolean {
  if (!WEB) return false
  try {
    return !(localStorage.getItem(SYNC_KEY) || isWebFileSyncOn())
  } catch {
    return true // 存储不可用时按未开启同步处理，照常提醒
  }
}

export default function LocalDataNotice() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (isLocalDataNoticeActive()) setShow(true)
  }, [])

  const close = () => setShow(false)

  // 前往「关于打赏」页（已打开项目时才有效；未打开项目时弹窗内的联系方式已足以引导）
  const goAbout = () => {
    try {
      window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: 'about' }))
    } catch {
      /* ignore */
    }
    close()
  }

  return (
    <Modal
      open={show}
      onClose={close}
      variant="plain"
      accent="amber"
      surface="900"
      width="lg"
      showCloseButton={false}
      titleSlot={
        <div className="flex items-center gap-2 text-amber">
          <AlertTriangle size={18} />
          <span className="font-semibold">数据仅保存在本地浏览器</span>
        </div>
      }
    >
      <div className="space-y-4 text-sm text-ink-300 leading-relaxed">
        <p>
          你当前<strong className="text-ink-100">未开启云端同步</strong>，所有创作数据（章节、世界观、人物卡、表格等）仅保存在你这台设备的浏览器里（IndexedDB），服务器不保留任何副本。
        </p>

        <div>
          <p className="text-ink-200 font-medium mb-2">以下情况会导致本地数据丢失：</p>
          <ul className="space-y-1.5 list-disc pl-5 text-ink-400">
            <li>在浏览器设置 / 开发者工具中清除站点数据（含 Cookie 与站点数据）</li>
            <li>使用<strong className="text-ink-200">无痕 / 隐私模式</strong>写作，关闭浏览器后数据被清除</li>
            <li>更换浏览器、设备或系统用户配置文件，原设备的数据无法带过去</li>
            <li>浏览器在磁盘空间紧张时，按"最近最少使用"自动回收不活跃站点的本地存储（概率低但存在）</li>
            <li>卸载或重置浏览器</li>
          </ul>
        </div>

        <p className="text-amber/90">
          ⚠️ 在进行上述操作前，请务必先在「项目管理」页点<strong className="text-amber">导出备份</strong>，把数据保存到本地文件，避免无法找回。
        </p>

        <div className="rounded-lg bg-ink-850 border border-ink-700 p-3">
          <p className="text-ink-200 font-medium mb-2">想要云端同步与自动备份？</p>
          <div className="mb-3 space-y-1.5 text-ink-400">
            <p>任选其一即可（左下角「云端同步」面板里切换）：</p>
            <p className="text-ink-300">
              <strong className="text-emerald-300">① 云盘文件方式 · 不用任何码</strong>
              ：选一个文件夹（建议放在 OneDrive / WPS 云盘 / 百度网盘 / 坚果云 等同步目录内），数据加密后存成「青春幻想引擎-同步数据.yfe」，由网盘客户端负责跨设备搬运。
            </p>
            <p className="text-ink-300">
              <strong className="text-amber">② 服务器方式 · 需要同步邀请码</strong>
              ：在「关于打赏」页的联系方式中加入交流群，或联系作者获取（YFE-SYNC- 开头）。开启后数据自动备份到云端，不再受本机风险影响。
            </p>
          </div>
          <ul className="space-y-1.5 text-ink-300">
            {CONTACT_LINKS.map(l => (
              <li key={l.label} className="flex gap-2">
                <span className="text-ink-500 shrink-0 w-32">{l.label}</span>
                <span className="text-ink-100">{l.value}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex gap-2 justify-end mt-5">
        <Button variant="ghost" onClick={goAbout}>
          前往关于打赏
        </Button>
        <Button variant="primary" onClick={close}>
          我已知晓
        </Button>
      </div>
    </Modal>
  )
}
