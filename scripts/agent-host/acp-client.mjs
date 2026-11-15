// ACP v1 over newline-delimited JSON-RPC. The launcher owns process-tree shutdown.
const MAX_FRAME = 1024 * 1024
const MAX_TEXT = 512 * 1024
const REQUEST_TIMEOUT = 30_000
/**
 * 单次生成（`session/prompt`）的等待上限。
 *
 * 🔴 2026-11-16 真机实测（3.5.6 安装版 + Antigravity 1.5.0 + gemini-3.8-flash）：
 *    「名词术语 AI 查重」32 条 → Agent 用了 190 秒仍未返回，旧值 180s 到点就报
 *    「ACP session/prompt 超时」，作者只看到一句超时、不知道是被限时还是 Agent 挂了。
 *    3.5.6 新接的结构化/批量任务（术语查重、多块校对、工单整章改写、拆书逐章抽取）
 *    都可能落在这个区间，故放宽到 300s，并让超时文案讲清「等了多久、还能怎么办」。
 *    （普通 JSON-RPC 请求仍是 30s：那类是握手/列表，慢就是真慢。）
 */
const PROMPT_TIMEOUT_MS = 300_000

function sessionFailureKind(method, error) {
  if (method !== 'session/new' || error.code !== -32603) return undefined
  // Classify within the host. Vendor error data can contain account data or URLs.
  const text = [error.message, typeof error.data === 'string' ? error.data : JSON.stringify(error.data)]
    .filter(value => typeof value === 'string').map(value => value.slice(0, 4096)).join(' ')
  if (/\b(?:401|403)\b|unauthori[sz]ed|permission denied|invalid credentials/i.test(text)) return 'auth'
  if (/\b429\b|resource.exhausted|rate.limit|quota/i.test(text)) return 'quota'
  if (/\b(?:502|503|504)\b|network|connection (?:reset|refused|aborted|error)|econnreset|service unavailable|timed out|deadline exceeded|temporar(?:y|ily)/i.test(text)) return 'network'
  return 'unknown'
}

export function createAcpClient({ input, output, exited, clientVersion }) {
  const requests = new Map()
  let nextId = 0
  let failure = null
  let buffered = Buffer.alloc(0)
  let receivedBytes = 0
  let turn = null

  function fail(error) {
    if (failure) return
    failure = error
    for (const pending of requests.values()) pending.reject(error)
    requests.clear()
  }

  function send(message) {
    if (failure) throw failure
    const frame = JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'
    if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error('ACP 请求超出大小限制。')
    input.write(frame)
  }

  function receive(frame) {
    const msg = JSON.parse(frame.toString('utf8'))
    if (msg?.jsonrpc !== '2.0') throw new Error('ACP 消息格式无效。')
    if (typeof msg.method === 'string') {
      if (msg.id != null) {
        if (msg.method === 'session/request_permission') {
          send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } })
        } else {
          send({ id: msg.id, error: { code: -32601, message: 'Client method unavailable' } })
        }
        throw new Error('ACP Agent 请求了当前操作不允许的能力。')
      }
      if (msg.method !== 'session/update' || !turn || msg.params?.sessionId !== turn.sessionId) return
      const update = msg.params.update
      if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
        throw new Error('ACP Agent 启动了当前写作任务不允许的工具。')
      }
      if (turn.signal?.aborted || update?.sessionUpdate !== 'agent_message_chunk') return
      if (update.content?.type !== 'text' || typeof update.content.text !== 'string') {
        throw new Error('ACP Agent 返回了非文本内容。')
      }
      turn.bytes += Buffer.byteLength(update.content.text)
      if (turn.bytes > MAX_TEXT) throw new Error('ACP 输出超出大小限制。')
      turn.chunks.push(update.content.text)
      turn.onChunk?.(update.content.text)
      return
    }
    const pending = requests.get(msg.id)
    if (!pending) return
    requests.delete(msg.id)
    if (msg.error) {
      const code = Number.isInteger(msg.error.code) ? msg.error.code : null
      pending.reject(Object.assign(new Error(`ACP ${pending.method} 失败（${code ?? '未知错误'}）。`), {
        acpCode: code, sessionFailure: sessionFailureKind(pending.method, msg.error),
      }))
    }
    else if (Object.hasOwn(msg, 'result')) pending.resolve(msg.result)
    else pending.reject(new Error('ACP 响应缺少结果。'))
  }

  function onData(chunk) {
    if (failure) return
    try {
      receivedBytes += chunk.length
      if (receivedBytes > 8 * MAX_FRAME) throw new Error('ACP 会话输出超出大小限制。')
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline < 0 ? chunk.length : newline
        if (buffered.length + end - start > MAX_FRAME) throw new Error('ACP 消息超出大小限制。')
        buffered = Buffer.concat([buffered, chunk.subarray(start, end)])
        if (newline < 0) return
        const frame = buffered
        buffered = Buffer.alloc(0)
        start = end + 1
        receive(frame)
        if (failure) return
      }
    } catch {
      fail(new Error('ACP 协议异常或输出超限。'))
    }
  }

  output.on('data', onData)
  const streamError = () => fail(new Error('ACP 传输中断。'))
  output.on('error', streamError)
  input.on('error', streamError)
  void exited.then(streamError, streamError)

  function request(method, params, timeout = REQUEST_TIMEOUT, signal, timeoutMessage) {
    signal?.throwIfAborted()
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(timeoutMessage || `ACP ${method} 超时。`)), timeout)
      const abort = () => fail(signal.reason)
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      const pending = {
        method,
        resolve: value => { cleanup(); resolve(value) },
        reject: error => { cleanup(); reject(error) },
      }
      requests.set(id, pending)
      signal?.addEventListener('abort', abort, { once: true })
      try { send({ id, method, params }) }
      catch (error) { requests.delete(id); pending.reject(error) }
    })
  }

  return {
    request,
    /** 传输已不可用（脏数据 / 进程退出 / 管道错误）：常驻宿主据此重建，而不是一直打在空处。 */
    isFailed: () => !!failure,
    async initialize(signal) {
      const result = await request('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Youth Fantasy Engine', version: clientVersion || '0.0.0' },
      }, undefined, signal)
      if (result?.protocolVersion !== 1) throw new Error('ACP 协议版本不兼容。')
      return result
    },
    async prompt({ sessionId, text, signal, onChunk }) {
      if (turn) throw new Error('已有 ACP 生成任务。')
      signal?.throwIfAborted()
      turn = { sessionId, chunks: [], bytes: 0, signal, onChunk }
      let cancelTimer
      const cancel = () => {
        try { send({ method: 'session/cancel', params: { sessionId } }) }
        catch { streamError() }
        cancelTimer = setTimeout(() => fail(new Error('ACP 取消未获确认。')), 2_000)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        const result = await request('session/prompt', {
          sessionId, prompt: [{ type: 'text', text }],
        }, PROMPT_TIMEOUT_MS, undefined,
        `ACP 生成超时：已等待 ${Math.round(PROMPT_TIMEOUT_MS / 1000)} 秒，Agent 未在限时内返回。`
        + '可缩小本次范围（减少条目 / 分段处理）、换更快的模型或推理档位，或切回 API 模式重试。')
        signal?.throwIfAborted()
        if (result?.stopReason !== 'end_turn') throw new Error('ACP 生成未完整结束。')
        const answer = turn.chunks.join('')
        if (!answer.trim()) throw new Error('ACP 返回空文本。')
        return answer
      } finally {
        clearTimeout(cancelTimer)
        signal?.removeEventListener('abort', cancel)
        turn = null
      }
    },
  }
}
