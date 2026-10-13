import { useEffect, useState } from 'react'
import { Save, HardDriveUpload, FileInput, FolderSync, FolderOpen, Undo2 } from 'lucide-react'
import {
  getDesktopState, subscribeDesktop, flushDesktop,
  exportDesktopData, importDesktopData, revealDesktopDataFile,
  chooseDesktopDataDir, relocateDesktopDataFile, resetDesktopDataPath,
} from '@/lib/app/desktop'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { isDesktopCloudSyncActive } from '@/lib/db'
import { Button } from '@/components/common/Button'

/**
 * 桌面（安装）版数据管理栏（两行）：
 * - 第一行：保存状态徽标（点击立即写盘）+ 导出 / 导入数据文件
 * - 第二行：数据文件所在目录（点击打开文件夹）+ 更改位置 / 恢复默认
 *
 * 「更改位置」（#033）可把数据文件指到 WPS 云盘 / OneDrive 等同步目录，
 * 由云盘客户端搬运实现跨设备同步，软件内不必再单独配同步路径。
 * ⚠️ 只搬数据文件本身，绝不能把整个 userData 目录交给云盘 —— 里面混着
 * Chromium 的 Local Storage（leveldb 带独占锁）与十几 MB 缓存，跨设备覆盖会损坏。
 *
 * 🔴 只有**内嵌**一种形态（2026-10-02 六维审计待办）：原先还有一个 `embedded=false` 的
 *   「左下角独立 fixed 浮层」分支，但两个调用方（DataDock / Sidebar Footer）**都传 embedded**，
 *   该分支无任何调用方 —— 死代码，且与红线「左下角只准 DataDock 一个浮层」相冲。
 *   现已删除：组件恒以内嵌形态渲染，不再有 fixed 浮层，也不再需要 `embedded` 形参。
 */
