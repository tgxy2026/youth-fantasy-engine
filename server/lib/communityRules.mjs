// ============ 投稿广场 · 纯规则层（无 IO，可单测） ============
//
// 这一层只做「算」和「判」，不读文件、不发网络、不认识 HTTP。
// 服务端（communityApi）与测试共用同一份，避免「界面说能发、服务端说超长」这类漂移。
//
// 🔴 字数口径必须与客户端一致：按 **Unicode 码点**（Array.from）计数，不是 UTF-16 长度。
//    中文每字 1 个码点，emoji 也算 1 个 —— 用 `String.length` 会把 emoji 算成 2，
//    用户看到「还有 3 字」却提交失败。
//
// 🔴 规则初筛**只打标记，不判违规**：命中联系方式/风险词只提高等级、交给人工，
//    因为文学语境里「杀人」「自杀」是正常情节，关键词一刀切必然误伤。

export const COMMUNITY_LIMITS = {
  titleMax: 100,
  bodyMax: 10000,
  commentMax: 1000,
  tagMax: 3,
  tagLenMax: 16,
  nicknameMin: 1,
  nicknameMax: 16,
  pageSize: 20,
  pageSizeMax: 50,
  /** 单账号 24h 投稿上限（防批量灌水）；评论另有更细的频次限制 */
  postDailyMax: 5,
  commentDailyMax: 40,
  reportDailyMax: 20,
}

/** 预设标签（首版刻意保持很小，够筛选即可，不做自由标签池） */
export const COMMUNITY_TAGS = ['练笔', '短篇', '设定', '灵感', '求评']

/** Unicode 码点计数（与客户端 `charCount` 同口径） */
export function charCount(text) {
  if (typeof text !== 'string' || !text) return 0
  let n = 0
  for (const _ of text) n++
  return n
}

/** 去掉首尾空白后仍是空的（含只有换行/全角空格/零宽字符的情况） */
export function isBlank(text) {
  if (typeof text !== 'string') return true
  // \u3000 全角空格、\u200b 零宽空格、\ufeff BOM 都按空白处理
  return text.replace(/[\s\u3000\u200b\ufeff]/g, '') === ''
}

export const POST_STATUS = Object.freeze({
  DRAFT: 'draft',
  PENDING: 'pending',
  PUBLISHED: 'published',
  CHANGES_REQUESTED: 'changes_requested',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
  REMOVED: 'removed',
})

export const COMMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  VISIBLE: 'visible',
  REJECTED: 'rejected',
  REMOVED: 'removed',
})

/** 只有这两个状态对公众可见 */
export const PUBLIC_POST_STATUS = Object.freeze([POST_STATUS.PUBLISHED])
export const PUBLIC_COMMENT_STATUS = Object.freeze([COMMENT_STATUS.VISIBLE])

// ---------------- 输入校验 ----------------

/**
 * 投稿输入校验。
 * @returns {{ok:true, value:{title:string, body:string, tags:string[]}} | {ok:false, code:string, error:string}}
 */
export function validatePostInput(input) {
  const title = typeof input?.title === 'string' ? input.title.trim() : ''
  const body = typeof input?.body === 'string' ? input.body : ''
  const rawTags = Array.isArray(input?.tags) ? input.tags : []

  if (isBlank(title)) return { ok: false, code: 'TITLE_REQUIRED', error: '请填写标题' }
  if (charCount(title) > COMMUNITY_LIMITS.titleMax) {
    return { ok: false, code: 'TITLE_TOO_LONG', error: `标题最多 ${COMMUNITY_LIMITS.titleMax} 个字符` }
  }
  if (isBlank(body)) return { ok: false, code: 'BODY_REQUIRED', error: '正文不能为空' }
  if (charCount(body) > COMMUNITY_LIMITS.bodyMax) {
    return { ok: false, code: 'BODY_TOO_LONG', error: `正文最多 ${COMMUNITY_LIMITS.bodyMax} 个字符` }
  }

  const tags = []
  for (const t of rawTags) {
    const tag = typeof t === 'string' ? t.trim() : ''
    if (!tag) continue
    if (!COMMUNITY_TAGS.includes(tag)) return { ok: false, code: 'TAG_UNKNOWN', error: '只能选择预设标签' }
    if (charCount(tag) > COMMUNITY_LIMITS.tagLenMax) return { ok: false, code: 'TAG_TOO_LONG', error: '标签过长' }
    if (!tags.includes(tag)) tags.push(tag)
    if (tags.length > COMMUNITY_LIMITS.tagMax) {
      return { ok: false, code: 'TAG_TOO_MANY', error: `最多选择 ${COMMUNITY_LIMITS.tagMax} 个标签` }
    }
  }

  return { ok: true, value: { title, body, tags } }
}

