// ============ 投稿广场 · 存储层（JSON 原子读写） ============
//
// 【为什么又是 JSON】与 users.json 同一套理由：小范围社区、单进程、备份=拷目录。
// 数据规模边界写在 `COMMUNITY_CAPACITY`：超过就停新提交并提示，而不是把内存吃满。
//
// 🔴 一次写操作 = 一个文件的一次「读-改-写」，全程同步（Node 单线程下即互斥）。
//    调用方**不得**在两次写入之间 `await` 之后再写回旧快照 —— 那会覆盖别人刚写的内容。
// 🔴 所有文件都带 `version`，将来换结构可判断是否迁移；不认识的结构直接抛错，不静默重建空表。
// 🔴 可枚举性：公开接口永不返回 uid / 登录名。这里存 uid 是必要的内部关联，
//    但任何 `toPublic*` 都在 api 层做，store 只负责原样存取。

import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeTextAtomicSync, readJSONOr } from './atomic.mjs'
import { readFileSync } from 'node:fs'

export const COMMUNITY_CAPACITY = {
  /** 池上限：超过后新投稿/评论进入 503「容量已满」，不删旧内容 */
  maxPosts: 5000,
  maxComments: 50000,
  maxReports: 20000,
  /** 审计日志保留条数（环形，最新在前） */
  maxAudit: 5000,
  /** 单篇最多保留的历史版本数（超出丢最旧的草稿/被拒版本，已发布版本永不清） */
  maxVersions: 20,
}

const FILES = {
  posts: 'posts.json',
  comments: 'comments.json',
  votes: 'votes.json',
  reports: 'reports.json',
  profiles: 'profiles.json',
  rank: 'rank.json',
  audit: 'audit.json',
  state: 'state.json',
}

function emptyMap() {
  return { version: 1, items: {} }
}

const DEFAULT_STATE = {
  version: 1,
  squareOpen: true,
  postsOpen: true,
  commentsOpen: true,
  updatedAt: 0,
}

/**
 * @param {{
 *   root:string,
 *   writeText?: (abs:string, text:string)=>void,
 *   readText?: (abs:string)=>string,
 * }} opts root 即 `<DATA_DIR>/community`
 *   注入 writeText/readText 仅用于故障注入测试（默认仍是原子写与同步读）。
 */
