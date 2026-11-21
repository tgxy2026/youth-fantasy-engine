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
//
// 【分层 · 3.5.3 P1-C】文件访问 + mtime 缓存 + 失败关闭守卫（load/save/mutate + 启动完整性检查）
//   已外抽到叶子 communityDocStore.mjs（可单独验证）；本文件只保留业务操作（投稿/评论/投票/举报/档案/排行/审计），
//   经引擎的 load/mutate 取用。对外接口与磁盘格式逐字不变。

import { existsSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { writeTextAtomicSync } from './atomic.mjs'
import { createCommunityDocStore } from './communityDocStore.mjs'
import { assertServiceStartable, isCommunityLocked } from './communityLock.mjs'
import { readFileSync } from 'node:fs'
import { allocateAnonymousHandle, anonymousWeekKey, anonymousRankWeeks, validAnonymousWeek, validAnonymousHandle, BEAST_DICTIONARY_SHA256 } from './communityAnon.mjs'

export const COMMUNITY_CAPACITY = {
  /** 池上限：超过后新投稿/评论进入 503「容量已满」，不删旧内容 */
  maxPosts: 5000,
  maxComments: 50000,
  maxReports: 20000,
  /** 合集上限（3.6.2）：与「每人 20 个」是两道闸，这道防的是全站被少数账号刷满 */
  maxCollections: 400,
  /** 审计日志保留条数（环形，最新在前） */
  maxAudit: 5000,
  /** 单篇最多保留的历史版本数（超出丢最旧的草稿/被拒版本，已发布版本永不清） */
  maxVersions: 20,
}

/**
 * 浏览量口径常量（3.6.2）。
 * 🔴 这三个数字是**产品口径**，不是随手写的性能参数：
 *    · `VIEW_WINDOW_MS` 24 小时：同一人一天内反复打开只算一次，跨天再读算新一次；
 *    · `VIEW_FLUSH_MS` 30 秒：浏览量靠内存累积后合并落盘，不每次读写整库；
 *    · `VIEW_FLUSH_MAX` 200 次脏计数：热门篇目不必等到 30 秒才落盘。
 *    代价见 `flushViews()` 的注释：进程被强杀最多丢一个窗口的计数。
 */
const VIEW_WINDOW_MS = 24 * 3600 * 1000
const VIEW_FLUSH_MS = 30 * 1000
const VIEW_FLUSH_MAX = 200
/** 去重记录上限（内存环形）；超了淘汰最旧的，重启即清 —— 丢的是"少算一次"而不是算错 */
const VIEW_SEEN_MAX = 20000

const FILES = {
  posts: 'posts.json',
  comments: 'comments.json',
  votes: 'votes.json',
  reports: 'reports.json',
  profiles: 'profiles.json',
  rank: 'rank.json',
  audit: 'audit.json',
  state: 'state.json',
  /** 合集（3.6.2）。缺失时按 `{version:1,items:{}}` 初始化，不影响老库启动检查 */
  collections: 'collections.json',
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
  anonSecret = null,
} = {}) {
  if (!root) throw new Error('community store 需要 root 目录')

  assertServiceStartable(root)
  const { load, mutate, assertCoreFiles } = createCommunityDocStore({
    root, files: FILES, readText, writeText, defaultState: DEFAULT_STATE,
  })
  assertCoreFiles()

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

  // ---------------- 合集（3.6.2） ----------------
  //
  // 🔴 关系**只存一侧**：帖子记 `collectionId`，合集**不存** postIds。
  //    理由：本存储是「整文件读改写」、没有事务；两处存同一关系必然有一次写失败导致不一致
  //    （帖子说在 A、合集里却没有它）。单向存 + 反查排序，只有一个写点，坏不了。

  function getCollection(id) {
    return load('collections').items[String(id || '')] || null
  }
  function putCollection(collection) {
    return mutate('collections', (db) => { db.items[collection.id] = collection; return collection })
  }
  function listCollectionsByUid(uid) {
    return Object.values(load('collections').items).filter((c) => c.uid === uid)
  }
  function countCollections() {
    return Object.keys(load('collections').items).length
  }
  function countCollectionsOf(uid) {
    return listCollectionsByUid(uid).length
  }
  function listPostsOfCollection(collectionId) {
    return Object.values(load('posts').items).filter((p) => p.collectionId === collectionId)
  }
  /**
   * 把帖子挂进合集 / 移出（`collectionId` 传空串 = 移出）。
   * 🔴 这是「把历史稿件移到合集里」的唯一入口：不要求帖子是新建的，老稿件同样适用，
   *    也不要求它以前有浏览量 —— 浏览量从挂上之后开始累积即可。
   * @returns 更新后的帖子；帖子不存在返回 null
   */
  function setPostCollection(postId, collectionId, order = 0) {
    return mutate('posts', (db) => {
      const p = db.items[String(postId)]
      if (!p) return null
      if (collectionId) {
        p.collectionId = collectionId
        p.collectionOrder = Number(order) || 0
      } else {
        delete p.collectionId
        delete p.collectionOrder
      }
      return p
    })
  }
  /**
   * 删合集前先解绑篇目。
   * 🔴 两步无法原子（跨两个文件）。**必须先解绑、再删合集**：
   *    反过来的话，帖子会指向一个不存在的合集（公开页空白、且没人知道该修哪）。
   *    这个方向的失败最坏只是「合集还在、篇目已解绑」，作者重试删一次即可。
   */
  function clearCollectionPosts(collectionId) {
    return mutate('posts', (db) => {
      let n = 0
      for (const p of Object.values(db.items)) {
        if (p.collectionId === collectionId) {
          delete p.collectionId
          delete p.collectionOrder
          n++
        }
      }
      return n
    })
  }
  function deleteCollection(id) {
    return mutate('collections', (db) => {
      if (!db.items[id]) return false
      delete db.items[id]
      return true
    })
  }
  /** 手动排序：顺序即数组下标；只动本合集内的帖子 */
  function reorderCollection(collectionId, postIds) {
    return mutate('posts', (db) => {
      let n = 0
      postIds.forEach((pid, i) => {
        const p = db.items[String(pid)]
        if (p && p.collectionId === collectionId) { p.collectionOrder = i; n++ }
      })
      return n
    })
  }

  // ---------------- 浏览量（3.6.2） ----------------
  //
  // 🔴 绝不每次浏览都落盘：`posts.json` 是整文件读改写，一篇热门投稿若每次浏览都写，
  //    等于每次浏览都重写全库 JSON。做法是内存累加 + 合并写（30s 或 200 次）——
  //    代价是进程被强杀时最多丢一个窗口的计数，可接受（浏览量丢几条不影响任何判断）。

  /** postId -> 待落盘的增量 */
  const viewDirty = new Map()
  let viewDirtyTotal = 0
  let viewTimer = null
  /** `${postId}::${viewerKey}` -> 上次计数时间（内存，重启即清） */
  const viewSeen = new Map()

  function scheduleViewFlush() {
    if (viewTimer) return
    viewTimer = setTimeout(() => { viewTimer = null; flushViews() }, VIEW_FLUSH_MS)
    // 不吊住进程退出（Node 测试与优雅关闭都需要）
    if (typeof viewTimer.unref === 'function') viewTimer.unref()
  }

  /** 把脏计数合并进 posts.json；失败时放回队列，**绝不让阅读报错** */
  function flushViews() {
    if (viewDirty.size === 0) return { flushed: 0, posts: 0 }
    const snapshot = [...viewDirty.entries()]
    viewDirty.clear()
    viewDirtyTotal = 0
    try {
      mutate('posts', (db) => {
        for (const [id, n] of snapshot) {
          const p = db.items[id]
          if (p) p.views = (Number(p.views) || 0) + n
        }
      })
      return { flushed: snapshot.reduce((s, [, n]) => s + n, 0), posts: snapshot.length }
    } catch (e) {
      for (const [id, n] of snapshot) viewDirty.set(id, (viewDirty.get(id) || 0) + n)
      viewDirtyTotal += snapshot.reduce((s, [, n]) => s + n, 0)
      return { flushed: 0, posts: 0, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 记一次浏览；返回是否真的计数（去重后）。
   * @param {{uid?:string, visitorKey?:string}} viewer
   *   uid：已登录账号；visitorKey：游客的「IP+UA 哈希」（**api 层算，store 不碰原始 IP**）
   */
  function recordView(postId, viewer = {}) {
    const post = getPost(postId)
    if (!post) return false
    const uid = String(viewer.uid || '')
    // 作者本人不计：自己反复打开不该涨自己的数
    if (uid && post.uid === uid) return false
    const key = uid ? `u:${uid}` : (viewer.visitorKey ? `k:${viewer.visitorKey}` : '')
    if (!key) return false
    const now = Date.now()
    const seenKey = `${post.id}::${key}`
    const last = viewSeen.get(seenKey)
    if (last && now - last < VIEW_WINDOW_MS) return false
    if (viewSeen.size >= VIEW_SEEN_MAX) {
      const oldest = viewSeen.keys().next().value
      if (oldest) viewSeen.delete(oldest)
    }
    viewSeen.set(seenKey, now)
    viewDirty.set(post.id, (viewDirty.get(post.id) || 0) + 1)
    viewDirtyTotal += 1
    if (viewDirtyTotal >= VIEW_FLUSH_MAX) flushViews()
    else scheduleViewFlush()
    return true
  }

  /** 测试与优雅关闭用：立刻落盘并返回结果 */
  function flushViewsNow() {
    if (viewTimer) { clearTimeout(viewTimer); viewTimer = null }
    return flushViews()
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
  const anonKeyId = Buffer.isBuffer(anonSecret) && anonSecret.length >= 32
    ? createHash('sha256').update(anonSecret).digest('hex') : ''
  function anonymousError(message) { const e = new Error(message); e.code = 'COMMUNITY_ANON_UNAVAILABLE'; return e }
  function anonymousEnabled() { return !!anonKeyId }
  function getAnonymousHandle(uid, weekKey) {
    if (!anonKeyId) throw anonymousError('匿名代号密钥未配置')
    const p = getProfile(uid)
    if (p?.anonKeyId !== anonKeyId || p?.anonDict !== BEAST_DICTIONARY_SHA256 || !validAnonymousWeek(weekKey) || !validAnonymousHandle(p?.anonHandles?.[weekKey])) {
      throw anonymousError('匿名代号映射缺失或版本不匹配；请停写并核对迁移与备份')
    }
    return p.anonHandles[weekKey]
  }
  function ensureAnonymousHandle(uid, weekKey) {
    if (!anonKeyId) throw anonymousError('匿名代号密钥未配置')
    const existing = getProfile(uid)
    if (existing?.anonHandles?.[weekKey]) return getAnonymousHandle(uid, weekKey)
    return mutate('profiles', (db) => {
      const prev = db.items[uid] || { nickname: '', postDisplay: 'anonymous', commentDisplay: 'anonymous', rankDisplay: 'anonymous', rankOptIn: false, updatedAt: 0 }
      if ((prev.anonKeyId && prev.anonKeyId !== anonKeyId) || (prev.anonDict && prev.anonDict !== BEAST_DICTIONARY_SHA256)) throw anonymousError('匿名代号密钥或词表版本不匹配')
      const mapping = { [weekKey]: {} }
      const occupied = new Set()
      for (const [otherId, profile] of Object.entries(db.items)) {
        const handle = profile?.anonHandles?.[weekKey]
        if (handle !== undefined) {
          if (profile.anonKeyId !== anonKeyId || profile.anonDict !== BEAST_DICTIONARY_SHA256 || !validAnonymousHandle(handle) || occupied.has(handle)) throw anonymousError('匿名代号映射损坏或版本不匹配')
          occupied.add(handle)
          mapping[weekKey][otherId] = handle
        }
      }
      const allocated = allocateAnonymousHandle(mapping, uid, weekKey, anonSecret)
      db.items[uid] = { ...prev, anonKeyId, anonDict: BEAST_DICTIONARY_SHA256, anonHandles: { ...prev.anonHandles, [weekKey]: allocated.handle } }
      return allocated.handle
    })
  }
  function assertAnonymousMappings() {
    const profiles = load('profiles').items
    if (!anonKeyId) {
      if (Object.values(profiles).some((p) => p?.anonHandles && Object.keys(p.anonHandles).length)) throw new Error('已有匿名代号映射，但密钥未配置；拒绝以旧模式启动')
      return
    }
    const occupied = new Set()
    for (const p of Object.values(profiles)) {
      if (!p?.anonHandles) continue
      if (p.anonKeyId !== anonKeyId || p.anonDict !== BEAST_DICTIONARY_SHA256 || typeof p.anonHandles !== 'object' || Array.isArray(p.anonHandles)) throw new Error('匿名代号映射损坏或版本不匹配')
      for (const [week, handle] of Object.entries(p.anonHandles)) {
        const key = `${week}\0${handle}`
        if (!validAnonymousWeek(week) || !validAnonymousHandle(handle) || occupied.has(key)) throw new Error('匿名代号映射损坏或存在冲突')
        occupied.add(key)
      }
    }
    for (const post of listPosts()) if (!post.isExample) getAnonymousHandle(post.uid, anonymousWeekKey(post.createdAt))
    for (const comment of Object.values(load('comments').items)) getAnonymousHandle(comment.uid, anonymousWeekKey(comment.createdAt))
    for (const row of listAllRankRows()) for (const week of anonymousRankWeeks(row.date)) getAnonymousHandle(row.uid, week)
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
      const now = Date.now()
      const nicknameChanged = Object.hasOwn(patch, 'nickname') && patch.nickname !== prev.nickname
      if (nicknameChanged && Object.hasOwn(prev, 'nicknameChangedAt')) {
        const last = prev.nicknameChangedAt
        if (!Number.isSafeInteger(last) || last <= 0 || last > now) {
          const e = new Error('昵称修改时间异常，请联系管理员核查')
          e.code = 'NICKNAME_TIME_INVALID'
          throw e
        }
        const remaining = last + 7 * 24 * 60 * 60 * 1000 - now
        if (remaining > 0) {
          const e = new Error('昵称修改后 7 天内不能再次修改')
          e.code = 'NICKNAME_COOLDOWN'
          e.retryAfter = Math.ceil(remaining / 1000)
          throw e
        }
      }
      if (!nicknameChanged && Object.keys(patch).length === 1 && Object.hasOwn(patch, 'nickname')) return prev
      const next = { ...prev, ...patch, ...(nicknameChanged ? { nicknameChangedAt: now } : {}), updatedAt: now }
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
    getCollection,
    putCollection,
    listCollectionsByUid,
    countCollections,
    countCollectionsOf,
    listPostsOfCollection,
    setPostCollection,
    clearCollectionPosts,
    deleteCollection,
    reorderCollection,
    recordView,
    flushViewsNow,
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
    anonymousEnabled,
    getAnonymousHandle,
    ensureAnonymousHandle,
    assertAnonymousMappings,
    putProfile,
    deleteProfileRank,
    getRankRow,
    putRankRow,
    listRankRows,
    listAllRankRows,
    appendAudit,
    listAudit,
    isLocked: () => isCommunityLocked(root),
    _files: FILES,
    _exists: () => existsSync(root),
  }
}