export function validateCommentInput(input) {
  const body = typeof input?.body === 'string' ? input.body.trim() : ''
  if (isBlank(body)) return { ok: false, code: 'COMMENT_REQUIRED', error: '评论不能为空' }
  if (charCount(body) > COMMUNITY_LIMITS.commentMax) {
    return { ok: false, code: 'COMMENT_TOO_LONG', error: `评论最多 ${COMMUNITY_LIMITS.commentMax} 个字符` }
  }
  return { ok: true, value: { body } }
}

/**
 * 昵称校验。
 * 🔴 与登录名**完全分离**：昵称可以和登录名相同，但匿名展示时绝不输出登录名；
 *    这里刻意不检查「是否与某账号重名」—— 重名是隐私边界问题，不是可用性问题，
 *    公开界面只显示昵称，不提供账号检索。
 */
export function validateNickname(raw) {
  const nickname = typeof raw === 'string' ? raw.trim() : ''
  if (!nickname) return { ok: false, code: 'NICKNAME_REQUIRED', error: '请填写昵称' }
  if (/[\u0000-\u001f\u007f]/.test(nickname)) return { ok: false, code: 'NICKNAME_INVALID', error: '昵称含有不可见字符' }
  const n = charCount(nickname)
  if (n < COMMUNITY_LIMITS.nicknameMin) return { ok: false, code: 'NICKNAME_REQUIRED', error: '请填写昵称' }
  if (n > COMMUNITY_LIMITS.nicknameMax) {
    return { ok: false, code: 'NICKNAME_TOO_LONG', error: `昵称最多 ${COMMUNITY_LIMITS.nicknameMax} 个字符` }
  }
  // 规避开「匿名用户」占位名，避免冒充匿名展示
  const reservedForm = nickname.normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/g, '')
  if (reservedForm === '匿名用户' || /\(匿名用户\)$/.test(reservedForm)) return { ok: false, code: 'NICKNAME_RESERVED', error: '该名称不可用，请换一个' }
  /**
   * 3.5.0 · 冒名与官方身份：昵称会公开展示，且**不做人工预审**（首期没有昵称审核队列），
   * 所以至少要在这里挡住「看起来像官方」的名字，否则任何人都能叫「官方客服」
   * 去私信/引导读者。命中即拒绝，不进入待审 —— 这类名字没有「语境可解释」的空间。
   */
  if (/(官方|管理员|客服|站主|版主|审核员|系统消息|YFE\s*官方)/i.test(nickname)) {
    return { ok: false, code: 'NICKNAME_IMPERSONATION', error: '昵称不能包含官方或管理身份字样，请换一个' }
  }
  return { ok: true, value: nickname }
}

/** 公开展示选择：'nickname' | 'anonymous' */
export function normalizeDisplayMode(raw, fallback = 'anonymous') {
  return raw === 'nickname' || raw === 'anonymous' ? raw : fallback
}

// ---------------- 规则初筛 ----------------

