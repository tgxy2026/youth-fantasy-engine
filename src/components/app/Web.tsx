import { useEffect, useState } from 'react'
import { HardDriveUpload, FileInput, Cloud } from 'lucide-react'
import {
  getPortableState, subscribePortable, flushPortable,
  exportPortableData, importPortableData, pickLocalFile,
} from '@/lib/storage/fileBackend'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'
import StorageWriteStatus from '@/components/common/StorageWriteStatus'
import AccountExit from '@/components/app/AccountExit'

/**
 * 网页版 · 云端账号数据条。
 *
 * 【为什么不能直接复用 `PortableDataBar`】网页版的云端模式**同时**具有 `PORTABLE` 标记
 * （服务端注入它是为了复用便携版那套 HTTP StoreOps），于是原实现会显示出
 * 「便携数据文件」「./data/youth-fantasy-engine-data.json」——一个在云端压根不存在的东西。
 * 作者会照着那句话去找文件、去拷贝，然后找不到，进而怀疑数据没存上。
 *
 * 【与便携版的真实差异】
 *   · 存储位置：服务器按账号隔离的目录（不是本地路径）⇒ 第二行改为「云端 · 已用 / 配额」。
 *   · 容量：有硬配额（默认 200 MB），写入超限会被服务端拒绝 ⇒ 用量必须看得见。
 *   · 键帽状态徽标与导出/导入行为**完全一致**（同一份 `portableStore`、同一份导出实现）。
 */
interface Usage {
  used: number
  quota: number
}

const fmtBytes = (b: number): string => {
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB'
  return b + ' B'
}

export function WebDataBar() {
  const [state, setState] = useState(getPortableState())
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [usage, setUsage] = useState<Usage | null>(() => {
    // 服务端注入的初值（index.html 里的 __YFE_USER__），先显示出来避免空窗。
    // 🔴 字段名是 `usedBytes` / `quotaBytes`（服务端 renderIndex 里注入的就是这两个），
    //    原先这里读的是 `used` / `quota` ⇒ 永远 undefined、首屏永远显示「云端空间」，
    //    得等 fetch('/api/auth/me') 回来才补上。2026-10-19 顺手修正。
    const boot = (window as unknown as {
      __YFE_USER__?: { usedBytes?: number; quotaBytes?: number }
    }).__YFE_USER__
    return boot ? { used: boot.usedBytes ?? 0, quota: boot.quotaBytes ?? 0 } : null
  })

  useEffect(() => subscribePortable(() => setState(getPortableState())), [])

  // 用量随保存更新：每次落盘成功后（lastSavedAt 变化）向服务端要一次真实值。
  // 🔴 不能自己按内存里的数据算 —— 外置大块（备份载荷 / 向量）也在配额里，前端算不出来。
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j?.ok || !j.user) return
        setUsage({ used: j.user.usedBytes ?? 0, quota: j.user.quotaBytes ?? 0 })
      })
      .catch(() => { /* 取不到就沿用旧值，不打扰作者 */ })
    return () => { cancelled = true }
  }, [state.lastSavedAt])

  const time = state.lastSavedAt
    ? new Date(state.lastSavedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '--:--:--'

  const doExport = async () => {
    setBusy('export')
    try {
      const r = await exportPortableData()
      if (r.ok) {
        const tip = r.strippedSecrets?.length
          ? `\n\n（为防密钥外泄，已剔除 ${r.strippedSecrets.length} 项本机密钥设置；换电脑后需重填一次模型配置）`
          : ''
        showToast(
          `已导出云端账号的全部数据（浏览器下载）：\n${r.fileName ?? ''}\n\n`
          + `可在桌面版「导入数据文件」里打开，也可以留档保存。${tip}`,
          'success', 7000,
        )
      } else showToast(r.error || '导出失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    if (!await confirmDialog({
      title: '导入数据文件',
      message: '导入将用所选文件的【全部内容】替换云端账号里的全部数据（含所有项目），确定继续？',
      confirmText: '继续导入', danger: true,
    })) return
    setBusy('import')
    try {
      const t = await pickLocalFile()
      if (t === null) { setBusy(null); return }
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

  const iconBtn =
    'flex items-center justify-center w-8 h-8 rounded-full border border-ink-600/60 bg-ink-800/60 text-ink-300 ' +
    'transition-colors hover:border-amber/50 hover:text-amber disabled:opacity-50'

  const quotaText = usage && usage.quota
    ? `已用 ${fmtBytes(usage.used)} / ${fmtBytes(usage.quota)}`
    : '云端空间'
  // 接近上限时提示变色（不报错也要让人提前知道快满了）
  const quotaWarn = !!usage && usage.quota > 0 && usage.used / usage.quota >= 0.9
  const name = (window as unknown as { __YFE_USER__?: { name?: string } }).__YFE_USER__?.name || ''

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      {state.saveConflict && <p role="alert" className="text-xs text-red-400">{state.lastError || '本窗口保存已停止。请先导出全部数据保留草稿，再重新打开并合并；请勿直接刷新。'}</p>}
      {/* 第一行：同步状态 + 导出 / 导入 */}
      <div className="flex items-center gap-1.5">
        <StorageWriteStatus facts={state}
          onSave={() => void flushPortable()}
          title={
            state.lastError
              ? '保存出错，点击重试'
              : `云端账号${name ? '：' + name : ''}\n最后保存：${time}${state.dirty ? '（有未保存的改动）' : ''}（点击立即保存）`
          }
        />
        <Button variant="bare" onClick={doExport} disabled={!!busy}
          title="导出全部数据：下载一个 JSON 文件（与桌面版格式一致，可直接导入桌面版）" className={iconBtn}>
          <HardDriveUpload size={14} className={busy === 'export' ? 'animate-pulse' : ''} />
        </Button>
        <Button variant="bare" onClick={doImport} disabled={!!busy}
          title="导入数据文件：选择之前导出的 JSON，替换云端账号的全部数据" className={iconBtn}>
          <FileInput size={14} className={busy === 'import' ? 'animate-pulse' : ''} />
        </Button>
      </div>

      {/* 第二行：云端账号 + 用量（取代便携版的「数据文件路径」） */}
      <div
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-ink-700 bg-ink-800/60 px-2.5 text-11"
        title={`当前登录：${name || '云端账号'}\n已用 ${usage ? fmtBytes(usage.used) : '—'}，配额 ${usage?.quota ? fmtBytes(usage.quota) : '—'}`}
      >
        <Cloud size={11} className="shrink-0 text-amber/70" />
        <span className="min-w-0 truncate text-ink-400">{name || '云端账号'}</span>
        <span className={`ml-auto min-w-0 truncate tabular-nums ${quotaWarn ? 'text-amber' : 'text-ink-500'}`}>
          {quotaText}
        </span>
        {/* 退出登录：并入这一行（原先在屏幕底部正中常驻，2026-10-19 按主人要求挪过来） */}
        <AccountExit />
      </div>
    </div>
  )
}
