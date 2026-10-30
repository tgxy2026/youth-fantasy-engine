// ============ 用户表（users.json 的唯一读写者） ============
//
// 【为什么用 JSON 而不是数据库】200 人以内、每次改动几百字节，一个 JSON 文件 + 原子写足够，
// 且「备份 = 拷一个文件」。真到需要 SQL 的规模（数千用户 / 并发写），换后端也只需改本文件。
//
// 🔴 缓存策略：按**文件 mtime** 失效，而不是「载入一次就一直用」。
//    原因是本文件会被两个进程碰：长驻的 yfe-web，以及运维用的 `admin.mjs`（发邀请码/调配额/删号）。
//    若服务端死守内存缓存，admin 改完文件后服务端下一次 persist 会把旧表整体写回去，
//    用户会看到「刚发的邀请码凭空消失」这类灵异现象。
//    mtime 比对的开销是一次 statSync（微秒级），换来的是两个进程永远看到同一份真相。
//
// 🔴 全程同步读写：Node 单线程下同步操作不会被并发打断，等于天然互斥；用户表很小，代价可忽略。
import { readFileSync, statSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { USERS_FILE, USERS_FILE_VERSION, DEFAULT_QUOTA } from './config.mjs'
import { writeTextAtomicSync } from './atomic.mjs'
import {
  createSession, findActive, touch, revoke, revokeOthers, revokeAll, prune,
  migrateLegacySession, summarize, expiryReason,
} from './sessions.mjs'

let cache = null
let cacheMtime = 0

function emptyDB() {
  return { version: USERS_FILE_VERSION, users: {}, invites: {} }
}

function normalizeDB(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.users || typeof parsed.users !== 'object') {
    throw new Error('users.json 结构无效（缺少 users 字段）')
  }
  parsed.invites = parsed.invites && typeof parsed.invites === 'object' ? parsed.invites : {}
  return parsed
}

/**
 * 载入用户表。
 * 🔴 损坏时**抛错而不是重建空表**：空表一旦被写回，全部账号与配额即刻蒸发。
 *    调用方（服务启动）应当直接失败退出，让运维看见，而不是带着空表继续跑。
 */
export function loadUsers() {
  let mtime
  try {
    mtime = statSync(USERS_FILE).mtimeMs
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const db = emptyDB()
      persist(db)
      return db
    }
    throw new Error(`users.json 无法访问：${e instanceof Error ? e.message : String(e)}`)
  }

  if (cache && mtime === cacheMtime) return cache

  const text = readFileSync(USERS_FILE, 'utf8')
  if (!text.trim()) throw new Error('users.json 是空文件（可能上次写入被中断）')
  const parsed = normalizeDB(JSON.parse(text))
  cache = parsed
  cacheMtime = mtime
  return cache
}

function persist(db) {
  writeTextAtomicSync(USERS_FILE, JSON.stringify(db, null, 2))
  cache = db
  try { cacheMtime = statSync(USERS_FILE).mtimeMs } catch { cacheMtime = 0 }
}

export function saveUsers() {
  const db = loadUsers()
  persist(db)
}

export function normalizeName(name) {
  return String(name || '').trim().toLowerCase()
}

export function findByName(name) {
  const db = loadUsers()
  const key = normalizeName(name)
  for (const u of Object.values(db.users)) {
    if (u.nameLower === key) return u
  }
  return null
}

export function findById(id) {
  const db = loadUsers()
  return db.users[id] || null
}

/** 预生成用户 id（供注册流程「先占邀请码、再建用户」使用，见 claimInvite 的注释） */
export function newUserId() {
  return 'u_' + randomBytes(6).toString('hex')
}

export function createUser({ id, name, passwordHash, quotaBytes = DEFAULT_QUOTA, role = 'user', invite = '' }) {
  const db = loadUsers()
  const uid = id || newUserId()
  const user = {
    id: uid,
    name: String(name).trim(),
    nameLower: normalizeName(name),
    pwd: passwordHash,
    quotaBytes,
    usedBytes: 0,
    role,
    // 来源邀请码 = 打赏凭证。双向可查：码能查出用过的人，人也能查出是哪张码进来的。
    invite: String(invite || ''),
    createdAt: Date.now(),
    lastLoginAt: 0,
  }
  db.users[uid] = user
  persist(db)
  return user
}

export function touchLogin(id) {
  const db = loadUsers()
  const u = db.users[id]
  if (!u) return
  u.lastLoginAt = Date.now()
  persist(db)
}

/** 记录已用字节（配额展示用；真实校验在读请求体时才做，见 index.mjs） */
export function setUsedBytes(id, bytes) {
  const db = loadUsers()
  const u = db.users[id]
  if (!u || u.usedBytes === bytes) return
  u.usedBytes = bytes
  persist(db)
}

