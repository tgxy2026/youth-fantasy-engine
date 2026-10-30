// ============ 3.3.2 · 老板键（桌面主进程）============
//
// 【它是什么】一个**系统级**快捷键：按下立刻隐藏本应用窗口（Windows 上连同任务栏按钮一起消失），
// 同时通知渲染层启动保存；再按同一个键恢复并回到原来的工作现场。
//
// 🔴 三条硬约束（来自规划 §15）：
//   1. **不关程序、不退出账号、不销毁页面**：只 `hide()` / `show()`，进程、草稿、光标、选区都在。
//   2. **注册失败绝不假装成功**：组合被占用时返回失败，旧键保持可用；
//      没有可用快捷键时**拒绝隐藏**（否则窗口藏了却没有任何恢复入口）。
//   3. **退出必须释放注册**：`will-quit` 时 unregister，避免全局热键在程序退出后还占着。
//
// 🔴 隐藏不是密码锁：任务管理器、系统历史、录屏仍能看到。这条要在界面文案里说清。
//
// 🔴 快捷键格式统一在 `normalize()` 一处收敛：Electron 认 `Control+Shift+F9`，
//    用户设置里可能写成 `Ctrl+Shift+F9`。两处各写一份必然漂移。
const { globalShortcut } = require('electron')

/** 默认候选（规划 §15.2；备选也在预设里，最终由用户在设置中选择） */
const DEFAULT_ACCEL = 'Control+Shift+F9'

const MOD_ALIASES = {
  ctrl: 'Control', control: 'Control',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
  meta: 'Command', cmd: 'Command', command: 'Command', super: 'Command',
}
const KEY_RE = /^(F([1-9]|1[0-9]|2[0-4])|[A-Z]|[0-9])$/
/** 输出顺序固定：与渲染层 `bossAccel.ts` 同口径，同一组合只有一种写法 */
const MOD_ORDER = ['Control', 'Alt', 'Shift', 'Command']

/** 规范化组合键；不认识或缺少修饰键时返回 null（裸 F9 会与系统/其他程序抢键） */
function normalize(accel) {
  const parts = String(accel || '').split('+').map((s) => s.trim()).filter(Boolean)
  const mods = new Set()
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

/** 给界面显示的写法：`Control+Shift+F9` → `Ctrl + Shift + F9` */
function describe(accel) {
  const norm = normalize(accel)
  if (!norm) return ''
  return norm
    .replace('Control', 'Ctrl')
    .replace('Command', 'Cmd')
    .split('+')
    .join(' + ')
}

let current = null        // 已注册的组合键（null = 未启用）
let attachedWin = null

function send(win, state) {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('boss:changed', state)
  } catch { /* 页面还没加载完时忽略 */ }
}

/**
 * 隐藏 / 恢复。
 * 🔴 先通知渲染层开始保存、再隐藏 —— 顺序反了会晚一个事件循环，快速连按容易丢状态。
 *    保存是异步的：隐藏不等待它（规划 §15.3「立即隐藏、同时启动保存」）。
 */
function toggle(win) {
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口不可用' }
  if (win.isVisible()) {
    if (!current) return { ok: false, error: '没有可用的老板键，隐藏后无法恢复，已取消' }
    send(win, { hidden: true, saving: true })
    win.hide()
    return { ok: true, hidden: true }
  }
  win.show()
  win.focus()
  send(win, { hidden: false })
  return { ok: true, hidden: false }
}

/**
 * 应用（或解除）快捷键。
 * @param {import('electron').BrowserWindow} win
 * @param {string|null} accel 传 null / 空串表示禁用
 * @returns {{ok:true, accel:string|null, display:string}|{ok:false, error:string, accel:string|null}}
 */
function apply(win, accel) {
  if (win) attachedWin = win
  const target = win || attachedWin
  if (!target) return { ok: false, error: '窗口尚未就绪', accel: current }

  const next = accel ? normalize(accel) : null
  if (accel && !next) {
    return { ok: false, error: '组合键格式不支持（需要至少一个修饰键 + 一个主键，如 Ctrl+Shift+F9）', accel: current }
  }

  if (next === current) {
    return { ok: true, accel: current, display: describe(current) }
  }

  if (next) {
    // 🔴 先注册新键、成功后再释放旧键：反过来会出现"旧键已注销、新键被占用"的空档。
    const registered = globalShortcut.register(next, () => { toggle(target) })
    if (!registered) {
      return { ok: false, error: '这个组合已被系统或其他程序占用，请换一个', accel: current }
    }
    if (current) {
      try { globalShortcut.unregister(current) } catch { /* 已失效 */ }
    }
    current = next
    return { ok: true, accel: current, display: describe(current) }
  }

  // 禁用
  if (current) {
    try { globalShortcut.unregister(current) } catch { /* 已失效 */ }
  }
  current = null
  return { ok: true, accel: null, display: '' }
}

function status(win) {
  const w = win || attachedWin
  return {
    accel: current,
    display: describe(current),
    hidden: !!w && !w.isDestroyed() && !w.isVisible(),
  }
}

/** 手动触发一次（设置页的「试一下」用；与快捷键走同一条路径） */
function manualToggle(win) {
  return toggle(win || attachedWin)
}

/** 退出时释放全局热键 */
function dispose() {
  try { globalShortcut.unregisterAll() } catch { /* 已退出 */ }
  current = null
  attachedWin = null
}

module.exports = {
  DEFAULT_ACCEL,
  normalize,
  describe,
  apply,
  status,
  toggle: manualToggle,
  dispose,
}