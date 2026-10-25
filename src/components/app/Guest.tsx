import { useState } from 'react'
import { HardDriveUpload, FileInput, ShieldAlert } from 'lucide-react'
import { exportGuestData, importGuestData } from '@/lib/db/guestData'
import { pickLocalFile } from '@/lib/storage/fileBackend'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'

/**
 * 游客模式数据管理栏（网页版 · 未注册用户）。
 *
 * 【它要解决什么问题】游客的数据存在浏览器 IndexedDB 里 —— 换设备看不到、清缓存就没了、
 * 浏览器还可能因为「长时间未访问」自动清理站点数据。所以这一栏的核心不是"管理"，
 * 而是**让用户有办法把稿子带走**，并且明确告知风险。
 *
 * 【与便携版栏的差异】
 *   · 没有"保存状态"流转：IndexedDB 写入是即时的（业务层 await 后才返回），不像整库 JSON 有防抖落盘，
 *     所以恒显示「已存本机」，不假装有"正在写入"。
 *   · 没有"数据文件位置"：数据在浏览器的存储沙箱里，不是一个可指的路径。
 *   · 多一条**升级入口**：注册账号后可用云端保存（这正是转化路径）。
 */
/** 上次导出备份的时间戳（localStorage）。游客唯一的"保险"就是这份导出的 JSON */
const EXPORT_KEY = 'yfe-guest-last-export'
const REMIND_AFTER_DAYS = 7

function readLastExport(): number {
  try {
    return Number(localStorage.getItem(EXPORT_KEY) || 0) || 0
  } catch {
    return 0
  }
}

function markExported() {
  try {
    localStorage.setItem(EXPORT_KEY, String(Date.now()))
  } catch { /* 隐私模式下写不了，不影响导出本身 */ }
}

export function GuestDataBar() {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [lastExport, setLastExport] = useState<number>(readLastExport)

  // 从未导出过，或距上次导出超过 7 天 ⇒ 值得再提一次
  const daysSince = lastExport ? Math.floor((Date.now() - lastExport) / 86_400_000) : -1
  const needRemind = lastExport === 0 || daysSince >= REMIND_AFTER_DAYS

  const doExport = async () => {
    setBusy('export')
    try {
      const r = await exportGuestData()
      if (r.ok) {
        markExported()
        setLastExport(Date.now())
        const tip = r.strippedSecrets?.length
          ? `\n\n（为防密钥外泄，已剔除 ${r.strippedSecrets.length} 项本机密钥设置；换设备后需重填模型配置）`
          : ''
        showToast(
          `已导出本机全部数据（浏览器下载）：\n${r.fileName ?? ''}\n\n`
          + `这份 JSON 是你的完整副件：换设备、换浏览器时用「导入」还原；`
          + `注册云端账号后也可以导入进去继续写。`
          // 🔴 3.2.6：**如实说明范围**。语义向量与知识库在两个独立 IDB 里，按设计不进整库 JSON
          //    （见 lib/db/guestData.ts 顶部）—— 以前只说"全部数据"，作者换机后才发现语义检索是空的。
          //    这是"少说了"而不是"多做了"，属于必须改的准确性提示。
          + `\n\n（语义检索索引与知识库不在这份文件里，换设备后需要重新建档）${tip}`,
          'success', 8000,
        )
      } else showToast(r.error || '导出失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    if (!await confirmDialog({
      title: '导入数据文件',
      message: '导入将用所选文件的【全部内容】替换当前浏览器里的全部数据（含所有项目），且无法撤销。确定继续？',
      confirmText: '继续导入', danger: true,
    })) return
    setBusy('import')
    try {
      const t = await pickLocalFile()
      if (t === null) { setBusy(null); return }
      const r = await importGuestData(t)
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

  const iconBtn =
    'flex items-center justify-center w-8 h-8 rounded-full border border-ink-600/60 bg-ink-800/60 text-ink-300 ' +
    'transition-colors hover:border-amber/50 hover:text-amber disabled:opacity-50'

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      {/* 第一行：本机状态 + 导出 / 导入 */}
      <div className="flex items-center gap-1.5">
        <div
          className="flex h-8 items-center gap-2 rounded-full border border-ink-700 bg-ink-800/60 px-3 text-12 text-ink-300"
          title="游客模式：数据保存在当前浏览器（IndexedDB）。换设备或清除浏览器数据后将无法找回，请定期导出备份。"
        >
          <ShieldAlert size={12} className="text-amber/80" />
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="whitespace-nowrap">已存本机</span>
        </div>
        <Button variant="bare" onClick={doExport} disabled={!!busy}
          title="导出全部数据：下载一个 JSON 文件，用于留档或换设备" className={iconBtn}>
          <HardDriveUpload size={14} className={busy === 'export' ? 'animate-pulse' : ''} />
        </Button>
        <Button variant="bare" onClick={doImport} disabled={!!busy}
          title="导入数据文件：选择之前导出的 JSON，替换当前浏览器里的全部数据" className={iconBtn}>
          <FileInput size={14} className={busy === 'import' ? 'animate-pulse' : ''} />
        </Button>
      </div>

      {/* 第二行：风险告知 + 升级入口（游客模式下最重要的一句话，别删） */}
      <div className="flex flex-col gap-1 px-1">
        <p className="text-11 leading-relaxed text-ink-500">
          数据仅在<strong className="text-ink-300">本机浏览器</strong>，清除缓存或换设备会丢失，请及时导出备份。
        </p>
        {/* 隔了一段时间没导出就再提醒一次：游客没有服务端副本，一份 JSON 是唯一的保险 */}
        {needRemind && (
          <p className="text-11 leading-relaxed text-amber/90">
            {lastExport === 0
              ? '还没有导出过备份 —— 建议现在导出一份存到别处。'
              : `已 ${daysSince} 天没有导出备份 —— 浏览器数据随时可能被系统清理。`}
          </p>
        )}
        <a href="/login"
          className="w-fit text-11 text-amber/90 underline-offset-2 transition-colors hover:text-amber hover:underline">
          注册账号 · 开启云端保存
        </a>
      </div>
    </div>
  )
}