/** 全部用户（按注册时间倒序） */
/**
 * 用**注册时那张邀请码**重置密码（WEB-06 的零成本方案）。
 *
 * 【为什么可行】邀请码由站主亲手发放、与账号一对一绑定（`user.invite` + `invite.usedBy` 双向可查）、
 * 8 位十六进制（约 10^12 组合）猜不动，且无需邮件服务。对「打赏用户」这个量级完全够用。
 *
 * 🔴 安全口径：
 *   · **用户名与邀请码必须同时匹配**。只校验「邀请码是否有效」会让拿到别人码的人重置别人的号；
 *   · 用户名不存在与邀请码不匹配返回**同一句错误** —— 分开提示等于免费告诉攻击者哪些用户名存在；
 *   · 重置后**清掉活跃会话**：用户来重置往往意味着怀疑账号被盗，不能让旧设备继续挂着；
 *   · 数据零改动：只换 `pwd` 一个字段，用户目录与全部稿件原样不动。
 */
export function resetPasswordByInvite(name, invite, newPasswordHash) {
  const db = loadUsers()
  const u = findByName(name)
  if (!u || !u.invite) return { ok: false, error: '用户名或邀请码不正确' }
  if (String(u.invite).toUpperCase() !== String(invite || '').trim().toUpperCase()) {
    return { ok: false, error: '用户名或邀请码不正确' }
  }
  u.pwd = newPasswordHash
  // 🔴 3.3.2：从「删掉那一个活跃会话」改为「撤销全部会话」——
  //    用户来重置往往意味着怀疑账号被盗，多设备时代必须把所有设备一起踢下线。
  const now = Date.now()
  // 🔴 迁移可能替换 db.users[id] 的对象引用，所以必须用 readSessions 取回「当前那一个」，
  //    否则撤销结果会写进孤儿对象（自检第 2 条抓到过的同一类错误）。
  const { list, user: cur } = readSessions(db, u.id, now)
  cur.sessionList = revokeAll(list, now).list
  delete cur.session
  persist(db)
  return { ok: true, value: cur }
}

