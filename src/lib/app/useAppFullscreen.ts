// ============ C2 · 全屏状态（桌面窗口桥 / 浏览器 Fullscreen API）============
//
// 规划 §4.1：桌面保留窗口桥，浏览器用运行时能力探测；状态由事件校准，不乐观显示「已全屏」。
// 本 hook 是**唯一**的全屏状态来源：外观开关、帮助手册的环境说明都读它，避免各写一版。
//
// 🔴 状态优先级：`HAS_WINDOW_BRIDGE`（桌面安装版）→ `browserFullscreenSupported()`（网页 / 便携）
//    → `none`（都不行，入口不显示，界面用「专注模式」兜底）。
// 🔴 只调**已有**判定：窗口桥来自 `desktop.ts`，浏览器能力来自 `browserFullscreen.ts`；
//    这里不新增平台判断表。
import { useCallback, useEffect, useState } from 'react'
import { HAS_WINDOW_BRIDGE, toggleFullscreen } from '@/lib/app/desktop'
import {
  browserFullscreenActive, browserFullscreenSupported, enterBrowserFullscreen,
  exitBrowserFullscreen, onBrowserFullscreenChange, type FullscreenOutcome,
} from '@/lib/app/browserFullscreen'

export type AppFullscreenMode = 'desktop' | 'browser' | 'none'

export interface AppFullscreenState {
  mode: AppFullscreenMode
  /** 当前形态有没有全屏入口（false ⇒ 界面不显示入口，改用专注模式） */
  supported: boolean
  active: boolean
  /** 最近一次失败：denied = 被拒/权限策略；unsupported = 没有 API。成功后清空 */
  error: '' | Exclude<FullscreenOutcome, 'ok'>
  toggle: () => Promise<void>
}

function currentMode(): AppFullscreenMode {
  if (HAS_WINDOW_BRIDGE) return 'desktop'
  return browserFullscreenSupported() ? 'browser' : 'none'
}

export function useAppFullscreen(): AppFullscreenState {
  const mode = currentMode()
  const [active, setActive] = useState(false)
  const [error, setError] = useState<'' | Exclude<FullscreenOutcome, 'ok'>>('')

  useEffect(() => {
    if (mode === 'desktop') {
      const w = typeof window === 'undefined' ? undefined : window.electronWindow
      if (!w) return
      let alive = true
      void w.isFullscreen().then(v => { if (alive) setActive(v) }).catch(() => {})
      const unsub = w.onFullscreenChange(v => setActive(v))
      return () => { alive = false; unsub?.() }
    }
    if (mode === 'browser') {
      setActive(browserFullscreenActive())
      // 用户按 Esc / 系统退出 / 别的脚本改 DOM，都走 fullscreenchange；
      // fullscreenerror 说明本次请求被拒，界面要如实说「没进成功」
      return onBrowserFullscreenChange(setActive, () => setError('denied'))
    }
    return
  }, [mode])

  const toggle = useCallback(async () => {
    setError('')
    if (mode === 'desktop') {
      await toggleFullscreen()
      return
    }
    if (mode === 'browser') {
      const outcome = browserFullscreenActive() ? await exitBrowserFullscreen() : await enterBrowserFullscreen()
      if (outcome !== 'ok') setError(outcome)
      // 事件通常已经来过；这里兜底一次，避免事件丢失时界面停在旧状态
      setActive(browserFullscreenActive())
      return
    }
    setError('unsupported')
  }, [mode])

  return { mode, supported: mode !== 'none', active, error, toggle }
}