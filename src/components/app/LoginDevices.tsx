/**
 * 网页版 · 「登录设备」弹窗（3.3.2 · P1-7）。
 *
 * 【它解决什么】3.3.2 起一个账号可以在多台设备同时登录（旧版是「新登录顶掉旧设备」）。
 *   能多端就必然需要「我在哪几台机器上还挂着」的可见性和撤销能力 ——
 *   否则密码泄漏、旧电脑卖掉、共享电脑忘记退出，用户只能靠「重置密码把所有人踢下线」这一个粗暴手段。
 *
 * 🔴 只在网页云端版有意义：`WEB_CLOUD` 为 false（桌面 / 便携 / 游客）时直接不渲染入口，
 *    避免出现「点了报 404」的按钮（同类判断见 `AccountExit.tsx`）。
 * 🔴 撤销**不是删除云端数据**：只结束那条会话。文案必须把这一点说清，
 *    否则用户会以为「撤销 = 那台机器上的稿子没了」而不敢点。
 * 🔴 本设备那条不给「撤销」按钮：允许一键把自己踢下线只会制造「我点了怎么黑屏了」的困惑，
 *    要退出请用旁边的「退出登录」。
 */
import { useCallback, useEffect, useState } from 'react'
import { MonitorSmartphone, RefreshCw, Trash2, Smartphone, Laptop } from 'lucide-react'
import { WEB_CLOUD } from '@/lib/app/platform'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'

interface SessionRow {
  sid: string
  kind: 'web' | 'desktop' | 'portable' | string
  label: string
  createdAt: number
  lastSeenAt: number
  active: boolean
  revokedAt: number | null
  current: boolean
}

const KIND_ICON = {
  web: MonitorSmartphone,
  desktop: Laptop,
  portable: Smartphone,
} as const

const KIND_NAME: Record<string, string> = {
  web: '浏览器',
  desktop: '桌面版',
  portable: '便携版',
}

const fmtWhen = (ms: number): string => {
  if (!ms) return '未知'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ms).toLocaleDateString('zh-CN')
}

export default function LoginDevices() {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<SessionRow[] | null>(null)
  const [limits, setLimits] = useState<{ soft: number; hard: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetch('/api/auth/sessions', { cache: 'no-store' })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j?.ok) {
        setError(j?.error || `读取登录设备失败（HTTP ${r.status}）`)
        setRows([])
        return
      }
      setRows(j.sessions as SessionRow[])
      setLimits({ soft: j.softLimit, hard: j.hardLimit })
    } catch (e) {
      setError(e instanceof Error ? e.message : '网络异常，读取登录设备失败')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) void load() }, [open, load])

  if (!WEB_CLOUD) return null

  const activeCount = (rows ?? []).filter((r) => r.active).length

  const revoke = async (row: SessionRow) => {
    const ok = await confirmDialog({
      title: '撤销这台设备',
      message: `将结束「${row.label || KIND_NAME[row.kind] || '未知设备'}」的登录状态。\n\n`
        + '云端数据不会删除，只是这台设备需要重新登录才能继续使用。',
    })
    if (!ok) return
    try {
      const r = await fetch('/api/auth/sessions/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: row.sid }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j?.ok) {
        showToast(j?.error || `撤销失败（HTTP ${r.status}）`, 'error')
        return
      }
      showToast(j.changed ? '已撤销该设备' : '该设备已经不在线，无需撤销', 'success')
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : '撤销失败，请检查网络', 'error')
    }
  }

  const revokeOthers = async () => {
    const others = (rows ?? []).filter((r) => r.active && !r.current).length
    const ok = await confirmDialog({
      title: '退出其他所有设备',
      message: `将结束除本机之外 ${others} 台设备的登录状态。\n\n云端数据不会删除。`
        + '如果怀疑账号被盗，撤完后建议再改一次密码。',
    })
    if (!ok) return
    try {
      const r = await fetch('/api/auth/sessions/revoke-others', { method: 'POST' })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j?.ok) {
        showToast(j?.error || `操作失败（HTTP ${r.status}）`, 'error')
        return
      }
      showToast(j.revoked ? `已退出 ${j.revoked} 台设备` : '没有其他在线设备', 'success')
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败，请检查网络', 'error')
    }
  }

  return (
    <>
      <Button
        variant="icon-muted"
        iconOnly
        size="xs"
        onClick={() => setOpen(true)}
        title="登录设备（查看在哪几台设备上登录，可单独撤销）"
        className="shrink-0"
      >
        <MonitorSmartphone size={12} />
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="登录设备"
        icon={<MonitorSmartphone size={15} />}
        width="md"
        footer={(
          <div className="flex w-full items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              刷新
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void revokeOthers()}
                disabled={loading || !(rows ?? []).some((r) => r.active && !r.current)}
              >
                退出其他设备
              </Button>
              <Button variant="primary" size="sm" onClick={() => setOpen(false)}>关闭</Button>
            </div>
          </div>
        )}
      >
        <div className="space-y-3">
          <p className="text-12 leading-relaxed text-ink-400">
            同一个账号可以在多台设备上同时登录，这里列出它们。
            撤回一台<strong className="text-ink-300">不会删除云端数据</strong>，只是那台设备需要重新登录。
          </p>

          {error && (
            <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-12 text-red-300">
              {error}
            </p>
          )}

          {loading && !rows && <p className="text-12 text-ink-500">正在读取…</p>}

          {rows && rows.length === 0 && !error && (
            <p className="text-12 text-ink-500">还没有读取到设备信息。</p>
          )}

          {rows && rows.length > 0 && (
            <ul className="divide-y divide-ink-700 overflow-hidden rounded-lg border border-ink-700">
              {rows.map((row) => {
                const Icon = KIND_ICON[row.kind as keyof typeof KIND_ICON] ?? MonitorSmartphone
                const dead = !row.active
                return (
                  <li key={row.sid} className="flex items-center gap-2.5 px-3 py-2">
                    <Icon size={14} className={dead ? 'shrink-0 text-ink-600' : 'shrink-0 text-amber/80'} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`min-w-0 truncate text-12 ${dead ? 'text-ink-600' : 'text-ink-200'}`}>
                          {row.label || KIND_NAME[row.kind] || '未知设备'}
                        </span>
                        {row.current && (
                          <span className="shrink-0 rounded-full bg-amber/15 px-1.5 py-0.5 text-11 text-amber">本机</span>
                        )}
                        {dead && (
                          <span className="shrink-0 rounded-full bg-ink-700 px-1.5 py-0.5 text-11 text-ink-400">已失效</span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-11 text-ink-500">
                        {dead
                          ? `已于 ${fmtWhen(row.revokedAt ?? 0)} 失效`
                          : `最近活动 ${fmtWhen(row.lastSeenAt)} · 登录于 ${fmtWhen(row.createdAt)}`}
                      </div>
                    </div>
                    {!row.current && !dead && (
                      <Button
                        variant="icon-danger"
                        iconOnly
                        size="xs"
                        onClick={() => void revoke(row)}
                        title="撤销这台设备（不删除云端数据）"
                        className="shrink-0"
                      >
                        <Trash2 size={12} />
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {limits && (
            <p className="text-11 text-ink-500">
              当前在线 {activeCount} 台；上限 {limits.hard} 台（超过 {limits.soft} 台会提示整理）。
            </p>
          )}
        </div>
      </Modal>
    </>
  )
}