export function listUsers() {
  const db = loadUsers()
  return Object.values(db.users).sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 取某用户的会话表，**并在需要时把旧的单会话字段搬过来**（不落盘，由调用方决定）。
 *
 * 🔴 纯函数式地接在当前 db 引用上：本文件全部同步读写，中途不 await ⇒ 不存在读改写竞态。
 * 🔴 迁移后删掉 `session` 字段：留着它会让两套来源同时存在，早晚有人只改其中一处。
 */
function getSessionListIn(db, id, now) {
  const u = db.users[id]
  if (!u) return []
  const { user, changed } = migrateLegacySession(u, now)
  if (changed) {
    // 🔴 只补 sessionList；旧 `session` 字段**留着**，等 checkSession 在旧令牌第一次到来时转正。
    //    提前删掉它 = 升级那一刻所有旧令牌立刻失效（审查抓到的真问题）。
    db.users[id] = user
  }
  return db.users[id].sessionList || []
}

/**
 * 读会话表并**同时取回迁移后的用户对象**。
 *
 * 🔴 为什么必须一起返回：`getSessionListIn` 迁移时会把 `db.users[id]` **换成一个新对象**。
 *    若调用方在调用前就 `const u = db.users[id]`，之后往这个旧对象上写 `sessionList`，
 *    写的是已经从表里摘掉的孤儿对象 —— `persist(db)` 存下去的那份根本没有新会话。
 *    这个 bug 真的发生过：注册后第二台设备登录，第一台的会话凭空消失（自检第 2 条抓到的）。
 */
function readSessions(db, id, now) {
  const list = getSessionListIn(db, id, now)
  return { list, user: db.users[id] }
}

/**
 * 新建一条会话（登录 / 注册 / 桌面授权换取令牌时调用）。
 *
 * 与旧 `setActiveSession` 的根本区别：**不覆盖其他设备**。软上限（10）时照样放行，
 * 只把 `limitExceeded` 交回给界面提示撤销；硬上限（20）才拒绝。
 * @returns {{ ok: boolean, code?: string, session?: object, limitExceeded?: boolean, activeCount?: number }}
 */
export function openSession(id, { sid, tokenHash, kind = 'web', label = '', now = Date.now() }) {
  const db = loadUsers()
  if (!db.users[id]) return { ok: false, code: 'NO_USER' }
  const { list, user: u } = readSessions(db, id, now)
  const r = createSession(list, { sid, tokenHash, kind, label, now })
  if (!r.ok) {
    // 触顶时也要把清理结果写回（可能刚清掉一批过期行），否则名额永远不释放
    u.sessionList = r.list
    persist(db)
    return { ok: false, code: r.code, activeCount: r.activeCount }
  }
  u.sessionList = r.list
  persist(db)
  return { ok: true, session: r.session, limitExceeded: !!r.limitExceeded, activeCount: r.activeCount }
}

/**
 * 按令牌摘要找会话并刷新 lastSeenAt（1 小时节流，`changed=false` 时不落盘）。
 * @returns {{ session: object|null, reason: string }}
 *   reason 用于把 401 分成「过期」与「被撤销」两种话（前端文案不同）。
 */
export function checkSession(id, { token, tokenHash, now = Date.now() } = {}) {
  const db = loadUsers()
  if (!db.users[id]) return { session: null, reason: 'NO_USER' }
  const { list, user: u } = readSessions(db, id, now)
  // 🔴 用 cur 跟踪「当前这一份会话表」：转正会换掉它，后面 touch/prune 必须基于新的那份。
  //    曾经这里直接用 `list`（转正前的空表）去 touch，并在 else 分支写回 u.sessionList ——
  //    等于把刚转正的那条会话**覆盖成空**，表现是「旧令牌能过鉴权，但设备列表里没有它」。
  let cur = list
  let s = findActive(cur, tokenHash, now)

  // 🔴 旧令牌就地转正（3.3.1 → 3.3.2 升级路径）：
  //    旧版令牌 3 段、服务端只记一个 `session.token`。摘要只有拿到 SECRET 的层算得出来，
  //    所以转正必须发生在这里（index.mjs 算好 tokenHash 传进来），而不是迁移函数里凭空造一个。
  //    转正后就删掉旧字段 —— 从此只认会话表，避免两套来源并存。
  if (!s && u.session && typeof u.session.token === 'string' && u.session.token) {
    const same = (() => {
      const a = Buffer.from(u.session.token)
      const b = Buffer.from(String(token || ''))
      return a.length === b.length && timingSafeEqual(a, b)
    })()
    if (same) {
      const created = createSession(cur, {
        sid: `legacy_${tokenHash.slice(0, 12)}`,
        tokenHash,
        kind: 'web',
        label: '升级前的设备',
        // 用旧记录里的登录时间，**不用 now**：否则等于给老会话偷偷续 90 天
        now: Number(u.session.at) || now,
      })
      delete u.session
      if (created.ok) {
        // 软/硬上限：旧设备本来就存在，硬顶时也让它进来（否则升级即掉线）
        u.sessionList = created.list
        cur = created.list
        persist(db)
        s = created.session
      } else {
        persist(db)
      }
    }
  }

  if (!s) {
    const prev = cur.find((x) => x.tokenHash === tokenHash)
    // 有一模一样的摘要但已失效 ⇒ 说清是撤销还是到期；完全没这条 ⇒ 当作过期（可能来自旧表）
    const reason = prev ? expiryReason(prev, now) || 'EXPIRED' : 'EXPIRED'
    return { session: null, reason }
  }
  const t = touch(cur, s.sid, now)
  if (t.changed) {
    u.sessionList = t.list
    persist(db)
  } else if (cur !== u.sessionList) {
    // 迁移或 prune 有变化但 touch 没写：补一次落盘，避免每次请求都重新迁移
    u.sessionList = cur
    persist(db)
  }
  return { session: s, reason: '' }
}

/** 撤销单条会话；返回是否真的改了（幂等，重复调用不写盘） */
export function revokeSessionById(id, sid, now = Date.now()) {
  const db = loadUsers()
  if (!db.users[id]) return false
  const { list, user: u } = readSessions(db, id, now)
  const r = revoke(list, sid, now)
  if (!r.changed) return false
  u.sessionList = r.list
  persist(db)
  return true
}

/** 撤销除当前会话外的全部；返回撤销条数 */
export function revokeOtherSessions(id, keepSid, now = Date.now()) {
  const db = loadUsers()
  if (!db.users[id]) return 0
  const { list, user: u } = readSessions(db, id, now)
  const r = revokeOthers(list, keepSid, now)
  if (!r.changed) return 0
  u.sessionList = r.list
  persist(db)
  return r.changed
}

/** 撤销全部会话（改密 / 重置 / 禁用）；返回撤销条数 */
export function revokeAllSessions(id, now = Date.now()) {
  const db = loadUsers()
  if (!db.users[id]) return 0
  const { list, user: u } = readSessions(db, id, now)
  const r = revokeAll(list, now)
  delete u.session
  if (!r.changed) { persist(db); return 0 }
  u.sessionList = r.list
  persist(db)
  return r.changed
}

/** 供界面用的会话列表（**不含 tokenHash**）；顺带清掉过期/超期撤销的行 */
export function listSessions(id, now = Date.now()) {
  const db = loadUsers()
  if (!db.users[id]) return []
  const { list, user: u } = readSessions(db, id, now)
  const p = prune(list, now)
  if (p.removed) {
    u.sessionList = p.list
    persist(db)
  }
  return summarize(p.removed ? p.list : list, now)
}

/** 会话是否仍然有效（不含刷新副作用；给「当前会话」标记用） */
export function isSessionActive(id, tokenHash, now = Date.now()) {
  const db = loadUsers()
  const u = db.users[id]
  if (!u) return false
  return !!findActive(getSessionListIn(db, id, now), tokenHash, now)
}

export function deleteUser(id) {
  const db = loadUsers()
  if (!db.users[id]) return false
  delete db.users[id]
  persist(db)
  return true
}

// ---------- 邀请码 ----------

/**
 * 生成邀请码。
 * 🔴 必须**与现有全部码（含已用完的）比对去重**：已用完的码仍留在 invites 里，
 *    若新码恰好与它相同，两个不同的人拿到同一个码 —— 后一个会被「已使用」拦住，
 *    但主人会以为「发出去的码不能用」，排查起来极难。
 */
export function createInvite({ code, maxUses = 1, note = '' } = {}) {
  const db = loadUsers()
  let c = String(code || '').trim().toUpperCase()
  if (c) {
    if (db.invites[c]) return { ok: false, error: `邀请码 ${c} 已存在，请换一个` }
  } else {
    let guard = 0
    do {
      c = randomBytes(4).toString('hex').toUpperCase()
      if (++guard > 100) return { ok: false, error: '邀请码生成失败（随机空间异常）' }
    } while (db.invites[c])
  }
  db.invites[c] = { createdAt: Date.now(), maxUses: Math.max(1, Number(maxUses) || 1), uses: 0, note, usedBy: [] }
  persist(db)
  return { ok: true, code: c }
}

/**
 * **原子地占用**一个邀请码：校验 + 核销在同一个同步块里完成。
 *
 * 🔴 这是「一个码不会被两个人用掉」的唯一保证点，改它之前先读完这段：
 *    · `loadUsers()` / `persist()` 全是**同步**的，Node 单线程下从「读到 uses」到「写回 uses+1」
 *      中间不会切给别的请求 —— 所以并发两个注册请求里，第二个必然读到已更新的 uses 并被拒。
 *    · 🔴 **本函数内（以及调用它的注册流程里，从 claimInvite 到 createUser 之间）绝对不许出现 `await`**。
 *      一旦让出事件循环，第二个请求就会插进来读到旧值，两个人同时注册成功、共用一张打赏码。
 *      请求体解析、密码哈希都必须放在 claimInvite **之前**完成。
 *    · 之所以要「先占码、后建用户」：反过来的话，用户建好了才发现码被别人抢走，
 *      只能回滚删除，而删除是更危险的操作（可能误删刚写入的数据）。
 */
export function claimInvite(code, uid, name) {
  const db = loadUsers()
  const key = String(code || '').trim().toUpperCase()
  const inv = db.invites[key]
  if (!inv) return { ok: false, error: '邀请码无效，请确认是否复制完整' }
  if (inv.uses >= inv.maxUses) return { ok: false, error: '该邀请码已被使用，不能重复注册' }
  inv.uses += 1
  if (!Array.isArray(inv.usedBy)) inv.usedBy = []
  inv.usedBy.push({ id: uid, name, at: Date.now() })
  persist(db)
  return { ok: true }
}

/**
 * 登记「这张码已经发出去了」（发给了谁可写进备注）。
 *
 * 🔴 为什么需要它：主人是手工发码的，发出去到对方注册之间有一段时间差。
 *    这期间码的状态是「未用」，与「还没发出去」完全一样 —— 再发一次就会把同一张码给两个人，
 *    后一个注册时被「已被使用」拦住，主人会以为发错了码。打上 `issuedAt` 就能区分三态。
 */
export function markIssued(code, note = '') {
  const db = loadUsers()
  const key = String(code || '').trim().toUpperCase()
  const inv = db.invites[key]
  if (!inv) return { ok: false, error: '找不到该邀请码' }
  if (inv.uses >= inv.maxUses) return { ok: false, error: '该码已被使用，无需再登记发放' }
  inv.issuedAt = Date.now()
  if (note) inv.note = note
  persist(db)
  return { ok: true }
}

export function listInvites() {
  const db = loadUsers()
  return Object.entries(db.invites).map(([code, v]) => ({
    code,
    createdAt: v.createdAt,
    issuedAt: v.issuedAt || 0,
    maxUses: v.maxUses,
    uses: v.uses,
    note: v.note,
    usedBy: Array.isArray(v.usedBy) ? v.usedBy : [],
  }))
}
