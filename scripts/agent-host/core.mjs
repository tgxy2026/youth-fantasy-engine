// ============ Agent 宿主核心（3.4.3 可写工具）============
//
// 桌面主进程与便携本地服务**共用**这一份：host 配置 + 请求账本 + 本地 HTTP。
// 页面侧执行器在渲染进程（`src/lib/agentHost/executor.ts`），本文件只负责：
//   · 用随机 token 保护本机端点（猜端口不足以调用）；
//   · 同一次 requestId 的幂等（pending / success / failed / unknown）；
//   · 把调用交给页面（桌面＝IPC；便携＝队列，页面轮询领取）；
//   · 授权范围持久化到**独立的本机文件**，不写进作品数据（不随云同步 / 导出外泄）。
//
// 🔴 只绑 127.0.0.1；Host 必须是本机（防 DNS rebinding，与便携服务同口径）。
// 🔴 不读任何登录凭据；host 文件里只有桥要用的端口与随机 token。
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

export const HOST_FILE_NAME = 'agent-host.json'
export const LEDGER_FILE_NAME = 'agent-host-requests.json'
export const HOST_VERSION = 1
/** 浏览器页面请求必须带这个头：跨源页面带自定义头会触发 CORS 预检并被拒绝 */
export const PAGE_HEADER = 'x-yfe-agent-page'
const MAX_LEDGER = 300
const CALL_TIMEOUT_MS = 45_000

export const ACTIONS = ['setting:create', 'chapter:create', 'chapter:write']
const MAX_GRANTED_PROJECTS = 200

export function emptyScope() {
  return { projects: [] }
}

/** 与 `src/lib/agentHost/contract.ts::normalizeAgentScope` 同口径（失败关闭） */
export function normalizeScope(raw) {
  const list = raw && typeof raw === 'object' ? raw.projects : null
  if (!Array.isArray(list)) return emptyScope()
  const seen = new Set()
  const projects = []
  for (const item of list) {
    if (projects.length >= MAX_GRANTED_PROJECTS) break
    const projectId = item && typeof item.projectId === 'string' ? item.projectId.trim() : ''
    if (!projectId || seen.has(projectId)) continue
    const actions = Array.isArray(item.actions)
      ? Array.from(new Set(item.actions.filter(a => typeof a === 'string' && ACTIONS.includes(a))))
      : []
    if (!actions.length) continue
    seen.add(projectId)
    projects.push({ projectId, actions })
  }
  return { projects }
}

export function actionAllowed(scope, projectId, action) {
  if (!projectId) return false
  const grant = (scope.projects || []).find(p => p.projectId === projectId)
  return !!grant && grant.actions.includes(action)
}

// ---------- 原子写 ----------

function writeAtomicSync(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text, 'utf8')
  try { fs.renameSync(tmp, file) } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败不影响主流程 */ }
    throw error
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// ---------- 配置 ----------

