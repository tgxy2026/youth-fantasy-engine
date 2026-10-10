// 3.0 · W0-2 老用户数据迁移内核（主进程侧）
//
// 职责（只做「渲染进程做不到」的文件系统 IO）：
//   ① 探测旧版（novel-studio）userData；
//   ② 在**窗口创建前**把旧 IndexedDB 目录复制过来（IDB 是进程内 LevelDB，时机晚了会不生效/损坏）；
//   ③ 读旧整库 JSON / 写新整库 JSON；④ 复制 Chromium profile 文件；⑤ 尽力定位旧版卸载器。
//
// 🔴 remap 逻辑（app / kind 改写）**刻意不在这里** —— 它放在渲染侧 `src/lib/storage/legacyMigration.ts`，
//    因为那是纯函数、可在 Node 单测里直接跑（本模块依赖 electron，单测环境跑不了）。
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { app, shell } = require('electron')

const LEGACY_APP_NAME = 'novel-studio'
const LEGACY_DATA_FILE = 'novel-studio-data.json'
const NEW_DATA_FILE = 'youth-fantasy-engine-data.json'

/** 旧版 userData 目录：`%APPDATA%\novel-studio`（与旧 package.json.name 同源） */
function legacyUserData() {
  return path.join(app.getPath('appData'), LEGACY_APP_NAME)
}

/**
 * 递归复制目录。
 * 🔴 自写而不用 `fs.cpSync`：本机曾见 `cpSync` 静默杀进程（见项目 MEMORY「进程/文件 API」红线）。
 * 单个文件失败**不中断整体** —— 迁移是「尽力而为」，个别文件失败也要把能搬的搬完。
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  let entries = []
  try { entries = fs.readdirSync(src, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    try {
      if (ent.isDirectory()) copyDirSync(s, d)
      else if (ent.isFile()) fs.copyFileSync(s, d)
    } catch { /* 单文件失败跳过 */ }
  }
}

/** Chromium profile 里与 app 名无关、按 origin 索引的项（整体复制安全） */
const PROFILE_ITEMS = ['Local Storage', 'Session Storage', 'Preferences', 'WebStorage']

/** 探测旧版数据，返回结构化结果（供渲染进程决定是否弹向导） */
function probeLegacy() {
  const dir = legacyUserData()
  let exists = false
  try { exists = fs.statSync(dir).isDirectory() } catch { exists = false }
  if (!exists) return { exists: false, legacyDir: dir }

  const customPathFile = path.join(dir, 'data-location.json')
  let customDataPath = ''
  try {
    const j = JSON.parse(fs.readFileSync(customPathFile, 'utf-8'))
    if (j && typeof j.path === 'string') customDataPath = j.path
  } catch { /* 无自定义数据路径 */ }

  const idbDir = path.join(dir, 'IndexedDB')
  const jsonPath = customDataPath || path.join(dir, LEGACY_DATA_FILE)
  const profile = {}
  for (const name of PROFILE_ITEMS) {
    try { profile[name] = fs.existsSync(path.join(dir, name)) } catch { profile[name] = false }
  }
  return {
    exists: true,
    legacyDir: dir,
    jsonPath,
    jsonExists: fs.existsSync(jsonPath),
    idbDir,
    idbExists: fs.existsSync(idbDir),
    profile,
    customDataPath,
  }
}

/**
 * 🔴 **窗口创建前**调用：新 userData 的 IndexedDB 目录尚不存在时，把旧 IDB 整目录复制过来。
 * 为什么必须在此刻：Chromium 的 IDB 是进程内 LevelDB，**运行时替换目录不生效且可能损坏**；
 * 只有「新 app 还没打开过 IDB」时整目录复制才安全（保证 MANIFEST / 文件号一致）。
 * 已存在（= 非首启，如「重新导入」）则**不复制** —— 交给渲染侧转库逻辑处理，避免覆盖新库。
 */
function precopyLegacyIdb() {
  try {
    const info = probeLegacy()
    if (!info.exists || !info.idbExists) return { copied: false, reason: 'no-legacy-idb' }
    const newIdbDir = path.join(app.getPath('userData'), 'IndexedDB')
    if (fs.existsSync(newIdbDir)) return { copied: false, reason: 'new-idb-exists' }
    copyDirSync(info.idbDir, newIdbDir)
    return { copied: true }
  } catch (e) {
    return { copied: false, reason: String((e && e.message) || e) }
  }
}

