import FeedbackButton from './FeedbackButton'
import WebTools from './WebTools'
import CloudFileSyncBar from './CloudFileSyncBar'
import { DesktopDataBar } from './Desktop'
import { PortableBadge } from './Portable'
import { WEB, DESKTOP, PORTABLE } from '../lib/env'
import { CLOUD_FILE_SYNC } from '../lib/desktopCloudSync'

/**
 * 左下角统一「数据坞」（#032）。
 *
 * 背景（为什么必须有这个组件）：此前左下角是三拨各自为政的 fixed 浮层——
 *   · DesktopBadge / PortableBadge：fixed bottom-3 left-3 z-50（本机保存、导出、导入）
 *   · WebTools：fixed bottom-4 left-4 z-40（云同步）
 * 定位差 1px、层级差 10、圆角与间距各不相同，桌面版直接**叠成一团互相遮挡**（z-50 压住 z-40，
 * 「保存 / 导出 / 导入」把整条同步 UI 盖掉）。
 *
 * 现在收编为一个等宽面板：统一位置、统一控件高度（h-8）、统一圆角与分隔线，按平台纵向堆叠：
 *   ① 本机存储（桌面：保存状态 + 导出/导入/打开目录；便携：U 盘保存状态）
 *   ② 云盘文件同步（桌面/便携，CLOUD_FILE_SYNC，无需服务器与同步码）
 *   ③ 网页版同步（WEB，服务器 / 云盘文件中转 + 同步码）
 *
 * 注意：项目内（有侧栏）不使用本浮层——桌面端全局 fixed 浮层会压住侧栏底部的
 * 「界面缩放 / 主题」等控件，因此项目内的本机存储行与云同步行改为内嵌进 Sidebar Footer。
 */
function Divider() {
  return <div className="my-2 h-px bg-ink-700/70" />
}

export default function DataDock() {
  const showLocal = DESKTOP || PORTABLE
  const showCloud = CLOUD_FILE_SYNC
  const showWeb = WEB

  // 三块都没有（如 dev 浏览器环境：DESKTOP 靠运行时探测 window.electronStore，
  // 普通浏览器里为 false，PORTABLE / WEB 也不成立）→ 不渲染，避免留下一个空面板边框。
  if (!showLocal && !showCloud && !showWeb) return null

  return (
    <div className="fixed bottom-4 left-4 z-40 flex w-[15rem] flex-col rounded-xl border border-ink-700/70 bg-ink-900/85 px-2.5 py-2 shadow-xl backdrop-blur">
      {showLocal && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs text-ink-300">
            <span className="font-medium">本机存储</span>
          </div>
          {DESKTOP && <DesktopDataBar embedded />}
          {PORTABLE && <PortableBadge embedded />}
        </div>
      )}

      {showLocal && showCloud && <Divider />}

      {showCloud && <CloudFileSyncBar variant="panel" />}

      {(showLocal || showCloud) && showWeb && <Divider />}

      {showWeb && (
        <div className="flex flex-col gap-1.5">
          {WEB && <FeedbackButton />}
          <WebTools />
        </div>
      )}
    </div>
  )
}
