// ============ 投稿广场 · 接口层 ============
//
// 【契约】全部在 `/api/community/**`；网页版用 Cookie、桌面版用 Bearer，
// 会话校验**复用** index.mjs 的 authCheck（单一真源），这里只接收它的结果。
//
// 🔴 公开接口只返回展示所需字段：没有 uid、没有登录名、没有昵称以外的稳定标识、
//    没有审核内部理由码给非作者。匿名展示在任何路径上都不回落成昵称。
// 🔴 所有写操作都要么幂等（带 clientToken / 重算计数），要么明确失败返回可理解的 code。
// 🔴 服务端是唯一裁判：前端隐藏按钮不构成权限控制，每个接口都自己校验。

import {
  COMMUNITY_LIMITS, COMMUNITY_TAGS,
  POST_STATUS, COMMENT_STATUS,
  charCount, isBlank, validatePostInput, validateCommentInput, validateNickname,
  normalizeDisplayMode, screenContent, commentAutoVisible,
  decodeCursor, clampPageSize, pageRows,
  validateDecision, periodRange, todayKeyCn,
  aggregateRank, applyRankReport,
} from './communityRules.mjs'
import { sendJSON, readJSONBody } from './http.mjs'
import { COMMUNITY_CAPACITY as CAP } from './communityStore.mjs'

const ANON_LABEL = '匿名用户'
const NICK_FALLBACK = '社区作者'

const isAdminRole = (user) => !!user && (user.role === 'admin' || user.role === 'moderator')
const isSuperAdmin = (user) => !!user && user.role === 'admin'

/**
 * 只裁剪「非发布、非待审」的历史版本。
 * 🔴 已发布版本与当前待审版本**永不删除**：审核决定、申诉与争议处理都要能追溯到具体内容；
 *    其余草稿/被拒版本超过上限时按最旧优先丢弃，避免单篇无限膨胀。
 */
function trimVersions(post, max = CAP.maxVersions) {
  if (!Array.isArray(post.versions) || post.versions.length <= max) return
  const keep = new Set([post.publishedVersionId, post.pendingVersionId].filter(Boolean))
  const protectedRows = post.versions.filter((v) => keep.has(v.vid))
  const others = post.versions.filter((v) => !keep.has(v.vid))
  const keepOthers = Math.max(0, max - protectedRows.length)
  const keptOthers = others.slice(-keepOthers)
  const kept = new Set([...protectedRows, ...keptOthers].map((v) => v.vid))
  post.versions = post.versions.filter((v) => kept.has(v.vid))
}

/** 公开可见：有已发布版本，且未被撤回/下架 */
export function postPubliclyVisible(post) {
  if (!post || !post.publishedVersionId) return false
  if (post.status === POST_STATUS.WITHDRAWN || post.status === POST_STATUS.REMOVED) return false
  /**
   * 🔴 撤回/下架之后再提交或申诉重开，**旧版本不能自动回到公开**。
   *    `publishedVersionId` 还要留着供审核、申诉与争议追溯，所以可见性必须另有标记，
   *    不能只看「有没有已发布版本」——否则一次 takedown 后只要状态变回 pending，
   *    被下架的旧内容就复活了（隔离流程实测抓到的真实缺陷）。
   */
  if (post.withdrawnAt || post.removedAt) return false
  return true
}

/** 取某篇的指定版本（不存在返回 null） */
export function versionOf(post, versionId) {
  if (!post || !Array.isArray(post.versions)) return null
  return post.versions.find((v) => v.vid === versionId) || null
}

function excerptOf(body, max = 140) {
  const flat = String(body || '').replace(/\s+/g, ' ').trim()
  if (charCount(flat) <= max) return flat
  let out = ''
  let n = 0
  for (const ch of flat) { if (n >= max) break; out += ch; n++ }
  return out + '…'
}

/**
 * 展示名解析。
 * 🔴 display === 'anonymous' 时**永远**返回匿名标签，即使 profile 里存了昵称。
 *    「昵称可能让不同内容互相关联」这件事在设置页明确告知，但不能靠后端猜。
 */
function displayNameOf(store, uid, mode) {
  if (mode !== 'nickname') return ANON_LABEL
  const p = store.getProfile(uid)
  const nick = p && typeof p.nickname === 'string' ? p.nickname.trim() : ''
  return nick || NICK_FALLBACK
}

function publicPost(store, post, { viewer = null, detail = false } = {}) {
  const v = versionOf(post, post.publishedVersionId)
  if (!v) return null
  const mine = !!viewer && viewer.id === post.uid
  const base = {
    id: post.id,
    title: v.title,
    tags: v.tags,
    createdAt: v.createdAt,
    updatedAt: post.updatedAt,
    counts: { up: post.counts?.up || 0, down: post.counts?.down || 0, comments: post.counts?.comments || 0 },
    displayName: displayNameOf(store, post.uid, post.display || 'anonymous'),
    authorLabel: post.display === 'nickname' ? '' : '匿名投稿者',
    ...(post.isExample === true ? { isExample: true } : {}),
  }
  if (detail) base.body = v.body
  else base.excerpt = excerptOf(v.body)
  if (mine) {
    base.myPost = true
  }
  if (viewer) {
    const vote = store.getVote(post.id, viewer.id)
    base.myVote = vote ? vote.value : 0
  }
  return base
}

function publicComment(store, comment, { viewer = null, post = null } = {}) {
  const out = {
    id: comment.id,
    createdAt: comment.createdAt,
    body: comment.body,
    displayName: displayNameOf(store, comment.uid, comment.display || 'anonymous'),
    byAuthor: !!post && post.uid === comment.uid,
  }
  if (viewer && viewer.id === comment.uid) out.myComment = true
  return out
}

/** 我的投稿视图：状态、原因、可申诉标记 */
function myPost(store, post) {
  const latest = post.versions?.[post.versions.length - 1] || null
  const published = versionOf(post, post.publishedVersionId)
  return {
    id: post.id,
    status: post.status,
    display: post.display || 'anonymous',
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    title: latest?.title || published?.title || '',
    // 🔴 作者编辑自己的稿件必须能拿到正文：这是本人内容，不经公开接口；
    //    公开列表/详情仍然只给已发布版本。
    body: latest?.body || published?.body || '',
    tags: latest?.tags || published?.tags || [],
    counts: { up: post.counts?.up || 0, down: post.counts?.down || 0, comments: post.counts?.comments || 0 },
    pendingVersionId: post.pendingVersionId || '',
    publishedVersionId: post.publishedVersionId || '',
    lastDecision: post.lastDecision || null,
    withdrawnAt: post.withdrawnAt || 0,
    hasPublishedVersion: !!post.publishedVersionId,
  }
}

function staled(reason) {
  return { ok: false, code: 'SESSION_STALE', error: reason === 'REVOKED' ? '账号已在其他设备退出登录' : '登录已过期，请重新登录' }
}

