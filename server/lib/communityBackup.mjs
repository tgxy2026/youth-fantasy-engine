// ============ 投稿广场 · 备份 / 校验 / 恢复（3.5.2） ============
//
// 【为什么需要独立工具】社区是 8 个 JSON 文件，每个文件的原子替换**不等于**跨文件事务：
//   「评论已写入、帖子计数还没写」这类中间状态在崩溃/断电后是可能出现的。
//   备份必须能证明「这是一份结构完整、关联可校验、计数一致」的快照，而不是简单拷目录。
//
// 【备份格式】
//   <backupDir>/manifest.json      只含清单与统计，**不含正文 / uid 以外的身份信息**
//   <backupDir>/posts.json …       8 个数据文件（缺失的历史空文件用空结构补齐）
//
// 【恢复原则】
//   1. 恢复前必须停写（调用方传入 stopConfirmed；工具无法验证进程真的停了）；
//   2. 先校验备份（哈希、结构、关联、计数），不通过绝不覆盖现有数据；
//   3. 先复制当前数据到 `<root>.pre-restore-<ts>`，再切换目录；
//   4. 恢复会改变可见性（例如备份里是公开、现在已下架）时必须显式接受，
//      **不允许静默重新公开已下架/删除内容**；
//   5. 进程中断只会留下临时目录，正式目录要么是旧的、要么是新的完整快照。

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync, copyFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const COMMUNITY_FILES = Object.freeze([
  'posts.json', 'comments.json', 'votes.json', 'reports.json',
  'profiles.json', 'rank.json', 'audit.json', 'state.json',
])
export const BACKUP_MANIFEST = 'manifest.json'
export const BACKUP_FORMAT = 1

const POST_STATUSES = new Set(['draft', 'pending', 'published', 'changes_requested', 'rejected', 'withdrawn', 'removed'])
const COMMENT_STATUSES = new Set(['pending', 'visible', 'rejected', 'removed'])
const DISPLAYS = new Set(['nickname', 'anonymous'])

export const defaultIO = {
  exists: (p) => existsSync(p),
  mkdir: (p) => mkdirSync(p, { recursive: false }),
  readText: (p) => readFileSync(p, 'utf8'),
  writeText: (p, t) => writeFileSync(p, t, 'utf8'),
  copyFile: (a, b) => copyFileSync(a, b),
  rename: (a, b) => renameSync(a, b),
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  readdir: (p) => readdirSync(p, { withFileTypes: true }),
  stat: (p) => statSync(p),
  sha256: (p) => createHash('sha256').update(readFileSync(p)).digest('hex'),
}

