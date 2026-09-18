// ============ 抽取层：aliases（别称）解析的回归用例 ============
//
// 模型返回的别称形态很杂：数组、顿号串、斜杠串，键名还可能是「别称/别名/曾用名」，
// 甚至顶层键中文化。这些都得吃下来，否则别称信息一丢，
// `flow/draft` 的跨章归并与 `settingLedger` 的判重就都白做了。
// 用本地假端点喂一段写死的返回，只验解析（不联网、不确定模型行为）。
import http from 'node:http'
import { __resetMockStores } from './mock-memory'
import { saveActiveId, saveProviders, type AIProvider } from '../src/lib/ai'
import { aiExtractSettingEntities } from '../src/lib/aiTasks'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const REPLY = JSON.stringify([
  { type: '人物', name: '王铁柱', aliases: ['铁柱', '阿柱', '王铁柱'], desc: '铁匠', evidence: '王铁柱提锤走来。' },
  { type: '人物', name: '守拙道人', 别称: '青玄子、守拙', desc: '', evidence: '守拙道人颔首。' },
  { 类型: '术语', 名称: '噬命诀', aliases: '吞命诀/噬命', desc: '', 原文: '噬命诀发动。' },
  { type: '地点', name: '青岚山', desc: '', evidence: '青岚山积雪。' },
])

/** 记住最近一次请求是否带 stream —— 顺带锁住「抽取必须走流式」这条 B2 不变量 */
const seen: { stream: boolean }[] = []

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) } catch { /* 忽略 */ }
    seen.push({ stream: body.stream === true })
    if (body.stream === true) {
      // 🔴 抽取自 B2 起走流式（输出变长，非流式会撞 180s 总超时墙）——
      //    假端点必须会推 SSE，否则这里会以「API 未返回内容」崩掉（2026-09-18 真踩过）。
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const mid = Math.floor(REPLY.length / 2)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: REPLY.slice(0, mid) } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: REPLY.slice(mid) } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: REPLY } }] }))
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
const PORT = (server.address() as { port: number }).port

__resetMockStores()
const CFG: AIProvider = {
  id: 'fake-extract', name: '假端点', type: 'openai',
  baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: 'k', model: 'fake-model',
}
await saveProviders([CFG])
await saveActiveId(CFG.id)

const out = await aiExtractSettingEntities('正文', '第1章')
const by = (n: string) => out.find(e => e.name === n)

ok('抽到 4 条', out.length === 4, String(out.length))

const wt = by('王铁柱')
ok('🔴 aliases 数组被解析', wt?.aliases?.join(',') === '铁柱,阿柱', wt?.aliases?.join(','))
ok('  · 与本名相同的别名被剔除', !wt?.aliases?.includes('王铁柱'), wt?.aliases?.join(','))
ok('  · 重复别名已去重', new Set(wt?.aliases ?? []).size === (wt?.aliases?.length ?? 0))

const sz = by('守拙道人')
ok('中文键「别称」+ 顿号分隔串也能解析', sz?.aliases?.join(',') === '青玄子,守拙', sz?.aliases?.join(','))

const sm = by('噬命诀')
ok('顶层中文键（类型/名称/原文）容错', !!sm, out.map(e => e.name).join(','))
ok('  · 别称用斜杠分隔也能解析', sm?.aliases?.join(',') === '吞命诀,噬命', sm?.aliases?.join(','))
ok('  · 中文键「原文」被认成 evidence', sm?.evidence === '噬命诀发动。', sm?.evidence)

const ql = by('青岚山')
ok('模型没给别称时不下发 aliases 字段（避免脏数据）', ql !== undefined && ql.aliases === undefined, JSON.stringify(ql?.aliases))

// 🔴 B2 起抽取必须走流式（输出变长，非流式必撞 180s 总超时墙）——
//    这条断言保证将来没人把 onToken 摘掉（摘了这里立刻红，而不是等到线上「抽取卡死」）
ok('🔴 抽取请求带 stream:true（B2：长输出必须流式）', seen.length > 0 && seen.every(s => s.stream),
  JSON.stringify(seen))

server.close()
console.log(`\n—— extractAliases 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
