// ============ 3.5.3 · P0 项目数据审计与受控恢复 ============
//
// 【它解决什么】索引写入、目录隔离、迁移或进程中断之后，账号可能停在「索引与状态不一致」
//   「purge-pending 残留」「账号锁残留」「孤儿项目目录」等中间态。读写路径对此一律失败关闭
//   （见 v2Index.readIndex / projectApi.assertIndexState），保护数据不被继续踩坏 —— 但失败关闭
//   之后必须有一条**可审计、可预览、受控**的恢复路径，否则账号会永久卡死。
//
// 🔴 五条不可协商的边界：
//   1. **审计只读**：auditAccount 不写任何文件，只报告事实与差异。
//   2. **不自动删除隔离目录、不自动清锁、不凭不完整数据重建索引**：每一类破坏性或重建动作
//      都要显式选择（--action）并 --apply 才执行；默认只预览。
//   3. **停写**：恢复写入前必须拿到账号协作写锁；拿不到（含残留锁）就拒绝，先处理锁。
//   4. **备份与留痕**：改索引前先把旧索引拷进 recovery-backups/；每次执行追加 recovery-journal.jsonl。
//   5. **数据源唯一**：索引落后于状态时，以 state.json + 当前 manifest 为准重建条目（state 是提交点）；
//      状态本身损坏/缺失时只报告，绝不猜测内容。
//
// ⚠️ 协作锁不是强制锁：旧进程或绕过协议的写入者不受约束。残留锁能否清除，按「持有进程是否存活、
//   是否同主机」判断；跨主机或无法解析的锁内容一律拒绝自动清除。真实断电与网络文件系统不在保证范围。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  accountRoot, indexFile, writeIndex, acquireAccountWriteLock, readAccountLockInfo,
} from './v2Index.mjs'
import { getProjectState, readManifest, objectPath, readEpoch, PROTOCOL_VERSION } from './projectStore.mjs'

const PID_RE = /^[A-Za-z0-9_-]{6,40}$/

/** 安全（非破坏、非重建）动作：--apply 即可执行；其余动作必须显式 --action 选择。 */
const SAFE_ACTIONS = new Set(['repair-entry', 'rollback-pending'])
/** 破坏性或重建动作：必须显式 --action 选择 + --apply。 */
const RISKY_ACTIONS = new Set(['remove-pending', 'drop-entry', 'clear-lock', 'adopt-project', 'rebuild-index'])

const projectsDir = (root) => path.join(root, 'projects')
const pendingDir = (root) => path.join(root, 'purge-pending')
const stateFile = (root, pid) => path.join(root, 'projects', pid, 'state.json')

function readJsonSafe(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'read-failed', error: error?.code || String(error) }
  }
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'corrupt' }
    return { status: 'ok', value, text }
  } catch {
    return { status: 'corrupt' }
  }
}

function listDirSafe(dir) {
  try { return fs.readdirSync(dir) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw Object.assign(new Error('PROJECT_DATA_READ_FAILED'), { code: 'PROJECT_DATA_READ_FAILED' })
  }
}

/** 持有进程是否存活（仅同主机可判定）。 */
function holderAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try { process.kill(pid, 0); return true } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true // 存在但非本用户所有
    return null
  }
}

/**
 * 只读审计一个账号。返回结构化报告与差异预览，不写任何文件。
 * @returns {{ accountId, at, index, epoch, accountLock, purgePending, projects, findings }}
 */
