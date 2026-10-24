// ============ 3.2.3 · R2 §6.1（便携配置）：真实 HTTP 写盘失败 ============
//
// 方案 §6.1 对便携版的要求是「本地 HTTP 失败、连接中断、提交后响应丢失」，取证方式写的是
// 「实际便携服务文件与重启回读」。这里不去伪造 fetch 的返回值 —— 起一个**真的 http 服务**，
// 真的 500、真的断 socket、真的 401，然后看 `flushPortable()` 与 `getPortableState()` 怎么说。
//
// 统一断言（方案原文）：失败不清 dirty、不误报已保存、失败后仍可重试；
// 保存中继续编辑，不能被这次回执把新草稿清掉。
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

type Mode = 'ok' | 'missing' | 'http500' | 'drop' | 'lost-response' | 'session-replaced' | 'slow'
let mode: Mode = 'missing'
let lastPutBody = ''
let putCount = 0
/**
 * 服务端真实状态（整库正文）。
 * 🔴 3.2.5 起便携服务也要求条件写（与云端同口径），夹具必须给出**真版本**：
 *    否则前端会把「服务端没给 revision」判成不可兼容并锁写盘 —— 那不是被测的产品行为。
 */
let currentText: string | null = null
const revisionOf = (text: string | null) =>
  '"yfe-' + createHash('sha256').update('portable\0' + (text === null ? 'missing' : 'text\0' + text)).digest('hex') + '"'

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(Buffer.from(c)))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const pathname = (req.url ?? '').split('?')[0]
    if (pathname !== '/api/data') { res.writeHead(404); res.end('{}'); return }
    if (req.method === 'GET') {
      const revision = revisionOf(currentText)
      res.setHeader('ETag', revision)
      res.setHeader('Content-Type', 'application/json')
      if (mode === 'missing' || currentText === null) { res.writeHead(404); res.end(JSON.stringify({ missing: true, revision })); return }
      res.writeHead(200)
      res.end(JSON.stringify({ text: currentText, revision }))
      return
    }
    if (req.method !== 'PUT') { res.writeHead(405); res.end(); return }
    putCount++
    lastPutBody = body
    const replyOk = () => {
      currentText = body
      const revision = revisionOf(currentText)
      res.setHeader('ETag', revision)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, revision }))
    }
    switch (mode) {
      case 'http500':
        res.writeHead(500); res.end('boom'); return
      case 'drop':
        // 连接中断：请求收到了，响应一个字节都不发就断掉
        req.socket.destroy(); return
      case 'lost-response':
        // 提交后响应丢失：服务端已经收到并真的落了盘，但回应在网络上没了
        currentText = body
        req.socket.destroy(); return
      case 'session-replaced':
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 'SESSION_REPLACED' })); return
      case 'slow':
        setTimeout(replyOk, 250)
        return
      default: {
        // 条件写：缺前置条件 428、版本不符 409（与便携服务实现一致）
        const expected = req.headers['if-match']
        if (!expected) { res.writeHead(428, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, code: 'REVISION_REQUIRED' })); return }
        const current = revisionOf(currentText)
        if (expected !== current) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, code: 'DATA_CONFLICT', revision: current })); return }
        replyOk()
      }
    }
  })
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port

// 便携判定来自 window.__YFE_PORTABLE__（服务注入），必须在 import 之前摆好
;(globalThis as unknown as { window: unknown }).window = {
  __YFE_PORTABLE__: { apiBase: `http://127.0.0.1:${port}` },
}

const fb = await import('@/lib/storage/fileBackend')
ok('便携判定生效（PORTABLE=true，走真实 HTTP）', fb.PORTABLE === true)

await fb.initPortableStore()
ok('首次使用（数据文件 404）不锁写盘', fb.getPortableState().writeLocked === false, fb.getPortableState().writeLockReason)

async function seed(value: string) {
  await fb.portableStore.put('meta', { key: 'draft', value })
}
const dirty = () => fb.getPortableState().dirty
const lastError = () => fb.getPortableState().lastError

