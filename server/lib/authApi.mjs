// ============ 3.5.3 · P2 认证领域路由 ============
//
// 从 index.mjs 的 handleApi 按「认证」领域外抽：注册 / 登录 / 退出 / 重置 / 激活 /
// 当前用户 / ping / 桌面授权交换（公开段，先于公共 authCheck），以及登录设备管理（鉴权段）。
// 本层只做路由分派，业务语义逐字不变 —— 含注册临界区「占码 → 建用户」之间不得 await 的约束、
// 用户名枚举防护、会话软/硬上限、桌面令牌只进响应体等原有保障。
//
// 🔴 公共防护仍留在 index.mjs，未随本层迁移：
//    · 同源校验 sameOriginWriteOk 仍在 handleApi 最前（cloudTransport 专项钉住其源码文本）；
//    · 社区路由先于项目 v2 的顺序、data/blob 的 user.id 入口都不在本层（communityContract / 平台审计钉住）。
// 🔴 返回约定与 handleV2 一致：`return sendJSON(...), true` 表示已处理；未匹配任何路由返回 false，
//    交回 index.mjs 继续后续分派 —— 未匹配路径仍会经过公共 authCheck 与最终 404，顺序与副作用不变。
// 🔴 密钥 / 会话 / Cookie / 统计相关的闭包由 index.mjs 注入（它们持有 boot 期的 SECRET 与模块状态）；
//    纯 lib 函数直接 import（ES 模块单例，与 index.mjs 读到的是同一份已加载状态）。
import { sendJSON, readJSONBody } from './http.mjs'
import { rateLimit, resetLimit } from './ratelimit.mjs'
import { validateName, validatePassword, hashPassword, verifyPassword } from './auth.mjs'
import {
  findByName, findById, createUser, touchLogin, newUserId,
  claimInvite, activateCloudSync,
  revokeSessionById, revokeOtherSessions, listSessions,
  resetPasswordByInvite, resetPasswordByRecoveryCode,
} from './users.mjs'
import { ensureUserDir } from './userdata.mjs'
import { redeemCode } from './desktopAuth.mjs'
import { readLegacyGate } from './legacyGate.mjs'
import { REGISTER_MODE, SESSION_TTL_MS } from './config.mjs'
import { SESSION_LIMITS } from './sessions.mjs'

/**
 * @param {object} deps index.mjs 持有的认证闭包与常量
 * @param {(req:object)=>{user:object|null,reason:string,session:object|null}} deps.authCheck
 * @param {(req:object,uid:string,kind?:string)=>object} deps.issueSession 签发会话 + 种 Cookie
 * @param {(req:object,uid:string,kind?:string)=>object} deps.createSessionFor 只建会话（桌面用）
 * @param {(u:object)=>object} deps.publicUser
 * @param {(req:object)=>string} deps.clearCookie
 * @param {(req:object)=>string} deps.clearGuestCookie
 * @param {(type:string)=>void} deps.recordStat
 * @param {(reason:string)=>string} deps.sessionCode
 * @param {string} deps.V2_ROOT
 * @param {string} deps.APP
 */
