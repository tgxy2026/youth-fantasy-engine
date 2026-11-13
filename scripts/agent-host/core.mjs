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
import { createHash, randomBytes } from 'node:crypto'

export const HOST_FILE_NAME = 'agent-host.json'
export const LEDGER_FILE_NAME = 'agent-host-requests.json'
export const HOST_VERSION = 1
/** 浏览器页面请求必须带这个头：跨源页面带自定义头会触发 CORS 预检并被拒绝 */
export const PAGE_HEADER = 'x-yfe-agent-page'
const CALL_TIMEOUT_MS = 45_000
// 只读请求不需要幂等账本，也不能把作品正文或设定保存在账本中。
const READ_TOOLS = new Set(['yfe_list_projects', 'yfe_get_project', 'yfe_list_chapters', 'yfe_read_chapter', 'yfe_check_chapter_words', 'yfe_check_chapter_typos', 'yfe_list_setting_tabs', 'yfe_list_setting_cards', 'yfe_read_setting_card', 'yfe_list_data_tabs', 'yfe_read_form', 'yfe_list_table_rows', 'yfe_list_tavern_reports', 'yfe_read_tavern_report', 'yfe_list_chapter_snapshots', 'yfe_read_chapter_snapshot', 'yfe_list_world_sets', 'yfe_list_world_packs', 'yfe_read_world_pack_table', 'yfe_list_project_backups', 'yfe_list_maps', 'yfe_list_map_places', 'yfe_search_project', 'yfe_read_plot_canvas', 'yfe_preview_world_import', 'yfe_preview_backup_restore', 'yfe_list_chapter_trash', 'yfe_list_check_reports', 'yfe_read_check_report', 'yfe_list_agent_tasks', 'yfe_get_agent_task'])
READ_TOOLS.add('yfe_list_inspirations')

export const ACTIONS = ['setting:create', 'setting:write', 'form:write', 'table:create', 'table:write', 'volume:create', 'volume:write', 'chapter:create', 'chapter:write', 'chapter:delete', 'inspiration:write', 'map:create', 'map:write', 'map:delete', 'canvas:write', 'world:read', 'world:write', 'backup:restore', 'chapter:restore', 'report:write', 'task:write']
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function requestDigest(meta) {
  return createHash('sha256').update(canonicalJson({ tool: meta.tool || '', projectId: meta.projectId || '', args: meta.args ?? null })).digest('hex')
}

