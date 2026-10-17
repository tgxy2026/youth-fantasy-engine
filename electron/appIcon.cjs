// ============ 应用图标（桌面快捷方式）切换内核 · 3.1.2 ============
//
// 【它做什么】把**内置的三套图标**（默认 / 幻想 / 典雅）应用到桌面与开始菜单的快捷方式上。
//
// 【为什么需要主进程】渲染进程拿不到壳层（shell）能力，也读不了 asar 外的真实路径。
//
// 【四个必须守住的点】
//  ① 🔴 **图标必须是真实文件路径**：`.lnk` 的 IconLocation 由 Windows 资源管理器自己读，
//     读不了 asar 内路径 ⇒ 内置 .ico 必须先**解包到 userData**（`app.getPath('userData')/app-icons/`），
//     再让快捷方式指向它。这也是「预置图标不额外增加打包配置」的做法（图标随 `electron/**` 进包即可）。
//  ② 🔴 **每次切换写新文件名**（`<key>-<时间戳>.ico`）：复用同一路径时资源管理器**常常不刷新**，
//     用户会以为「点了没反应」。换路径会让壳层立刻重载图标。
//  ③ 🔴 **必须能自愈**：应用内更新是「下载 Setup → 拉起安装器」，NSIS 会**重建快捷方式**
//     （electron-builder.yml 里 `createDesktopShortcut: always`）⇒ 用户选的图标被打回默认。
//     故启动时比对 `.lnk` 当前图标是否仍指向本机的预设文件，不是就重写一次。
//  ④ 🔴 **只动快捷方式，不动主 exe**：exe 自身的图标是 PE 资源，改它要重写二进制、会破坏
//     主 exe 体积基线（246,487,040）与一致性校验 ⇒ 本功能**明确不碰**，界面上如实说明。
//
// 【覆盖范围】桌面 + 开始菜单两条快捷方式（同一份逻辑）。便携版没有安装过程，
//   自然也没有这两条快捷方式 ⇒ `supported()` 为假的形态下界面隐藏入口。
const path = require('path')
const fs = require('fs')

/** 内置预设（key 即文件名；label 仅供主进程自检/日志，界面文案在渲染层） */
const PRESETS = [
  { key: 'default', label: '默认' },
  { key: 'fantasy', label: '幻想' },
  { key: 'elegant', label: '典雅' },
]

/** 快捷方式显示名（与 electron-builder.yml 的 nsis.shortcutName 一致） */
const SHORTCUT_NAME = '青春幻想引擎'

/** Windows 才支持（其它平台没有 .lnk） */
function supported() {
  return process.platform === 'win32'
}

/** 内置图标源目录（随 electron/** 进包；asar 内可读） */
function builtinDir() {
  return path.join(__dirname, 'icons')
}

function presetKeyOf(input) {
  const k = String(input || '').trim()
  return PRESETS.some(p => p.key === k) ? k : null
}

/** 解包目录：<userData>/app-icons/（真实文件系统路径，快捷方式才能引用） */
function unpackDir(app) {
  return path.join(app.getPath('userData'), 'app-icons')
}

