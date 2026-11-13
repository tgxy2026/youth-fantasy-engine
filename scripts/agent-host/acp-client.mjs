// ACP v1 over newline-delimited JSON-RPC. The launcher owns process-tree shutdown.
const MAX_FRAME = 1024 * 1024
const MAX_TEXT = 512 * 1024
const REQUEST_TIMEOUT = 30_000

export function createAcpClient({ input, output, exited }) {
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
      pending.reject(Object.assign(new Error(`ACP ${pending.method} 失败（${code ?? '未知错误'}）。`), { acpCode: code }))
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

  function request(method, params, timeout = REQUEST_TIMEOUT, signal) {
    signal?.throwIfAborted()
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`ACP ${method} 超时。`)), timeout)
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
    async initialize(signal) {
      const result = await request('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Youth Fantasy Engine', version: '3.5.4' },
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
        }, 180_000)
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
