// 本地「假模型」服务：给测试用的 Ollama 兼容端点（不联网、不耗额度）。
//
// 为什么要它（2026-09-19）：创意写作/连写这条链路原先**只有前端实机验证**能覆盖，
// 而实机验证要真模型、要几分钟、还烧额度 —— 于是「0 章落库却报成功」这种缺陷
// 可以在里面躺很久没人发现。有了它，整条链路可以在单测里几秒跑完并断言到**落库结果**。
//
// 协议：`POST /api/chat`，逐行裸 JSON（与 Ollama 一致），delta 在 `message.content`。
// 🔴 必须**分块流式**返回：非流式响应要等整段生成完才回头，会撞 `CHAT_TIMEOUT_MS`(180s)，
//    而本假模型要验证的恰恰是"流式开关有没有打开"——一次性返回会把这条验证废掉。
import http from 'node:http'

export interface FakeOllamaCall { sys: string; user: string; stream: boolean }

export interface FakeOllama {
  /** 监听端口，用来拼 provider 的 baseUrl */
  port: number
  /** 收到过的请求（按顺序），供断言"调了什么任务""是不是流式" */
  calls: FakeOllamaCall[]
  close: () => void
}

export async function startFakeOllama(o: {
  /** 普通（创作类）请求返回的正文 */
  body: string
  /**
   * 结构化请求（提示词里点名要 JSON）返回什么，默认 `[]`。
   * 传 `'__EMPTY__'` 可让**所有**请求都返回空正文 —— 用来复现"模型没返回内容"的失败路径。
   * 传 `'__JSON_EMPTY__'` 只让**结构化请求**返回空（正文请求照常）——
   * 用来复现"正文能生成、但自检/抽取等 json 任务失败"的路径（WQ1-2 回归防线）。
   */
  json?: string
}): Promise<FakeOllama> {
  const calls: FakeOllamaCall[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      let j: { messages?: { role: string; content: string }[]; stream?: boolean } = {}
      try { j = JSON.parse(raw || '{}') } catch { /* 忽略坏请求 */ }
      const msgs = j.messages ?? []
      const sys = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n')
      calls.push({ sys, user: msgs.filter(m => m.role === 'user').map(m => m.content).join('\n'), stream: j.stream === true })
      const jsonEmpty = o.json === '__JSON_EMPTY__'
      const empty = o.json === '__EMPTY__' || o.body === '__EMPTY__'
      const text = empty ? '' : (/JSON/i.test(sys) ? (jsonEmpty ? '' : (o.json ?? '[]')) : o.body)
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      if (j.stream !== true) {
        // 🔴 非流式必须返回**单个 JSON 对象**（与真实 Ollama 一致）。
        //    2026-10-19 WQ1-2 修复：原先对所有请求都分块吐 NDJSON，而非流式路径
        //    （chat.ts 的 res.json()）解析不了多行 ⇒ content 恒空 ⇒ 报"未返回内容"。
        //    这个缺陷让测试环境里的自检**从来没成功过**——旧代码 `.catch(() => [])`
        //    把失败吞成"无问题"，于是整条链路的自检一直是假绿。
        res.end(JSON.stringify({ message: { content: text }, done: true }) + '\n')
        return
      }
      // 分块：模拟真实流式（首字节很快到，尾字节慢慢来）
      const parts = text.match(/[\s\S]{1,120}/g) ?? ['']
      let i = 0
      const tick = () => {
        if (i < parts.length) {
          res.write(JSON.stringify({ message: { content: parts[i++] }, done: false }) + '\n')
          setTimeout(tick, 0)
        } else {
          res.write(JSON.stringify({ message: { content: '' }, done: true }) + '\n')
          res.end()
        }
      }
      tick()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return { port, calls, close: () => server.close() }
}

/** 把内存库里的 provider 指向假模型（测试用） */
export const FAKE_PROVIDER_ID = 'fake-ollama'
export function fakeProvider(port: number) {
  return {
    id: FAKE_PROVIDER_ID, name: '测试假模型', type: 'ollama' as const,
    baseUrl: `http://127.0.0.1:${port}`, apiKey: '', model: 'fake', local: true,
  }
}