export function auditAccount(v2Root, accountId, { now = Date.now() } = {}) {
  const root = accountRoot(v2Root, accountId)
  const findings = []
  const add = (kind, severity, detail, extra = {}) => findings.push({ kind, severity, detail, ...extra })

  // ---- 索引 ----
  const idxRead = readJsonSafe(indexFile(v2Root, accountId))
  let indexProjects = null
  if (idxRead.status === 'ok') {
    if (!idxRead.value.projects || typeof idxRead.value.projects !== 'object' || Array.isArray(idxRead.value.projects)) {
      idxRead.status = 'corrupt'
    } else {
      indexProjects = idxRead.value.projects
    }
  }
  const index = { status: idxRead.status }
  if (idxRead.status === 'corrupt') add('index-corrupt', 'error', '索引文件损坏，无法解析；读写已失败关闭。', { recoverable: 'rebuild-index' })
  else if (idxRead.status === 'read-failed') add('index-read-failed', 'error', `索引读取失败（${idxRead.error}）。`, {})
  else if (idxRead.status === 'missing') {
    const hasData = listDirSafe(projectsDir(root)).length > 0 || listDirSafe(path.join(root, 'objects')).length > 0
    if (hasData) {
      index.status = 'missing-with-data'
      add('index-missing-with-data', 'error', '索引缺失但已有项目/对象数据；不会当作空账号重建。', { recoverable: 'rebuild-index' })
    } else {
      index.status = 'missing-empty'
    }
  }

  // ---- 世代 ----
  let epoch = { present: fs.existsSync(path.join(root, 'epoch.json')), value: null }
  try { epoch.value = readEpoch(root) } catch (error) { epoch.error = error?.code || String(error) }
  if (!epoch.present) add('epoch-missing', 'info', 'epoch.json 缺失，按历史初始世代 1 处理（旧库兼容，非损坏）。', {})

  // ---- 账号锁 ----
  const lockInfo = readAccountLockInfo(v2Root, accountId)
  let accountLock = { present: false }
  if (lockInfo) {
    const sameHost = !!lockInfo.host && lockInfo.host === os.hostname()
    const alive = sameHost ? holderAlive(lockInfo.pid) : null
    accountLock = {
      present: true, pid: lockInfo.pid, host: lockInfo.host, at: lockInfo.at,
      ageMs: lockInfo.mtimeMs ? Math.max(0, now - lockInfo.mtimeMs) : null,
      sameHost, holderAlive: alive, raw: lockInfo.raw,
    }
    add('residual-account-lock', 'error',
      `账号写锁残留（pid=${lockInfo.pid ?? '?'} host=${lockInfo.host || '?'}）。` +
      (sameHost ? (alive === false ? '持有进程已退出，可显式清除。' : alive === true ? '持有进程仍在运行，禁止清除。' : '无法判定持有进程，禁止自动清除。') : '跨主机或未知主机，禁止自动清除。'),
      { recoverable: 'clear-lock', canClear: sameHost && alive === false })
  }

  // ---- purge-pending 隔离区 ----
  const purgePending = []
  for (const pid of listDirSafe(pendingDir(root))) {
    const entry = indexProjects ? indexProjects[pid] : undefined
    const st = readJsonSafe(path.join(pendingDir(root), pid, 'state.json'))
    const references = !!entry
    let classification, recoverable
    if (!references) {
      classification = 'leftover' // 索引已移除＝永久删除已提交，隔离目录只是未清掉的证据
      recoverable = 'remove-pending'
      add('purge-pending-leftover', 'warn', `隔离目录 ${pid}：索引已不含该项目（永久删除已提交），目录为待核对残留。`, { pid, recoverable })
    } else if (st.status === 'ok' && Number.isSafeInteger(st.value.revision) &&
      Number(entry.revision) === st.value.revision && Boolean(entry.deletedAt) === Boolean(st.value.deletedAt)) {
      classification = 'rollback' // 索引仍引用且状态一致＝隔离后索引写失败、回滚也失败
      recoverable = 'rollback-pending'
      add('purge-pending-rollback', 'error', `隔离目录 ${pid}：索引仍引用且状态一致，可移回项目目录。`, { pid, recoverable })
    } else {
      classification = 'ambiguous'
      add('purge-pending-ambiguous', 'error', `隔离目录 ${pid}：索引仍引用但状态不一致或损坏，需人工核对，不自动处理。`, { pid })
    }
    purgePending.push({ pid, classification, indexReferences: references, stateStatus: st.status, recoverable })
  }
  if (purgePending.length) index.blockedByPending = true

  // ---- 项目逐一对账 ----
  const diskPids = listDirSafe(projectsDir(root)).filter((n) => PID_RE.test(n))
  const indexPids = indexProjects ? Object.keys(indexProjects) : []
  const allPids = [...new Set([...diskPids, ...indexPids])].sort()
  const projects = []
  for (const pid of allPids) {
    const onDisk = diskPids.includes(pid)
    const entry = indexProjects ? indexProjects[pid] : undefined
    const inIndex = !!entry
    const row = { pid, onDisk, inIndex, issues: [] }
    if (inIndex) {
      row.indexRevision = Number(entry.revision)
      row.indexDeleted = !!entry.deletedAt
      row.indexSnapshotId = entry.snapshotId || ''
    }
    if (!onDisk) {
      if (inIndex) {
        row.issues.push('index-entry-no-dir')
        add('index-entry-no-dir', 'error', `索引含 ${pid} 但项目目录缺失；需人工确认后移除条目或从备份恢复目录。`, { pid, recoverable: 'drop-entry' })
      }
      projects.push(row)
      continue
    }
    let state = null
    try {
      state = getProjectState(root, pid, accountId)
      row.stateRevision = state.revision
      row.stateDeleted = state.deleted
      row.stateSnapshotId = state.snapshotId
    } catch (error) {
      row.stateError = error?.code || String(error)
      row.issues.push('state-unreadable')
      add('state-unreadable', 'error', `项目 ${pid} 状态不可读（${row.stateError}）；只报告，不猜测内容。`, { pid })
      projects.push(row)
      continue
    }
    if (!inIndex) {
      // 孤儿目录：状态有效但索引没有它（迁移中断 / 索引写失败）
      if (indexProjects) {
        row.issues.push('orphan-project')
        add('orphan-project', 'error', `项目 ${pid} 目录与状态有效但索引缺失（迁移中断或索引写失败）；可显式收编。`, { pid, recoverable: 'adopt-project' })
      }
      projects.push(row)
      continue
    }
    // 索引与状态对账
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 0) {
      row.issues.push('index-entry-invalid')
      add('index-entry-invalid', 'error', `项目 ${pid} 索引条目 revision 非法。`, { pid })
    } else if (entry.revision < state.revision) {
      row.issues.push('index-behind-state')
      add('index-behind-state', 'error', `项目 ${pid} 索引落后于状态（索引 ${entry.revision} < 状态 ${state.revision}）；可以状态为准修复条目。`, { pid, recoverable: 'repair-entry' })
    } else if (entry.revision > state.revision) {
      row.issues.push('index-ahead-of-state')
      add('index-ahead-of-state', 'error', `项目 ${pid} 索引领先于状态（索引 ${entry.revision} > 状态 ${state.revision}）；可能状态回退，需人工核对，不自动修复。`, { pid })
    } else if (!state.deleted && entry.snapshotId && entry.snapshotId !== state.snapshotId) {
      row.issues.push('snapshot-mismatch')
      add('snapshot-mismatch', 'error', `项目 ${pid} 同版本但快照标识不一致；需人工核对，不自动修复。`, { pid })
    }
    // 已删除项目索引保留旧 snapshotId 属正常，不据此判不一致。
    projects.push(row)
  }

  return { accountId, at: now, index, epoch, accountLock, purgePending, projects, findings }
}