/**
 * @param {{
 *   store: ReturnType<import('./communityStore.mjs').createCommunityStore>,
 *   authCheck: (req:any)=>Promise<{user:object|null,reason:string}>|{user:object|null,reason:string},
 *   rateLimit: (key:string,limit:number,windowMs:number)=>{ok:boolean,retryAfter?:number},
 *   findUserById?: (id:string)=>object|null,
 * }} deps
 */
export function createCommunityApi({ store, authCheck, rateLimit, findUserById = () => null }) {
  const limit = (key, n, ms) => rateLimit(key, n, ms)

  function audit(actor, action, target = {}, note = '') {
    try {
      store.appendAudit({
        actorId: actor?.id || '',
        actorRole: actor?.role || '',
        action,
        targetType: target.type || '',
        targetId: target.id || '',
        versionId: target.versionId || '',
        note: String(note || '').slice(0, 400),
      })
    } catch { /* 审计失败不得阻断主流程，但也不要静默改结论 */ }
  }

  /** 今日已发投稿数（按账号；用于日限额，比滑动窗口更贴近产品口径） */
  function countTodayPosts(uid, now = Date.now()) {
    const start = now - 24 * 3600 * 1000
    return store.listPosts().filter((p) => p.uid === uid && p.createdAt >= start).length
  }
  function countTodayComments(uid, now = Date.now()) {
    const start = now - 24 * 3600 * 1000
    return store.listCommentsByUid(uid).filter((c) => c.createdAt >= start).length
  }

  function ensureNickname(uid) {
    const p = store.getProfile(uid)
    if (p) return p
    return store.putProfile(uid, {})
  }

  /**
   * 主入口。返回 true 表示已处理（调用方不再走后续路由）。
   * @param {{req:any,res:any,path:string,qs:URLSearchParams,user:object|null,session:object|null,authReason:string,ip:string}} ctx
   */
  async function handle(ctx) {
    const { req, res, qs } = ctx
    const path = ctx.path
    const method = String(req.method || 'GET').toUpperCase()
    const user = ctx.user || null

    const state = store.getState()

    // ---------- 公共读 ----------
    if (path === '/api/community/square' && method === 'GET') {
      return sendJSON(res, 200, {
        ok: true,
        open: state.squareOpen,
        postsOpen: state.postsOpen && state.squareOpen,
        commentsOpen: state.commentsOpen && state.squareOpen,
        tags: COMMUNITY_TAGS,
        limits: {
          titleMax: COMMUNITY_LIMITS.titleMax,
          bodyMax: COMMUNITY_LIMITS.bodyMax,
          commentMax: COMMUNITY_LIMITS.commentMax,
          tagMax: COMMUNITY_LIMITS.tagMax,
        },
      })
    }

    if (path === '/api/community/posts' && method === 'GET') {
      if (!state.squareOpen) {
        return sendJSON(res, 200, { ok: true, closed: true, items: [], nextCursor: '' })
      }
      const tag = String(qs.get('tag') || '')
      const cursor = decodeCursor(qs.get('cursor') || '')
      const size = clampPageSize(qs.get('limit'))
      const rows = store.listPosts()
        .filter(postPubliclyVisible)
        .map((p) => ({ post: p, ts: versionOf(p, p.publishedVersionId)?.createdAt || p.createdAt, id: p.id }))
        .filter((row) => !tag || (versionOf(row.post, row.post.publishedVersionId)?.tags || []).includes(tag))
        .sort((a, b) => (b.ts - a.ts) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      const page = pageRows(rows.map((r) => ({ id: r.id, ts: r.ts, row: r })), { cursor, limit: size })
      return sendJSON(res, 200, {
        ok: true,
        closed: false,
        items: page.items.map((it) => publicPost(store, it.row.post, { viewer: user })),
        nextCursor: page.nextCursor,
      })
    }

    const postMatch = /^\/api\/community\/posts\/([^/]+)(\/comments|\/vote|\/submit|\/withdraw|\/display)?$/.exec(path)
    if (postMatch) {
      const postId = decodeURIComponent(postMatch[1])
      const sub = postMatch[2] || ''
      const post = store.getPost(postId)

      if (!sub && method === 'GET') {
        if (!post || (!postPubliclyVisible(post) && !(user && (user.id === post.uid || isAdminRole(user))))) {
          return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在或已不可见' })
        }
        if (!postPubliclyVisible(post)) {
          // 🔴 未公开的内容不在「读者路径」返回正文：作者看自己的走 `/my/posts`，
          //    管理员看全文走 `/admin/item`（那里另有权限与审计）。
          //    旧链接只告诉「暂时不可见」，不暴露作者或审核原因。
          const latest = post.versions?.[post.versions.length - 1]
          return sendJSON(res, 200, {
            ok: true, unavailable: true, id: post.id, status: post.status,
            title: user && user.id === post.uid ? (latest?.title || '') : '', updatedAt: post.updatedAt,
          })
        }
        return sendJSON(res, 200, { ok: true, post: publicPost(store, post, { viewer: user, detail: true }) })
      }

      if (sub === '/comments') {
        if (method === 'GET') {
          if (!post || !postPubliclyVisible(post)) {
            return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在或已不可见' })
          }
          const cursor = decodeCursor(qs.get('cursor') || '')
          const size = clampPageSize(qs.get('limit'))
          const rows = store.listCommentsOf(post.id)
            .filter((c) => c.status === COMMENT_STATUS.VISIBLE)
            .map((c) => ({ id: c.id, ts: c.createdAt, c }))
            .sort((a, b) => (b.ts - a.ts) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
          const page = pageRows(rows, { cursor, limit: size })
          return sendJSON(res, 200, {
            ok: true,
            items: page.items.map((it) => publicComment(store, it.c, { viewer: user, post })),
            nextCursor: page.nextCursor,
          })
        }

        if (method === 'POST') {
          if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
          if (!state.squareOpen || !state.commentsOpen) {
            return sendJSON(res, 503, { ok: false, code: 'COMMENTS_CLOSED', error: '评论暂时关闭，请稍后再试' })
          }
          if (!post || !postPubliclyVisible(post)) {
            return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在或已不可见' })
          }
          const rl = limit(`c:comment:${user.id}`, COMMUNITY_LIMITS.commentDailyMax, 24 * 3600 * 1000)
          if (!rl.ok) return sendJSON(res, 429, { ok: false, code: 'RATE_LIMITED', error: `今天评论太频繁，请 ${rl.retryAfter} 秒后再试` })
          if (countTodayComments(user.id) >= COMMUNITY_LIMITS.commentDailyMax) {
            return sendJSON(res, 429, { ok: false, code: 'RATE_LIMITED', error: '今天的评论已达上限' })
          }
          const body = await readJSONBody(req, 16 * 1024).catch(() => null)
          if (!body) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求格式错误' })
          const v = validateCommentInput(body)
          if (!v.ok) return sendJSON(res, 400, { ok: false, code: v.code, error: v.error })

          // 🔴 幂等：同一令牌重复提交返回同一条，不产生第二条评论
          const token = String(body.clientToken || '')
          if (token) {
            const dup = store.listCommentsOf(post.id).find((c) => c.uid === user.id && c.clientToken === token)
            if (dup) {
              return sendJSON(res, 200, {
                ok: true, duplicate: true,
                comment: { id: dup.id, status: dup.status, createdAt: dup.createdAt },
              })
            }
          }
          if (store.counts().comments >= CAP.maxComments) {
            return sendJSON(res, 503, { ok: false, code: 'CAPACITY_FULL', error: '评论容量已满，请稍后再试' })
          }
          const screening = screenContent(v.value.body, 'comment')
          const visible = commentAutoVisible(screening)
          const now = Date.now()
          const comment = {
            id: store.newId('c'),
            postId: post.id,
            uid: user.id,
            body: v.value.body,
            display: normalizeDisplayMode(body.display, 'anonymous'),
            status: visible ? COMMENT_STATUS.VISIBLE : COMMENT_STATUS.PENDING,
            screening,
            clientToken: token,
            createdAt: now,
          }
          store.putComment(comment)
          if (visible) {
            post.counts = { ...(post.counts || {}), comments: (post.counts?.comments || 0) + 1 }
            store.putPost(post)
          }
          return sendJSON(res, 200, {
            ok: true,
            comment: { id: comment.id, status: comment.status, createdAt: comment.createdAt },
          })
        }
      }

      if (sub === '/display' && method === 'POST') {
        if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
        if (!post) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在' })
        if (post.uid !== user.id) return sendJSON(res, 403, { ok: false, code: 'FORBIDDEN', error: '无权修改该投稿的展示方式' })
        if (post.status === POST_STATUS.REMOVED || post.status === POST_STATUS.WITHDRAWN) {
          return sendJSON(res, 409, { ok: false, code: 'NOT_EDITABLE', error: '该投稿已不可修改' })
        }
        const body = await readJSONBody(req, 4 * 1024).catch(() => null)
        if (!body) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求格式错误' })
        const display = normalizeDisplayMode(body.display, post.display || 'anonymous')
        /**
         * 已发布内容改为匿名：**立即更新展示**，不需要重新审核（只换展示方式，不改正文）。
         * 🔴 不能承诺「消除先前关联」：缓存、他人截图与已读记录不归我们控制，文案必须说明。
         */
        post.display = display
        post.updatedAt = Date.now()
        store.putPost(post)
        audit(user, 'post.display', { type: 'post', id: post.id }, display)
        return sendJSON(res, 200, { ok: true, display, note: '展示方式已更新；新打开页面会生效，已经被他人看到或保存的内容无法收回。' })
      }

      if (sub === '/vote' && method === 'POST') {
        if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
        if (!state.squareOpen) return sendJSON(res, 503, { ok: false, code: 'SQUARE_CLOSED', error: '广场暂时关闭' })
        if (!post || !postPubliclyVisible(post)) {
          return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在或已不可见' })
        }
        if (post.uid === user.id) {
          return sendJSON(res, 400, { ok: false, code: 'SELF_VOTE', error: '不能给自己的投稿投票' })
        }
        const rl = limit(`c:vote:${user.id}`, 120, 3600 * 1000)
        if (!rl.ok) return sendJSON(res, 429, { ok: false, code: 'RATE_LIMITED', error: '操作太频繁' })
        const body = await readJSONBody(req, 4 * 1024).catch(() => null)
        const raw = Number(body?.value)
        const value = raw === 1 ? 1 : raw === -1 ? -1 : raw === 0 ? 0 : NaN
        if (!Number.isFinite(value)) return sendJSON(res, 400, { ok: false, code: 'BAD_VALUE', error: '无效的投票值' })
        // 同一账号同一投稿只有一条记录：切换与取消都是覆盖，服务端重算汇总
        store.setVote(post.id, user.id, value)
        const counts = store.recountVotes(post.id)
        post.counts = { ...(post.counts || {}), up: counts.up, down: counts.down }
        store.putPost(post)
        return sendJSON(res, 200, { ok: true, counts: post.counts, myVote: value })
      }
    }

    // 评论删除（自己的，或管理员）
    const commentDel = /^\/api\/community\/comments\/([^/]+)$/.exec(path)
    if (commentDel && method === 'DELETE') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const c = store.getComment(decodeURIComponent(commentDel[1]))
      if (!c) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '评论不存在' })
      const own = c.uid === user.id
      if (!own && !isAdminRole(user)) return sendJSON(res, 403, { ok: false, code: 'FORBIDDEN', error: '无权删除该评论' })
      if (c.status === COMMENT_STATUS.REMOVED) return sendJSON(res, 200, { ok: true, changed: false })
      const wasVisible = c.status === COMMENT_STATUS.VISIBLE
      c.status = COMMENT_STATUS.REMOVED
      c.removedAt = Date.now()
      c.removedBy = own ? 'author' : user.role
      store.putComment(c)
      const post = store.getPost(c.postId)
      if (post && wasVisible) {
        post.counts = { ...(post.counts || {}), comments: Math.max(0, (post.counts?.comments || 0) - 1) }
        store.putPost(post)
      }
      if (!own) audit(user, 'comment.remove', { type: 'comment', id: c.id }, '管理员删除评论')
      return sendJSON(res, 200, { ok: true, changed: true })
    }

// 申诉（3.5.0）：作者对「未通过 / 需修改 / 被下架」提出复核请求。
    // 🔴 与举报共用同一张表（`reports.json`）但 `kind='appeal'` 分开统计与展示；
    //    申诉记录绑定**当时被审的版本**，管理员复核时看到的就是作者当初提交的那一版。
    if (path === '/api/community/appeals' && method === 'POST') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const rl = limit(`c:appeal:${user.id}`, 10, 24 * 3600 * 1000)
      if (!rl.ok) return sendJSON(res, 429, { ok: false, code: 'RATE_LIMITED', error: '今天提交的申诉太多了' })
      const body = await readJSONBody(req, 8 * 1024).catch(() => null)
      if (!body) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求格式错误' })
      const post = store.getPost(String(body.postId || ''))
      if (!post) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在' })
      if (post.uid !== user.id) return sendJSON(res, 403, { ok: false, code: 'FORBIDDEN', error: '只能为自己的投稿申诉' })
      const open = store.findOpenReport(user.id, 'post', post.id, 'appeal')
      if (open) return sendJSON(res, 200, { ok: true, duplicate: true, id: open.id, status: open.status })
      const versionId = String(body.versionId || post.lastDecision?.versionId || post.pendingVersionId || post.publishedVersionId || '')
      const appeal = {
        id: store.newId('a'),
        kind: 'appeal',
        uid: user.id,
        targetType: 'post',
        targetId: post.id,
        versionId,
        reason: String(body.reason || '').slice(0, 500),
        status: 'open',
        createdAt: Date.now(),
      }
      store.putReport(appeal)
      return sendJSON(res, 200, { ok: true, id: appeal.id, status: appeal.status })
    }

    if (path === '/api/community/my/appeals' && method === 'GET') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const items = store.listReports()
        .filter((r) => (r.kind || 'report') === 'appeal' && r.uid === user.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50)
        .map((r) => ({ id: r.id, postId: r.targetId, status: r.status, createdAt: r.createdAt, outcome: r.outcome || '' }))
      return sendJSON(res, 200, { ok: true, items })
    }

    // 举报
    if (path === '/api/community/reports' && method === 'POST') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const rl = limit(`c:report:${user.id}`, COMMUNITY_LIMITS.reportDailyMax, 24 * 3600 * 1000)
      if (!rl.ok) return sendJSON(res, 429, { ok: false, code: 'RATE_LIMITED', error: '举报过于频繁' })
      const body = await readJSONBody(req, 8 * 1024).catch(() => null)
      if (!body) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求格式错误' })
      const targetType = body.targetType === 'comment' ? 'comment' : body.targetType === 'post' ? 'post' : ''
      const targetId = String(body.targetId || '')
      if (!targetType || !targetId) return sendJSON(res, 400, { ok: false, code: 'BAD_TARGET', error: '举报对象无效' })
      const target = targetType === 'post' ? store.getPost(targetId) : store.getComment(targetId)
      if (!target) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '举报对象不存在' })
      const reason = String(body.reason || '').slice(0, 40)
      const detail = String(body.detail || '').slice(0, 500)
      const open = store.findOpenReport(user.id, targetType, targetId)
      if (open) return sendJSON(res, 200, { ok: true, duplicate: true, id: open.id, status: open.status })
      if (store.counts().reports >= CAP.maxReports) {
        return sendJSON(res, 503, { ok: false, code: 'CAPACITY_FULL', error: '举报队列已满，请稍后再试' })
      }