export function loadConfig(file) {
  const raw = readJson(file)
  return {
    version: HOST_VERSION,
    enabled: raw && raw.enabled === true,
    scope: normalizeScope(raw && raw.scope),
    port: raw && Number.isInteger(raw.port) ? raw.port : 0,
    token: raw && typeof raw.token === 'string' && raw.token.length >= 32 ? raw.token : randomBytes(32).toString('hex'),
    updatedAt: raw && typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
}

export function saveConfig(file, config) {
  const out = {
    version: HOST_VERSION,
    enabled: config.enabled === true,
    scope: normalizeScope(config.scope),
    port: Number.isInteger(config.port) ? config.port : 0,
    token: config.token,
    updatedAt: Date.now(),
  }
  writeAtomicSync(file, JSON.stringify(out, null, 2) + '\n')
  try { fs.chmodSync(file, 0o600) } catch { /* Windows / 某些文件系统不支持，忽略 */ }
  return out
}

// ---------- 请求账本 ----------

export function createLedger(file) {
  let state = readJson(file)
  if (!state || typeof state !== 'object' || typeof state.requests !== 'object' || !state.requests) {
    state = { version: 1, requests: {} }
  }
  const save = () => {
    const entries = Object.values(state.requests)
    if (entries.length > MAX_LEDGER) {
      entries.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      for (const drop of entries.slice(0, entries.length - MAX_LEDGER)) delete state.requests[drop.requestId]
    }
    writeAtomicSync(file, JSON.stringify({ version: 1, requests: state.requests }, null, 2) + '\n')
  }
  return {
    get(requestId) { return state.requests[requestId] || null },
    list() { return Object.values(state.requests) },
    begin(requestId, meta) {
      const prev = state.requests[requestId]
      if (prev) {
        if (prev.state === 'success') return { kind: 'replay', record: prev }
        if (prev.state === 'unknown') return { kind: 'unknown', record: prev }
        if (prev.state === 'pending' && Date.now() - (prev.updatedAt || 0) < CALL_TIMEOUT_MS) return { kind: 'in-flight', record: prev }
        // failed / 过期 pending：允许重试（覆盖为本次 pending）
      }
      const now = Date.now()
      state.requests[requestId] = {
        requestId, tool: String(meta.tool || ''), projectId: String(meta.projectId || ''),
        sessionId: String(meta.sessionId || ''), state: 'pending', createdAt: now, updatedAt: now,
      }
      save()
      return { kind: 'started' }
    },
    finish(requestId, result) {
      const rec = state.requests[requestId]
      if (!rec) return
      const unknown = !result || result.ok === false && (
        result.code === 'SAVE_FAILED' || result.code === 'OUTCOME_UNKNOWN' || result.code === 'INTERNAL'
      )
      rec.state = result && result.ok === true ? 'success' : unknown ? 'unknown' : 'failed'
      rec.code = result && result.ok === false ? result.code : undefined
      rec.error = result && result.ok === false ? result.error : undefined
      rec.result = result && result.ok === true ? truncate(result.value) : undefined
      rec.updatedAt = Date.now()
      save()
    },
    markUnknown(requestId, error) {
      const rec = state.requests[requestId]
      if (!rec) return
      rec.state = 'unknown'
      rec.code = 'OUTCOME_UNKNOWN'
      rec.error = String(error || '结果不明')
      rec.updatedAt = Date.now()
      save()
    },
  }
}

/** 账本里只留精简后的返回值：正文不进账本（主数据才是真源） */
function truncate(value) {
  try {
    const text = JSON.stringify(value)
    if (text && text.length > 4000) return { truncated: true, note: '返回值过大已截断，请以引擎内数据为准' }
    return JSON.parse(text)
  } catch { return undefined }
}

// ---------- 便携页面队列 ----------

export function createPageQueue({ timeoutMs = CALL_TIMEOUT_MS } = {}) {
  let seq = 0
  const waiting = new Map()   // id -> { resolve, timer, clientId }
  const pending = []          // [{ id, payload }]
  const clients = new Map()   // clientId -> lastSeen
  return {
    clients,
    push(payload) {
      const id = `req-${Date.now().toString(36)}-${++seq}`
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          const index = pending.findIndex(item => item.id === id)
          if (index >= 0) pending.splice(index, 1)
          resolve({ ok: false, code: 'OUTCOME_UNKNOWN', error: '页面在超时时间内未回传结果（结果不明，请勿盲目重试）' })
        }, timeoutMs)
        waiting.set(id, { resolve, timer })
        pending.push({ id, payload })
      })
    },
    next(clientId) {
      if (typeof clientId === 'string' && clientId) clients.set(clientId, Date.now())
      // 清掉长时间不再轮询的客户端（状态展示用）
      for (const [key, seenAt] of clients) if (Date.now() - seenAt > 30_000) clients.delete(key)
      const item = pending.shift()
      return item ? { id: item.id, payload: item.payload } : null
    },
    settle(id, clientId, result) {
      const waiter = waiting.get(id)
      if (!waiter) return false
      clearTimeout(waiter.timer)
      waiting.delete(id)
      if (typeof clientId === 'string' && clientId) clients.set(clientId, Date.now())
      waiter.resolve(result)
      return true
    },
    size() { return pending.length },
  }
}

// ---------- HTTP 服务 ----------