const URL_RE = /(https?:\/\/|www\.)[^\s]{3,}/i
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/
const QQ_RE = /(?:qq|扣扣|企鹅)\D{0,4}\d{5,12}/i
const WECHAT_RE = /(?:微信|weixin|vx|v信|加v)\D{0,4}[a-z0-9_-]{4,20}/i
const INVITE_RE = /(?:加群|群号|进群|私聊|代写|代笔|接单|有偿|付费|收费|兼职|刷单|返利|贷款|博彩)/

/** 风险词只用于「提级到人工」，绝不用来自动拒绝 */
const RISK_WORDS = [
  '代写', '代笔', '接单', '刷单', '返利', '博彩', '赌博', '贷款', '办证', '发票',
  '约炮', '裸聊', '色情', '成人视频',
  '傻逼', '去死', '废物', '贱人',
]

/**
 * 规则初筛。
 *
 * @param {string} text
 * @param {'post'|'comment'} kind
 * @returns {{ level:'low'|'review'|'high', reasons:string[], truncated:boolean }}
 *   · `low`    —— 无任何命中，且文本足够「正常」（评论只有这一级会自动放行）
 *   · `review` —— 命中联系方式/重复/过短等，交人工
 *   · `high`   —— 命中多条或明确风险词，优先人工处理
 *   🔴 返回值里**不包含原文片段**：理由码足够人工判断，把正文再复制一份进队列只是扩大泄露面。
 */
export function screenContent(text, kind = 'comment') {
  const body = typeof text === 'string' ? text : ''
  const reasons = []
  const hits = []

  if (isBlank(body)) reasons.push('BLANK')
  if (charCount(body) < 2) reasons.push('TOO_SHORT')
  if (kind === 'comment' && /^(顶|赞|沙发|打卡|111+|\+1|好|妙)$/.test(body.trim())) reasons.push('LOW_INFO')

  if (URL_RE.test(body)) { reasons.push('URL'); hits.push('url') }
  if (EMAIL_RE.test(body)) { reasons.push('EMAIL'); hits.push('email') }
  if (PHONE_RE.test(body)) { reasons.push('PHONE'); hits.push('phone') }
  if (QQ_RE.test(body)) { reasons.push('CONTACT_QQ'); hits.push('qq') }
  if (WECHAT_RE.test(body)) { reasons.push('CONTACT_WECHAT'); hits.push('wechat') }
  if (INVITE_RE.test(body)) { reasons.push('SOLICIT'); hits.push('solicit') }

  const words = RISK_WORDS.filter((w) => body.includes(w))
  if (words.length) { reasons.push('RISK_WORD'); hits.push(...words.map(() => 'risk')) }

  // 重复刷屏：同一段短句重复 4 次以上，或单字符占比过高
  const compact = body.replace(/\s/g, '')
  if (compact.length >= 8) {
    const unit = compact.slice(0, Math.max(2, Math.floor(compact.length / 8)))
    let repeats = 0
    for (let i = 0; i + unit.length <= compact.length; i += unit.length) {
      if (compact.slice(i, i + unit.length) === unit) repeats++
      else break
    }
    if (repeats >= 4) reasons.push('REPEAT')
    const freq = new Map()
    for (const ch of compact) freq.set(ch, (freq.get(ch) || 0) + 1)
    const top = Math.max(...freq.values())
    if (top / compact.length >= 0.6) reasons.push('REPEAT')
  }

  const uniq = [...new Set(reasons)]
  let level = 'low'
  if (uniq.length) level = 'review'
  if (hits.length >= 2 || uniq.includes('RISK_WORD') || uniq.includes('SOLICIT')) level = 'high'
  return { level, reasons: uniq, truncated: false }
}

/**
 * 评论是否可直接显示。
 * 🔴 只有「检查已完成 + 低风险」才放行；任何异常（规则抛错、结果缺失）都必须保持待审。
 */
export function commentAutoVisible(screening) {
  return !!screening && screening.level === 'low' && Array.isArray(screening.reasons) && screening.reasons.length === 0
}

// ---------------- 分页 ----------------

