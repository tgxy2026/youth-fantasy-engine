// ============ 3.3.2 · 老板键（渲染层平台判定与主进程桥）============
//
// 【它负责什么】
//   · 桌面：把用户选的组合键交给主进程申请，并订阅"已隐藏 / 已恢复"事件；
//   · 便携 / 网页：没有系统级热键能力，只能用**页面内**快捷键弹一块遮挡屏（焦点在页面里才生效）。
//
// 🔴 **禁止假装能隐藏浏览器**：普通网页既藏不了标签页，也藏不了任务栏按钮。
//    非桌面形态的文案必须写"当前页面遮挡"，不能写成"窗口已隐藏"（规划 §15.1）。
//
// 🔴 能力判定只看 `window.electronBoss` 存不存在，不看平台常量：
//    真正决定能不能隐藏窗口的是 preload 有没有暴露这组 IPC，而不是"是不是桌面版"这个标签。
//
// 组合键的纯逻辑（规范化 / 匹配 / 显示）在 `bossAccel.ts`（叶子模块，可脱离平台穷举测）。
import { DESKTOP } from '@/lib/app/desktop'
import { PORTABLE } from '@/lib/storage/fileBackend'
import { WEB } from '@/lib/app/platform'
import { accelDisplay } from '@/lib/app/bossAccel'

export {
  BOSS_COVER_EVENT, BOSS_DEFAULT_ACCEL, BOSS_PREF_CHANGED_EVENT, BOSS_PRESETS,
  accelDisplay, matchesAccel, normalizeAccel,
} from '@/lib/app/bossAccel'
export type { BossPreset, KeyLike } from '@/lib/app/bossAccel'

export interface BossKeyState {
  accel: string | null
  display: string
  hidden: boolean
}

export interface BossApplyResult {
  ok: boolean
  accel?: string | null
  display?: string
  error?: string
}

interface ElectronBossAPI {
  apply(accel: string | null): Promise<BossApplyResult>
  status(): Promise<BossKeyState>
  toggle(): Promise<{ ok: boolean; hidden?: boolean; error?: string }>
  onChanged(cb: (s: { hidden: boolean; saving?: boolean }) => void): () => void
}

declare global {
  interface Window {
    electronBoss?: ElectronBossAPI
  }
}

/** 能不能做"窗口级"老板键 */
export function hasDesktopBossKey(): boolean {
  return typeof window !== 'undefined' && !!window.electronBoss
}

/** 非桌面形态只能做页面内遮挡（便携 / 网页 / 浏览器） */
export function bossKeyMode(): 'desktop' | 'overlay' | 'unsupported' {
  if (hasDesktopBossKey()) return 'desktop'
  if (typeof window === 'undefined') return 'unsupported'
  // 桌面壳缺 electronBoss（旧版 preload）时不要退化成"遮挡" —— 用户会以为窗口藏了
  if (DESKTOP) return 'unsupported'
  if (PORTABLE || WEB) return 'overlay'
  return 'unsupported'
}

/** 「哪些形态能干什么」的界面文案（一处写清，别在三个组件里各解释一遍） */
export function bossKeyLimits(accel: string | null | undefined): string {
  const display = accelDisplay(accel)
  if (bossKeyMode() === 'desktop') {
    return `按 ${display} 会立即隐藏本应用窗口（含任务栏按钮），同时开始保存；再按同一组合恢复。`
      + '\n\n隐藏不是密码锁：任务管理器、系统历史与录屏仍可能看到。'
  }
  if (bossKeyMode() === 'overlay') {
    return `按 ${display} 会用一块遮挡屏盖住当前页面并开始保存。`
      + '\n\n浏览器标签名称、浏览器窗口与任务栏图标仍可能可见；页面没有焦点时快捷键不生效。'
  }
  return '当前形态不支持老板键。'
}

// ---------------- 主进程桥 ----------------

export async function applyBossKey(accel: string | null): Promise<BossApplyResult> {
  if (!hasDesktopBossKey()) return { ok: false, error: '当前形态没有桌面窗口隐藏能力' }
  try {
    return await window.electronBoss!.apply(accel)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '申请快捷键失败' }
  }
}

export async function bossKeyStatus(): Promise<BossKeyState | null> {
  if (!hasDesktopBossKey()) return null
  try {
    return await window.electronBoss!.status()
  } catch {
    return null
  }
}

export async function toggleBossKey(): Promise<{ ok: boolean; hidden?: boolean; error?: string }> {
  if (!hasDesktopBossKey()) return { ok: false, error: '当前形态没有桌面窗口隐藏能力' }
  try {
    return await window.electronBoss!.toggle()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '隐藏失败' }
  }
}

/** 订阅隐藏 / 恢复事件；返回退订函数（非桌面形态返回空操作） */
export function onBossKeyChanged(cb: (s: { hidden: boolean; saving?: boolean }) => void): () => void {
  if (!hasDesktopBossKey()) return () => {}
  try {
    return window.electronBoss!.onChanged(cb)
  } catch {
    return () => {}
  }
}