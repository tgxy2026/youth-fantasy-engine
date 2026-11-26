// ============ WCP 本地 Agent 工作区 · Electron 安全宿主（3.7.4 · W2）============
//
// 主进程侧的唯一落盘入口。所有 IPC 都走这里，渲染进程不直接碰 fs。
//
// 🔴 四条铁律：
//   ① 默认根 = 当前**真实数据文件**同级 `wcp-workspaces/`（跟随 D 盘 / 同步盘 / 自定义位置）；
//   ② 所有相对路径用 `path.resolve` + `path.relative` 锁定在根目录内，`../` 一律拦截；
//   ③ 写入统一 `temp → fsync → rename`，Agent 不会读到半截文件；
//   ④ 过期清理只作用于引擎托管的只读清单，**永久排除 `outbox/`** —— 那是 Agent 唯一可写区。
//
// 为什么抽成独立模块：main.cjs 已 1700+ 行，且这些规则需要能被 node 单测直接调
// （不需要启动 Electron），否则「路径穿越 / 成对归档 / 无残留 .tmp」只能靠真机手点。
'use strict'

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const ROOT_DIRNAME = 'wcp-workspaces'
const OUTBOX_DIR = 'outbox'
const IMPORTED_DIR = 'imported'
const MANAGED_ROOT_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'manifest.json'])
const MANAGED_PREFIXES = ['01-base/', '02-context/', '03-schemas/', '04-chapters/']
const MAX_READ_BYTES = 8 * 1024 * 1024
let tmpSeq = 0

/** 数据文件同级的默认工作区根（D1） */
function defaultWorkspaceRoot(dataFile) {
  return path.join(path.dirname(String(dataFile || '')), ROOT_DIRNAME)
}

/**
 * 把一个相对路径解析到根目录内。
 * 返回 null = 不合法（空路径 / `..` 穿越 / 跨盘 / 绝对路径）。
 */
function resolveInside(root, rel) {
  if (typeof rel !== 'string') return null
  const clean = rel.replace(/\\/g, '/').trim()
  if (!clean || clean.includes('\u0000')) return null
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) return null
  if (clean.split('/').some(seg => seg === '..')) return null
  const normRoot = path.resolve(String(root || ''))
  const abs = path.resolve(normRoot, clean)
  const back = path.relative(normRoot, abs)
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null
  return abs
}