/**
 * 游标 = base64url(JSON{v, ts, id})。
 * 🔴 必须带 `id` 做次序键：仅按时间戳分页时，同一毫秒内新增的两条会在翻页时重复或丢失。
 */
export function encodeCursor(cursor) {
  if (!cursor || typeof cursor.ts !== 'number' || typeof cursor.id !== 'string') return ''
  return Buffer.from(JSON.stringify({ v: 1, ts: cursor.ts, id: cursor.id }), 'utf8').toString('base64url')
}

export function decodeCursor(raw) {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!parsed || parsed.v !== 1 || typeof parsed.ts !== 'number' || typeof parsed.id !== 'string') return null
    return { ts: parsed.ts, id: parsed.id }
  } catch {
    return null
  }
}

export function clampPageSize(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return COMMUNITY_LIMITS.pageSize
  return Math.min(COMMUNITY_LIMITS.pageSizeMax, Math.max(1, Math.floor(n)))
}

/**
 * 按 `(ts, id)` 倒序取一页。
 * @param {Array<{id:string, ts:number}>} rows 已按 ts desc, id desc 排序
 */
export function pageRows(rows, { cursor = null, limit = COMMUNITY_LIMITS.pageSize } = {}) {
  const size = clampPageSize(limit)
  let start = 0
  if (cursor) {
    start = rows.findIndex((r) => r.ts < cursor.ts || (r.ts === cursor.ts && r.id < cursor.id))
    if (start < 0) return { items: [], nextCursor: '' }
  }
  const items = rows.slice(start, start + size)
  const last = items[items.length - 1]
  const hasMore = items.length === size && start + size < rows.length
  return { items, nextCursor: hasMore && last ? encodeCursor({ ts: last.ts, id: last.id }) : '' }
}

// ---------------- 审核决定 ----------------

/**
 * 校验「管理员决定」是否仍然作用于当前待审版本。
 *
 * 🔴 审核结果必须绑定具体版本：作者撤回、重新提交或管理员已处理过之后，
 *    旧版本上的迟到回执**绝不能**把新内容放出去。
 * @returns {{ok:true}|{ok:false, code:string, error:string}}
 */
export function validateDecision(post, versionId, action) {
  if (!post) return { ok: false, code: 'NOT_FOUND', error: '内容不存在' }
  const v = String(versionId || '')
  if (!v) return { ok: false, code: 'VERSION_REQUIRED', error: '缺少审核版本' }

  if (action === 'approve' || action === 'reject' || action === 'request_changes') {
    if (post.status !== POST_STATUS.PENDING) {
      return { ok: false, code: 'NOT_PENDING', error: '该内容已不在待审状态' }
    }
    if (String(post.pendingVersionId || '') !== v) {
      return { ok: false, code: 'STALE_VERSION', error: '内容已更新，请重新领取后再审' }
    }
    return { ok: true }
  }
  if (action === 'remove' || action === 'restore') {
    // 下架/恢复针对的是「已发布版本」，同样要绑定版本
    if (String(post.publishedVersionId || '') !== v) {
      return { ok: false, code: 'STALE_VERSION', error: '发布版本已变化，请刷新后再操作' }
    }
    return { ok: true }
  }
  return { ok: false, code: 'BAD_ACTION', error: '不支持的处理动作' }
}

// ---------------- 排行周期 ----------------

/** 排行榜固定北京时间自然日/周/月（服务端与客户端同口径） */
export const RANK_TZ_OFFSET_MIN = 8 * 60

/** 'YYYY-MM-DD' → 当日 00:00 UTC 毫秒（当作北京时间的日期标签使用） */
export function dateKeyToUtc(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const ms = Date.UTC(y, mo - 1, d)
  const check = new Date(ms)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return ms
}