export function createCommunityStore({
  root,
  writeText = writeTextAtomicSync,
  readText = (abs) => readFileSync(abs, 'utf8'),
} = {}) {
  if (!root) throw new Error('community store 需要 root 目录')

  /** 目录中实际存在的社区数据文件（用于区分「首次使用」与「文件意外丢失」） */
  function presentFiles() {
    try { return new Set(readdirSync(root).filter((n) => Object.values(FILES).includes(n))) }
    catch { return new Set() }
  }

  /**
   * 启动期完整性检查：
   *  - posts.json 丢失、但目录里还有其他社区文件 -> 拒绝启动。否则空表写回会让投稿整体蒸发。
   *  - comments.json 丢失、但帖子计数显示存在评论 -> 拒绝启动，要求从备份恢复。
   * 🔴 首次使用（目录为空）不触发；正常空社区也不会触发。
   */
  function assertCoreFiles() {
    const present = presentFiles()
    if (!present.has(FILES.posts) && present.size > 0) {
      throw new Error('社区核心文件 posts.json 缺失（目录中仍有其他社区数据）；请停写并从备份恢复，禁止用空表继续写入')
    }
    if (!present.has(FILES.posts) || present.has(FILES.comments)) return
    const r = readJSONOr(join(root, FILES.posts), readText)
    if (!r.ok) return // 损坏会由 load() 给出更明确的错误
    const commentRefs = Object.values(r.value?.items || {})
      .reduce((n, p) => n + (Number(p?.counts?.comments) || 0), 0)
    if (commentRefs > 0) {
      throw new Error('社区评论文件 comments.json 缺失，但帖子记录显示存在评论；请停写并从备份恢复')
    }
  }
  assertCoreFiles()

  // mtime 缓存：只对本进程读频繁的小文件生效；写后立即更新，避免读到旧内容
  const cache = new Map()
  function fileOf(key) {
    return join(root, FILES[key])
  }
  function load(key) {
    const abs = fileOf(key)
    let mtime = 0
    try { mtime = statSync(abs).mtimeMs } catch { mtime = 0 }
    const hit = cache.get(key)
    if (hit && hit.mtime === mtime && mtime !== 0) return hit.value

    const r = readJSONOr(abs, readText)
    if (r.ok) {
      const value = r.value
      if (!value || typeof value !== 'object' || typeof value.items !== 'object' || !value.items) {
        throw new Error(`社区数据文件结构无效：${FILES[key]}`)
      }
      cache.set(key, { mtime, value })
      return value
    }
    if (r.missing) {
      // 运行期间 posts.json 被误删：不能当成空社区继续写
      if (key === 'posts' && presentFiles().size > 0) {
        throw new Error('社区核心文件 posts.json 在运行期间缺失；请停写并从备份恢复')
      }
      const value = key === 'state' ? { ...DEFAULT_STATE, items: {} } : emptyMap()
      cache.set(key, { mtime: 0, value })
      return value
    }
    // 🔴 损坏必须炸：把损坏文件当空表写回 = 全站投稿蒸发
    throw new Error(`社区数据文件损坏（${FILES[key]}）：${r.error}`)
  }
  function save(key, value) {
    writeText(fileOf(key), JSON.stringify(value, null, 2))
    let mtime = 0
    try { mtime = statSync(fileOf(key)).mtimeMs } catch { mtime = 0 }
    cache.set(key, { mtime, value })
  }

  /**
   * 🔴 写失败或 fn 抛错时必须丢弃缓存：fn 直接改了缓存对象，若写盘失败后继续命中缓存，
   *    读接口会看到从未落盘的「幽灵数据」。丢缓存后下次从磁盘读回旧内容。
   */
  function mutate(key, fn) {
    const db = load(key)
    try {
      const result = fn(db)
      save(key, db)
      return result
    } catch (e) {
      cache.delete(key)
      throw e
    }
  }

  function newId(prefix) {
    return `${prefix}_${randomBytes(8).toString('hex')}`
  }

  /** 计数（用于容量闸与运维视图）；不扫正文 */
  function counts() {
    const posts = Object.keys(load('posts').items).length
    const comments = Object.keys(load('comments').items).length
    const reports = Object.keys(load('reports').items).length
    return { posts, comments, reports }
  }

  // ---------------- 状态开关 ----------------

  function getState() {
    const db = load('state')
    const src = db.items?.global || db
    return {
      squareOpen: src.squareOpen !== false,
      postsOpen: src.postsOpen !== false,
      commentsOpen: src.commentsOpen !== false,
      updatedAt: Number(src.updatedAt) || 0,
    }
  }
  function setState(patch) {
    return mutate('state', (db) => {
      db.items = db.items || {}
      db.items.global = { ...getStateOf(db), ...patch, updatedAt: Date.now() }
      db.version = 1
      return db.items.global
    })
  }
  function getStateOf(db) {
    const src = db.items?.global || db
    return {
      squareOpen: src.squareOpen !== false,
      postsOpen: src.postsOpen !== false,
      commentsOpen: src.commentsOpen !== false,
      updatedAt: Number(src.updatedAt) || 0,
    }
  }

  // ---------------- 投稿 ----------------

  function getPost(id) {
    return load('posts').items[String(id || '')] || null
  }
  function putPost(post) {
    return mutate('posts', (db) => { db.items[post.id] = post; return post })
  }
  function listPosts() {
    return Object.values(load('posts').items)
  }

  /** 按幂等令牌找已存在的投稿（网络重试 / 连点两次都不会产生第二篇） */
  function findPostByToken(uid, token) {
    if (!token) return null
    const t = load('posts').items
    for (const p of Object.values(t)) {
      if (p.uid === uid && p.clientToken && p.clientToken === token) return p
    }
    return null
  }

  // ---------------- 评论 ----------------

  function getComment(id) {
    return load('comments').items[String(id || '')] || null
  }
  function putComment(comment) {
    return mutate('comments', (db) => { db.items[comment.id] = comment; return comment })
  }
  function listCommentsOf(postId) {
    const items = load('comments').items
    const out = []
    for (const c of Object.values(items)) if (c.postId === postId) out.push(c)
    return out
  }
  function listCommentsByUid(uid) {
    return Object.values(load('comments').items).filter((c) => c.uid === uid)
  }

  // ---------------- 投票 ----------------

  function voteKey(postId, uid) {
    return `${postId}::${uid}`
  }
  function getVote(postId, uid) {
    return load('votes').items[voteKey(postId, uid)] || null
  }
  function setVote(postId, uid, value, now = Date.now()) {
    return mutate('votes', (db) => {
      const k = voteKey(postId, uid)
      if (!value) {
        if (db.items[k]) delete db.items[k]
        return null
      }
      const row = { postId, uid, value, updatedAt: now }
      db.items[k] = row
      return row
    })
  }
  /** 从评论表重算公开可见数（权威口径；与 post.counts.comments 漂移时以此为准） */
  function recountComments(postId) {
    let total = 0
    for (const c of Object.values(load('comments').items)) {
      if (c.postId === postId && c.status === 'visible') total++
    }
    return total
  }
  /** 从投票表重算，避免自增计数在并发下漂移 */
  function recountVotes(postId) {
    let up = 0
    let down = 0
    for (const v of Object.values(load('votes').items)) {
      if (v.postId !== postId) continue
      if (v.value === 1) up++
      else if (v.value === -1) down++
    }
    return { up, down }
  }
  function votesOfUser(uid) {
    return Object.values(load('votes').items).filter((v) => v.uid === uid)
  }

  // ---------------- 举报 ----------------

  function putReport(report) {
    return mutate('reports', (db) => { db.items[report.id] = report; return report })
  }
  function getReport(id) {
    return load('reports').items[String(id || '')] || null
  }
  function listReports() {
    return Object.values(load('reports').items)
  }
  /** 同一用户对同一目标只保留一条待处理记录（重复点击不刷屏）；`kind` 区分举报与申诉 */
  function findOpenReport(uid, targetType, targetId, kind = 'report') {
    for (const r of Object.values(load('reports').items)) {
      if (r.uid === uid && r.targetType === targetType && r.targetId === targetId
        && (r.kind || 'report') === kind
        && (r.status === 'open' || r.status === 'claimed')) return r
    }
    return null
  }

  // ---------------- 档案（昵称 / 匿名偏好 / 排行授权） ----------------

  function getProfile(uid) {
    return load('profiles').items[uid] || null
  }
  function putProfile(uid, patch) {
    return mutate('profiles', (db) => {
      const prev = db.items[uid] || {
        nickname: '',
        postDisplay: 'anonymous',
        commentDisplay: 'anonymous',
        rankDisplay: 'anonymous',
        rankOptIn: false,
        updatedAt: 0,
      }
      const next = { ...prev, ...patch, updatedAt: Date.now() }
      db.items[uid] = next
      return next
    })
  }
  function deleteProfileRank(uid) {
    return mutate('rank', (db) => {
      let removed = 0
      for (const [k, row] of Object.entries(db.items)) {
        if (row.uid === uid) { delete db.items[k]; removed++ }
      }
      return removed
    })
  }

  // ---------------- 排行上报 ----------------

  function rankKey(uid, deviceId, projectId, date) {
    return `${uid}::${deviceId}::${projectId}::${date}`
  }
  function getRankRow(uid, deviceId, projectId, date) {
    return load('rank').items[rankKey(uid, deviceId, projectId, date)] || null
  }
  function putRankRow(row) {
    return mutate('rank', (db) => {
      db.items[rankKey(row.uid, row.deviceId, row.projectId, row.date)] = row
      return row
    })
  }
  function listRankRows(uid) {
    return Object.values(load('rank').items).filter((r) => r.uid === uid)
  }
  function listAllRankRows() {
    return Object.values(load('rank').items)
  }

  // ---------------- 审计 ----------------

  function appendAudit(entry) {
    return mutate('audit', (db) => {
      const list = Array.isArray(db.items.list) ? db.items.list : []
      list.unshift({ ...entry, at: entry.at || Date.now(), id: entry.id || newId('a') })
      db.items.list = list.slice(0, COMMUNITY_CAPACITY.maxAudit)
      db.version = 1
      return db.items.list[0]
    })
  }
  function listAudit(limit = 50) {
    const list = load('audit').items.list
    return Array.isArray(list) ? list.slice(0, Math.max(1, Math.min(500, Number(limit) || 50))) : []
  }

  return {
    root,
    newId,
    counts,
    getState,
    setState,
    getPost,
    putPost,
    listPosts,
    findPostByToken,
    getComment,
    putComment,
    listCommentsOf,
    listCommentsByUid,
    getVote,
    setVote,
    recountComments,
    recountVotes,
    votesOfUser,
    putReport,
    getReport,
    listReports,
    findOpenReport,
    getProfile,
    putProfile,
    deleteProfileRank,
    getRankRow,
    putRankRow,
    listRankRows,
    listAllRankRows,
    appendAudit,
    listAudit,
    _files: FILES,
    _exists: () => existsSync(root),
  }
}