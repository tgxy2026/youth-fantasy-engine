// ============ 3.3.2 · 老板键 · 组合键纯逻辑（叶子模块）============
//
// 【为什么单独一个文件】这些判断要在**不碰任何浏览器/Electron API**的前提下被穷举测试：
//   · 规范化（`Ctrl+Shift+F9` ↔ Electron 认的 `Control+Shift+F9`）
//   · 页内快捷键匹配（便携 / 网页的遮挡屏靠它）
//   · 界面显示写法
// 放在 `bossKey.ts` 里也能用，但那个模块要 import 平台判定（desktop / fileBackend），
// 单测会顺带拉起一大串存储模块 —— 叶子模块让"格式对不对"可以先证明。
//
// 🔴 这里与 `electron/bossKey.cjs` 的 `normalize()` 是**两份实现**（两种语言没法共享），
//    测试钉住输出格式；一旦漂移就会出现"设置里能选、按下去没反应"。
// 🔴 裸 F9 / 裸字母不合法：那会与系统或其他程序抢键，且用户几乎不可能是这个意图。

/** 默认候选（规划 §15.2）；备选同样列在预设里，由用户自己选 */
export const BOSS_DEFAULT_ACCEL = 'Control+Shift+F9'

/** 偏好变化 / 手动遮挡的窗口事件名（同窗口改 localStorage 不会触发 storage 事件） */
export const BOSS_PREF_CHANGED_EVENT = 'yfe:boss-pref-changed'
export const BOSS_COVER_EVENT = 'yfe:boss-cover'

export interface BossPreset {
  accel: string
  label: string
  note: string
}

export const BOSS_PRESETS: readonly BossPreset[] = [
  { accel: 'Control+Shift+F9', label: 'Ctrl + Shift + F9', note: '默认候选' },
  { accel: 'Control+Shift+F10', label: 'Ctrl + Shift + F10', note: '备选' },
  { accel: 'Control+Shift+F11', label: 'Ctrl + Shift + F11', note: '备选（部分笔记本需按 Fn）' },
]

const MOD_ALIASES: Record<string, string> = {
  ctrl: 'Control', control: 'Control',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
  meta: 'Command', cmd: 'Command', command: 'Command', super: 'Command',
}
const KEY_RE = /^(F([1-9]|1[0-9]|2[0-4])|[A-Z]|[0-9])$/
/** 输出顺序固定：同一组合只有一种写法（否则"注册过的"和"设置里的"会被当成两个键） */
const MOD_ORDER = ['Control', 'Alt', 'Shift', 'Command'] as const

/** 规范化组合键（`Ctrl+Shift+F9` → `Control+Shift+F9`）；不合法返回 null */
export function normalizeAccel(input: string | null | undefined): string | null {
  const parts = String(input || '').split('+').map((s) => s.trim()).filter(Boolean)
  const mods = new Set<string>()
  let key = ''
  for (const part of parts) {
    const mod = MOD_ALIASES[part.toLowerCase()]
    if (mod) { mods.add(mod); continue }
    const upper = part.toUpperCase()
    if (KEY_RE.test(upper)) { key = upper; continue }
    return null
  }
  if (!key || mods.size === 0) return null
  return `${MOD_ORDER.filter((m) => mods.has(m)).join('+')}+${key}`
}

/**
 * 把一次真实按键翻译成组合键（3.3.2 · 2026-10-31 主人要求"让用户自己定义"）。
 *
 * 返回 `null` 表示这次按键不能当老板键，调用方据此提示原因：
 *   · 只按了修饰键（Ctrl/Shift/Alt/Cmd）—— 还没按到主键；
 *   · 主键不在允许集合（只收 F1–F24 / A–Z / 0–9）—— 符号键在不同键盘布局下差异太大；
 *   · 只有 Shift —— Shift+F9 这类几乎没人用，还容易和输入法冲突。
 *
 * 🔴 **必须要求至少 Control / Alt / Command 之一**：裸键（或仅 Shift）会抢走别的程序的按键，
 *    而且 Electron 的全局热键注册对这类组合行为不稳定。
 */
export function accelFromKeyboard(e: {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  const raw = String(e.key || '')
  // 纯修饰键：继续等用户按主键
  if (/^(Control|Shift|Alt|AltGraph|Meta|CapsLock|Dead|Unidentified)$/i.test(raw)) return null
  const upper = raw.length === 1 ? raw.toUpperCase() : raw
  if (!KEY_RE.test(upper)) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Control')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Command')
  if (!parts.some((p) => p === 'Control' || p === 'Alt' || p === 'Command')) return null
  return normalizeAccel([...parts, upper].join('+'))
}

/** 给界面看的写法（`Control+Shift+F9` → `Ctrl + Shift + F9`） */
export function accelDisplay(accel: string | null | undefined): string {
  const norm = normalizeAccel(accel)
  if (!norm) return ''
  return norm.replace('Control', 'Ctrl').replace('Command', 'Cmd').split('+').join(' + ')
}

export interface KeyLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  isComposing?: boolean
}

/**
 * 页内快捷键匹配。
 * 🔴 输入法组合中（`isComposing`）一律不触发：中文输入法下 F 键/字母可能是候选键。
 */
export function matchesAccel(e: KeyLike, accel: string | null | undefined): boolean {
  if (!e || e.isComposing) return false
  const norm = normalizeAccel(accel)
  if (!norm) return false
  const parts = norm.split('+')
  const key = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  if (e.ctrlKey !== mods.has('Control') || e.shiftKey !== mods.has('Shift')) return false
  if (e.altKey !== mods.has('Alt') || e.metaKey !== mods.has('Command')) return false
  return String(e.key || '').toUpperCase() === key
}