export function createLedger(file) {
  let state = readJson(file)
  if (!state && !fs.existsSync(file)) {
    state = { version: 1, requests: {} }
  }
  if (!state || typeof state !== 'object' || !state.requests || typeof state.requests !== 'object' || Array.isArray(state.requests)) {
    throw new Error('Agent 请求账本无法读取或格式损坏；为避免重复写入，已拒绝启动，请保留账本并排查。')
  }
  state.requests = Object.assign(Object.create(null), state.requests)
  // 不自动清除账本：遗忘一次已完成或结果不明的写入会让同一 ID 再次执行。
  const save = () => {
    writeAtomicSync(file, JSON.stringify({ version: 1, requests: state.requests }, null, 2) + '\n')
  }
  const expire = rec => {
    if (rec && rec.state === 'pending' && Date.now() - (rec.updatedAt || 0) >= CALL_TIMEOUT_MS) {
      rec.state = 'unknown'
      rec.code = 'OUTCOME_UNKNOWN'
      rec.error = '请求超时或宿主重启，无法确认是否已写入。'
      rec.updatedAt = Date.now()
      save()
    }
    return rec
  }
  return {
    get(requestId) { return expire(state.requests[requestId]) || null },
    list() { return Object.values(state.requests).map(expire) },
    begin(requestId, meta) {
      const digest = requestDigest(meta)
      const prev = state.requests[requestId]
      if (prev) {
        // 旧版记录没有摘要，无法证明参数相同，必须人工核对。
        if (!prev.digest) return { kind: 'unknown', record: prev }
        if (prev.digest !== digest) return { kind: 'conflict', record: prev }
        if (prev.state === 'success') return { kind: 'replay', record: prev }
        if (prev.state === 'unknown') return { kind: 'unknown', record: prev }
        if (prev.state === 'pending') {
          expire(prev)
          return { kind: prev.state === 'unknown' ? 'unknown' : 'in-flight', record: prev }
        }
        // 仅确定未写入的 failed 允许重试。
      }
      const now = Date.now()
      state.requests[requestId] = {
        requestId, tool: String(meta.tool || ''), projectId: String(meta.args?.projectId || meta.projectId || ''),
        sessionId: String(meta.sessionId || ''), digest, state: 'pending', createdAt: now, updatedAt: now,
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
      if (typeof clientId !== 'string' || !clientId || clientId.length > 200) return null
      if (typeof clientId === 'string' && clientId) clients.set(clientId, Date.now())
      // 清掉长时间不再轮询的客户端（状态展示用）
      for (const [key, seenAt] of clients) if (Date.now() - seenAt > 30_000) clients.delete(key)
      if (clients.size > 1) {
        for (const waiter of waiting.values()) {
          if (waiter.clientId && waiter.isWrite) waiter.competingPage = true
        }
      }
      if (clients.size > 1 && pending.length && !READ_TOOLS.has(pending[0].payload?.call?.tool)) {
        const blocked = pending.shift()
        const waiter = waiting.get(blocked.id)
        if (waiter) {
          clearTimeout(waiter.timer)
          waiting.delete(blocked.id)
          waiter.resolve({ ok: false, code: 'STORAGE_BLOCKED', error: '检测到多个引擎页面，为避免并发覆盖，请只保留一个页面后重试。' })
        }
        return null
      }
      const item = pending.shift()
      if (item) {
        const waiter = waiting.get(item.id)
        if (waiter) {
          waiter.clientId = clientId
          waiter.isWrite = !READ_TOOLS.has(item.payload?.call?.tool)
        }
      }
      return item ? { id: item.id, payload: item.payload } : null
    },
    settle(id, clientId, result) {
      const waiter = waiting.get(id)
      if (!waiter || !waiter.clientId || waiter.clientId !== clientId) return false
      clearTimeout(waiter.timer)
      waiting.delete(id)
      if (typeof clientId === 'string' && clientId) clients.set(clientId, Date.now())
      waiter.resolve(waiter.competingPage
        ? { ok: false, code: 'OUTCOME_UNKNOWN', error: '执行期间检测到其他引擎页面，写入结果不明；请核对数据和草稿，勿盲目重试。' }
        : result)
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
export function createAgentHost({ configFile, callPage, clientCount = () => 0, modeGate = null, callReadonly }) {
  const configPending = `${configFile}.pending`
  try {
    fs.lstatSync(configPending)
    throw new Error('Agent 配置更新未确认，请先检查并恢复配置')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const ledgerFile = path.join(path.dirname(configFile), LEDGER_FILE_NAME)
  const ledger = createLedger(ledgerFile)
  let config = loadConfig(configFile)
  let server = null
  let port = 0
  let configBlocked = false

  function status() {
    // 运行模式真源摘要（ISSUE-01）：enabled 只表示配置开关，不代表当前模式允许调用。
    const mode = modeGate ? modeGate.snapshot() : null
    return {
      running: !!server && port > 0,
      enabled: config.enabled === true,
      port: port || null,
      bridgeFile: configFile,
      scope: normalizeScope(config.scope),
      clients: clientCount(),
      lastError: configBlocked ? 'Agent 配置更新未确认，连接已停用；请先检查并恢复配置。' : '',
      tokenConfigured: !!config.token,
      connectionMode: mode ? { phase: mode.phase, mode: mode.mode ?? null, busy: mode.busy === true, reason: typeof mode.reason === 'string' ? mode.reason : '' } : null,
    }
  }

  function setConfig(patch) {
    if (configBlocked) throw new Error('Agent 配置更新未确认，请先检查并恢复配置')
    if (patch?.enabled === true && modeGate) {
      const mode = modeGate.snapshot()
      if (mode.phase !== 'stable' || mode.mode !== 'agent' || mode.busy) throw new Error('当前模式不允许开启 Agent 连接。')
    }
    const next = {
      ...config,
      ...(patch && typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      ...(patch && patch.scope ? { scope: normalizeScope(patch.scope) } : {}),
      port: port || config.port,
    }
    try {
      // 先建立持久的中断标记；意外退出或配置写入失败时启动不能沿用旧授权。
      fs.mkdirSync(path.dirname(configFile), { recursive: true })
      const fd = fs.openSync(configPending, 'wx', 0o600)
      try { fs.writeFileSync(fd, 'Agent config update pending\n'); fs.fsyncSync(fd) }
      finally { fs.closeSync(fd) }
      const saved = saveConfig(configFile, next)
      fs.unlinkSync(configPending)
      config = saved
    } catch (error) {
      // 授权写入失败时，既不能应用未保存的授权，也不能继续接受写入。
      // 磁盘记录可能仍是旧值；下次启动前必须修复存储故障并重新核对授权。
      config = { ...config, enabled: false }
      configBlocked = true
      throw error
    }
    return status()
  }

  function authorized(req) {
    const raw = req.headers.authorization || ''
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : ''
    return !!token && token === config.token
  }

  async function handleCallInner(body) {
    if (!config.enabled) {
      return { ok: false, code: 'HOST_DISABLED', error: 'Agent 写入连接未开启。请在青春幻想引擎「模型设置 → Agent 连接」中开启并授权项目。' }
    }
    const call = body && body.call
    if (!call || typeof call !== 'object' || typeof call.tool !== 'string' || typeof call.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(call.requestId)) {
      return { ok: false, code: 'BAD_REQUEST', error: '请求格式不合法（缺少 call.tool / call.requestId）' }
    }
    if (READ_TOOLS.has(call.tool)) {
      try {
        return { ok: true, result: await callPage({ call: { ...call }, scope: normalizeScope(config.scope) }) }
      } catch (error) {
        return { ok: false, code: 'INTERNAL', error: `页面读取失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }
    if (clientCount() > 1) return { ok: false, code: 'STORAGE_BLOCKED', error: '检测到多个引擎页面，为避免并发覆盖，请只保留一个页面后重试。' }
    const begin = ledger.begin(call.requestId, call)
    if (begin.kind === 'conflict') {
      return { ok: false, code: 'REQUEST_ID_REUSED', error: '该 requestId 已用于不同的工具或参数，请为新操作使用新的 requestId。' }
    }
    if (begin.kind === 'replay') {
      return { ok: true, result: { ok: true, value: begin.record.result }, replayed: true }
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

  // 可注入的宿主租约接线。调用方必须提供与 API 请求共用的唯一 modeGate；
  // 未传入时保留旧行为，不得将该兼容路径称为已实现互斥。
  async function handleCall(body) {
    if (!modeGate) return handleCallInner(body)
    const owner = 'agent-host'
    let lease
    try { lease = modeGate.acquire('agent', owner) }
    catch { return { ok: false, code: 'MODE_BLOCKED', error: '请切换到 MCP 模式后再调用工具。' } }
    // 超时、异常可能仍有页面写入在途，保留租约使模式切换失败关闭；
    // 不凭超时自动释放，直至将来由可信宿主确认任务终止并人工恢复。
    const result = await handleCallInner(body)
    if (result?.code === 'OUTCOME_UNKNOWN' || result?.result?.code === 'OUTCOME_UNKNOWN') return result
    if (!modeGate.release(lease, owner)) throw new Error('Agent 任务租约释放未确认，请核对任务状态')
    return result
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

      if (route === '/api/agent/readonly' && req.method === 'POST' && callReadonly && modeGate) {
        if (!authorized(req)) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' })
        const body = JSON.parse(await readBody(req))
        const owner = 'agent-host-readonly'
        let lease
        try { lease = modeGate.acquire('agent', owner) }
        catch { return sendJson(res, 409, { ok: false, code: 'MODE_BLOCKED', error: '请切换到 MCP 模式后再读取作品。' }) }
        try {
          if (!config.enabled) return sendJson(res, 403, { ok: false, code: 'HOST_DISABLED', error: '请开启 MCP 连接并授权项目。' })
          const value = await callReadonly(body, normalizeScope(config.scope))
          return sendJson(res, 200, { ok: true, value })
        } finally {
          modeGate.release(lease, owner)
        }
      }

      // ISSUE-11：账本查询刻意不经 modeGate——切回 API 模式后业务调用会被 MODE_BLOCKED 拒绝，
      // 但「结果不明 → yfe_request_status 核对」的收尾链路必须仍然可用（见适配规范 §4）。
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
      try {
        config = saveConfig(configFile, { ...config, port })
      } catch (error) {
        // 配置落盘失败时不能留下监听器：调用方可能随即释放唯一宿主锁。
        await new Promise((resolve, reject) => serverImpl.close(closeError => closeError ? reject(closeError) : resolve()))
        server = null
        port = 0
        throw error
      }
      return port
    },
    async stop() {
      if (!server) return
      const current = server
      // 只有确认监听器关闭后才能让模式服务释放宿主锁。
      await new Promise((resolve, reject) => current.close(error => error ? reject(error) : resolve()))
      server = null
      port = 0
      // 配置结果不明时保留磁盘原状，不能用退出时的内存快照覆盖待核对的证据。
      if (!configBlocked) {
        try { config = saveConfig(configFile, { ...config, port: 0 }) } catch { /* 退出阶段写不进去不阻断 */ }
      }
    },
  }
}

/** 页面端点共用的同源头校验（供便携服务复用） */
export { isLocalHost, sameOriginPage, sendJson, readBody }