export function createAuthApi({
  authCheck, issueSession, createSessionFor, publicUser,
  clearCookie, clearGuestCookie, recordStat, sessionCode,
  V2_ROOT, APP,
}) {
  // ---- 公开段：先于公共 authCheck（注册/登录无需会话；ping 是健康检查）----
  async function handlePublic({ req, res, path, ip }) {
    // ---- 注册 ----
    if (path === '/api/auth/register' && req.method === 'POST') {
      if (REGISTER_MODE === 'closed') return sendJSON(res, 403, { ok: false, error: '本站暂未开放注册' }), true
      const rl = rateLimit(`reg:${ip}`, 5, 60 * 60 * 1000)
      if (!rl.ok) return sendJSON(res, 429, { ok: false, error: `注册过于频繁，请 ${rl.retryAfter} 秒后再试` }), true

      let body
      try { body = await readJSONBody(req, 8 * 1024) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }), true }

      const nv = validateName(body.name)
      if (!nv.ok) return sendJSON(res, 400, { ok: false, error: nv.error }), true
      const pv = validatePassword(body.password)
      if (!pv.ok) return sendJSON(res, 400, { ok: false, error: pv.error }), true
      if (findByName(nv.value)) return sendJSON(res, 409, { ok: false, error: '该用户名已被占用' }), true

      // ---- 临界区准备：把可能失败 / 可能慢的步骤全部放到「占码」之前 ----
      // 密码哈希（scrypt，约数十毫秒）必须在这里做完：它若放在 claimInvite 之后，
      // 就等于在「占码」与「建用户」之间让出了事件循环 —— 见 claimInvite 的注释。
      const uid = newUserId()
      const pwdHash = hashPassword(pv.value)

      let inviteCode = ''
      if (REGISTER_MODE === 'invite') {
        inviteCode = String(body.invite || '').trim().toUpperCase()
        if (!inviteCode) return sendJSON(res, 400, { ok: false, error: '请填写邀请码' }), true
      } else {
        // 3.5.0 开放注册：邀请码可选，只用来「同时开通云端同步」。
        // 🔴 填了就必须有效：静默忽略会让用户以为资格已开通，实际没有。
        inviteCode = String(body.invite || '').trim().toUpperCase()
      }

      // 🔴 临界区（全同步，中间不得出现 await）：占码 → 建用户
      if (inviteCode) {
        const claim = claimInvite(inviteCode, uid, nv.value)
        if (!claim.ok) return sendJSON(res, 400, { ok: false, error: claim.error }), true
      }
      const user = createUser({
        id: uid, name: nv.value, passwordHash: pwdHash, invite: inviteCode,
        // 3.5.0：邀请码/激活码 = 云端资格凭证（保持既有打赏用户的权益）；
        // 开放注册（无码）= 可参与社区、暂不授予同步，由运营另行开通。
        cloudSync: inviteCode ? true : false,
      })
      ensureUserDir(user.id)
      touchLogin(user.id) // 注册即登录，最后登录时间此刻就是现在（否则界面显示「—」）
      // 🔴 临界区结束
      console.log(`[auth] 新用户注册：${user.name} (${user.id}) from ${ip}`)
      recordStat('register')
      const issued = issueSession(req, user.id)
      if (!issued.ok) {
        // 理论上注册时不可能触顶（新账号没有会话），留这条是为了不把「拒绝」当成成功
        return sendJSON(res, 409, { ok: false, code: issued.code, error: '登录设备过多，请先在其他设备上退出' }), true
      }
      return sendJSON(res, 200, { ok: true, user: publicUser(user), sessionLimitExceeded: issued.limitExceeded }, {
        // 注册即登录：种会话，同时清掉游客标记（否则下次打开还会被当成游客）
        'Set-Cookie': [issued.cookie, clearGuestCookie(req)],
      }), true
    }

    // ---- 登录 ----
    if (path === '/api/auth/login' && req.method === 'POST') {
      const rl = rateLimit(`login:${ip}`, 12, 10 * 60 * 1000)
      if (!rl.ok) return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${rl.retryAfter} 秒后再试` }), true

      let body
      try { body = await readJSONBody(req, 8 * 1024) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }), true }

      const user = findByName(body.name)
      // 🔴 用户名不存在与密码错误返回**同一句话**：分开提示等于免费提供用户名枚举
      if (!user || !verifyPassword(String(body.password || ''), user.pwd)) {
        return sendJSON(res, 401, { ok: false, error: '用户名或密码不正确' }), true
      }
      resetLimit(`login:${ip}`)
      touchLogin(user.id)
      console.log(`[auth] 登录：${user.name} from ${ip}`)
      recordStat('login')
      const issued = issueSession(req, user.id)
      if (!issued.ok) {
        // 硬上限（20 台）才会走到这里。软上限（10 台）是放行 + 提示撤销，不拒绝登录。
        return sendJSON(res, 409, {
          ok: false, code: issued.code,
          error: '登录的设备太多（已达上限）。请先在常用设备上打开「登录设备」撤销一台，或凭邀请码重置密码。',
        }), true
      }
      return sendJSON(res, 200, {
        ok: true, user: publicUser(findById(user.id)),
        // 界面据此提示「已登录 N 台，建议撤销不用的设备」；不自动踢人
        sessionLimitExceeded: issued.limitExceeded,
        sessionCount: issued.activeCount,
      }, {
        'Set-Cookie': [issued.cookie, clearGuestCookie(req)],
      }), true
    }

    // ---- 退出 ----
    if (path === '/api/auth/logout' && req.method === 'POST') {
      // 3.3.2：只撤销**本设备**这条会话。旧实现是「抹掉账号唯一的活跃会话」，
      // 多设备时代那样做等于「一台退出，全部下线」，与「各设备可单独管理」正相反。
      const chkOut = authCheck(req)
      if (chkOut.user && chkOut.session) revokeSessionById(chkOut.user.id, chkOut.session.sid)
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(req) }), true
    }

    // ---- 凭邀请码重置密码（WEB-06） ----
    if (path === '/api/auth/reset' && req.method === 'POST') {
      // 限流口径与登录一致：重置是暴力试邀请码的主要入口，必须按 IP 卡住
      const rl = rateLimit(`reset:${ip}`, 5, 10 * 60 * 1000)
      if (!rl.ok) return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${rl.retryAfter} 秒后再试` }), true

      let body
      try { body = await readJSONBody(req, 8 * 1024) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }), true }

      const nv = validateName(body.name)
      if (!nv.ok) return sendJSON(res, 400, { ok: false, error: nv.error }), true
      const pv = validatePassword(body.password)
      if (!pv.ok) return sendJSON(res, 400, { ok: false, error: pv.error }), true
      const invite = String(body.invite || '').trim().toUpperCase()
      // 3.5.0：开放注册的账号没有邀请码，改用站主人工核实后签发的一次性「找回码」。
      const recovery = String(body.recovery || '').trim().toUpperCase()
      if (!invite && !recovery) return sendJSON(res, 400, { ok: false, error: '请填写邀请码或找回码' }), true

      const r = recovery
        ? resetPasswordByRecoveryCode(nv.value, recovery, hashPassword(pv.value))
        : resetPasswordByInvite(nv.value, invite, hashPassword(pv.value))
      if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error }), true

      console.log(`[auth] 密码重置（凭${recovery ? '找回码' : '邀请码'}）：${r.value.name} from ${ip}`)
      recordStat('reset')
      return sendJSON(res, 200, { ok: true, name: r.value.name }), true
    }

    // ---- 已注册账号兑换云同步资格 ----
    if (path === '/api/auth/activate' && req.method === 'POST') {
      const checked = authCheck(req)
      if (!checked.user) return sendJSON(res, 401, { ok: false, error: '请先登录' }), true
      const expectedAccount = req.headers['x-yfe-account-context']
      if (typeof expectedAccount === 'string' && expectedAccount !== checked.user.id) {
        return sendJSON(res, 409, { ok: false, code: 'ACCOUNT_CONTEXT_CHANGED', error: '账号已在其他页面切换，请刷新页面后重试；邀请码未使用。' }), true
      }
      const rl = rateLimit(`activate:${checked.user.id}:${ip}`, 10, 60 * 60 * 1000)
      if (!rl.ok) return sendJSON(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' }), true
      const body = await readJSONBody(req, 8 * 1024).catch(() => null)
      if (!body) return sendJSON(res, 400, { ok: false, error: '请求格式错误' }), true
      const result = activateCloudSync(checked.user.id, body.code)
      if (!result.ok) return sendJSON(res, 400, { ok: false, error: result.error }), true
      return sendJSON(res, 200, { ok: true, alreadyActive: result.alreadyActive }), true
    }

    // ---- 当前用户 ----
    if (path === '/api/auth/me' && req.method === 'GET') {
      // 用自己的 authCheck（此处位于公共 chk 定义之前，不能借用）
      const me = authCheck(req)
      if (!me.user) return sendJSON(res, 401, { ok: false, error: '未登录', code: sessionCode(me.reason) }), true
      const u = me.user
      // 🔴 不再每次调用都 usageOf() 重算：那会**递归遍历整个用户目录**（data.json + 全部外置 blob），
      //    重度用户几千个文件时是几百毫秒的同步 IO，而页面加载 + 底部胶囊每次都要调这个接口。
      //    usedBytes 由 PUT /api/data 与 blob 写入时同步维护，这里直接返回记录值即可
      //    （配额提示不需要精确到字节，滞后一次保存完全可接受）。
      return sendJSON(res, 200, {
        ok: true, user: publicUser(u),
        // 旧版写入是否已被停用：前端据此**提前**告诉用户「该升级了」，而不是等他敲完一章再报错
        legacyWriteBlocked: readLegacyGate(V2_ROOT, u.id).blocked,
      }), true
    }

    if (path === '/api/ping') {
      return sendJSON(res, 200, { ok: true, app: APP, now: Date.now() }), true
    }

    // ---- 桌面授权交换（3.3.2 · 不需要 Cookie：授权码本身就是凭据）----
    if (path === '/api/auth/desktop/exchange' && req.method === 'POST') {
      const rl = rateLimit(`dp:${ip}`, 20, 10 * 60 * 1000)
      if (!rl.ok) return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${rl.retryAfter} 秒后再试` }), true
      let body
      try { body = await readJSONBody(req, 8 * 1024) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }), true }
      const r = redeemCode({ code: String(body?.code || ''), verifier: String(body?.verifier || '') })
      if (!r.ok) {
        // 授权码相关错误一律 400 且不含细节来源（不告诉调用方是「过期」还是「不匹配」以外的东西）
        return sendJSON(res, r.status || 400, { ok: false, error: r.error }), true
      }
      const du = findById(r.uid)
      if (!du) return sendJSON(res, 400, { ok: false, error: '账号不存在' }), true
      const s = createSessionFor(req, du.id, 'desktop')
      if (!s.ok) {
        return sendJSON(res, 409, {
          ok: false, code: s.code,
          error: '登录的设备太多（已达上限）。请先在浏览器里撤销一台不用的设备，或凭邀请码重置密码。',
        }), true
      }
      console.log(`[auth] 桌面授权登录：${du.name} (端口 ${r.port}) from ${ip}`)
      recordStat('desktop_login')
      // 🔴 令牌只出现在响应体：不进 URL、不进日志
      return sendJSON(res, 200, {
        ok: true, token: s.token, expiresAt: Date.now() + SESSION_TTL_MS,
        user: publicUser(du), sessionLimitExceeded: s.limitExceeded, sessionCount: s.activeCount,
      }), true
    }

    return false
  }

  // ---- 鉴权段：登录设备管理（在 community/v2 之后、data/blob 之前；user/chk 由 index.mjs 传入）----
  async function handleSessions({ req, res, path, user, chk }) {
    // ---- 登录设备管理（3.3.2 · P1）----
    // 软上限 10 / 硬上限 20：这里把两个数交给界面，避免前端另写一份（必然漂移）
    if (path === '/api/auth/sessions' && req.method === 'GET') {
      if (!user) return sendJSON(res, 401, { ok: false, error: '未登录', code: sessionCode(chk.reason) }), true
      const cur = chk.session?.sid || ''
      const list = listSessions(user.id).map((s) => ({ ...s, current: s.sid === cur }))
      return sendJSON(res, 200, {
        ok: true, sessions: list, softLimit: SESSION_LIMITS.soft, hardLimit: SESSION_LIMITS.hard,
      }), true
    }

    if (path === '/api/auth/sessions/revoke' && req.method === 'POST') {
      if (!user) return sendJSON(res, 401, { ok: false, error: '未登录', code: sessionCode(chk.reason) }), true
      let body
      try { body = await readJSONBody(req, 4 * 1024) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }), true }
      const sid = String(body?.sid || '')
      if (!sid) return sendJSON(res, 400, { ok: false, error: '缺少会话 id' }), true
      // 🔴 只按「自己的」会话表撤销：api 层从不接受外部传来的 uid，防越权
      const changed = revokeSessionById(user.id, sid)
      const isSelf = sid === (chk.session?.sid || '')
      return sendJSON(res, 200, { ok: true, changed, selfRevoked: isSelf && changed },
        isSelf && changed ? { 'Set-Cookie': clearCookie(req) } : undefined), true
    }

    if (path === '/api/auth/sessions/revoke-others' && req.method === 'POST') {
      if (!user) return sendJSON(res, 401, { ok: false, error: '未登录', code: sessionCode(chk.reason) }), true
      const cur = chk.session?.sid || ''
      const revoked = cur ? revokeOtherSessions(user.id, cur) : 0
      return sendJSON(res, 200, { ok: true, revoked }), true
    }

    return false
  }

  return { handlePublic, handleSessions }
}