const report = {
        id: store.newId('r'),
        kind: 'report',
        uid: user.id,
        targetType,
        targetId,
        reason,
        detail,
        status: 'open',
        createdAt: Date.now(),
      }
      store.putReport(report)
      return sendJSON(res, 200, { ok: true, id: report.id, status: report.status })
    }

    // ---------- 我的 / 投稿 ----------
    if (path === '/api/community/my/posts' && method === 'GET') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const items = store.listPosts().filter((p) => p.uid === user.id).sort((a, b) => b.updatedAt - a.updatedAt).map((p) => myPost(store, p))
      return sendJSON(res, 200, { ok: true, items })
    }

    if (path === '/api/community/my/comments' && method === 'GET') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const items = store.listCommentsByUid(user.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200)
        .map((c) => ({
          id: c.id, postId: c.postId, body: c.body, status: c.status,
          createdAt: c.createdAt, screening: c.status === COMMENT_STATUS.PENDING ? (c.screening?.reasons || []) : [],
        }))
      return sendJSON(res, 200, { ok: true, items })
    }

    if (path === '/api/community/my/reports' && method === 'GET') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const items = store.listReports().filter((r) => r.uid === user.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
        .map((r) => ({ id: r.id, targetType: r.targetType, targetId: r.targetId, status: r.status, createdAt: r.createdAt, outcome: r.outcome || '' }))
      return sendJSON(res, 200, { ok: true, items })
    }

    if (path === '/api/community/posts' && method === 'POST') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      if (!state.squareOpen) return sendJSON(res, 503, { ok: false, code: 'SQUARE_CLOSED', error: '广场暂时关闭' })
      if (!state.postsOpen) return sendJSON(res, 503, { ok: false, code: 'POSTS_CLOSED', error: '投稿暂时关闭，你的内容仍保存在本地草稿' })
      const rl = limit(`c:post:${user.id}`, COMMUNITY_LIMITS.postDailyMax, 24 * 3600 * 1000)
      if (!rl.ok) return sendJSON(res, 429, { ok: false, code: 'RATE_LIMITED', error: `今天投稿太频繁，请 ${rl.retryAfter} 秒后再试` })
      if (countTodayPosts(user.id) >= COMMUNITY_LIMITS.postDailyMax) {
        return sendJSON(res, 429, { ok: false, code: 'RATE_LIMITED', error: '今天的投稿已达上限' })
      }
      const body = await readJSONBody(req, 64 * 1024).catch(() => null)
      if (!body) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求格式错误' })
      const v = validatePostInput(body)
      if (!v.ok) return sendJSON(res, 400, { ok: false, code: v.code, error: v.error })

      const token = String(body.clientToken || '').slice(0, 64)
      const dup = store.findPostByToken(user.id, token)
      if (dup) return sendJSON(res, 200, { ok: true, duplicate: true, post: myPost(store, dup) })
      if (store.counts().posts >= CAP.maxPosts) {
        return sendJSON(res, 503, { ok: false, code: 'CAPACITY_FULL', error: '投稿容量已满，请稍后再试' })
      }
      const now = Date.now()
      const draft = body.draft === true
      const vid = store.newId('v')
      const post = {
        id: store.newId('p'),
        uid: user.id,
        status: draft ? POST_STATUS.DRAFT : POST_STATUS.PENDING,
        display: normalizeDisplayMode(body.display, 'anonymous'),
        createdAt: now,
        updatedAt: now,
        versions: [{ vid, title: v.value.title, body: v.value.body, tags: v.value.tags, createdAt: now }],
        pendingVersionId: draft ? '' : vid,
        publishedVersionId: '',
        screening: screenContent(v.value.body, 'post'),
        clientToken: token,
        counts: { up: 0, down: 0, comments: 0 },
      }
      store.putPost(post)
      return sendJSON(res, 200, { ok: true, post: myPost(store, post) })
    }

    const submitMatch = /^\/api\/community\/posts\/([^/]+)\/submit$/.exec(path)
    if (submitMatch && method === 'POST') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const post = store.getPost(decodeURIComponent(submitMatch[1]))
      if (!post) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在' })
      if (post.uid !== user.id) return sendJSON(res, 403, { ok: false, code: 'FORBIDDEN', error: '无权操作该投稿' })
      if (!state.postsOpen || !state.squareOpen) {
        return sendJSON(res, 503, { ok: false, code: 'POSTS_CLOSED', error: '投稿暂时关闭，你的内容仍保存在本地草稿' })
      }
      const latest = post.versions?.[post.versions.length - 1]
      const v = validatePostInput({ title: latest?.title, body: latest?.body, tags: latest?.tags })
      if (!v.ok) return sendJSON(res, 400, { ok: false, code: v.code, error: v.error })
      post.status = POST_STATUS.PENDING
      post.pendingVersionId = latest.vid
      post.screening = screenContent(v.value.body, 'post')
