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

const server = http.createServer((req, res) => {
  req.on('data', () => { /* 丢弃请求体 */ })
  req.on('end', () => {
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

server.close()
console.log(`\n—— extractAliases 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
