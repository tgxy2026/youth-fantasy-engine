/**
 * 老板键设置（3.3.2 · 规划 §15）。
 *
 * 【它在哪】侧栏左下角设置区（与「界面缩放 / 数据文件 / 云盘同步」同一列）。
 * 【它管什么】启用 / 关闭、选组合键、看清"是否真的生效"，以及一句"试一下"。
 *
 * 🔴 **必须区分「已保存的偏好」与「实际生效的组合」**：
 *    桌面端的组合键由主进程申请，被别的程序占用时会失败。失败时偏好不写入，
 *    界面要明说"没生效"，否则用户会以为设置好了、按下去却没反应。
 * 🔴 便携 / 网页没有系统级热键能力，这里如实写成"页面遮挡"（规划 §15.1）。
 */
import { useCallback, useEffect, useState } from 'react'
import { EyeOff, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Modal } from '@/components/dialogs/Modal'
import { showToast } from '@/components/dialogs/dialogs'
import { readBoolPref, readStringPref, writeBoolPref, writeStringPref } from '@/lib/settings/uiPrefs'
import {
  BOSS_COVER_EVENT, BOSS_DEFAULT_ACCEL, BOSS_PREF_CHANGED_EVENT, BOSS_PRESETS,
  accelDisplay, applyBossKey, bossKeyLimits, bossKeyMode, bossKeyStatus, normalizeAccel, toggleBossKey,
} from '@/lib/app/bossKey'

export const BOSS_ENABLED_KEY = 'boss-key-enabled'
export const BOSS_ACCEL_KEY = 'boss-key-accel'

export default function BossKeySettings() {
  const mode = bossKeyMode()
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(() => readBoolPref(BOSS_ENABLED_KEY, true))
  const [accel, setAccel] = useState(() => normalizeAccel(readStringPref(BOSS_ACCEL_KEY)) || BOSS_DEFAULT_ACCEL)
  const [active, setActive] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const st = await bossKeyStatus()
    setActive(st?.accel ?? null)
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  const commit = async (nextEnabled: boolean, nextAccel: string) => {
    setBusy(true)
    setError('')
    try {
      if (mode === 'desktop') {
        const r = await applyBossKey(nextEnabled ? nextAccel : null)
        if (!r.ok) {
          setError(r.error || '申请快捷键失败')
          return
        }
      }
      writeBoolPref(BOSS_ENABLED_KEY, nextEnabled)
      writeStringPref(BOSS_ACCEL_KEY, nextAccel)
      setEnabled(nextEnabled)
      setAccel(nextAccel)
      window.dispatchEvent(new CustomEvent(BOSS_PREF_CHANGED_EVENT))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const tryNow = async () => {
    if (mode === 'desktop') {
      const r = await toggleBossKey()
      if (!r.ok) showToast(r.error || '隐藏失败', 'error')
      return
    }
    window.dispatchEvent(new CustomEvent(BOSS_COVER_EVENT))
  }

  if (mode === 'unsupported') {
    return (
      <Button variant="secondary" size="xs" className="w-full !justify-start gap-1.5" disabled
        title="当前形态没有窗口隐藏或页面遮挡能力">
        <EyeOff size={12} /> 老板键 <span className="ml-auto text-ink-600">不支持</span>
      </Button>
    )
  }

  const summary = !enabled
    ? '未启用'
    : (mode === 'desktop' ? (active ? accelDisplay(active) : '未生效') : accelDisplay(accel))

  return (
    <>
      <Button
        variant="secondary"
        size="xs"
        className="w-full !justify-start gap-1.5"
        onClick={() => setOpen(true)}
        title={mode === 'desktop' ? '老板键：一键隐藏本应用窗口' : '老板键：一键遮挡当前页面'}
      >
        <EyeOff size={12} /> 老板键 <span className="ml-auto truncate text-ink-500">{summary}</span>
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="老板键"
        icon={<ShieldAlert size={15} />}
        width="md"
        footer={(
          <div className="flex w-full items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void tryNow()}
              disabled={busy || !enabled || (mode === 'desktop' && !active)}
              title={mode === 'desktop' && !active ? '还没有注册成功的组合键 —— 隐藏后将无法用快捷键恢复' : '试一次隐藏 / 遮挡'}>
              现在试一次
            </Button>
            <div className="ml-auto">
              <Button variant="primary" size="sm" onClick={() => setOpen(false)}>知道了</Button>
            </div>
          </div>
        )}
      >
        <div className="space-y-3">
          <p className="whitespace-pre-line text-12 leading-relaxed text-ink-400">
            {bossKeyLimits(enabled ? accel : null)}
          </p>

          {error && (
            <p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-12 text-rose-200">
              {error}
            </p>
          )}

          <div className="flex items-center gap-2 rounded-lg border border-ink-700 px-3 py-2">
            <span className="min-w-0 flex-1 text-12 text-ink-300">
              启用老板键
            </span>
            <Button variant="secondary" size="xs" onClick={() => void commit(!enabled, accel)} disabled={busy}>
              {enabled ? '关闭' : '开启'}
            </Button>
          </div>

          <div className="rounded-lg border border-ink-700 px-3 py-2">
            <p className="text-11 text-ink-500">组合键</p>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {BOSS_PRESETS.map((p) => {
                const selected = normalizeAccel(accel) === p.accel
                return (
                  <Button
                    key={p.accel}
                    variant={selected ? 'primary' : 'secondary'}
                    size="xs"
                    className="!justify-start gap-2"
                    disabled={busy}
                    onClick={() => void commit(true, p.accel)}
                  >
                    <span className="tabular-nums">{p.label}</span>
                    <span className={`ml-auto text-11 ${selected ? 'text-ink-800/70' : 'text-ink-500'}`}>{p.note}</span>
                  </Button>
                )
              })}
            </div>
            <p className="mt-2 text-11 leading-relaxed text-ink-500">
              选择会立刻申请注册；若提示「被占用」，换一个即可 —— 失败时原来的组合仍然可用。
            </p>
          </div>

          {mode === 'desktop' && (
            <p className="text-11 leading-relaxed text-ink-500">
              当前注册：{active ? accelDisplay(active) : '无'}。
              {'\n'}退出软件时会释放这个组合键，不会一直占着。
            </p>
          )}
        </div>
      </Modal>
    </>
  )
}