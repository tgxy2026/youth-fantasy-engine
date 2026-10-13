import { useEffect, useState } from 'react'
import { Save, HardDriveUpload, FileInput, FolderOpen } from 'lucide-react'
import {
  getPortableState, subscribePortable, flushPortable,
  exportPortableData, importPortableData, pickLocalFile, portableDataDir, portableDataPath,
} from '@/lib/storage/fileBackend'
import { confirmDialog, copyText, showToast } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'

/**
 * 便携（U 盘）版数据管理栏 —— `DesktopDataBar` 的浏览器等价实现。
 *
 * 【与桌面版栏的差异（全部源于「没有主进程」）】
 *   · 保存状态徽标（点击立即写盘）—— **一致**。
 *   · 导出 = 浏览器下载一份 `.json`（桌面版是原生「另存为」对话框）。
 *   · 导入 = 浏览器 `<input type=file>` 选文件（桌面版是原生「打开」对话框）。
 *   · 数据目录 = **只显示、可复制路径**（浏览器打不开资源管理器）；
 *     且便携版数据固定在应用目录 `./data`，没有「更改位置」—— 改了就不叫便携版了。
 */
export function PortableDataBar() {
  const [state, setState] = useState(getPortableState())
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  useEffect(() => subscribePortable(() => setState(getPortableState())), [])

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
      const r = await exportPortableData()
      if (r.ok) {
        // 🔴 2026-10-13：导出的副本**不含** AI 密钥 / 检索密钥（与桌面版 exportDesktopData 同口径）
        const tip = r.strippedSecrets?.length
          ? `\n\n（为防密钥外泄，已剔除 ${r.strippedSecrets.length} 项本机密钥设置；换电脑后需重填一次模型配置）`
          : ''
        showToast(`已导出全部数据（浏览器下载）：\n${r.fileName ?? ''}\n\n这就是本机数据的完整副本：可以单独留档，换电脑时用「导入数据文件」还原。${tip}`, 'success', 6000)
      } else showToast(r.error || '导出失败', 'error')
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
      const t = await pickLocalFile()
      if (t === null) { setBusy(null); return } // 用户取消
      const r = await importPortableData(t)
      if (r.ok) {
        showToast('导入成功，即将重新加载应用。')
        location.reload()
      } else {
        showToast('导入失败：' + (r.error ?? '未知错误'), 'error')
      }
    } catch (e) {
      showToast('导入失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(null)
    }
  }

  const doCopyDir = async () => {
    const p = portableDataPath() || portableDataDir()
    if (!p) { showToast('暂时拿不到数据文件路径', 'error'); return }
    await copyText(p, '已复制数据文件路径：\n' + p + '\n\n在文件资源管理器地址栏粘贴即可打开所在文件夹。')
  }

  const iconBtn =
    'flex items-center justify-center w-8 h-8 rounded-full border border-ink-600/60 bg-ink-800/60 text-ink-300 ' +
    'transition-colors hover:border-amber/50 hover:text-amber disabled:opacity-50'

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      {/* 第一行：保存状态 + 导出 / 导入 */}
      <div className="flex items-center gap-1.5">
        <Button variant="bare"
          onClick={() => void flushPortable()}
          title={
            state.lastError
              ? '保存出错，点击重试'
              : state.dataPath
                ? `数据文件：${state.dataPath}\n最后保存：${time}${state.dirty ? '（有未保存的改动）' : ''}（点击立即保存）`
                : `最后保存：${time}（点击立即保存到数据文件）`
          }
          className="flex h-8 items-center gap-2 rounded-full border border-ink-700 bg-ink-800/60 px-3 text-12 text-ink-300 transition-colors hover:border-amber/50 hover:text-ink-100"
        >
          <Save size={12} className="text-amber/80" />
          <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
          <span className="whitespace-nowrap">{text}</span>
        </Button>
        <Button variant="bare" onClick={doExport} disabled={!!busy} title="导出数据文件：把全部数据导出为一个 JSON 文件（浏览器下载），用于留档或搬到别的电脑" className={iconBtn}>
          <HardDriveUpload size={14} className={busy === 'export' ? 'animate-pulse' : ''} />
        </Button>
        <Button variant="bare" onClick={doImport} disabled={!!busy} title="导入数据文件：选择之前导出的数据文件，替换本机全部数据" className={iconBtn}>
          <FileInput size={14} className={busy === 'import' ? 'animate-pulse' : ''} />
        </Button>
      </div>

      {/* 第二行：数据文件位置（点击复制路径）+ 打开所在文件夹的提示 */}
      <div className="flex items-center gap-1.5">
        <Button variant="bare"
          onClick={() => void doCopyDir()}
          title={state.dataPath ? `数据文件：${state.dataPath}\n点击复制路径（浏览器无法直接打开文件夹）` : '点击复制数据文件路径'}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border border-ink-700 bg-ink-800/60 px-2.5 text-11 text-ink-400 transition-colors hover:border-amber/50 hover:text-ink-200"
        >
          <FolderOpen size={11} className="shrink-0" />
          <span className="truncate">{portableDataDir() || './data'}</span>
        </Button>
      </div>
    </div>
  )
}