/** 读旧整库 JSON 原文（remap 在渲染侧做 → 本函数只搬字节） */
function readLegacyJson() {
  const info = probeLegacy()
  if (!info.exists) return { ok: false, error: '未找到旧版数据目录' }
  if (!info.jsonExists) return { ok: false, error: '旧版数据目录里没有整库 JSON 文件' }
  try {
    return { ok: true, text: fs.readFileSync(info.jsonPath, 'utf-8'), path: info.jsonPath }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 把 remap 后的整库 JSON 写入新 userData（原子写：先 .tmp 再 rename，防半截文件） */
async function writeNewJson(text) {
  try {
    const dir = app.getPath('userData')
    await fsp.mkdir(dir, { recursive: true })
    const target = path.join(dir, NEW_DATA_FILE)
    const tmp = target + '.tmp'
    await fsp.writeFile(tmp, String(text == null ? '' : text), 'utf-8')
    await fsp.rename(tmp, target)
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 复制旧 Chromium profile 文件到新 userData（目标已存在则跳过，避免覆盖新 app 自生的配置） */
function copyLegacyProfile() {
  const info = probeLegacy()
  if (!info.exists) return { ok: false, error: '未找到旧版数据目录' }
  const newDir = app.getPath('userData')
  const copied = []
  for (const name of PROFILE_ITEMS) {
    const src = path.join(info.legacyDir, name)
    const dest = path.join(newDir, name)
    try {
      if (!fs.existsSync(src) || fs.existsSync(dest)) continue
      const st = fs.statSync(src)
      if (st.isDirectory()) copyDirSync(src, dest)
      else fs.copyFileSync(src, dest)
      copied.push(name)
    } catch { /* 单项失败不中断 */ }
  }
  return { ok: true, copied }
}

/**
 * 尽力定位旧版卸载器：扫常见安装根目录，找名字含 novel / 青春幻想 / youth 且带 `Uninstall*.exe` 的目录。
 * ⚠️ 刻意**不读注册表、不起子进程**（本机子进程调用受限，fs 只读更稳）；
 *    找不到时由渲染层引导作者去「设置 → 应用」手动卸载。
 */
function findLegacyUninstaller() {
  const roots = [
    path.join(app.getPath('home'), 'AppData', 'Local', 'Programs'),
    process.env['ProgramFiles'] || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  ]
  const hits = []
  for (const root of roots) {
    let subs = []
    try { subs = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const ent of subs) {
      if (!ent.isDirectory()) continue
      const nm = ent.name.toLowerCase()
      if (!(nm.includes('novel') || nm.includes('青春幻想') || nm.includes('youth'))) continue
      const dir = path.join(root, ent.name)
      let files = []
      try { files = fs.readdirSync(dir) } catch { continue }
      const un = files.find(f => /^uninstall.*\.exe$/i.test(f))
      if (un) hits.push({ dir, uninstaller: path.join(dir, un) })
    }
  }
  return { ok: hits.length > 0, hits }
}

/**
 * 在系统资源管理器里打开旧版数据目录 —— 供作者确认数据已安全迁移后**手动清理残留**。
 * 🔴 刻意不自动删除：残留目录里可能混着我们无法判定的东西（旧字体/缓存/自定义路径文件），
 *    删不删由作者裁决（呼应「AI 只辅助不越权」红线）。
 */
async function revealLegacyDir() {
  const info = probeLegacy()
  if (!info.exists) return { ok: false, error: '未找到旧版数据目录' }
  const err = await shell.openPath(info.legacyDir)
  return err ? { ok: false, error: err } : { ok: true, path: info.legacyDir }
}

/** 拉起卸载器（走系统 shell，不 spawn 子进程） */
async function runUninstaller(uninstallerPath) {
  try {
    const err = await shell.openPath(String(uninstallerPath || ''))
    return err ? { ok: false, error: err } : { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

module.exports = {
  LEGACY_APP_NAME,
  LEGACY_DATA_FILE,
  NEW_DATA_FILE,
  legacyUserData,
  probeLegacy,
  precopyLegacyIdb,
  readLegacyJson,
  writeNewJson,
  copyLegacyProfile,
  findLegacyUninstaller,
  runUninstaller,
  revealLegacyDir,
}
