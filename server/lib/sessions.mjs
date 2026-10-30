// ============ 3.3.2 · P1 会话列表（纯数据层）============
//
// 背景：现有后端是**单会话**（`users.mjs` 的 `u.session` 只存一个 token，新登录顶掉旧设备，
// 见 `users.mjs` setActiveSession 的注释，那是为消除多端并发 WEB-02 的刻意设计）。
// 3.3.2 要允许多端接续，就必须把「一个 token」换成「一张会话表」，同时保住可撤销性。
//
// 🔴 本文件**只做数据语义**，不改任何路由：
//    · 不写 `index.mjs`，不替换 `issueSession`，不加接口；
//    · 存储仍是 `users.json`（迁移函数见 `migrateLegacySession`），但调用方由后续步骤接。
//    这样在拍板前就能把「上限 / 期限 / 撤销 / 并发」的语义用自检跑死，且线上零行为变化。
//
// 🔴 三个不可让步的判据：
//    1. **不存明文 token** —— 只存 tokenHash。users.json 一旦泄漏（备份、误传），
//       明文就等于把每台设备的口令一起交出去。
//    2. **撤销 ≠ 删行** —— 打 `revokedAt`，保留 7 天再清；否则「我明明点了退出」无从审计。
//    3. **过期时间一律以调用方传入的 `now` 为准** —— 不在本文件读 Date.now()，
//       否则时钟回拨/测试注入都会变成难复现的玄学 bug。
//
// 口径来源：`docs/3.3.2-P1多会话设计稿-v1-2026-10-30.md` §2（上限与期限、撤销触发）。

const DAY = 24 * 60 * 60 * 1000

/** 会话语义常量（设计稿 §2.2；改这些值要同步改文档） */
export const SESSION_LIMITS = {
  /** 软上限：超过时登录仍成功，但要让界面提示「先撤销一台」（规划 §12：不自动踢人） */
  soft: 10,
  /** 硬上限：防止列表无限增长；触顶拒绝新会话 */
  hard: 20,
  /** 不活动过期 */
  inactivityMs: 30 * DAY,
  /** 绝对过期（活跃使用也不能越过） */
  absoluteMs: 90 * DAY,
  /** `lastSeenAt` 落盘节流：users.json 是全量重写，逐请求写会变磁盘风暴 */
  touchThrottleMs: 60 * 60 * 1000,
  /** 已撤销记录保留期（审计痕迹） */
  revokedTtlMs: 7 * DAY,
}

/** 会话种类（决定界面文案与凭据强度） */
export const SESSION_KINDS = /** @type {const} */ (['web', 'desktop', 'portable'])

/** 为什么不能新建会话 */
export const SESSION_REFUSE = /** @type {const} */ ({
  HARD_LIMIT: 'SESSION_LIMIT_REACHED',
})

function isActive(s, now) {
  if (!s || s.revokedAt) return false
  if (now - s.createdAt > SESSION_LIMITS.absoluteMs) return false
  if (now - (s.lastSeenAt ?? s.createdAt) > SESSION_LIMITS.inactivityMs) return false
  return true
}

/** 到期判定单独导出：界面上要能区分「不活动过期」和「绝对过期」两种说法 */
export function expiryReason(session, now) {
  if (!session) return 'MISSING'
  if (session.revokedAt) return 'REVOKED'
  if (now - session.createdAt > SESSION_LIMITS.absoluteMs) return 'ABSOLUTE'
  if (now - (session.lastSeenAt ?? session.createdAt) > SESSION_LIMITS.inactivityMs) return 'INACTIVITY'
  return ''
}

/**
 * 新建一条会话。
 * @param {Array<object>} list 现有会话表（不会被就地修改）
 * @param {{ sid: string, tokenHash: string, kind?: string, label?: string, now: number }} input
 * @returns {{ ok: boolean, code?: string, list: Array<object>, session?: object, limitExceeded?: boolean, activeCount: number }}
 */
export function createSession(list, { sid, tokenHash, kind = 'web', label = '', now }) {
  if (!sid || !tokenHash) throw new Error('createSession 需要 sid 与 tokenHash')
  if (!SESSION_KINDS.includes(kind)) throw new Error(`未知会话种类：${kind}`)
  const pruned = prune(list, now).list
  const active = pruned.filter((s) => isActive(s, now))
  if (active.length >= SESSION_LIMITS.hard) {
    return { ok: false, code: SESSION_REFUSE.HARD_LIMIT, list: pruned, activeCount: active.length }
  }
  const session = {
    sid,
    tokenHash,
    kind,
    label: String(label || '').slice(0, 60),
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  }
  return {
    ok: true,
    list: [...pruned, session],
    session,
    // 软上限：仍然放行，但要告诉界面去提示撤销
    limitExceeded: active.length + 1 > SESSION_LIMITS.soft,
    activeCount: active.length + 1,
  }
}

/** 按 tokenHash 找有效会话；找不到时返回 null（调用方据此回 401 并区分 code） */
export function findActive(list, tokenHash, now) {
  const s = (list || []).find((x) => x.tokenHash === tokenHash)
  return s && isActive(s, now) ? s : null
}

