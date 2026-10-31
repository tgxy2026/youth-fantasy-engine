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
import { useCallback, useEffect, useRef, useState } from 'react'
import { EyeOff, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Modal } from '@/components/dialogs/Modal'
import { showToast } from '@/components/dialogs/dialogs'
import { readBoolPref, readStringPref, writeBoolPref, writeStringPref } from '@/lib/settings/uiPrefs'
import {
  BOSS_COVER_EVENT, BOSS_DEFAULT_ACCEL, BOSS_PREF_CHANGED_EVENT, BOSS_PRESETS,
  accelDisplay, accelFromKeyboard, applyBossKey, bossKeyLimits, bossKeyMode, bossKeyStatus, normalizeAccel,
  toggleBossKey,
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
  /**
   * 正在录制自定义组合键（3.3.2 · 2026-10-31 主人要求"用户自己定义用哪个键"）。
   * 录制时整个窗口的按键都被截住，所以必须有明确的取消方式（Esc / 再点一次）。
   */
  const [recording, setRecording] = useState(false)
  const [recordHint, setRecordHint] = useState('')
  /**
   * 录制回调里要用"最新的 commit"，但不能把 commit 放进依赖数组（它每次 render 都是新函数，
   * 会不停重绑 keydown）。用 ref 转一手：监听只绑一次，永远调到最新那个。
   */
  const commitRef = useRef<(nextEnabled: boolean, nextAccel: string) => Promise<void>>(async () => {})

  const refresh = useCallback(async () => {
    const st = await bossKeyStatus()
    setActive(st?.accel ?? null)
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  // 面板关了要停止录制，否则按键会被一直截住（用户会以为键盘坏了）
  useEffect(() => {
    if (!open) { setRecording(false); setRecordHint('') }
  }, [open])

  /**
   * 录制自定义组合键。
   * 🔴 用捕获阶段 + preventDefault + stopPropagation：录制时不能让按键漏到编辑器里
   *    （否则用户按 Ctrl+A 会顺手把正文全选）。
   * 🔴 判据全部交给 `accelFromKeyboard`（纯函数、已被单测穷举），这里只管提示。
   */
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        setRecordHint('')
        return
      }
      const accelText = accelFromKeyboard(e)
      if (!accelText) {
        setRecordHint('要按住 Ctrl / Alt（可再加 Shift），再按一个字母、数字或 F1–F24')
        return
      }
      setRecording(false)
      setRecordHint('')
      void commitRef.current(true, accelText)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

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

  useEffect(() => { commitRef.current = commit })

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

  /** 当前组合不在三条预设里 ⇒ 视为"自定义"，单独显示一行，避免用户以为设置丢了 */
  const customAccel = BOSS_PRESETS.some((p) => p.accel === normalizeAccel(accel)) ? '' : normalizeAccel(accel) || ''

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
            {/**
              * 自定义组合键（3.3.2 · 2026-10-31 主人要求）。
              * 三条预设不够用：不同键盘（F 区被 Fn 占用）、不同习惯都得能自己定。
              */}
            <div className="mt-2 rounded-md border border-ink-700/70 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-11 text-ink-400">
                  自定义
                  {customAccel && (
                    <span className="ml-1.5 text-12 text-amber-200">{accelDisplay(customAccel)}</span>
                  )}
                </span>
                <Button
                  variant={recording ? 'primary' : 'secondary'}
                  size="xs"
                  disabled={busy}
                  onClick={() => { setRecordHint(''); setRecording((v) => !v) }}
                  title="按下你想用的组合键，会自动申请注册"
                >
                  {recording ? '按下组合键…（Esc 取消）' : (customAccel ? '重录' : '自己按一个')}
                </Button>
              </div>
              {recordHint && (
                <p className="mt-1 text-11 leading-relaxed text-amber-300/90">{recordHint}</p>
              )}
              {!recording && !recordHint && (
                <p className="mt-1 text-11 leading-relaxed text-ink-600">
                  必须带 Ctrl 或 Alt（可再加 Shift），主键用字母 / 数字 / F1–F24。
                </p>
              )}
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