/** 单级目录名（工作区书名目录）：允许中文，但不允许分隔符 / 穿越 */
function safeFolder(folder) {
  if (typeof folder !== 'string') return ''
  const name = folder.trim()
  if (!name || name === '.' || name === '..') return ''
  if (name.includes('/') || name.includes('\\') || name.includes('\u0000')) return ''
  if (/[<>:"|?*]/.test(name)) return ''
  return name
}

/** 引擎托管只读文件（过期清理的唯一候选） */
function isManagedReadonly(rel) {
  const p = String(rel || '').replace(/\\/g, '/')
  if (!p || p === OUTBOX_DIR || p.startsWith(`${OUTBOX_DIR}/`)) return false
  if (MANAGED_ROOT_FILES.has(p)) return true
  return MANAGED_PREFIXES.some(prefix => p.startsWith(prefix))
}

/** 原子写：同目录唯一 tmp → write + fsync → rename（失败清理 tmp） */
async function atomicWrite(abs, text) {
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${++tmpSeq}.tmp`
  let handle = null
  try {
    handle = await fsp.open(tmp, 'w')
    await handle.writeFile(String(text), 'utf-8')
    await handle.sync()
    await handle.close()
    handle = null
    await renameWithRetry(tmp, abs)
  } catch (err) {
    try { if (handle) await handle.close() } catch { /* 已关闭 */ }
    try { await fsp.unlink(tmp) } catch { /* 名字唯一，残留不影响后续写 */ }
    throw err
  }
}

/**
 * Windows 瞬时占用（杀软 / 索引 / 文件监视）会让 rename 报 EPERM/EACCES/EBUSY。
 * 工作区是「Agent 可能正在读」的目录，更不能因为一次瞬时占用把整次同步判失败。
 */
async function renameWithRetry(from, to) {
  const delays = [10, 20, 50, 100, 200, 300]
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (err) {
      const code = err && err.code
      if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || attempt >= delays.length) throw err
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
}

/**
 * 目标路径是否落在程序安装目录内。
 *
 * 🔴 即使以管理员权限运行也必须拒绝：写进 `Program Files` 的成果会在升级安装时被整体覆盖，
 *    且与 NSIS 的目录清理相互踩踏。Windows 路径比较不区分大小写。
 */
function isInsideInstallDir(target, installDirs) {
  if (!target || !Array.isArray(installDirs) || !installDirs.length) return false
  const norm = p => {
    const abs = path.resolve(String(p || ''))
    return process.platform === 'win32' ? abs.toLowerCase() : abs
  }
  const t = norm(target)
  return installDirs.filter(Boolean).some(dir => {
    const b = norm(dir)
    if (!b) return false
    if (t === b) return true
    return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
  })
}

/** 目录可写探活：真实写一个探针文件再删掉，比只看 mode 位可靠 */
async function diagnoseRoot(root, installDirs = []) {
  const abs = path.resolve(String(root || ''))
  if (isInsideInstallDir(abs, installDirs)) {
    return {
      ok: false, writable: false, root: abs, code: 'EINSTALLDIR',
      error: '这个目录位于程序安装目录内，软件升级时会被覆盖，不能作为工作区。请改选数据目录同级或其它可写目录。',
    }
  }
  try {
    await fsp.mkdir(abs, { recursive: true })
    const probe = path.join(abs, `.wcp-write-probe-${process.pid}-${Date.now()}`)
    await fsp.writeFile(probe, 'ok', 'utf-8')
    await fsp.unlink(probe)
    return { ok: true, writable: true, root: abs, error: '' }
  } catch (err) {
    const code = err && err.code ? String(err.code) : ''
    const friendly = code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
      ? '这个目录当前不可写（可能位于安装目录、受系统保护或被安全软件占用）。请在设置里改选一个可写目录。'
      : `目录不可用：${err && err.message ? err.message : String(err)}`
    return { ok: false, writable: false, root: abs, error: friendly, code }
  }
}

async function pruneEmptyDirs(baseDir, protectedTop) {
  let entries = []
  try { entries = await fsp.readdir(baseDir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const abs = path.join(baseDir, entry.name)
    if (protectedTop && path.resolve(abs) === path.resolve(protectedTop)) continue
    await pruneEmptyDirs(abs, protectedTop)
    try {
      const rest = await fsp.readdir(abs)
      if (!rest.length) await fsp.rmdir(abs)
    } catch { /* 删不掉就留着 */ }
  }
}

/**
 * 应用一份增量计划。
 * @param {{root:string, folder:string, files?:Array<{path:string,content:string}>, deletions?:string[]}} payload
 */
async function applyPlan(payload, installDirs = []) {
  const root = path.resolve(String(payload && payload.root || ''))
  const folder = safeFolder(payload && payload.folder)
  if (!folder) return { ok: false, error: '工作区目录名不合法。', written: 0, deleted: 0, errors: [] }
  const folderAbs = resolveInside(root, folder)
  if (!folderAbs) return { ok: false, error: '工作区目录越界，已拒绝写入。', written: 0, deleted: 0, errors: [] }
  if (isInsideInstallDir(folderAbs, installDirs)) {
    return { ok: false, error: '工作区位于程序安装目录内，已拒绝写入（升级会覆盖）。', written: 0, deleted: 0, errors: [] }
  }

  const files = Array.isArray(payload.files) ? payload.files : []
  const deletions = Array.isArray(payload.deletions) ? payload.deletions : []
  const errors = []
  let written = 0
  let deleted = 0

  for (const file of files) {
    const rel = file && typeof file.path === 'string' ? file.path.replace(/\\/g, '/') : ''
    if (!/^[A-Za-z0-9._/-]+$/.test(rel) || !isManagedReadonly(rel)) {
      errors.push(`跳过不合法的只读文件路径：${rel || '（空）'}`)
      continue
    }
    const abs = resolveInside(folderAbs, rel)
    if (!abs) {
      errors.push(`跳过越界路径：${rel}`)
      continue
    }
    try {
      await atomicWrite(abs, file.content == null ? '' : String(file.content))
      written++
    } catch (err) {
      errors.push(`${rel}：${err && err.message ? err.message : String(err)}`)
    }
  }

  for (const relRaw of deletions) {
    const rel = typeof relRaw === 'string' ? relRaw.replace(/\\/g, '/') : ''
    if (!isManagedReadonly(rel)) continue // 非托管区（尤其 outbox/）绝不删
    const abs = resolveInside(folderAbs, rel)
    if (!abs) continue
    try {
      await fsp.unlink(abs)
      deleted++
    } catch (err) {
      if (!err || err.code !== 'ENOENT') errors.push(`${rel}：${err && err.message ? err.message : String(err)}`)
    }
  }

  // 清理过期文件后可能留下空目录（例如关闭 04-chapters 后的 vol-xx/）
  for (const prefix of ['01-base', '02-context', '03-schemas', '04-chapters']) {
    await pruneEmptyDirs(path.join(folderAbs, prefix), folderAbs)
  }

  // 唯一可写区必须存在；只建目录，不碰里面任何文件
  try { await fsp.mkdir(path.join(folderAbs, OUTBOX_DIR), { recursive: true }) } catch { /* 建不出由上层报错 */ }

  return {
    ok: errors.length === 0,
    error: errors.length ? errors.slice(0, 3).join('；') : '',
    written,
    deleted,
    errors,
  }
}

/** 扫描 `outbox/`：按同名双文件配对，按修改时间倒序 */
async function scanOutbox(payload) {
  const root = path.resolve(String(payload && payload.root || ''))
  const folder = safeFolder(payload && payload.folder)
  const folderAbs = folder ? resolveInside(root, folder) : null
  if (!folderAbs) return { ok: false, error: '工作区目录不合法。', entries: [] }
  const dir = path.join(folderAbs, OUTBOX_DIR)
  let names = []
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    names = entries.filter(e => e.isFile()).map(e => e.name)
  } catch {
    return { ok: true, entries: [] }
  }
  const groups = new Map()
  for (const name of names) {
    const isJson = name.endsWith('.wcp.json')
    const isMd = name.endsWith('.md')
    if (!isJson && !isMd) continue
    const base = isJson ? name.slice(0, -'.wcp.json'.length) : name.slice(0, -'.md'.length)
    if (!base) continue
    const abs = path.join(dir, name)
    let stat = null
    try { stat = await fsp.stat(abs) } catch { continue }
    const group = groups.get(base) || { base, jsonName: '', mdName: '', size: 0, mtimeMs: 0 }
    if (isJson) group.jsonName = name
    else group.mdName = name
    group.size += stat.size
    group.mtimeMs = Math.max(group.mtimeMs, stat.mtimeMs || 0)
    groups.set(base, group)
  }
  const entries = [...groups.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { ok: true, entries, dir }
}

/** 只读一份收件箱文件（限制在 `outbox/` 内 + 大小上限） */
async function readOutboxFile(payload) {
  const root = path.resolve(String(payload && payload.root || ''))
  const folder = safeFolder(payload && payload.folder)
  const name = payload && typeof payload.name === 'string' ? payload.name : ''
  if (!/^[^\\/]+\.(wcp\.json|md)$/i.test(name)) return { ok: false, error: '文件名不合法。', text: '' }
  const folderAbs = folder ? resolveInside(root, folder) : null
  if (!folderAbs) return { ok: false, error: '工作区目录不合法。', text: '' }
  const abs = resolveInside(folderAbs, `${OUTBOX_DIR}/${name}`)
  if (!abs) return { ok: false, error: '文件越界，已拒绝读取。', text: '' }
  try {
    const stat = await fsp.stat(abs)
    if (!stat.isFile()) return { ok: false, error: '目标不是文件。', text: '' }
    if (stat.size > MAX_READ_BYTES) return { ok: false, error: '文件超过 8 MB，已拒绝读取。', text: '' }
    return { ok: true, text: await fsp.readFile(abs, 'utf-8'), name }
  } catch (err) {
    return { ok: false, error: err && err.code === 'ENOENT' ? '文件已不在收件箱（可能已被归档）。' : String(err && err.message || err), text: '' }
  }
}

async function moveFile(src, dest) {
  try {
    await fsp.rename(src, dest)
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err
    await fsp.copyFile(src, dest)
    await fsp.unlink(src)
  }
}

/**
 * 成对归档到 `outbox/imported/`（D3）。
 * 同名已存在时自动加 `-2` / `-3` 后缀，绝不覆盖历史产物。
 */
async function archiveOutbox(payload) {
  const root = path.resolve(String(payload && payload.root || ''))
  const folder = safeFolder(payload && payload.folder)
  const folderAbs = folder ? resolveInside(root, folder) : null
  if (!folderAbs) return { ok: false, error: '工作区目录不合法。', archived: [] }
  const requested = [payload && payload.jsonName, payload && payload.mdName]
    .filter(n => typeof n === 'string' && /^[^\\/]+\.(wcp\.json|md)$/i.test(n))
  if (!requested.length) return { ok: false, error: '没有可归档的文件名。', archived: [] }
  const outbox = path.join(folderAbs, OUTBOX_DIR)
  const imported = path.join(outbox, IMPORTED_DIR)
  try { await fsp.mkdir(imported, { recursive: true }) } catch (err) { return { ok: false, error: String(err && err.message || err), archived: [] } }

  const archived = []
  const errors = []
  for (const name of requested) {
    const src = path.join(outbox, name)
    let stat = null
    try { stat = await fsp.stat(src) } catch { continue }
    if (!stat.isFile()) continue
    const ext = name.endsWith('.wcp.json') ? '.wcp.json' : '.md'
    const stem = name.slice(0, -ext.length)
    let dest = path.join(imported, `${stem}${ext}`)
    for (let n = 2; fs.existsSync(dest) && n < 100; n++) dest = path.join(imported, `${stem}-${n}${ext}`)
    try {
      await moveFile(src, dest)
      archived.push(path.basename(dest))
    } catch (err) {
      errors.push(`${name}：${err && err.message ? err.message : String(err)}`)
    }
  }
  if (!archived.length && errors.length) return { ok: false, error: errors.join('；'), archived }
  if (!archived.length) return { ok: false, error: '收件箱里已找不到对应文件。', archived }
  return { ok: true, archived, error: errors.length ? errors.join('；') : '' }
}

/**
 * 注册 IPC。main.cjs 只调用这一处；测试直接调上面的纯函数。
 * @param {{ipcMain:any, app:any, shell:any, dialog:any, dataFile:()=>string, ownsCurrentData:()=>boolean}} deps
 */
function registerWcpWorkspaceIpc(deps) {
  const { ipcMain, app, shell, dialog, dataFile, ownsCurrentData } = deps
  const rootOf = value => (typeof value === 'string' && value.trim() ? value.trim() : defaultWorkspaceRoot(dataFile()))
  const installDirsOf = () => {
    const dirs = []
    try {
      if (app && app.isPackaged) {
        if (process.resourcesPath) dirs.push(process.resourcesPath)
        dirs.push(path.dirname(app.getPath('exe')))
      }
    } catch { /* 取 exe 路径失败不挡其它校验 */ }
    return dirs
  }
  const guardWrite = () => (!ownsCurrentData || ownsCurrentData())
    ? null
    : { ok: false, error: '数据目录未取得独占权，已禁止写入工作区。' }

  ipcMain.handle('wcpWorkspace:defaultRoot', () => {
    try {
      return { ok: true, root: defaultWorkspaceRoot(dataFile()), dataPath: dataFile(), userData: app.getPath('userData') }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('wcpWorkspace:diagnose', async (_e, root) => {
    try { return await diagnoseRoot(rootOf(root), installDirsOf()) } catch (err) { return { ok: false, writable: false, error: String(err) } }
  })

  ipcMain.handle('wcpWorkspace:chooseRoot', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择本地 Agent 工作区根目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    return !r.canceled && r.filePaths.length ? r.filePaths[0] : null
  })

  ipcMain.handle('wcpWorkspace:apply', async (_e, payload) => {
    const blocked = guardWrite()
    if (blocked) return blocked
    try {
      const root = rootOf(payload && payload.root)
      // 写前可写探活：安装目录 / 只读盘在这里就给出中文提示，不让作者看到裸 EACCES
      const dirs = installDirsOf()
      const diag = await diagnoseRoot(root, dirs)
      if (!diag.ok) return { ok: false, error: diag.error, written: 0, deleted: 0, errors: [] }
      return await applyPlan({ ...payload, root }, dirs)
    } catch (err) {
      return { ok: false, error: String(err && err.message || err), written: 0, deleted: 0, errors: [] }
    }
  })

  ipcMain.handle('wcpWorkspace:scan', async (_e, payload) => {
    try { return await scanOutbox({ ...payload, root: rootOf(payload && payload.root) }) } catch (err) {
      return { ok: false, error: String(err), entries: [] }
    }
  })

  ipcMain.handle('wcpWorkspace:read', async (_e, payload) => {
    try { return await readOutboxFile({ ...payload, root: rootOf(payload && payload.root) }) } catch (err) {
      return { ok: false, error: String(err), text: '' }
    }
  })

  ipcMain.handle('wcpWorkspace:archive', async (_e, payload) => {
    const blocked = guardWrite()
    if (blocked) return { ...blocked, archived: [] }
    try { return await archiveOutbox({ ...payload, root: rootOf(payload && payload.root) }) } catch (err) {
      return { ok: false, error: String(err), archived: [] }
    }
  })

  ipcMain.handle('wcpWorkspace:reveal', async (_e, payload) => {
    try {
      const folder = safeFolder(payload && payload.folder)
      const abs = folder ? resolveInside(rootOf(payload && payload.root), folder) : null
      if (!abs) return { ok: false, error: '工作区目录不合法。' }
      await fsp.mkdir(abs, { recursive: true })
      const err = await shell.openPath(abs)
      return err ? { ok: false, error: err } : { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
}

module.exports = {
  defaultWorkspaceRoot,
  isInsideInstallDir,
  resolveInside,
  isManagedReadonly,
  diagnoseRoot,
  applyPlan,
  scanOutbox,
  readOutboxFile,
  archiveOutbox,
  registerWcpWorkspaceIpc,
}