/**
 * 刷新 lastSeenAt（节流）。返回 `{ list, changed }`：
 * `changed=false` 时调用方**不要**落盘 —— 这正是避免磁盘风暴的关键。
 */
export function touch(list, sid, now) {
  const idx = (list || []).findIndex((s) => s.sid === sid)
  if (idx < 0) return { list, changed: false }
  const s = list[idx]
  if (!isActive(s, now)) return { list, changed: false }
  if (now - (s.lastSeenAt ?? 0) < SESSION_LIMITS.touchThrottleMs) return { list, changed: false }
  const next = list.slice()
  next[idx] = { ...s, lastSeenAt: now }
  return { list: next, changed: true }
}

/** 撤销指定会话（幂等：已撤销的不重复写） */
export function revoke(list, sid, now) {
  let changed = false
  const next = (list || []).map((s) => {
    if (s.sid !== sid || s.revokedAt) return s
    changed = true
    return { ...s, revokedAt: now }
  })
  return { list: next, changed }
}

/** 撤销除当前会话外的全部（「退出其他所有设备」） */
export function revokeOthers(list, currentSid, now) {
  let changed = 0
  const next = (list || []).map((s) => {
    if (s.sid === currentSid || s.revokedAt) return s
    changed++
    return { ...s, revokedAt: now }
  })
  return { list: next, changed }
}

/** 撤销全部（改密 / 重置 / 账号禁用）。返回撤销条数，调用方据此决定是否清 Cookie */
export function revokeAll(list, now) {
  let changed = 0
  const next = (list || []).map((s) => {
    if (s.revokedAt) return s
    changed++
    return { ...s, revokedAt: now }
  })
  return { list: next, changed }
}

/**
 * 清理：已撤销超过 7 天的行、已过期的行。
 * 🔴 过期行也要清 —— 否则 90 天前的会话会一直占着 `activeCount` 的名额。
 * 返回 `{ list, removed }`，`removed=0` 时不必落盘。
 */
export function prune(list, now) {
  const kept = []
  let removed = 0
  for (const s of list || []) {
    if (s.revokedAt && now - s.revokedAt > SESSION_LIMITS.revokedTtlMs) { removed++; continue }
    if (!s.revokedAt && now - s.createdAt > SESSION_LIMITS.absoluteMs) { removed++; continue }
    if (!s.revokedAt && now - (s.lastSeenAt ?? s.createdAt) > SESSION_LIMITS.inactivityMs) { removed++; continue }
    kept.push(s)
  }
  return { list: removed ? kept : list || [], removed }
}

/**
 * 老数据迁移：`u.session = { token, at }` → `sessionList: [{…}]`。
 *
 * 🔴 旧 token **必须继续有效**：否则升级那一刻全员掉线，正在写的人会以为稿子没了
 *    （规划 §12「期限和存量会话升级须提前告知」）。
 * 🔴 `createdAt` 用 `at`（旧代码记录的是登录时间），不要用 now —— 那会把老会话的
 *    90 天绝对期限凭空续期。
 */
export function migrateLegacySession(user, now) {
  if (!user) return { user, changed: false }
  if (Array.isArray(user.sessionList)) return { user, changed: false }
  const legacy = user.session
  if (!legacy || !legacy.token) {
    // 没有旧会话：给一张空表，避免各处再判 undefined
    if (user.sessionList === undefined) return { user: { ...user, sessionList: [] }, changed: true }
    return { user, changed: false }
  }
  const token = String(legacy.token)
  const session = {
    sid: 'legacy_' + tokenHashStub(token),
    tokenHash: tokenHashStub(token),
    kind: 'web',
    label: '升级前的设备',
    createdAt: Number(legacy.at) || now,
    lastSeenAt: Number(legacy.at) || now,
    revokedAt: null,
  }
  const { sessionList, session: _drop, ...rest } = user
  return { user: { ...rest, sessionList: [session] }, changed: true }
}

/**
 * 旧数据迁移用的稳定哈希（只用于生成 sid/tokenHash 的占位）。
 * 🔴 真正上线时 tokenHash 必须是 HMAC-SHA256(令牌, 服务端密钥)，见 auth.mjs；
 *    这里用纯 JS 的 djb2 只是为了让迁移函数在没有密钥的单元测试里也能跑。
 */
function tokenHashStub(token) {
  let h = 5381
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) >>> 0
  return 'stub_' + h.toString(16)
}

/** 给界面的公开视图 —— **绝不包含 tokenHash**（防止 UI 泄漏凭据） */
export function summarize(list, now) {
  return (list || [])
    .filter((s) => isActive(s, now) || s.revokedAt)
    .map((s) => ({
      sid: s.sid,
      kind: s.kind,
      label: s.label,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt ?? s.createdAt,
      active: isActive(s, now),
      revokedAt: s.revokedAt ?? null,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.lastSeenAt - a.lastSeenAt)
}

export { isActive }