export function utcToDateKey(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 北京时间「今天」的 dateKey */
export function todayKeyCn(nowMs = Date.now()) {
  return utcToDateKey(nowMs + RANK_TZ_OFFSET_MIN * 60000).slice(0, 10)
}

/**
 * 周期范围（闭区间，按日期字符串比较）。
 * · day   —— 当天
 * · week  —— 周一至周日
 * · month —— 自然月
 */
export function periodRange(period, dateKey) {
  const base = dateKeyToUtc(dateKey)
  if (base === null) return null
  if (period === 'day') return { start: dateKey, end: dateKey }
  if (period === 'month') {
    const d = new Date(base)
    const startKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
    const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
    return { start: startKey, end: utcToDateKey(endMs) }
  }
  if (period === 'week') {
    const d = new Date(base)
    const dow = d.getUTCDay() // 0=周日
    const back = (dow + 6) % 7
    const startMs = base - back * 86400000
    const endMs = startMs + 6 * 86400000
    return { start: utcToDateKey(startMs), end: utcToDateKey(endMs) }
  }
  return null
}

/**
 * 排行聚合。
 *
 * 日榜汇总同账号当天各项目的有符号净增量。周/月榜累加已结束日期的正净增量。
 * 日期按北京时间计算。并列同名次，次序稳定。
 *
 * @param {Array<{id:string, date:string, netDelta:number}>} rows 已按 (uid, date, project) 归一后的行
 * @param {{period:'day'|'week'|'month', date:string, today?:string}} opts
 * @returns {Array<{id:string, value:number, raw:number, rank:number}>} raw 为日净增量或周期有效累计
 */
export function aggregateRank(rows, { period = 'day', date, today = todayKeyCn() } = {}) {
  const range = periodRange(period, date)
  if (!range) return []
  const daysByAuthor = new Map()
  for (const r of rows) {
    if (!r || typeof r.date !== 'string') continue
    if (r.date < range.start || r.date > range.end) continue
    if (period !== 'day' && r.date >= today) continue
    const delta = Number(r.netDelta)
    if (!Number.isFinite(delta)) continue
    if (!daysByAuthor.has(r.id)) daysByAuthor.set(r.id, new Map())
    const days = daysByAuthor.get(r.id)
    days.set(r.date, (days.get(r.date) || 0) + delta)
  }
  const list = [...daysByAuthor.entries()].map(([id, days]) => {
    const raw = period === 'day' ? days.get(date) : [...days.values()].reduce((sum, delta) => sum + Math.max(0, delta), 0)
    return { id, raw, value: Math.max(0, raw) }
  })
  // 稳定次序：数值降序 → id 升序（id 是不透明句柄，不含账号信息）
  list.sort((a, b) => (b.value - a.value) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let rank = 1
  let prev = null
  for (let i = 0; i < list.length; i++) {
    if (prev !== null && list[i].value === prev) {
      list[i].rank = list[i - 1].rank
    } else {
      list[i].rank = i + 1
      prev = list[i].value
    }
  }
  return list
}

/**
 * 上报增量合并：同一 (uid, 设备, 项目, 日期) 只保留 seq 最大的一条。
 * 🔴 离线重放、重复点击都会带旧 seq —— 必须丢弃，否则「撤回后迟到的旧数据」会复活。
 */
export function applyRankReport(existing, incoming) {
  if (!existing) return { accept: true, row: incoming }
  if (Number(incoming.seq) < Number(existing.seq)) return { accept: false, row: existing }
  // 同 seq 视为重复请求：只有内容一致才幂等成功，不一致按冲突拒绝（不覆盖）
  if (Number(incoming.seq) === Number(existing.seq)) {
    return { accept: Number(incoming.netDelta) === Number(existing.netDelta), row: existing }
  }
  return { accept: true, row: incoming }
}

/** 稳定句柄：公开排行里代替账号 id，避免跨内容关联 */
export function rankHandle(uid, dateKey) {
  // 只作为「同一次聚合内的稳定排序键」，不出现在对外字段里
  return `${String(uid).slice(-6)}:${dateKey}`
}