/** 8 个文件的空结构（首次使用 / 某些文件从未写入过） */
export function emptyCommunityData() {
  return {
    'posts.json': { version: 1, items: {} },
    'comments.json': { version: 1, items: {} },
    'votes.json': { version: 1, items: {} },
    'reports.json': { version: 1, items: {} },
    'profiles.json': { version: 1, items: {} },
    'rank.json': { version: 1, items: {} },
    'audit.json': { version: 1, items: { list: [] } },
    'state.json': {
      version: 1,
      items: { global: { squareOpen: true, postsOpen: true, commentsOpen: true, updatedAt: 0 } },
    },
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function countOf(value) {
  return Number(value) || 0
}

/** 与 communityApi.postPubliclyVisible 同口径（备份/恢复只判断「对外可见」） */
export function snapshotPostVisible(post) {
  if (!post || !post.publishedVersionId) return false
  if (post.status === 'withdrawn' || post.status === 'removed') return false
  if (post.withdrawnAt || post.removedAt) return false
  return true
}

/**
 * 读取目录中的 8 个文件并解析。缺失文件用空结构占位，但记录在 `present` 里，
 * 让调用方区分「从未写入」与「意外丢失」。
 */
export function readCommunityData(root, io = defaultIO) {
  const data = emptyCommunityData()
  const present = []
  const problems = []
  for (const file of COMMUNITY_FILES) {
    const abs = join(root, file)
    if (!io.exists(abs)) continue
    try {
      const text = io.readText(abs)
      if (!text.trim()) throw new Error('文件内容为空')
      data[file] = JSON.parse(text)
      present.push(file)
    } catch (e) {
      problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { data, present, problems }
}

function itemsOf(data, file, label) {
  const v = data[file]
  if (!isPlainObject(v) || !isPlainObject(v.items)) throw new Error(`${label} 结构无效（缺少 items 对象）`)
  return v.items
}

/**
 * 结构 + 关联 + 计数校验。
 * @returns {{
 *   ok:boolean, problems:string[], warnings:string[], repairs:Array<object>,
 *   counts:object, data:object, normalized:object
 * }}
 *   · problems  -> 结构/关联硬错误，备份或恢复必须拒绝；
 *   · warnings  -> 孤儿引用等可保留但不可达的记录；
 *   · repairs   -> 计数漂移；`normalized` 是重算后的副本，live 不会被改写。
 */
export function validateSnapshot(data) {
  const problems = []
  const warnings = []
  const repairs = []
  const normalized = JSON.parse(JSON.stringify(data))

  let posts
  let comments
  let votes
  try {
    posts = itemsOf(normalized, 'posts.json', 'posts.json')
    comments = itemsOf(normalized, 'comments.json', 'comments.json')
    votes = itemsOf(normalized, 'votes.json', 'votes.json')
    itemsOf(normalized, 'reports.json', 'reports.json')
    itemsOf(normalized, 'profiles.json', 'profiles.json')
    itemsOf(normalized, 'rank.json', 'rank.json')
    const auditItems = itemsOf(normalized, 'audit.json', 'audit.json')
    if (!Array.isArray(auditItems.list)) problems.push('audit.json 的 items.list 必须是数组')
  } catch (e) {
    return { ok: false, problems: [e instanceof Error ? e.message : String(e)], warnings, repairs, counts: {}, data, normalized }
  }

  for (const [key, post] of Object.entries(posts)) {
    if (!isPlainObject(post)) { problems.push(`帖子 ${key} 不是对象`); continue }
    if (post.id !== key) problems.push(`帖子 ${key} 的 id 字段不一致`)
    if (typeof post.uid !== 'string' || !post.uid) problems.push(`帖子 ${key} 缺少 uid`)
    if (!POST_STATUSES.has(post.status)) problems.push(`帖子 ${key} 状态非法：${String(post.status)}`)
    if (!Array.isArray(post.versions)) {
      problems.push(`帖子 ${key} 缺少 versions 数组`)
    } else {
      const vids = new Set(post.versions.map((v) => (isPlainObject(v) ? String(v.vid || '') : '')).filter(Boolean))
      if (post.publishedVersionId && !vids.has(String(post.publishedVersionId))) {
        problems.push(`帖子 ${key} 的 publishedVersionId 不在 versions 中`)
      }
      if (post.pendingVersionId && !vids.has(String(post.pendingVersionId))) {
        problems.push(`帖子 ${key} 的 pendingVersionId 不在 versions 中`)
      }
    }
    if (!isPlainObject(post.counts)) problems.push(`帖子 ${key} 缺少 counts`)
  }

  const visibleByPost = new Map()
  for (const [key, c] of Object.entries(comments)) {
    if (!isPlainObject(c)) { problems.push(`评论 ${key} 不是对象`); continue }
    if (c.id !== key) problems.push(`评论 ${key} 的 id 字段不一致`)
    if (typeof c.postId !== 'string' || !c.postId) problems.push(`评论 ${key} 缺少 postId`)
    if (!COMMENT_STATUSES.has(c.status)) problems.push(`评论 ${key} 状态非法：${String(c.status)}`)
    if (typeof c.body !== 'string') problems.push(`评论 ${key} 缺少正文`)
    if (!posts[c.postId]) warnings.push(`评论 ${key} 指向不存在的帖子 ${String(c.postId)}（保留但不可达）`)
    if (c.status === 'visible') visibleByPost.set(c.postId, (visibleByPost.get(c.postId) || 0) + 1)
  }

  const upByPost = new Map()
  const downByPost = new Map()
  for (const [key, v] of Object.entries(votes)) {
    if (!isPlainObject(v)) { problems.push(`投票 ${key} 不是对象`); continue }
    if (typeof v.postId !== 'string' || !v.postId) problems.push(`投票 ${key} 缺少 postId`)
    if (v.value !== 1 && v.value !== -1) problems.push(`投票 ${key} 的值必须是 1 或 -1`)
    if (!posts[v.postId]) warnings.push(`投票 ${key} 指向不存在的帖子 ${String(v.postId)}（保留但不可达）`)
    if (v.value === 1) upByPost.set(v.postId, (upByPost.get(v.postId) || 0) + 1)
    if (v.value === -1) downByPost.set(v.postId, (downByPost.get(v.postId) || 0) + 1)
  }

  for (const [key, p] of Object.entries(normalized['profiles.json'].items)) {
    if (!isPlainObject(p)) { problems.push(`档案 ${key} 不是对象`); continue }
    if (typeof p.nickname !== 'string') problems.push(`档案 ${key} 缺少昵称字段`)
    for (const field of ['postDisplay', 'commentDisplay', 'rankDisplay']) {
      if (p[field] !== undefined && !DISPLAYS.has(p[field])) problems.push(`档案 ${key} 的 ${field} 非法`)
    }
  }

  for (const [key, row] of Object.entries(normalized['rank.json'].items)) {
    if (!isPlainObject(row)) { problems.push(`排行 ${key} 不是对象`); continue }
    if (typeof row.uid !== 'string' || !row.uid) problems.push(`排行 ${key} 缺少 uid`)
    if (!Number.isFinite(Number(row.netDelta))) problems.push(`排行 ${key} 的 netDelta 非数值`)
  }

  for (const [key, r] of Object.entries(normalized['reports.json'].items)) {
    if (!isPlainObject(r)) { problems.push(`举报/申诉 ${key} 不是对象`); continue }
    if (r.targetType !== 'post' && r.targetType !== 'comment') problems.push(`举报/申诉 ${key} 的 targetType 非法`)
    const targetExists = r.targetType === 'post' ? !!posts[r.targetId] : !!comments[r.targetId]
    if (!targetExists) warnings.push(`举报/申诉 ${key} 的目标 ${String(r.targetId)} 不存在（保留处理记录）`)
  }

  if (problems.length) {
    return { ok: false, problems, warnings, repairs, counts: {}, data, normalized }
  }

  // 计数漂移：以评论/投票表为权威重算备份副本（不改 live）
  for (const [id, post] of Object.entries(posts)) {
    const expectedComments = visibleByPost.get(id) || 0
    const expectedUp = upByPost.get(id) || 0
    const expectedDown = downByPost.get(id) || 0
    const curComments = countOf(post.counts?.comments)
    const curUp = countOf(post.counts?.up)
    const curDown = countOf(post.counts?.down)
    if (curComments !== expectedComments) {
      repairs.push({ postId: id, field: 'comments', from: curComments, to: expectedComments })
      post.counts = { ...post.counts, comments: expectedComments }
    }
    if (curUp !== expectedUp) {
      repairs.push({ postId: id, field: 'up', from: curUp, to: expectedUp })
      post.counts = { ...post.counts, up: expectedUp }
    }
    if (curDown !== expectedDown) {
      repairs.push({ postId: id, field: 'down', from: curDown, to: expectedDown })
      post.counts = { ...post.counts, down: expectedDown }
    }
  }

  const counts = {
    posts: Object.keys(posts).length,
    comments: Object.keys(comments).length,
    votes: Object.keys(votes).length,
    reports: Object.keys(normalized['reports.json'].items).length,
    profiles: Object.keys(normalized['profiles.json'].items).length,
    rank: Object.keys(normalized['rank.json'].items).length,
    audit: normalized['audit.json'].items.list.length,
  }
  return { ok: true, problems, warnings, repairs, counts, data, normalized }
}

/** 检查 live 目录（不写任何文件） */
export function inspectCommunity(root, io = defaultIO) {
  if (!io.exists(root)) return { ok: false, problems: ['社区目录不存在'], warnings: [], repairs: [], counts: {}, present: [], data: null, normalized: null }
  const read = readCommunityData(root, io)
  if (read.problems.length) {
    return { ok: false, problems: read.problems, warnings: [], repairs: [], counts: {}, present: read.present, data: read.data, normalized: null }
  }
  const v = validateSnapshot(read.data)
  return { ...v, present: read.present }
}

function stampOf(now) {
  // 精确到毫秒并加随机后缀：恢复/备份可能在同一秒内连续执行，目录名不能撞
  return `${new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 23)}-${randomBytes(2).toString('hex')}`
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 创建一致性备份。
 * @param {{root:string, dest:string, now?:number, keep?:number, io?:object}} opts
 *   dest 是最终备份目录（必须不存在）；调用方负责父目录存在。
 */
export function createBackup({ root, dest, now = Date.now(), keep = 0, io = defaultIO } = {}) {
  if (!root || !dest) return { ok: false, error: '缺少 root / dest' }
  if (io.exists(dest)) return { ok: false, error: '目标备份目录已存在，拒绝覆盖' }
  const inspect = inspectCommunity(root, io)
  if (!inspect.ok) return { ok: false, error: '社区数据未通过完整性检查，拒绝备份', problems: inspect.problems }

  const staging = `${dest}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  try {
    io.mkdir(staging)
    const files = {}
    for (const file of COMMUNITY_FILES) {
      const text = JSON.stringify(inspect.normalized[file], null, 2)
      const abs = join(staging, file)
      io.writeText(abs, text)
      files[file] = { bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Text(text) }
    }
    const manifest = {
      format: BACKUP_FORMAT,
      kind: 'community',
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      sourceName: basename(root),
      files,
      counts: inspect.counts,
      warnings: inspect.warnings,
      repairs: inspect.repairs,
    }
    io.writeText(join(staging, BACKUP_MANIFEST), JSON.stringify(manifest, null, 2))
    const verified = verifyBackup(staging, { io })
    if (!verified.ok) throw new Error(`备份自检失败：${verified.problems.join('；')}`)
    io.rename(staging, dest)
    const pruned = keep > 0 ? pruneOldBackups(dest, keep, io) : []
    return { ok: true, dir: dest, manifest, pruned }
  } catch (e) {
    try { io.rm(staging) } catch { /* 残留 tmp 不覆盖正式目录 */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 只清理由本工具生成、同父目录、名称以 community- 开头的旧备份 */
export function pruneOldBackups(dest, keep, io = defaultIO) {
  const parent = dirname(dest)
  let entries = []
  try { entries = io.readdir(parent) } catch { return [] }
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('community-'))
    .map((e) => join(parent, e.name))
    .filter((p) => p !== dest)
    .sort()
  const remove = dirs.slice(0, Math.max(0, dirs.length - keep))
  const pruned = []
  for (const p of remove) {
    try { io.rm(p); pruned.push(p) } catch { /* 单个删除失败不影响备份 */ }
  }
  return pruned
}

/**
 * 校验备份目录：清单、文件集合、逐文件哈希、结构、关联、计数。
 * 备份内的计数必须是修复后的一致状态；发现漂移即失败（不能拿不一致快照恢复）。
 */
export function verifyBackup(dir, { io = defaultIO } = {}) {
  const problems = []
  const warnings = []
  if (!io.exists(dir)) return { ok: false, problems: ['备份目录不存在'], warnings }
  let manifest
  try {
    manifest = JSON.parse(io.readText(join(dir, BACKUP_MANIFEST)))
  } catch (e) {
    return { ok: false, problems: [`清单不可读：${e instanceof Error ? e.message : String(e)}`], warnings }
  }
  if (!isPlainObject(manifest) || manifest.format !== BACKUP_FORMAT || manifest.kind !== 'community') {
    return { ok: false, problems: ['清单格式不支持'], warnings }
  }
  if (!isPlainObject(manifest.files)) return { ok: false, problems: ['清单缺少文件列表'], warnings }

  const expected = new Set(Object.keys(manifest.files))
  const actual = new Set(
    io.readdir(dir).filter((e) => e.isFile()).map((e) => e.name).filter((n) => n !== BACKUP_MANIFEST),
  )
  for (const name of expected) if (!actual.has(name)) problems.push(`备份缺少文件 ${name}`)
  for (const name of actual) if (!expected.has(name)) problems.push(`备份包含清单未列出的文件 ${name}`)
  for (const file of COMMUNITY_FILES) {
    if (!expected.has(file)) problems.push(`清单缺少社区文件 ${file}`)
  }

  for (const [name, meta] of Object.entries(manifest.files)) {
    const abs = join(dir, name)
    if (!io.exists(abs)) continue
    try {
      const bytes = io.stat(abs).size
      if (bytes !== Number(meta.bytes)) problems.push(`${name} 大小不符（清单 ${meta.bytes}，实际 ${bytes}）`)
      const hash = io.sha256(abs)
      if (hash !== meta.sha256) problems.push(`${name} 哈希不符（文件被修改）`)
    } catch (e) {
      problems.push(`${name} 无法读取：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (problems.length) return { ok: false, problems, warnings, manifest }

  const read = readCommunityData(dir, io)
  if (read.problems.length) return { ok: false, problems: read.problems, warnings, manifest }
  const v = validateSnapshot(read.data)
  if (!v.ok) return { ok: false, problems: v.problems, warnings: v.warnings, manifest }
  if (v.repairs.length) {
    return { ok: false, problems: [`备份内计数不一致（${v.repairs.length} 处），不是可恢复的一致快照`], warnings: v.warnings, manifest, repairs: v.repairs }
  }
  for (const key of Object.keys(v.counts)) {
    if (Number(manifest.counts?.[key]) !== Number(v.counts[key])) {
      problems.push(`清单统计与内容不一致：${key}（清单 ${manifest.counts?.[key]}，实际 ${v.counts[key]}）`)
    }
  }
  if (problems.length) return { ok: false, problems, warnings: v.warnings, manifest }
  return { ok: true, problems: [], warnings: v.warnings, manifest, counts: v.counts, data: v.data }
}

/**
 * 可见性差异。恢复旧快照会改变内容可见性时，必须让操作者显式接受。
 * @returns {Array<{type:string, postId:string, currentStatus?:string, backupStatus?:string, backupVisible?:boolean}>}
 */
export function diffVisibility(currentData, backupData) {
  const current = currentData?.['posts.json']?.items || {}
  const backup = backupData?.['posts.json']?.items || {}
  const changes = []
  for (const [id, b] of Object.entries(backup)) {
    const c = current[id]
    const backupVisible = snapshotPostVisible(b)
    if (!c) {
      changes.push({ type: 'restored-absent', postId: id, backupStatus: b.status, backupVisible })
      continue
    }
    const currentVisible = snapshotPostVisible(c)
    if (backupVisible && !currentVisible) {
      changes.push({ type: 'would-republish', postId: id, currentStatus: c.status, backupStatus: b.status })
    } else if (!backupVisible && currentVisible) {
      changes.push({ type: 'would-hide', postId: id, currentStatus: c.status, backupStatus: b.status })
    }
  }
  return changes
}

function writeSnapshotFiles(data, dir, io) {
  for (const file of COMMUNITY_FILES) {
    io.writeText(join(dir, file), JSON.stringify(data[file], null, 2))
  }
}

function copyDirFiles(from, to, io) {
  for (const ent of io.readdir(from)) {
    if (!ent.isFile()) continue
    io.copyFile(join(from, ent.name), join(to, ent.name))
  }
}

/**
 * 恢复备份（必须停写）。
 * @param {{
 *   backupDir:string, root:string, now?:number,
 *   stopConfirmed:boolean, acceptVisibilityChanges?:boolean, io?:object
 * }} opts
 */
export function restoreBackup({
  backupDir, root, now = Date.now(), stopConfirmed = false, acceptVisibilityChanges = false, io = defaultIO,
} = {}) {
  if (!stopConfirmed) {
    return { ok: false, code: 'STOP_REQUIRED', error: '恢复前必须停止社区写入；请停服务后重新执行并确认' }
  }
  const verified = verifyBackup(backupDir, { io })
  if (!verified.ok) {
    return { ok: false, code: 'BACKUP_INVALID', error: '备份未通过完整性校验，拒绝覆盖现有数据', problems: verified.problems }
  }
  const backupData = verified.data
  const current = io.exists(root) ? inspectCommunity(root, io) : null
  const changes = diffVisibility(current?.data, backupData)
  if (changes.length && !acceptVisibilityChanges) {
    return {
      ok: false, code: 'VISIBILITY_CHANGES',
      error: '恢复会改变内容可见性（可能重新公开已下架/删除内容）。核对清单后显式接受才能继续。',
      changes, warnings: verified.warnings,
    }
  }

  const ts = stampOf(now)
  const preRestoreDir = `${root}.pre-restore-${ts}`
  const staging = `${root}.restore-${ts}`
  const replaced = `${root}.replaced-${ts}`
  let preRestoreCreated = false
  let movedOld = false
  try {
    if (io.exists(root)) {
      io.mkdir(preRestoreDir)
      preRestoreCreated = true
      copyDirFiles(root, preRestoreDir, io)
    }
    io.mkdir(staging)
    writeSnapshotFiles(backupData, staging, io)
    const staged = validateSnapshot(readCommunityData(staging, io).data)
    if (!staged.ok || staged.repairs.length) throw new Error(`恢复副本自检失败：${[...staged.problems, ...(staged.repairs.length ? ['计数不一致'] : [])].join('；')}`)

    if (io.exists(root)) { io.rename(root, replaced); movedOld = true }
    try {
      io.rename(staging, root)
    } catch (e) {
      if (movedOld) { try { io.rename(replaced, root) } catch { /* 保留证据 */ } }
      throw e
    }
    if (movedOld) { try { io.rm(replaced) } catch { /* pre-restore 已保留 */ } }
    return {
      ok: true, restoredTo: root,
      preRestoreDir: preRestoreCreated ? preRestoreDir : '',
      changes, warnings: verified.warnings,
    }
  } catch (e) {
    try { io.rm(staging) } catch { /* ignore */ }
    return {
      ok: false, code: 'RESTORE_FAILED',
      error: e instanceof Error ? e.message : String(e),
      preRestoreDir: preRestoreCreated ? preRestoreDir : '',
      changes,
    }
  }
}