export function DesktopDataBar() {
  const [state, setState] = useState(getDesktopState())
  const [busy, setBusy] = useState<'export' | 'import' | 'relocate' | 'reset' | null>(null)
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
      const r = await exportDesktopData()
      if (r.ok && r.path) {
        // 🔴 2026-10-13：导出的副本**不含** AI 密钥 / 检索密钥（换了文案如实告知）——
        //    它会被作者丢云盘 / 发给别人，原先整库原样倒出等于把 apiKey 一起送出去。
        const tip = r.strippedSecrets?.length
          ? `\n\n（为防密钥外泄，已剔除 ${r.strippedSecrets.length} 项本机密钥设置；换电脑后需重填一次模型配置）`
          : ''
        showToast(`已导出全部数据到：\n${r.path}\n\n这就是本机数据的完整副本：可以单独留档，换电脑时用「导入数据文件」还原。${tip}`, 'success', 6000)
      } else if (!r.cancelled) showToast(r.error || '导出失败', 'error')
    } catch (e) {
      showToast('导出失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    /**
     * 🔴 审计 2026-09-18（P1-6）：云盘文件同步开启时**拒绝导入**（理由见 db/core.ts 的
     *    isDesktopCloudSyncActive）。与其「导入成功却什么都没变」，不如明确拒绝
     *    并告诉他先关同步 —— 这才是他能照着做的下一步。
     */
    if (isDesktopCloudSyncActive()) {
      showToast('云盘文件同步正在开启，无法导入数据文件。\n请先在「云盘文件同步」栏点「关闭」切回本机存储，再执行导入。', 'error', 6000)
      return
    }
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

  /**
   * 更改数据文件位置（#033）。
   * 把数据文件指到 WPS 云盘 / OneDrive 等同步目录，由云盘客户端搬运实现跨设备同步。
   * 必须如实告知「云盘是文件级同步」这一本质限制 —— 冲突时是整库覆盖，不是丢几条。
   */
  const doRelocate = async () => {
    const target = await chooseDesktopDataDir()
    if (!target) return
    if (!await confirmDialog({
      title: '更改数据文件位置',
      message:
        `数据文件将迁移到：\n${target}\n\n` +
        '· 若该位置已有数据文件（例如另一台设备同步过来的），将改用那份数据；\n' +
        '· 本机当前的数据文件不会被删除，仍留在原处。\n\n' +
        '⚠️ 放进云盘同步目录可实现跨设备同步，但云盘是「文件级」同步：\n' +
        '· 不要在多台设备上同时打开本软件编辑，冲突会导致整库覆盖；\n' +
        '· 换设备前请先关闭软件，等云盘同步完成后再打开。\n\n' +
        '确定继续？切换后应用会重新加载。',
      confirmText: '迁移并重新加载',
    })) return
    setBusy('relocate')
    try {
      const r = await relocateDesktopDataFile(target)
      if (r.ok) {
        location.reload() // 重新加载让新路径生效（落地后即为新位置的数据）
      } else {
        showToast('迁移失败：' + (r.error ?? '未知错误'), 'error')
      }
    } catch (e) {
      showToast('迁移失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(null)
    }
  }

  /** 恢复默认存放位置（系统用户数据目录）。原位置的数据文件保留不动。 */
  const doResetPath = async () => {
    if (!await confirmDialog({
      title: '恢复默认存放位置',
      message:
        '数据文件将改回系统默认位置（用户数据目录）。\n\n' +
        '· 当前位置的数据文件不会被删除，可以手动取回；\n' +
        '· 若默认位置原本已有数据文件，将改用那份数据。\n\n' +
        '确定继续？切换后应用会重新加载。',
      confirmText: '恢复并重新加载',
      danger: true,
    })) return
    setBusy('reset')
    try {
      const r = await resetDesktopDataPath()
      if (r.ok) {
        location.reload()
      } else {
        showToast('恢复失败：' + (r.error ?? '未知错误'), 'error')
      }
    } catch (e) {
      showToast('恢复失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(null)
    }
  }

  /** 数据文件所在目录（去掉文件名，展示更清爽） */
  const dataDir = state.dataPath ? state.dataPath.replace(/[\\/][^\\/]*$/, '') : ''

  const iconBtn =
    'flex items-center justify-center w-8 h-8 rounded-full border border-ink-600/60 bg-ink-800/60 text-ink-300 ' +
    'transition-colors hover:border-amber/50 hover:text-amber disabled:opacity-50'

  const smallIconBtn =
    'flex items-center justify-center w-7 h-7 shrink-0 rounded-full border border-ink-600/60 bg-ink-800/60 text-ink-300 ' +
    'transition-colors hover:border-amber/50 hover:text-amber disabled:opacity-50'

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      {/* 第一行：保存状态 + 导出 / 导入 */}
      <div className="flex items-center gap-1.5">
        <Button variant="bare"
          onClick={() => void flushDesktop()}
          title={
            state.lastError
              ? '保存出错，点击重试'
              : state.dataPath
                ? `数据文件：${state.dataPath}\n最后保存：${time}${state.dirty ? '（有未保存的改动）' : ''}（点击立即保存）`
                : `最后保存：${time}（点击立即保存到本地数据文件）`
          }
          className="flex h-8 items-center gap-2 rounded-full border border-ink-700 bg-ink-800/60 px-3 text-12 text-ink-300 transition-colors hover:border-amber/50 hover:text-ink-100"
        >
          <Save size={12} className="text-amber/80" />
          <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
          <span className="whitespace-nowrap">{text}</span>
        </Button>
        <Button variant="bare" onClick={doExport} disabled={!!busy} title="导出数据文件：把本机全部数据导出一个 JSON 文件，用于留档或搬到别的电脑" className={iconBtn}>
          <HardDriveUpload size={14} className={busy === 'export' ? 'animate-pulse' : ''} />
        </Button>
        <Button variant="bare" onClick={doImport} disabled={!!busy} title="导入数据文件：选择之前导出的数据文件，替换本机全部数据" className={iconBtn}>
          <FileInput size={14} className={busy === 'import' ? 'animate-pulse' : ''} />
        </Button>
      </div>

      {/* 第二行：数据文件位置（点击打开所在文件夹）+ 更改位置 / 恢复默认。
          拆成两行是因为 15rem 宽的数据坞放不下第五个按钮，且路径本身也值得让用户看见。 */}
      <div className="flex items-center gap-1.5">
        <Button variant="bare"
          onClick={() => void revealDesktopDataFile()}
          title={state.dataPath
            // 🔴 2026-10-13：这条路径是「手动复制数据文件当备份」的入口 —— 该文件是**明文**整库
            //    （含 AI 密钥），必须就地提醒，否则用户拷走它等于把密钥一起备份出去。
            ? `数据文件：${state.dataPath}\n点击在资源管理器中打开该文件夹\n\n⚠️ 该文件是明文整库（含 AI 密钥等本机设置），请勿直接当备份外传。要留档请用「导出数据文件」——它会剔除密钥。`
            : '点击打开数据文件夹'}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border border-ink-700 bg-ink-800/60 px-2.5 text-11 text-ink-400 transition-colors hover:border-amber/50 hover:text-ink-200"
        >
          <FolderOpen size={11} className="shrink-0" />
          <span className="truncate">{dataDir || '默认位置'}</span>
        </Button>
        <Button variant="bare" onClick={doRelocate} disabled={!!busy} title="更改数据文件位置：可指到云盘同步目录实现跨设备同步" className={smallIconBtn}>
          <FolderSync size={13} className={busy === 'relocate' ? 'animate-pulse' : ''} />
        </Button>
        {state.isCustomPath && (
          <Button variant="bare" onClick={doResetPath} disabled={!!busy} title="恢复默认存放位置（系统用户数据目录）" className={smallIconBtn}>
            <Undo2 size={13} className={busy === 'reset' ? 'animate-pulse' : ''} />
          </Button>
        )}
      </div>
    </div>
  )
}