post.updatedAt = Date.now()
      // 🔴 不在这里清 withdrawnAt：作者撤回后再提交，旧版本要等审核通过才回到公开
      store.putPost(post)
      return sendJSON(res, 200, { ok: true, post: myPost(store, post) })
    }

    const editMatch = /^\/api\/community\/posts\/([^/]+)$/.exec(path)
    if (editMatch && method === 'PUT') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const post = store.getPost(decodeURIComponent(editMatch[1]))
      if (!post) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在' })
      if (post.uid !== user.id) return sendJSON(res, 403, { ok: false, code: 'FORBIDDEN', error: '无权操作该投稿' })
      if (post.status === POST_STATUS.REMOVED || post.status === POST_STATUS.WITHDRAWN) {
        return sendJSON(res, 409, { ok: false, code: 'NOT_EDITABLE', error: '该投稿已不可编辑' })
      }
      if (!state.postsOpen || !state.squareOpen) {
        return sendJSON(res, 503, { ok: false, code: 'POSTS_CLOSED', error: '投稿暂时关闭，改动未提交' })
      }
      const body = await readJSONBody(req, 64 * 1024).catch(() => null)
      if (!body) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求格式错误' })
      const v = validatePostInput(body)
      if (!v.ok) return sendJSON(res, 400, { ok: false, code: v.code, error: v.error })
      const now = Date.now()
      const vid = store.newId('v')
      post.versions.push({ vid, title: v.value.title, body: v.value.body, tags: v.value.tags, createdAt: now })
      trimVersions(post)
      post.display = normalizeDisplayMode(body.display ?? post.display, post.display || 'anonymous')
      post.pendingVersionId = body.draft === true && !post.publishedVersionId ? '' : vid
      post.status = body.draft === true && !post.publishedVersionId ? POST_STATUS.DRAFT : POST_STATUS.PENDING
      post.screening = screenContent(v.value.body, 'post')
      post.updatedAt = now
      // 旧发布版本保持公开（默认策略），状态回到 pending 但 publishedVersionId 不动
      if (post.publishedVersionId) post.status = POST_STATUS.PENDING
      store.putPost(post)
      return sendJSON(res, 200, { ok: true, post: myPost(store, post) })
    }

    const withdrawMatch = /^\/api\/community\/posts\/([^/]+)\/withdraw$/.exec(path)
    if (withdrawMatch && method === 'POST') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const post = store.getPost(decodeURIComponent(withdrawMatch[1]))
      if (!post) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在' })
      if (post.uid !== user.id) return sendJSON(res, 403, { ok: false, code: 'FORBIDDEN', error: '无权操作该投稿' })
      if (post.status === POST_STATUS.WITHDRAWN) return sendJSON(res, 200, { ok: true, changed: false })
      post.status = POST_STATUS.WITHDRAWN
      post.pendingVersionId = ''
      post.withdrawnAt = Date.now()
      post.updatedAt = Date.now()
      store.putPost(post)
      audit(user, 'post.withdraw', { type: 'post', id: post.id }, '作者撤回')
      return sendJSON(res, 200, { ok: true, changed: true })
    }

    if (editMatch && method === 'DELETE') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const post = store.getPost(decodeURIComponent(editMatch[1]))
      if (!post) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在' })
      if (post.uid !== user.id && !isAdminRole(user)) return sendJSON(res, 403, { ok: false, code: 'FORBIDDEN', error: '无权删除该投稿' })
      // 作者删除 = 撤回并标记；管理员删除 = 下架。两者都立即停止公开展示，保留争议记录。
      post.status = post.uid === user.id ? POST_STATUS.WITHDRAWN : POST_STATUS.REMOVED
      post.pendingVersionId = ''
      post.withdrawnAt = Date.now()
      post.updatedAt = Date.now()
      store.putPost(post)
      audit(user, 'post.delete', { type: 'post', id: post.id }, post.uid === user.id ? '作者删除' : '管理员删除')
      return sendJSON(res, 200, { ok: true, changed: true })
    }

    // ---------- 档案 ----------
    if (path === '/api/community/profile' && method === 'GET') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const p = ensureNickname(user.id)
      return sendJSON(res, 200, {
        ok: true,
        profile: {
          nickname: p.nickname || '',
          postDisplay: p.postDisplay || 'anonymous',
          commentDisplay: p.commentDisplay || 'anonymous',
          rankDisplay: p.rankDisplay || 'anonymous',
          rankOptIn: !!p.rankOptIn,
          rankOptInAt: Number(p.rankOptInAt) || 0,
          rankRevokedAt: Number(p.rankRevokedAt) || 0,
          updatedAt: p.updatedAt || 0,
        },
      })
    }

    if (path === '/api/community/profile' && method === 'PUT') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const body = await readJSONBody(req, 8 * 1024).catch(() => null)
      if (!body) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求格式错误' })
      const patch = {}
      if (body.nickname !== undefined) {
        const nv = validateNickname(body.nickname)
        if (!nv.ok) return sendJSON(res, 400, { ok: false, code: nv.code, error: nv.error })
        patch.nickname = nv.value
      }
      if (body.postDisplay !== undefined) patch.postDisplay = normalizeDisplayMode(body.postDisplay, 'anonymous')
      if (body.commentDisplay !== undefined) patch.commentDisplay = normalizeDisplayMode(body.commentDisplay, 'anonymous')
      if (body.rankDisplay !== undefined) patch.rankDisplay = normalizeDisplayMode(body.rankDisplay, 'anonymous')
      if (body.rankOptIn !== undefined) {
        const next = !!body.rankOptIn
        // 🔴 关闭参与即撤回：立即清空已上传数据，并让旧队列在服务端失效
        if (!next) {
          store.deleteProfileRank(user.id)
          patch.rankOptIn = false
          patch.rankRevokedAt = Date.now()
        } else {
          const prev = store.getProfile(user.id)
          // 重新开启不自动恢复旧数据：清一次，保证「开启前的历史」不会出现
          if (!prev?.rankOptIn) store.deleteProfileRank(user.id)
          patch.rankOptIn = true
          patch.rankOptInAt = Date.now()
        }
      }
      const p = store.putProfile(user.id, patch)
      audit(user, 'profile.update', { type: 'profile', id: user.id }, Object.keys(patch).join(','))
      return sendJSON(res, 200, {
        ok: true,
        profile: {
          nickname: p.nickname || '',
          postDisplay: p.postDisplay || 'anonymous',
          commentDisplay: p.commentDisplay || 'anonymous',
          rankDisplay: p.rankDisplay || 'anonymous',
          rankOptIn: !!p.rankOptIn,
          rankOptInAt: Number(p.rankOptInAt) || 0,
          rankRevokedAt: Number(p.rankRevokedAt) || 0,
          updatedAt: p.updatedAt || 0,
        },
      })
    }

    // ---------- 排行上报与展示 ----------
    if (path === '/api/community/rank/report' && method === 'POST') {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      const p = store.getProfile(user.id)
      if (!p || !p.rankOptIn) {
        return sendJSON(res, 403, { ok: false, code: 'RANK_NOT_ENABLED', error: '尚未开启排行同步' })
      }
      const rl = limit(`c:rank:${user.id}`, 120, 3600 * 1000)
      if (!rl.ok) return sendJSON(res, 429, { ok: false, code: 'RATE_LIMITED', error: '上报过于频繁' })
      const body = await readJSONBody(req, 32 * 1024).catch(() => null)
      if (!body) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求格式错误' })
      // 🔴 撤回授权后，旧队列的迟到上报一律拒绝：不能因为客户端还没清队列就让旧数据复活
      if (p.rankRevokedAt && Number(body.issuedAt || 0) < Number(p.rankRevokedAt)) {
        return sendJSON(res, 409, { ok: false, code: 'RANK_REVOKED', error: '排行授权已撤回' })
      }
      const deviceId = String(body.deviceId || '').slice(0, 64)
      if (!/^[a-zA-Z0-9_-]{6,64}$/.test(deviceId)) {
        return sendJSON(res, 400, { ok: false, code: 'BAD_DEVICE', error: '设备标识无效' })
      }
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, 400) : []
      const accepted = []
      const rejected = []
      const now = Date.now()
      for (const e of entries) {
        const projectId = String(e?.projectId || '').slice(0, 128)
        const date = String(e?.date || '')
        const netDelta = Number(e?.netDelta)
        const seq = Number(e?.seq)
        if (!projectId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(netDelta) || !Number.isFinite(seq)) {
          rejected.push({ projectId, date, code: 'INVALID' })
          continue
        }
        // 🔴 只接受「最近 40 天」的日期：防止伪造历史或时钟错乱刷榜
        const today = todayKeyCn(now)
        const dayMs = 24 * 3600 * 1000
        const base = Date.parse(`${today}T00:00:00Z`)
        const target = Date.parse(`${date}T00:00:00Z`)
        if (!Number.isFinite(target) || Math.abs(base - target) > 40 * dayMs) {
          rejected.push({ projectId, date, code: 'DATE_OUT_OF_RANGE' })
          continue
        }
        const existing = store.getRankRow(user.id, deviceId, projectId, date)
        // 🔴 逐条校验「这条记录是在撤回之后产生的吗」：只看请求级 issuedAt 不够，
        //    重新开启后旧账本行（updatedAt 早于撤回）仍可能被一起打包上来。
        if (p.rankRevokedAt && Number(e.issuedAt || 0) < p.rankRevokedAt) {
          rejected.push({ projectId, date, code: 'RANK_REVOKED' })
          continue
        }
        const incoming = { uid: user.id, deviceId, projectId, date, netDelta, seq, reportedAt: now }
        const r = applyRankReport(existing, incoming)
        if (!r.accept) {
          rejected.push({ projectId, date, code: 'STALE_SEQ' })
          continue
        }
        if (!existing || Number(existing.seq) !== seq || Number(existing.netDelta) !== netDelta) store.putRankRow(r.row)
        accepted.push({ projectId, date })
      }
      return sendJSON(res, 200, { ok: true, accepted, rejected, serverDate: todayKeyCn(now) })
    }

    if (path === '/api/community/rank' && method === 'GET') {
      if (!state.squareOpen) {
        return sendJSON(res, 200, { ok: true, closed: true, entries: [], period: 'day', range: null })
      }
      const period = ['day', 'week', 'month'].includes(String(qs.get('period'))) ? String(qs.get('period')) : 'day'
      const date = String(qs.get('date') || '') || todayKeyCn()
      const range = periodRange(period, date)
      if (!range) return sendJSON(res, 400, { ok: false, code: 'BAD_DATE', error: '日期无效' })
      // 只取「已开启排行」的账号；撤回的已在 profile 里关掉，且数据已删
      const opted = new Map()
      for (const row of store.listAllRankRows()) {
        const p = store.getProfile(row.uid)
        if (!p || !p.rankOptIn) continue
        opted.set(row.uid, p)
      }
      // 同 (uid, project, date) 取最新上报的设备值，避免多设备双计
      const latest = new Map()
      for (const row of store.listAllRankRows()) {
        if (!opted.has(row.uid)) continue
        const k = `${row.uid}::${row.projectId}::${row.date}`
        const prev = latest.get(k)
        if (!prev || row.reportedAt > prev.reportedAt || (row.reportedAt === prev.reportedAt && row.seq > prev.seq)) latest.set(k, row)
      }
      const rows = [...latest.values()].map((r) => ({ id: r.uid, date: r.date, netDelta: r.netDelta }))
      const ranked = aggregateRank(rows, { period, date })
      // 只保留能展示的账号（匿名或昵称），并且绝不输出 uid
      const entries = ranked
        .filter((r) => opted.has(r.id))
        .map((r) => ({
          rank: r.rank,
          value: r.value,
          displayName: displayNameOf(store, r.id, opted.get(r.id).rankDisplay || 'anonymous'),
        }))
        .filter((r) => r.value > 0)
      return sendJSON(res, 200, { ok: true, closed: false, period, range, entries })
    }

    // ---------- 管理 ----------
    if (path.startsWith('/api/community/admin/')) {
      if (!user) return sendJSON(res, 401, { ok: false, ...staled(ctx.authReason) })
      if (!isAdminRole(user)) return sendJSON(res, 403, { ok: false, code: 'FORBIDDEN', error: '需要审核权限' })
      return handleAdmin({ req, res, path, qs, user, authReason: ctx.authReason })
    }

    return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '接口不存在' })
  }

  async function handleAdmin({ req, res, path, qs, user }) {
    const method = String(req.method || 'GET').toUpperCase()

    if (path === '/api/community/admin/overview' && method === 'GET') {
const posts = store.listPosts()
      const pendingPosts = posts.filter((p) => p.status === POST_STATUS.PENDING).length
      const openRecords = store.listReports().filter((r) => r.status === 'open' || r.status === 'claimed')
      return sendJSON(res, 200, {
        ok: true,
        counts: store.counts(),
        queue: {
          posts: pendingPosts,
          comments: countPendingComments(),
          reports: openRecords.filter((r) => (r.kind || 'report') === 'report').length,
          appeals: openRecords.filter((r) => r.kind === 'appeal').length,
        },
        state: store.getState(),
      })
    }

    if (path === '/api/community/admin/queue' && method === 'GET') {
      const type = String(qs.get('type') || 'post')
      const cursor = decodeCursor(qs.get('cursor') || '')
      const size = clampPageSize(qs.get('limit'))
      if (type === 'comment') {
        const rows = allComments()
          .filter((c) => c.status === COMMENT_STATUS.PENDING)
          .map((c) => ({ id: c.id, ts: c.createdAt, c }))
          .sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1))
        const page = pageRows(rows, { cursor, limit: size })
        return sendJSON(res, 200, {
          ok: true,
          items: page.items.map(({ c }) => ({
            id: c.id, postId: c.postId, body: c.body, createdAt: c.createdAt,
            screening: c.screening ? { level: c.screening.level, reasons: c.screening.reasons } : null,
            claimedBy: c.claimedBy || '', claimedAt: c.claimedAt || 0,
          })),
          nextCursor: page.nextCursor,
        })
      }