/** 由状态 + 当前 manifest 重建索引条目（state 是提交点）。已删除项目保留旧对象清单与配额口径。 */
function entryFromState(root, pid, state, existing, now) {
  if (state.deletedAt) {
    return {
      ...(existing || {}),
      name: existing?.name || '',
      revision: state.revision, snapshotId: state.snapshotId,
      deletedAt: state.deletedAt, updatedAt: now,
    }
  }
  const manifest = state.revision > 0 ? readManifest(root, pid, state.revision) : null
  const objectList = []
  let incoming = 0
  const seen = new Set()
  for (const o of [...(manifest?.objects || []), ...(manifest?.assets || [])]) {
    if (!o || typeof o.hash !== 'string' || seen.has(o.hash)) continue
    seen.add(o.hash)
    let size = 0
    try { size = fs.statSync(objectPath(root, o.hash)).size } catch { /* 缺对象按 0 记，配额偏保守 */ }
    incoming += size
    objectList.push({ hash: o.hash, bytes: size })
  }
  return {
    name: existing?.name || manifest?.project?.name || '',
    revision: state.revision, snapshotId: state.snapshotId,
    updatedAt: now, objectBytes: incoming, objects: objectList, deletedAt: 0,
  }
}

/** 把审计发现转成可执行动作清单（含差异预览）。 */
export function planRecovery(report) {
  const actions = []
  for (const f of report.findings) {
    if (!f.recoverable) continue
    const safe = SAFE_ACTIONS.has(f.recoverable)
    actions.push({
      kind: f.recoverable, pid: f.pid || null, safe,
      description: f.detail,
      requiresConfirm: !safe,
    })
  }
  return actions
}

function backupIndex(root, accountId, now) {
  const file = indexFile(path.dirname(path.dirname(root)), accountId)
  if (!fs.existsSync(file)) return null
  const dir = path.join(root, 'recovery-backups')
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `index-${now}.json`)
  fs.copyFileSync(file, dest)
  return dest
}