function isLocalHost(req) {
  const host = (req.headers.host || '').trim().toLowerCase()
  if (!host) return false
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let len = 0
    req.on('data', chunk => {
      len += chunk.length
      if (len > limit) { reject(new Error('请求体过大')); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sameOriginPage(req) {
  if (req.headers[PAGE_HEADER] !== '1') return false
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const referer = req.headers.referer
  if (!referer) return site === 'same-origin' || site === 'none'
  try {
    return new URL(referer).host === req.headers.host
  } catch { return false }
}

function sendJson(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra })
  res.end(body)
}

/**
 * 创建宿主服务。
 * @param {object} opts
 * @param {string} opts.configFile   本机 host 配置文件（不随作品数据同步）
 * @param {(payload:object)=>Promise<object>} opts.callPage  把调用交给页面执行
 * @param {()=>number} [opts.clientCount]
 */
export function createAgentHost({ configFile, callPage, clientCount = () => 0 }) {
  const ledgerFile = path.join(path.dirname(configFile), LEDGER_FILE_NAME)
  const ledger = createLedger(ledgerFile)
  let config = loadConfig(configFile)
  let server = null
  let port = 0

  function status() {
    return {
      running: !!server && port > 0,
      enabled: config.enabled === true,
      port: port || null,
      bridgeFile: configFile,
      scope: normalizeScope(config.scope),
      clients: clientCount(),
      lastError: '',
      tokenConfigured: !!config.token,
    }
  }

  function setConfig(patch) {
    config = {
      ...config,
      ...(patch && typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      ...(patch && patch.scope ? { scope: normalizeScope(patch.scope) } : {}),
      port: port || config.port,
    }
    config = saveConfig(configFile, config)
    return status()
  }

  function authorized(req) {
    const raw = req.headers.authorization || ''
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : ''
    return !!token && token === config.token
  }

  async function handleCall(body) {
    if (!config.enabled) {
      return { ok: false, code: 'HOST_DISABLED', error: 'Agent 写入连接未开启。请在青春幻想引擎「模型设置 → Agent 连接」中开启并授权项目。' }
    }
    const call = body && body.call
    if (!call || typeof call !== 'object' || typeof call.tool !== 'string' || typeof call.requestId !== 'string') {
      return { ok: false, code: 'BAD_REQUEST', error: '请求格式不合法（缺少 call.tool / call.requestId）' }
    }
    const begin = ledger.begin(call.requestId, call)
    if (begin.kind === 'replay') {
      return { ok: true, result: begin.record.result, replayed: true }
    }
    if (begin.kind === 'unknown') {
      return {
        ok: false, code: 'OUTCOME_UNKNOWN',
        error: '该 requestId 上一次的结果不明（超时 / 落盘未确认）。请先凭 requestId 查询或在引擎中核对，不要盲目重复写入。',
        current: { requestId: call.requestId, state: begin.record.state, code: begin.record.code },
      }
    }
    if (begin.kind === 'in-flight') {
      return { ok: false, code: 'DUPLICATE_IN_FLIGHT', error: '同一个 requestId 正在处理中，请等待结果或稍后凭 requestId 查询。' }
    }
    let result
    try {
      result = await callPage({ call: { ...call }, scope: normalizeScope(config.scope) })
    } catch (error) {
      ledger.markUnknown(call.requestId, error)
      return { ok: false, code: 'OUTCOME_UNKNOWN', error: `页面执行未回传结果（${error && error.message ? error.message : String(error)}），结果不明，请勿盲目重试。` }
    }
    ledger.finish(call.requestId, result)
    return { ok: true, result }
  }

  const serverImpl = createServer(async (req, res) => {
    try {
      if (!isLocalHost(req)) return sendJson(res, 403, { ok: false, error: 'forbidden: 仅接受本机请求' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const route = url.pathname

      if (route === '/api/agent/status' && req.method === 'GET') {
        if (!authorized(req) && !sameOriginPage(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        return sendJson(res, 200, { ok: true, ...status() })
      }

      if (route === '/api/agent/call' && req.method === 'POST') {
        if (!authorized(req)) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '缺少或错误的连接 token' })
        let body
        try { body = JSON.parse(await readBody(req)) } catch { return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: '请求体不是有效 JSON' }) }
        return sendJson(res, 200, await handleCall(body))
      }

      if (route.startsWith('/api/agent/request/') && req.method === 'GET') {
        if (!authorized(req) && !sameOriginPage(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        const requestId = decodeURIComponent(route.slice('/api/agent/request/'.length))
        const record = ledger.get(requestId)
        if (!record) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有该 requestId 的记录：${requestId}` })
        return sendJson(res, 200, { ok: true, request: record })
      }

      if (route === '/api/agent/config' && req.method === 'POST') {
        if (!authorized(req) && !sameOriginPage(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        let body
        try { body = JSON.parse(await readBody(req)) } catch { return sendJson(res, 400, { ok: false, error: '请求体不是有效 JSON' }) }
        return sendJson(res, 200, { ok: true, status: setConfig(body) })
      }

      return sendJson(res, 404, { ok: false, error: 'unknown api' })
    } catch (error) {
      return sendJson(res, 500, { ok: false, code: 'INTERNAL', error: error && error.message ? error.message : String(error) })
    }
  })

  return {
    status,
    setConfig,
    ledger,
    configFile,
    async start() {
      if (server) return port
      await new Promise((resolve, reject) => {
        serverImpl.once('error', reject)
        serverImpl.listen(0, '127.0.0.1', resolve)
      })
      server = serverImpl
      port = serverImpl.address().port
      config = saveConfig(configFile, { ...config, port })
      return port
    },
    async stop() {
      if (!server) return
      const current = server
      server = null
      port = 0
      await new Promise(resolve => current.close(() => resolve()))
      try { config = saveConfig(configFile, { ...config, port: 0 }) } catch { /* 退出阶段写不进去不阻断 */ }
    },
  }
}

/** 页面端点共用的同源头校验（供便携服务复用） */
export { isLocalHost, sameOriginPage, sendJson, readBody }