if (type === 'report' || type === 'appeal') {
        const wantAppeal = type === 'appeal'
        const rows = store.listReports()
          .filter((r) => (r.status === 'open' || r.status === 'claimed')
            && ((r.kind || 'report') === 'appeal') === wantAppeal)
          .map((r) => ({ id: r.id, ts: r.createdAt, r }))
          .sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1))
        const page = pageRows(rows, { cursor, limit: size })
        return sendJSON(res, 200, {
          ok: true,
          items: page.items.map(({ r }) => ({
            id: r.id, kind: r.kind || 'report', targetType: r.targetType, targetId: r.targetId,
            versionId: r.versionId || '', reason: r.reason,
            detail: r.detail || '', createdAt: r.createdAt, status: r.status,
            claimedBy: r.claimedBy || '', claimedAt: r.claimedAt || 0,
          })),
          nextCursor: page.nextCursor,
        })
      }
      const rows = store.listPosts()
        .filter((p) => p.status === POST_STATUS.PENDING && p.pendingVersionId)
        .map((p) => ({ id: p.id, ts: p.updatedAt, p }))
        .sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1))
      const page = pageRows(rows, { cursor, limit: size })
      return sendJSON(res, 200, {
        ok: true,
        items: page.items.map(({ p }) => {
          const v = versionOf(p, p.pendingVersionId)
          return {
            id: p.id,
            versionId: p.pendingVersionId,
            title: v?.title || '',
            excerpt: excerptOf(v?.body || '', 240),
            tags: v?.tags || [],
            createdAt: v?.createdAt || p.updatedAt,
            screening: p.screening ? { level: p.screening.level, reasons: p.screening.reasons } : null,
            advice: p.advice && p.advice.versionId === p.pendingVersionId ? p.advice : null,
            claimedBy: p.claimedBy || '', claimedAt: p.claimedAt || 0,
          }
        }),
        nextCursor: page.nextCursor,
      })
    }

    if (path === '/api/community/admin/item' && method === 'GET') {
      const type = String(qs.get('type') || 'post')
      const id = String(qs.get('id') || '')
      if (type === 'comment') {
        const c = store.getComment(id)
        if (!c) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '评论不存在' })
        const post = store.getPost(c.postId)
        return sendJSON(res, 200, {
          ok: true,
          item: {
            id: c.id, postId: c.postId, body: c.body, status: c.status, createdAt: c.createdAt,
            screening: c.screening || null,
            postTitle: versionOf(post, post?.publishedVersionId || post?.pendingVersionId)?.title || '',
          },
        })
      }
      const p = store.getPost(id)
      if (!p) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在' })
      const v = versionOf(p, p.pendingVersionId || p.publishedVersionId)
      return sendJSON(res, 200, {
        ok: true,
        item: {
          id: p.id, status: p.status,
          versionId: p.pendingVersionId || p.publishedVersionId,
          title: v?.title || '', body: v?.body || '', tags: v?.tags || [],
          createdAt: v?.createdAt || p.createdAt,
          screening: p.screening || null,
          advice: p.advice && p.advice.versionId === (p.pendingVersionId || p.publishedVersionId) ? p.advice : null,
          versions: (p.versions || []).map((x) => ({ vid: x.vid, title: x.title, createdAt: x.createdAt })),
        },
      })
    }

    if (path === '/api/community/admin/claim' && method === 'POST') {
      const body = await readJSONBody(req, 8 * 1024).catch(() => null)
      const type = body?.type === 'comment' ? 'comment' : body?.type === 'report' ? 'report' : 'post'
      const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 20).map(String) : []
      if (!ids.length) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '缺少领取对象' })
      const now = Date.now()
      const changed = []
      for (const id of ids) {
        if (type === 'comment') {
          const c = store.getComment(id)
          if (c && c.status === COMMENT_STATUS.PENDING) { c.claimedBy = user.id; c.claimedAt = now; store.putComment(c); changed.push(id) }
        } else if (type === 'report') {
          const r = store.getReport(id)
          if (r && r.status === 'open') { r.status = 'claimed'; r.claimedBy = user.id; r.claimedAt = now; store.putReport(r); changed.push(id) }
        } else {
          const p = store.getPost(id)
          if (p && p.status === POST_STATUS.PENDING) { p.claimedBy = user.id; p.claimedAt = now; store.putPost(p); changed.push(id) }
        }
      }
      audit(user, 'queue.claim', { type, id: changed.join(',') }, `领取 ${changed.length} 项`)
      return sendJSON(res, 200, { ok: true, claimed: changed })
    }

    if (path === '/api/community/admin/advice' && method === 'POST') {
      // 🔴 本地 AI 的建议只登记，不改变任何状态；管理员刷新队列时才看得到
      const body = await readJSONBody(req, 16 * 1024).catch(() => null)
      const targetType = body?.targetType === 'comment' ? 'comment' : 'post'
      const id = String(body?.id || '')
      const versionId = String(body?.versionId || '')
      const suggestion = ['approve', 'review', 'reject'].includes(body?.suggestion) ? body.suggestion : 'review'
      const reasons = Array.isArray(body?.reasons) ? body.reasons.slice(0, 10).map((r) => String(r).slice(0, 200)) : []
      if (!id) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '缺少对象' })
      const advice = {
        suggestion, reasons, versionId, at: Date.now(),
        model: String(body?.model || '').slice(0, 80),
        // 管理员需要看到「建议是在哪个端点上生成的」，用来确认没有把待审正文发到公网
        endpoint: String(body?.endpoint || '').slice(0, 120),
        coverage: {
          truncated: body?.coverage?.truncated === true,
          shown: Math.max(0, Number(body?.coverage?.shown) || 0),
          total: Math.max(0, Number(body?.coverage?.total) || 0),
        },
      }
      if (targetType === 'post') {
        const p = store.getPost(id)
        if (!p) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '投稿不存在' })
        if (p.pendingVersionId !== versionId) return sendJSON(res, 409, { ok: false, code: 'STALE_VERSION', error: '内容已更新' })
        p.advice = advice
        store.putPost(p)
      } else {
        const c = store.getComment(id)
        if (!c) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '评论不存在' })
        c.advice = advice
        store.putComment(c)
      }
      return sendJSON(res, 200, { ok: true })
    }

    if (path === '/api/community/admin/decision' && method === 'POST') {
      const body = await readJSONBody(req, 16 * 1024).catch(() => null)
      if (!body) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求格式错误' })
      const targetType = body.targetType === 'comment' ? 'comment' : 'post'
      const id = String(body.id || '')
      const action = String(body.action || '')
      const versionId = String(body.versionId || '')
      const reason = String(body.reason || '').slice(0, 400)

      if (targetType === 'comment') {
        const c = store.getComment(id)
        if (!c) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '评论不存在' })
        if (c.status !== COMMENT_STATUS.PENDING) return sendJSON(res, 409, { ok: false, code: 'NOT_PENDING', error: '该评论已处理' })
        if (action === 'approve') {
          c.status = COMMENT_STATUS.VISIBLE
          const post = store.getPost(c.postId)
          if (post) {
            post.counts = { ...(post.counts || {}), comments: (post.counts?.comments || 0) + 1 }
            store.putPost(post)
          }
        } else if (action === 'reject' || action === 'remove') {
          c.status = COMMENT_STATUS.REJECTED
        } else {
          return sendJSON(res, 400, { ok: false, code: 'BAD_ACTION', error: '不支持的处理动作' })
        }
        c.decidedBy = user.id
        c.decidedAt = Date.now()
        c.decisionReason = reason
        store.putComment(c)
        audit(user, `comment.${action}`, { type: 'comment', id }, reason)
        return sendJSON(res, 200, { ok: true, status: c.status })
      }

      const post = store.getPost(id)
      const check = validateDecision(post, versionId, action)
      if (!check.ok) return sendJSON(res, check.code === 'NOT_FOUND' ? 404 : 409, { ok: false, code: check.code, error: check.error })

      const now = Date.now()
      post.lastDecision = { versionId, action, reason, by: user.id, at: now }