/** 桌面与开始菜单两条快捷方式路径（可能都不存在 —— 未安装 / 用户手动删过） */
function shortcutPaths(app) {
  const out = [path.join(app.getPath('desktop'), `${SHORTCUT_NAME}.lnk`)]
  try {
    out.push(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${SHORTCUT_NAME}.lnk`))
  } catch {
    /* 老系统没有 appData 时忽略 */
  }
  return out
}

/** 已有快捷方式（存在的那些） */
function existingShortcuts(app) {
  return shortcutPaths(app).filter(p => {
    try { return fs.statSync(p).isFile() } catch { return false }
  })
}

/** 读一条 .lnk 的当前图标路径（读不出返回 null） */
function readIconOf(lnkPath) {
  try {
    const d = require('electron').shell.readShortcutLink(lnkPath)
    return typeof d.icon === 'string' && d.icon ? d.icon : null
  } catch {
    return null
  }
}

/**
 * 「默认图标」＝**快捷方式自己指向的那个主程序**，而不是 `process.execPath`。
 *
 * 🔴 这条是真机自检抓出来的坑（2026-10-17）：开发模式下 `process.execPath` 是
 *    `node_modules/electron/dist/electron.exe` —— 用它当默认图标，会把桌面快捷方式
 *    指到一个跟安装目录毫无关系的 exe 上（图标虽然也显示得出来，但那是「开发者的壳」）。
 *    而 `.lnk` 的 `target` 本来就写着安装版 exe 的真实路径（如
 *    `D:\Program Files\YouthFantasyEngine\YouthFantasyEngine.exe`），直接拿它当默认图标，
 *    dev / 安装版 / 换目录 三种情况天然都对。
 */
function defaultIconOf(lnkPath) {
  try {
    const d = require('electron').shell.readShortcutLink(lnkPath)
    const t = typeof d.target === 'string' ? d.target : ''
    if (/\.(exe|ico)$/i.test(t)) return t
  } catch {
    /* 读不出（快捷方式损坏）→ 退回自身 */
  }
  return process.execPath
}

/** 本机当前生效的预设（由桌面快捷方式推断；非预设或读不到返回 null） */
function currentKey(app) {
  const lnk = shortcutPaths(app)[0]
  const icon = readIconOf(lnk)
  if (!icon) return null
  if (path.resolve(icon) === path.resolve(defaultIconOf(lnk))) return 'default'
  const base = path.basename(icon)
  for (const p of PRESETS) {
    if (base === `${p.key}.ico` || base.startsWith(`${p.key}-`)) return p.key
  }
  return null
}

/**
 * 把内置 .ico 解包到 userData，返回新文件的真实路径。
 * 🔴 每次调用都写**新文件名**（时间戳）—— 见本文件头 ② 的刷新问题。
 */
function unpackIcon(app, key) {
  const src = path.join(builtinDir(), `${key}.ico`)
  const bytes = fs.readFileSync(src) // asar 内可读
  const dir = unpackDir(app)
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  const dst = path.join(dir, `${key}-${stamp}.ico`)
  fs.writeFileSync(dst, bytes)
  // 顺手清掉该预设的旧文件（只留刚写的这一个；其它预设的文件不动）
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(`${key}-`) || f === path.basename(dst)) continue
    try { fs.unlinkSync(path.join(dir, f)) } catch { /* 正被占用就留着，下次再清 */ }
  }
  return dst
}

/** 读出 256 图标的 PNG 字节（ICO 目录里第一条即 PNG 条目），供界面预览 */
function previewDataUrl(key) {
  try {
    const buf = fs.readFileSync(path.join(builtinDir(), `${key}.ico`))
    const count = buf.readUInt16LE(4)
    let best = null
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16
      const w = buf[off] || 256
      const size = buf.readUInt32LE(off + 8)
      const dataOff = buf.readUInt32LE(off + 12)
      if (!best || w > best.w) best = { w, size, dataOff }
    }
    if (!best) return null
    const slice = buf.subarray(best.dataOff, best.dataOff + best.size)
    const isPng = slice[0] === 0x89 && slice[1] === 0x50
    if (!isPng) return null // 非 PNG 条目（BMP）不做内联预览
    return 'data:image/png;base64,' + Buffer.from(slice).toString('base64')
  } catch {
    return null
  }
}

/** 预设清单（含预览 dataURL，界面直接 <img> 显示） */
function listPresets() {
  return PRESETS.map(p => ({ key: p.key, label: p.label, preview: previewDataUrl(p.key) }))
}

/**
 * 应用一个预设：桌面 + 开始菜单一起改；同时把运行中窗口的图标也换掉（即时反馈）。
 * @returns {{ok:boolean, supported?:boolean, key?:string, iconPath?:string, applied?:string[], error?:string}}
 */
function applyPreset(app, win, key) {
  if (!supported()) return { ok: false, supported: false, error: '当前平台不支持桌面快捷方式图标切换' }
  const k = presetKeyOf(key)
  if (!k) return { ok: false, error: `未知的图标预设：${key}` }
  const lnks = existingShortcuts(app)
  let iconPath = null
  try {
    // 默认 = 主程序自身图标（不额外解包）；其余预设落到 userData
    if (k === 'default') {
      iconPath = lnks.length ? defaultIconOf(lnks[0]) : process.execPath
    } else {
      iconPath = unpackIcon(app, k)
    }
  } catch (e) {
    return { ok: false, error: '写入图标文件失败：' + (e && e.message ? e.message : String(e)) }
  }
  const shell = require('electron').shell
  const applied = []
  const failed = []
  for (const lnk of lnks) {
    try {
      // 'update' 只覆盖给定字段，快捷方式的目标/工作目录/参数原样保留
      shell.writeShortcutLink(lnk, 'update', { icon: iconPath, iconIndex: 0 })
      applied.push(path.basename(lnk))
    } catch (e) {
      failed.push(`${path.basename(lnk)}（${e && e.message ? e.message : String(e)}）`)
    }
  }
  try {
    win?.setIcon && win.setIcon(iconPath)
  } catch {
    /* 窗口图标失败不影响快捷方式 */
  }
  if (!applied.length) {
    return {
      ok: false,
      key: k,
      iconPath,
      error: failed.length
        ? '快捷方式写入失败：' + failed.join('；')
        : '没有找到桌面 / 开始菜单快捷方式（可能是便携版或未安装）',
    }
  }
  return { ok: true, key: k, iconPath, applied, failed: failed.length ? failed : undefined }
}

/**
 * 偏好文件：`<userData>/app-icon.json`，形如 `{ "key": "fantasy" }`。
 *
 * 🔴 为什么**主进程自己存一份**，而不是去读渲染层的 localStorage：
 *   启动自愈必须发生在**窗口渲染之前**（否则用户会先看到一个默认图标、再被改掉）；
 *   那一刻渲染层还没跑起来，localStorage 读不到。而且本机偏好属「这台机器的壳层设置」，
 *   与 `yfe-ui:` 那批界面偏好各管一段 —— 主进程这份是**唯一真源**，渲染层通过 IPC 查询。
 */
function prefsFile(app) {
  return path.join(app.getPath('userData'), 'app-icon.json')
}

function readSavedKey(app) {
  try {
    const d = JSON.parse(fs.readFileSync(prefsFile(app), 'utf-8'))
    return presetKeyOf(d && d.key)
  } catch {
    return null
  }
}

function writeSavedKey(app, key) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(prefsFile(app), JSON.stringify({ key }, null, 2) + '\n', 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * 启动自愈：**只在前一次选择不是「默认」时**才检查。
 * 判据严格——必须是「快捷方式当前图标不再指向本机该预设的解包文件」，否则会每次启动都写新文件。
 */
function healIfNeeded(app, win, savedKey) {
  if (!supported()) return { ok: false, supported: false }
  const k = presetKeyOf(savedKey)
  if (!k) return { ok: false, error: '未保存偏好，跳过自愈' }
  const lnks = existingShortcuts(app)
  if (!lnks.length) return { ok: false, error: '没有快捷方式' }
  const icon = readIconOf(lnks[0])
  const okAsIs = k === 'default'
    ? !!icon && path.resolve(icon) === path.resolve(defaultIconOf(lnks[0]))
    : !!icon && path.resolve(icon).startsWith(path.resolve(unpackDir(app)) + path.sep) &&
      path.basename(icon).startsWith(`${k}-`)
  if (okAsIs) return { ok: true, healed: false }
  const r = applyPreset(app, win, k)
  return { ...r, healed: r.ok === true }
}

module.exports = {
  PRESETS,
  SHORTCUT_NAME,
  supported,
  listPresets,
  currentKey,
  applyPreset,
  healIfNeeded,
  readSavedKey,
  writeSavedKey,
  shortcutPaths,
  existingShortcuts,
  readIconOf,
  defaultIconOf,
}