// ---------- ① HTTP 500：失败不清 dirty、不误报已保存 ----------
{
  mode = 'http500'
  await seed('v1')
  ok('① 写输入后进入 dirty（有未落盘改动）', dirty() === true)
  const r = await fb.flushPortable()
  ok('🔴 ① HTTP 500 ⇒ flush 返回 false（不许报成功）', r === false)
  ok('🔴 ① 失败后 dirty 仍在（草稿没被"保存成功"清掉）', dirty() === true)
  ok('① 错误如实写进状态（含 HTTP 500）', lastError().includes('HTTP 500'), lastError())

  mode = 'ok'
  const retried = await fb.flushPortable()
  ok('① 服务恢复后重试成功', retried === true, lastError())
  ok('① 成功后 dirty 清掉', dirty() === false)
  ok('① 服务端确实收到了这次正文', lastPutBody.includes('"draft"') && lastPutBody.includes('v1'))
}

// ---------- ② 连接中断：同样不许当成功 ----------
{
  mode = 'drop'
  await seed('v2')
  const r = await fb.flushPortable()
  ok('🔴 ② 连接被断开 ⇒ false', r === false)
  ok('🔴 ② dirty 保留', dirty() === true)
  ok('② 有错误说明', lastError().length > 0, lastError())
  mode = 'ok'
  ok('② 重试可成功', (await fb.flushPortable()) === true && dirty() === false)
}

// ---------- ③ 提交后响应丢失：收到了但没回话，不能算保存成功 ----------
{
  mode = 'lost-response'
  await seed('v3')
  const before = putCount
  const r = await fb.flushPortable()
  ok('🔴 ③ 响应丢失 ⇒ false（不能凭"请求发出去了"算保存）', r === false)
  ok('③ 请求确实到达了服务端（不是发都没发出去）', putCount > before, `${before}->${putCount}`)
  ok('🔴 ③ dirty 保留', dirty() === true)
  mode = 'ok'
  ok('③ 重试可成功', (await fb.flushPortable()) === true && dirty() === false)
}

// ---------- ④ 会话被顶掉：错误文案要能指导作者重新登录 ----------
{
  mode = 'session-replaced'
  await seed('v4')
  const r = await fb.flushPortable()
  ok('④ 401/SESSION_REPLACED ⇒ false', r === false)
  ok('🔴 ④ 文案说清"账号已在别处登录"（不是笼统的写入失败）',
    lastError().includes('账号已在别处登录'), lastError())
  ok('④ dirty 保留', dirty() === true)
  mode = 'ok'
  ok('④ 重试可成功', (await fb.flushPortable()) === true)
}

// ---------- ⑤ 保存中继续编辑：旧回执不能清掉新草稿 ----------
{
  mode = 'slow'
  await seed('v5-a')
  const inFlight = fb.flushPortable()
  // 请求在途时作者又改了 —— 这正是"旧回执清新草稿"的现场
  await new Promise(r => setTimeout(r, 50))
  await seed('v5-b')
  const done = await inFlight
  ok('⑤ 在途写盘本身成功', done === true)
  ok('🔴 ⑤ 保存期间的新改动仍然 dirty（不能被旧回执清掉）', dirty() === true)

  mode = 'ok'
  const second = await fb.flushPortable()
  ok('⑤ 再存一次把新内容写下去', second === true && dirty() === false)
  ok('🔴 ⑤ 服务端最终拿到的是新内容', lastPutBody.includes('v5-b'), lastPutBody.slice(-120))
}

// ---------- ⑥ 状态自洽 ----------
{
  const st = fb.getPortableState()
  ok('⑥ 全部结束后不在 saving 态', st.saving === false)
  ok('⑥ 成功后 lastError 被清空', st.lastError === '', st.lastError)
  ok('⑥ lastSavedAt 有值（真的记了保存时间）', st.lastSavedAt > 0)
}

server.close()
console.log(`\n———— portableSaveFailure：${pass} 通过 / ${fail} 失败 ————`)
process.exit(fail > 0 ? 1 : 0)