function journal(root, record) {
  const file = path.join(root, 'recovery-journal.jsonl')
  fs.appendFileSync(file, JSON.stringify(record) + '\n')
}

/**
 * 受控恢复。默认只预览；apply=true 才执行。
 * @param {object} o
 * @param {string} o.v2Root
 * @param {string} o.accountId
 * @param {boolean} [o.apply] 默认 false（预览）
 * @param {{kind:string,pid?:string}[]} [o.actions] 显式选择的动作；为空且 apply 时只执行安全动作
 * @param {number} [o.now]
 * @returns {{ report, plan, executed, skipped, results, journalFile }}
 */
export function recoverAccount({ v2Root, accountId, apply = false, actions = [], now = Date.now() }) {
  const root = accountRoot(v2Root, accountId)
  const report = auditAccount(v2Root, accountId, { now })
  const plan = planRecovery(report)

  // 选择要执行的动作：显式 actions 直接执行（由处理器安全守卫兜底，可拒绝不安全情形）；
  // 未显式选择时，apply 只执行计划里的安全动作。
  const explicit = Array.isArray(actions) && actions.length > 0
  for (const s of (explicit ? actions : [])) {
    if (!SAFE_ACTIONS.has(s.kind) && !RISKY_ACTIONS.has(s.kind)) {
      throw Object.assign(new Error(`未知恢复动作：${s.kind}`), { code: 'BAD_RECOVERY_ACTION' })
    }
  }
  const selected = explicit
    ? actions.map((s) => ({ kind: s.kind, pid: s.pid || null, safe: SAFE_ACTIONS.has(s.kind), requiresConfirm: !SAFE_ACTIONS.has(s.kind) }))
    : plan.filter((a) => apply && a.safe)
  const matches = (a, s) => a.kind === s.kind && (s.pid == null || s.pid === a.pid)

  const results = []
  const executed = []
  const skipped = plan.filter((a) => !selected.some((s) => matches(a, s))).map((a) => ({ kind: a.kind, pid: a.pid, reason: '未选择' }))
  if (!apply) {
    return { report, plan, executed, skipped, results, preview: true, journalFile: null }
  }

  // ---- 停写：先处理残留锁（若被选择），再拿账号锁 ----
  const clearLock = selected.find((a) => a.kind === 'clear-lock')
  if (clearLock) {
    const info = readAccountLockInfo(v2Root, accountId)
    if (!info) {
      results.push({ kind: 'clear-lock', ok: true, detail: '锁已不存在，无需清除。' })
    } else {
      const sameHost = !!info.host && info.host === os.hostname()
      const alive = sameHost ? holderAlive(info.pid) : null
      if (!sameHost || alive !== false) {
        results.push({ kind: 'clear-lock', ok: false, detail: '拒绝清除：持有进程仍在运行、跨主机或无法判定。请先停止持有进程。' })
        return { report, plan, executed, skipped, results, preview: false, journalFile: null }
      }
      fs.unlinkSync(path.join(root, '.account-write.lock'))
      results.push({ kind: 'clear-lock', ok: true, detail: `已清除残留锁（pid=${info.pid} 已退出）。` })
      journal(root, { at: now, action: 'clear-lock', pid: info.pid })
    }
  }

  const lock = acquireAccountWriteLock(v2Root, accountId)
  if (!lock) {
    results.push({ kind: 'account-lock', ok: false, detail: '账号正在被写入（PROJECT_ACCOUNT_BUSY），恢复拒绝执行；请先停写或处理残留锁。' })
    return { report, plan, executed, skipped, results, preview: false, journalFile: null }
  }

  let backedUp = false
  const ensureBackup = () => { if (!backedUp) { backupIndex(root, accountId, now); backedUp = true } }
  const readIdx = () => {
    const r = readJsonSafe(indexFile(v2Root, accountId))
    if (r.status !== 'ok' || !r.value.projects) return null
    return r.value
  }
  const writeIdx = (idx) => { ensureBackup(); writeIndex(v2Root, accountId, idx) }

  try {
    for (const action of selected) {
      if (action.kind === 'clear-lock') { executed.push(action); continue } // 已在锁前处理
      const pid = action.pid
      try {
        if (action.kind === 'repair-entry' || action.kind === 'adopt-project') {
          const state = getProjectState(root, pid, accountId)
          const idx = readIdx()
          if (!idx) { results.push({ kind: action.kind, pid, ok: false, detail: '索引不可读，拒绝重建条目。' }); continue }
          if (action.kind === 'repair-entry' && !idx.projects[pid]) { results.push({ kind: action.kind, pid, ok: false, detail: '索引已无该项目，改用 adopt-project。' }); continue }
          if (action.kind === 'adopt-project' && idx.projects[pid]) { results.push({ kind: action.kind, pid, ok: false, detail: '索引已含该项目，无需收编。' }); continue }
          const before = idx.projects[pid] ? { ...idx.projects[pid] } : null
          idx.projects[pid] = entryFromState(root, pid, state, idx.projects[pid], now)
          writeIdx(idx)
          executed.push(action)
          results.push({ kind: action.kind, pid, ok: true, detail: `条目已按状态重建（revision ${state.revision}）。`, before, after: idx.projects[pid] })
          journal(root, { at: now, action: action.kind, pid, before, after: idx.projects[pid] })
        } else if (action.kind === 'rollback-pending') {
          const pending = path.join(pendingDir(root), pid)
          const target = path.join(projectsDir(root), pid)
          const idx = readIdx()
          if (!idx || !idx.projects[pid]) { results.push({ kind: action.kind, pid, ok: false, detail: '索引已不含该项目，不能移回（改用 remove-pending 核对）。' }); continue }
          if (fs.existsSync(target)) { results.push({ kind: action.kind, pid, ok: false, detail: '项目目录已存在，拒绝覆盖。' }); continue }
          fs.renameSync(pending, target)
          executed.push(action)
          results.push({ kind: action.kind, pid, ok: true, detail: '隔离目录已移回项目目录。' })
          journal(root, { at: now, action: action.kind, pid })
        } else if (action.kind === 'remove-pending') {
          const pending = path.join(pendingDir(root), pid)
          const idx = readIdx()
          if (idx && idx.projects[pid]) { results.push({ kind: action.kind, pid, ok: false, detail: '索引仍引用该项目，拒绝删除隔离目录（应先 rollback-pending）。' }); continue }
          fs.rmSync(pending, { recursive: true, force: true })
          executed.push(action)
          results.push({ kind: action.kind, pid, ok: true, detail: '已删除永久删除残留的隔离目录（索引此前已提交移除）。' })
          journal(root, { at: now, action: action.kind, pid })
        } else if (action.kind === 'drop-entry') {
          const idx = readIdx()
          if (!idx || !idx.projects[pid]) { results.push({ kind: action.kind, pid, ok: false, detail: '索引已无该项目。' }); continue }
          if (fs.existsSync(path.join(projectsDir(root), pid))) { results.push({ kind: action.kind, pid, ok: false, detail: '项目目录仍在，拒绝移除条目（避免丢数据）。' }); continue }
          const before = { ...idx.projects[pid] }
          delete idx.projects[pid]
          writeIdx(idx)
          executed.push(action)
          results.push({ kind: action.kind, pid, ok: true, detail: '已移除指向缺失目录的索引条目。', before })
          journal(root, { at: now, action: action.kind, pid, before })
        } else if (action.kind === 'rebuild-index') {
          // 仅当所有磁盘项目状态都可读时才重建；否则拒绝（不凭不完整数据重建）。
          const diskPids = listDirSafe(projectsDir(root)).filter((n) => PID_RE.test(n))
          const rebuilt = { projects: {} }
          let incomplete = false
          for (const p of diskPids) {
            try {
              const state = getProjectState(root, p, accountId)
              rebuilt.projects[p] = entryFromState(root, p, state, null, now)
            } catch { incomplete = true; break }
          }
          if (incomplete) { results.push({ kind: action.kind, ok: false, detail: '存在状态不可读的项目，拒绝凭不完整数据重建索引。' }); continue }
          ensureBackup()
          writeIndex(v2Root, accountId, rebuilt)
          executed.push(action)
          results.push({ kind: action.kind, ok: true, detail: `索引已按 ${diskPids.length} 个有效项目重建（旧索引已备份）。` })
          journal(root, { at: now, action: action.kind, projects: diskPids })
        }
      } catch (error) {
        results.push({ kind: action.kind, pid, ok: false, detail: error?.message || String(error) })
      }
    }
  } finally {
    lock.release()
  }
  return { report, plan, executed, skipped, results, preview: false, journalFile: path.join(root, 'recovery-journal.jsonl') }
}

export { SAFE_ACTIONS, RISKY_ACTIONS }