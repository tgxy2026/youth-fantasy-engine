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
import { readCommunityMeta, writeCommunityMeta, commentsFileVerdict } from './communityFiles.mjs'
import { acquireCommunityLock, releaseCommunityLock } from './communityLock.mjs'

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
  /**
   * 🔴 跨文件快照边界：先统一记录全部文件的 stat，再读取，最后统一对比。
   *    只在单文件读取前后对比，发现不了「读完 posts 后、读 comments 前」的交错写入。
   *    这是检测层；备份入口还要求显式停写（stopConfirmed），两者一起构成边界。
   */
  const baseline = new Map()
  for (const file of COMMUNITY_FILES) {
    const abs = join(root, file)
    if (!io.exists(abs)) continue
    try {
      const st = io.stat(abs)
      baseline.set(file, { mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      problems.push(`${file}: 无法读取文件状态`)
    }
  }
  for (const file of COMMUNITY_FILES) {
    if (!baseline.has(file)) continue
    const abs = join(root, file)
    try {
      const text = io.readText(abs)
      if (!text.trim()) throw new Error('文件内容为空')
      data[file] = JSON.parse(text)
      present.push(file)
    } catch (e) {
      problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (!problems.length) {
    const final = new Map()
    for (const file of COMMUNITY_FILES) {
      const abs = join(root, file)
      if (!io.exists(abs)) {
        if (baseline.has(file)) problems.push(`${file} 在快照读取期间消失`)
        continue
      }
      try {
        const st = io.stat(abs)
        final.set(file, { mtimeMs: st.mtimeMs, size: st.size })
      } catch {
        problems.push(`${file} 在快照读取期间无法读取`)
      }
    }
    for (const [file, st] of baseline) {
      const now = final.get(file)
      if (!now) continue
      if (now.mtimeMs !== st.mtimeMs || now.size !== st.size) {
        problems.push(`${file} 在快照读取期间发生变化（可能有并发写入）`)
      }
    }
    for (const file of final.keys()) {
      if (!baseline.has(file)) problems.push(`${file} 在快照读取期间出现`)
    }
  }
  return { data, present, problems }
}

/** 核心文件存在性：区分「首次使用」「历史从未评论」与「无法证明安全」 */
function coreFileProblems(root, present, data) {
  const problems = []
  if (!present.includes('posts.json') && present.length > 0) {
    problems.push('社区核心文件 posts.json 缺失（目录中仍有其他社区数据），拒绝检查/备份')
    return problems
  }
  if (present.includes('comments.json')) return problems
  const verdict = commentsFileVerdict({
    present,
    postsItems: data?.['posts.json']?.items || {},
    meta: readCommunityMeta(root),
  })
  if (!verdict.ok) problems.push(verdict.message)
  return problems
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
  let voteSeq = 0
  for (const [, v] of Object.entries(votes)) {
    voteSeq++
    if (!isPlainObject(v)) { problems.push(`投票记录 #${voteSeq} 不是对象`); continue }
    if (typeof v.postId !== 'string' || !v.postId) problems.push(`投票记录 #${voteSeq} 缺少 postId`)
    if (v.value !== 1 && v.value !== -1) problems.push(`投票记录 #${voteSeq} 的值必须是 1 或 -1`)
    if (!posts[v.postId]) warnings.push(`投票记录指向不存在的帖子 ${String(v.postId)}（保留但不可达）`)
    if (v.value === 1) upByPost.set(v.postId, (upByPost.get(v.postId) || 0) + 1)
    if (v.value === -1) downByPost.set(v.postId, (downByPost.get(v.postId) || 0) + 1)
  }

  let profileSeq = 0
  for (const [, p] of Object.entries(normalized['profiles.json'].items)) {
    profileSeq++
    if (!isPlainObject(p)) { problems.push(`档案 #${profileSeq} 不是对象`); continue }
    if (typeof p.nickname !== 'string') problems.push(`档案 #${profileSeq} 缺少昵称字段`)
    for (const field of ['postDisplay', 'commentDisplay', 'rankDisplay']) {
      if (p[field] !== undefined && !DISPLAYS.has(p[field])) problems.push(`档案 #${profileSeq} 的 ${field} 非法`)
    }
  }

  let rankSeq = 0
  for (const [, row] of Object.entries(normalized['rank.json'].items)) {
    rankSeq++
    if (!isPlainObject(row)) { problems.push(`排行 #${rankSeq} 不是对象`); continue }
    if (typeof row.uid !== 'string' || !row.uid) problems.push(`排行 #${rankSeq} 缺少 uid`)
    if (!Number.isFinite(Number(row.netDelta))) problems.push(`排行 #${rankSeq} 的 netDelta 非数值`)
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

/**
 * 检查 live 目录（不写任何文件）。
 * 🔴 默认只返回对外诊断（统计/问题/警告），不返回 data / normalized；
 *    需要内部快照的调用方（备份）必须显式传 includeData: true。
 * @param {string} root
 * @param {{io?:object, includeData?:boolean}|object} [options] 兼容旧签名（直接传 io）
 */
export function inspectCommunity(root, options = {}) {
  const io = options.io || (typeof options.exists === 'function' ? options : defaultIO)
  const includeData = options.includeData === true
  if (!io.exists(root)) {
    return { ok: false, problems: ['社区目录不存在'], warnings: [], repairs: [], counts: {}, present: [] }
  }
  const read = readCommunityData(root, io)
  const coreProblems = coreFileProblems(root, read.present, read.data)
  const problems = [...read.problems, ...coreProblems]
  if (problems.length) {
    const result = { ok: false, problems, warnings: [], repairs: [], counts: {}, present: read.present }
    if (includeData) result.data = read.data
    return result
  }
  const v = validateSnapshot(read.data)
  const result = { ...v, present: read.present }
  if (!includeData) { delete result.data; delete result.normalized }
  return result
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
 * @param {{root:string, dest:string, now?:number, keep?:number, io?:object, stopConfirmed?:boolean}} opts
 *   dest 是最终备份目录（必须不存在）；调用方负责父目录存在。
 *   stopConfirmed 必须为 true：备份是停写快照，不宣称可以热备。
 */
export function createBackup(opts = {}) {
  if (!opts.root) return { ok: false, error: '缺少 root / dest' }
  const lock = acquireCommunityLock(opts.root, { tool: 'backup' })
  if (!lock.ok) {
    return {
      ok: false, code: lock.code,
      error: lock.code === 'STALE_LOCK'
        ? '存在疑似残留的备份锁；核对进程后使用 unlock --confirm-stale，不自动删除'
        : '社区备份/恢复锁已被占用，拒绝并发备份',
      lock: lock.lock,
    }
  }
  try { return createBackupUnlocked(opts) } finally { releaseCommunityLock(opts.root) }
}

function createBackupUnlocked({ root, dest, now = Date.now(), keep = 0, io = defaultIO, stopConfirmed = false } = {}) {
  if (!root || !dest) return { ok: false, error: '缺少 root / dest' }
  if (!stopConfirmed) {
    return { ok: false, code: 'STOP_REQUIRED', error: '备份前必须停止社区写入；停服务后加 --confirm-stopped 重新执行' }
  }
  if (io.exists(dest)) return { ok: false, error: '目标备份目录已存在，拒绝覆盖' }
  const inspect = inspectCommunity(root, { io, includeData: true })
  if (!inspect.ok) {
    const concurrent = inspect.problems.some((p) => p.includes('并发写入') || p.includes('快照读取期间'))
    return {
      ok: false,
      code: concurrent ? 'CONCURRENT_WRITE' : 'INVALID_DATA',
      error: concurrent ? '备份读取期间检测到并发写入，拒绝把混合快照标成成功' : '社区数据未通过完整性检查，拒绝备份',
      problems: inspect.problems,
    }
  }

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
      sourceName: 'community',
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

/**
 * 采纳「历史社区从未写入过评论」：只在操作人明确确认后补空 comments.json + 标记。
 * 🔴 标记为 true（评论曾初始化）时拒绝；已有 comments.json 时拒绝。
 * 这不是自动修复，也不代表能证明数据没丢；只是把人工核对结果持久化。
 */
export function adoptEmptyComments({ root, now = Date.now(), confirm = false, io = defaultIO } = {}) {
  if (!root) return { ok: false, error: '缺少 root' }
  if (!confirm) return { ok: false, code: 'CONFIRM_REQUIRED', error: '必须显式确认该社区从未写入过评论，才能补空 comments.json' }
  const commentsPath = join(root, 'comments.json')
  if (io.exists(commentsPath)) return { ok: false, code: 'COMMENTS_EXISTS', error: 'comments.json 已存在，不需要采纳空评论' }
  const meta = readCommunityMeta(root)
  if (meta && meta.commentsInitialized === true) {
    return { ok: false, code: 'COMMENTS_WERE_INITIALIZED', error: '该社区的评论文件曾初始化；当前缺失应视为丢失，请从备份恢复，禁止补空' }
  }
  if (!io.exists(join(root, 'posts.json'))) return { ok: false, code: 'POSTS_MISSING', error: 'posts.json 不存在；首次初始化不应使用采纳命令' }
  io.writeText(commentsPath, JSON.stringify({ version: 1, items: {} }, null, 2))
  writeCommunityMeta(root, { commentsInitialized: false, createdAt: now, adoptedAt: now }, io.writeText)
  return { ok: true, adopted: true, note: '已补空 comments.json；该社区被标记为从未写入评论，请保留本次人工核对记录' }
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
export function verifyBackup(dir, { io = defaultIO, includeData = false, usersFile = '' } = {}) {
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
  warnings.push(...v.warnings)

  /**
   * 账号关联核对（可选）：社区与 users.json 分属不同文件，恢复顺序应先账号后社区。
   * 只报告「多少个引用找不到账号」，不输出 uid/登录名；找不到账号的内容仍保留。
   */
  if (usersFile) {
    try {
      const db = JSON.parse(io.readText(usersFile))
      const known = new Set(Object.keys(db?.users || {}))
      const uids = new Set()
      for (const post of Object.values(v.data['posts.json'].items || {})) if (post?.uid) uids.add(post.uid)
      for (const c of Object.values(v.data['comments.json'].items || {})) if (c?.uid) uids.add(c.uid)
      for (const uid of Object.keys(v.data['profiles.json'].items || {})) uids.add(uid)
      for (const row of Object.values(v.data['rank.json'].items || {})) if (row?.uid) uids.add(row.uid)
      let missing = 0
      for (const uid of uids) if (!known.has(uid)) missing++
      if (missing > 0) {
        warnings.push(`社区记录引用 ${missing} 个当前用户表中不存在的账号（内容保留；昵称/作者功能可能不可用）`)
      }
    } catch {
      warnings.push('用户表不可读；未核对账号关联')
    }
  }

  const result = { ok: true, problems: [], warnings, manifest, counts: v.counts }
  if (includeData) result.data = v.data
  return result
}

/**
 * 恢复影响差异（双向）：
 *   · 备份可见、当前不可见 -> would-republish（可能重新公开已下架内容）
 *   · 备份不可见、当前可见 -> would-hide
 *   · 当前有、备份没有     -> would-remove（恢复后当前新增内容会消失）
 *   · 同 id 但版本/展示不同 -> content-changed（恢复会回退当前编辑）
 *   · 评论/投票/举报/档案/排行当前独有 -> records-not-in-backup
 * 🔴 只输出不透明 postId / 计数与状态，不输出正文、uid、昵称或登录名。
 * @returns {{changes:Array<object>, summary:object}}
 */
export function diffVisibility(currentData, backupData) {
  const current = currentData?.['posts.json']?.items || {}
  const backup = backupData?.['posts.json']?.items || {}
  const currentComments = currentData?.['comments.json']?.items || {}
  const backupComments = backupData?.['comments.json']?.items || {}
  const changes = []
  const summary = {
    postsRemoved: 0, postsContentChanged: 0, comments: 0,
    commentStatusChanges: 0, commentContentChanges: 0, commentDisplayChanges: 0,
    commentRestored: 0, commentRemoved: 0,
    votes: 0, reports: 0, profiles: 0, rank: 0, auditRemoved: 0,
    reportsChanged: 0, profilesChanged: 0, rankChanged: 0, votesChanged: 0,
  }
  const contentFingerprint = (post) => JSON.stringify({
    display: post?.display || '',
    versions: Array.isArray(post?.versions)
      ? post.versions.map((v) => [v?.vid, v?.title, v?.body, v?.tags])
      : [],
  })
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
    } else if (contentFingerprint(c) !== contentFingerprint(b)) {
      changes.push({ type: 'content-changed', postId: id, currentStatus: c.status, backupStatus: b.status })
      summary.postsContentChanged++
    }
  }
  for (const [id, c] of Object.entries(current)) {
    if (backup[id]) continue
    changes.push({ type: 'would-remove', postId: id, currentStatus: c.status, currentVisible: snapshotPostVisible(c) })
    summary.postsRemoved++
  }

  // 评论：同 ID 的状态/正文/展示方式变化，以及当前/备份独有的评论
  for (const [id, b] of Object.entries(backupComments)) {
    const c = currentComments[id]
    if (!c) {
      changes.push({ type: 'comment-restored-absent', commentId: id, backupStatus: b.status })
      summary.commentRestored++
      continue
    }
    if (String(c.status || '') !== String(b.status || '')) {
      changes.push({ type: 'comment-status-changed', commentId: id, currentStatus: c.status, backupStatus: b.status })
      summary.commentStatusChanges++
    }
    if (String(c.body || '') !== String(b.body || '')) {
      changes.push({ type: 'comment-content-changed', commentId: id })
      summary.commentContentChanges++
    }
    if ((c.display || 'anonymous') !== (b.display || 'anonymous')) {
      changes.push({ type: 'comment-display-changed', commentId: id })
      summary.commentDisplayChanges++
    }
  }
  for (const [id, c] of Object.entries(currentComments)) {
    if (backupComments[id]) continue
    changes.push({ type: 'comment-would-remove', commentId: id, currentStatus: c.status })
    summary.commentRemoved++
    summary.comments++
  }

  // 关联记录：当前独有数量（原口径）+ 同 ID 状态/内容变化的计数（不输出 uid/正文）
  for (const file of ['votes.json', 'reports.json', 'profiles.json', 'rank.json']) {
    const cur = currentData?.[file]?.items || {}
    const bak = backupData?.[file]?.items || {}
    const count = Object.keys(cur).filter((key) => !bak[key]).length
    summary[file.replace('.json', '')] = count
    if (count > 0) changes.push({ type: 'records-not-in-backup', file, count })
  }
  const reportFingerprint = (r) => JSON.stringify({ status: r?.status || '', kind: r?.kind || '' })
  for (const [id, b] of Object.entries(backupData?.['reports.json']?.items || {})) {
    const c = currentData?.['reports.json']?.items?.[id]
    if (c && reportFingerprint(c) !== reportFingerprint(b)) summary.reportsChanged++
  }
  const profileFingerprint = (p) => JSON.stringify({
    nickname: p?.nickname || '', postDisplay: p?.postDisplay || '', commentDisplay: p?.commentDisplay || '',
    rankDisplay: p?.rankDisplay || '', rankOptIn: !!p?.rankOptIn,
  })
  for (const [id, b] of Object.entries(backupData?.['profiles.json']?.items || {})) {
    const c = currentData?.['profiles.json']?.items?.[id]
    if (c && profileFingerprint(c) !== profileFingerprint(b)) summary.profilesChanged++
  }
  for (const [key, b] of Object.entries(backupData?.['rank.json']?.items || {})) {
    const c = currentData?.['rank.json']?.items?.[key]
    if (c && Number(c.netDelta) !== Number(b.netDelta)) summary.rankChanged++
  }
  for (const [key, b] of Object.entries(backupData?.['votes.json']?.items || {})) {
    const c = currentData?.['votes.json']?.items?.[key]
    if (c && Number(c.value) !== Number(b.value)) summary.votesChanged++
  }
  const currentAudit = currentData?.['audit.json']?.items?.list || []
  const backupAuditIds = new Set((backupData?.['audit.json']?.items?.list || []).map((e) => e?.id))
  summary.auditRemoved = currentAudit.filter((e) => !backupAuditIds.has(e?.id)).length
  if (summary.reportsChanged) changes.push({ type: 'reports-changed', count: summary.reportsChanged })
  if (summary.profilesChanged) changes.push({ type: 'profiles-changed', count: summary.profilesChanged })
  if (summary.rankChanged) changes.push({ type: 'rank-changed', count: summary.rankChanged })
  if (summary.votesChanged) changes.push({ type: 'votes-changed', count: summary.votesChanged })
  if (summary.auditRemoved) changes.push({ type: 'audit-not-in-backup', count: summary.auditRemoved })
  return { changes, summary }
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
export function restoreBackup(opts = {}) {
  if (!opts.root) return { ok: false, code: 'NO_ROOT', error: '缺少 root' }
  const lock = acquireCommunityLock(opts.root, { tool: 'restore' })
  if (!lock.ok) {
    return {
      ok: false, code: lock.code,
      error: lock.code === 'STALE_LOCK'
        ? '存在疑似残留的备份锁；核对进程后使用 unlock --confirm-stale，不自动删除'
        : '社区备份/恢复锁已被占用，拒绝并发恢复',
      lock: lock.lock,
    }
  }
  try { return restoreBackupUnlocked(opts) } finally { releaseCommunityLock(opts.root) }
}

function restoreBackupUnlocked({
  backupDir, root, now = Date.now(), stopConfirmed = false, acceptVisibilityChanges = false, io = defaultIO,
} = {}) {
  if (!stopConfirmed) {
    return { ok: false, code: 'STOP_REQUIRED', error: '恢复前必须停止社区写入；请停服务后重新执行并确认' }
  }
  const verified = verifyBackup(backupDir, { io, includeData: true })
  if (!verified.ok) {
    return { ok: false, code: 'BACKUP_INVALID', error: '备份未通过完整性校验，拒绝覆盖现有数据', problems: verified.problems }
  }
  const backupData = verified.data
  const current = io.exists(root) ? inspectCommunity(root, { io, includeData: true }) : null
  const diff = diffVisibility(current?.data, backupData)
  const changes = diff.changes
  const summary = diff.summary
  const hasImpact = changes.length > 0 || Object.values(summary).some((n) => Number(n) > 0)
  if (hasImpact && !acceptVisibilityChanges) {
    return {
      ok: false, code: 'VISIBILITY_CHANGES',
      error: '恢复会移除/改变当前内容或改变可见性。核对清单后显式接受才能继续。',
      changes, summary, warnings: verified.warnings,
    }
  }

  const ts = stampOf(now)
  const preRestoreDir = `${root}.pre-restore-${ts}`
  const staging = `${root}.restore-${ts}`
  const replaced = `${root}.replaced-${ts}`
  let preRestoreCreated = false
  let movedOld = false
  const liveStampOf = () => {
    const out = {}
    for (const file of COMMUNITY_FILES) {
      const abs = join(root, file)
      if (!io.exists(abs)) continue
      try { const st = io.stat(abs); out[file] = `${st.mtimeMs}:${st.size}` } catch { out[file] = 'unreadable' }
    }
    return out
  }
  const stampsEqual = (a, b) => {
    const ka = Object.keys(a)
    if (ka.length !== Object.keys(b).length) return false
    return ka.every((key) => a[key] === b[key])
  }
  const beforeStamps = io.exists(root) ? liveStampOf() : null
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

    // 停写确认仍可能被误用：切换前再检查 live 是否被写入
    if (beforeStamps && !stampsEqual(beforeStamps, liveStampOf())) {
      throw new Error('恢复准备期间检测到 live 数据变化（可能有并发写入）；已中止，未切换目录')
    }
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
      changes, summary, warnings: verified.warnings,
    }
  } catch (e) {
    try { io.rm(staging) } catch { /* ignore */ }
    return {
      ok: false, code: 'RESTORE_FAILED',
      error: e instanceof Error ? e.message : String(e),
      preRestoreDir: preRestoreCreated ? preRestoreDir : '',
      changes, summary,
    }
  }
}