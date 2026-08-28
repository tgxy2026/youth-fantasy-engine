import { useEffect, useState } from 'react'
import { Save, HardDriveUpload, FileInput, FolderSearch } from 'lucide-react'
import {
  getDesktopState, subscribeDesktop, flushDesktop,
  exportDesktopData, importDesktopData, revealDesktopDataFile,
} from '../lib/desktop'
import { confirmDialog, showToast } from './dialogs'

/**
 * 桌面（安装）版数据管理栏：
 * - 保存状态徽标（点击立即写盘）
 * - 导出数据文件（→ U 盘，便携版可直接打开）
 * - 导入数据文件（← 便携版 U 盘数据文件，替换本机数据）
 * - 打开数据文件夹（手动备份本地数据文件）
 *
 * 两种形态：
 * - embedded=false（默认）：固定浮层，用于「项目列表页」等没有侧栏的场景（左下角）。
 * - embedded=true：内嵌形态，去掉浮层阴影/毛玻璃，供 Sidebar 底部 Footer 直接承载，
 *   避免在桌面端用全局 fixed 浮层压住左侧栏的「界面缩放 / 主题」等控件。
 */
export function DesktopDataBar({ embedded = false }: { embedded?: boolean }) {
  const [state, setState] = useState(getDesktopState())
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  useEffect(() => subscribeDesktop(() => setState(getDesktopState())), [])

  const time = state.lastSavedAt
    ? new Date(state.lastSavedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '--:--:--'

  const text = state.lastError
    ? '保存出错'
    : state.saving
      ? '正在写入'
      : state.dirty
        ? '待保存'
        : '已保存'

  const dotColor = state.lastError
    ? 'bg-red-500'
    : (state.saving || state.dirty)
      ? 'bg-yellow-400'
      : 'bg-emerald-500'

  const doExport = async () => {
    setBusy('export')
    try {
      const path = await exportDesktopData()
      if (path) showToast(`已导出全部数据到：\n${path}\n\n在便携版启动页选「打开数据文件」选中它，即可在 U 盘上继续创作。`, 'success', 6000)
    } catch (e) {
      showToast('导出失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    if (!await confirmDialog({
      title: '导入数据文件',
      message: '导入将用所选数据文件的【全部内容】替换本机当前全部数据（含所有项目），确定继续？',
      confirmText: '继续导入', danger: true,
    })) return
    setBusy('import')
    try {
      const r = await importDesktopData()
      if (r.ok) {
        showToast('导入成功，即将重新加载应用。')
        location.reload()
      } else if (!r.cancelled) {
        showToast('导入失败：' + (r.error ?? '未知错误'), 'error')
      }
    } catch (e) {
      showToast('导入失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(null)
    }
  }

  const iconBtn =
    'flex items-center justify-center w-8 h-8 rounded-full border transition-colors hover:border-amber/50 hover:text-amber disabled:opacity-50 ' +
    (embedded
      ? 'border-ink-600/60 bg-ink-800/60 text-ink-300'
      : 'border-ink-600/80 bg-ink-900/90 text-ink-300 shadow-lg backdrop-blur')

  return (
    <div className={embedded ? 'flex items-center gap-2 pt-1' : 'fixed bottom-3 left-3 z-50 flex items-center gap-2'}>
      <button
        onClick={() => void flushDesktop()}
        title={
          state.lastError
            ? '保存出错，点击重试'
            : state.dataPath
              ? `数据文件：${state.dataPath}\n最后保存：${time}${state.dirty ? '（有未保存改动）' : ''}（点击立即保存）`
              : `最后保存：${time}（点击立即保存到本地数据文件）`
        }
        className={
          'flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] text-ink-300 transition-colors hover:border-amber/50 hover:text-ink-100 ' +
          (embedded
            ? 'border-ink-700 bg-ink-800/60'
            : 'border-ink-600/80 bg-ink-900/90 shadow-lg backdrop-blur')
        }
      >
        <Save size={12} className="text-amber/80" />
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
        <span className="whitespace-nowrap">{text}</span>
      </button>
      <button onClick={doExport} disabled={!!busy} title="导出数据文件：把本机全部数据存到 U 盘等位置，便携版可直接打开使用" className={iconBtn}>
        <HardDriveUpload size={14} className={busy === 'export' ? 'animate-pulse' : ''} />
      </button>
      <button onClick={doImport} disabled={!!busy} title="导入数据文件：选择便携版（U 盘）的数据文件，替换本机全部数据" className={iconBtn}>
        <FileInput size={14} className={busy === 'import' ? 'animate-pulse' : ''} />
      </button>
      <button onClick={() => void revealDesktopDataFile()} title="打开数据文件夹（手动备份本地数据文件）" className={iconBtn}>
        <FolderSearch size={14} />
      </button>
    </div>
  )
}

/** 项目列表页（无侧栏）使用的固定浮层版 */
export function DesktopBadge() {
  return <DesktopDataBar />
}