if (action === 'approve') {
        post.publishedVersionId = versionId
        post.pendingVersionId = ''
        post.status = POST_STATUS.PUBLISHED
        // 审核通过 = 恢复公开：清掉撤回/下架留下的可见性标记
        post.withdrawnAt = 0
        post.removedAt = 0
      } else if (action === 'reject') {
        post.pendingVersionId = ''
        // 已有发布版本时：旧版本继续展示（默认策略），不因一次修改被拒而整体下线
        post.status = post.publishedVersionId ? POST_STATUS.PUBLISHED : POST_STATUS.REJECTED
      } else if (action === 'request_changes') {
        post.pendingVersionId = ''
        post.status = post.publishedVersionId ? POST_STATUS.PUBLISHED : POST_STATUS.CHANGES_REQUESTED
      } else if (action === 'remove') {
        post.status = POST_STATUS.REMOVED
        post.removedAt = now
      } else if (action === 'restore') {
        post.status = POST_STATUS.PUBLISHED
        post.removedAt = 0
      }
      post.updatedAt = now
      store.putPost(post)
      audit(user, `post.${action}`, { type: 'post', id, versionId }, reason)
      return sendJSON(res, 200, { ok: true, status: post.status })
    }

    if (path === '/api/community/admin/report' && method === 'POST') {
      const body = await readJSONBody(req, 8 * 1024).catch(() => null)
      const id = String(body?.id || '')
      const outcome = String(body?.outcome || '').slice(0, 40)
      const action = String(body?.action || 'none')
const r = store.getReport(id)
      if (!r) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '记录不存在' })
      if (r.status === 'closed') return sendJSON(res, 200, { ok: true, changed: false })
      r.status = 'closed'
      r.outcome = outcome || action
      r.closedBy = user.id
      r.closedAt = Date.now()
      store.putReport(r)
      /**
       * 申诉复核通过（`reopen`）：把**申诉指向的那个版本**重新放回待审队列。
       * 🔴 不直接发布：申诉只推翻「上次处理」，不替代审核本身；管理员还要按正常流程看内容再决定。
       * 🔴 版本必须仍存在（作者可能已删除/撤回），否则只关闭申诉并说明。
       */
      if (action === 'reopen' && r.kind === 'appeal') {
        const p = store.getPost(r.targetId)
        const versionId = String(r.versionId || '')
        if (p && versionId && versionOf(p, versionId)) {
          p.status = POST_STATUS.PENDING
          p.pendingVersionId = versionId
          p.updatedAt = Date.now()
          store.putPost(p)
          audit(user, 'appeal.reopen', { type: 'post', id: p.id, versionId }, '申诉复核通过，重新进入待审')
        }
      }
      // 可选：举报成立 → 直接下架/删除对应内容
      if (action === 'takedown') {
        if (r.targetType === 'post') {
const p = store.getPost(r.targetId)
          if (p && p.publishedVersionId) {
            p.status = POST_STATUS.REMOVED
            // 🔴 只改状态不够：申诉重开或作者再提交会把状态改回 pending，
            //    必须留 `removedAt` 才能在 `postPubliclyVisible` 里继续压住旧版本。
            p.removedAt = Date.now()
            p.updatedAt = Date.now()
            store.putPost(p)
            audit(user, 'post.remove', { type: 'post', id: p.id, versionId: p.publishedVersionId }, '举报成立下架')
          }
        } else {
          const c = store.getComment(r.targetId)
          if (c && c.status === COMMENT_STATUS.VISIBLE) {
            c.status = COMMENT_STATUS.REMOVED
            c.removedAt = Date.now()
            c.removedBy = user.role
            store.putComment(c)
            const post = store.getPost(c.postId)
            if (post) { post.counts = { ...(post.counts || {}), comments: Math.max(0, (post.counts?.comments || 0) - 1) }; store.putPost(post) }
            audit(user, 'comment.remove', { type: 'comment', id: c.id }, '举报成立下架')
          }
        }
      }
      audit(user, 'report.close', { type: 'report', id }, r.outcome)
      return sendJSON(res, 200, { ok: true, changed: true })
    }

    if (path === '/api/community/admin/switch' && method === 'POST') {
      if (!isSuperAdmin(user)) return sendJSON(res, 403, { ok: false, code: 'FORBIDDEN', error: '需要管理员权限' })
      const body = await readJSONBody(req, 4 * 1024).catch(() => null)
      if (!body) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求格式错误' })
      const patch = {}
      for (const k of ['squareOpen', 'postsOpen', 'commentsOpen']) {
        if (body[k] !== undefined) patch[k] = !!body[k]
      }
      if (!Object.keys(patch).length) return sendJSON(res, 400, { ok: false, code: 'BAD_REQUEST', error: '没有要修改的开关' })
      const next = store.setState(patch)
      audit(user, 'switch.update', { type: 'state', id: 'global' }, JSON.stringify(patch))
      return sendJSON(res, 200, { ok: true, state: next })
    }

    if (path === '/api/community/admin/audit' && method === 'GET') {
      return sendJSON(res, 200, { ok: true, items: store.listAudit(Number(qs.get('limit')) || 50) })
    }

    return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '接口不存在' })
  }

  function allComments() {
    const out = []
    for (const p of store.listPosts()) out.push(...store.listCommentsOf(p.id))
    return out
  }
  function countPendingComments() {
    return allComments().filter((c) => c.status === COMMENT_STATUS.PENDING).length
  }

  return { handle, _internal: { publicPost, publicComment, myPost }, ANON_LABEL }
}
