// ============ 「长文生成必须走流式」的不变量 ============
//
// 为什么值得单独锁一条：
//   非流式请求的**响应头要等整段生成完**才回来，于是必然撞上 `CHAT_TIMEOUT_MS`（180s）的总超时；
//   流式只要首字节到达就清掉那个定时器（`fetchWithTimeout` 的 `onResponse` → `readSSE` 首字节回调）。
//
// 实测事故（2026-09-18）：创意写作的「设定奠基」一次要产 28 条（2+4+4+4+5+6+3），
// 用云端模型也超过 180s → 被掐死 → 界面表现是「闸门① 永远不出现」，外层还会再重试一次，白等 6 分钟。
// 同 `runAutoContinue` 必须传 `onBodyToken` 是一个道理。
//
// 这里起一个**本地假端点**（OpenAI 兼容 + SSE），记录每次请求的 `stream` 字段：
//   ① aiGenerateBible / aiGenerateOutline 必须发出 `stream:true`；
//   ② 流式内容要能被正确拼起来、解析成实体（证明流式路径本身是通的）；
//   ③ 负面对照 —— 不传 onToken 的裸 chat 必须是 `stream:false`（证明这条断言真有判别力，
//      若哪天有人把 longStream 去掉，①② 立刻红）。
import http from 'node:http'
import { __resetMockStores } from './mock-memory'
import { saveProviders, saveActiveId, chat } from '../src/lib/ai'
import { aiGenerateBible, aiPlanOutline } from '../src/lib/aiTasks'
import type { AIProvider } from '../src/lib/ai'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 假端点 ----------
const BIBLE_JSON = JSON.stringify({
  characters: [
    { name: '陈渊', tier: '主要', identity: '少年修士', traits: '沉默寡言', realm: '淬体境' },
    { name: '苏念', tier: '次要', identity: '药庐学徒', traits: '灵动跳脱' },
  ],
  factions: [{ name: '青岚宗', desc: '云州正道魁首' }],
  locations: [{ name: '云州城', desc: '东洲边境大城', category: '城' }],
  terms: [{ name: '噬命诀', desc: '吞噬他人修为续命的功法' }],
  items: [{ name: '玄铁令', desc: '青岚宗内门信物', category: '法器', grade: '凡品' }],
})
const OUTLINE_JSON = JSON.stringify({
  volumes: [{ title: '噬命初醒', positioning: '少年初获禁功', stage: '淬体→凝气', scope: '云州', opening: '被人踩在脚下', climax1: '夺修为反杀', turn: '功诀反噬', climax2: '宗门追捕', ending: '逃入中州', events: '起→承→转→合', subplots: '苏念的来历' }],
  chapters: [{ title: '血月夜', event: '陈渊在乱葬岗吞下第一缕修为', function: '推进主线', cast: '陈渊', hook: '功诀在他识海睁开了眼', scenes: ['乱葬岗夺修', '药庐疗伤'] }],
})

const seen: { stream: boolean; model: string; enableThinking?: unknown }[] = []
let payload = BIBLE_JSON
/** 置 true 时：带 enable_thinking 的请求一律 400（模拟「端点不认这个字段」） */
let rejectThinking = false
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) } catch { /* 忽略 */ }
    seen.push({ stream: body.stream === true, model: String(body.model ?? ''), enableThinking: body.enable_thinking })
    if (rejectThinking && 'enable_thinking' in body) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unknown field enable_thinking' } }))
      return
    }
    if (body.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // 分两段推，模拟真实增量（顺便证明拼接逻辑正确）
      const mid = Math.floor(payload.length / 2)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(0, mid) } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(mid) } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: payload } }] }))
    }
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
const PORT = (server.address() as { port: number }).port

__resetMockStores()
const CFG: AIProvider = {
  id: 'fake-endpoint', name: '假端点', type: 'openai',
  baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: 'test-key', model: 'fake-model',
}
await saveProviders([CFG])
await saveActiveId(CFG.id)

// ---------- ① 设定奠基：必须流式，且内容能解析 ----------
const bible = await aiGenerateBible('一个靠吞噬他人修为续命的少年。')
const bibleReq = seen[seen.length - 1]
ok('🔴 aiGenerateBible 发出的是流式请求（stream:true）', bibleReq?.stream === true, JSON.stringify(bibleReq))
ok('aiGenerateBible 能解析流式拼接后的 JSON（5 类实体都取到）', bible.length >= 6, `${bible.length} 条`)
ok('  · 人物分级保住了（主要 / 次要）', bible.filter(e => e.type === '人物').length === 2,
  bible.filter(e => e.type === '人物').map(e => e.name + ':' + e.tier).join(','))
ok('  · 分类映射正确（势力 / 地点 / 术语 / 物品各 1）',
  ['势力', '地点', '术语', '物品'].every(t => bible.some(e => e.type === t)),
  bible.map(e => e.type).join(','))

// ---------- ② 大纲规划（分卷大纲 + 章节细纲）：同样必须流式 ----------
payload = OUTLINE_JSON
const outline = await aiPlanOutline('【设定资料】陈渊 / 青岚宗 / 云州城', {
  volumes: 1, chaptersPerVolume: 1, fromNo: 1, fromVolumeNo: 1,
})
const outlineReq = seen[seen.length - 1]
ok('🔴 aiPlanOutline 发出的是流式请求（stream:true）', outlineReq?.stream === true, JSON.stringify(outlineReq))
ok('aiPlanOutline 解析出 1 卷（流式拼接未破坏 JSON）', outline.volumes.length === 1, String(outline.volumes.length))
ok('  · 卷名与章名都取到了', outline.volumes[0]?.title === '噬命初醒' && outline.chapters[0]?.title === '血月夜',
  `${outline.volumes[0]?.title} / ${outline.chapters[0]?.title}`)
ok('  · 章节 no 由系统从 fromNo 起编号（不接受模型自带编号）', outline.chapters[0]?.no === 1)
ok('  · scenes 解析为数组', Array.isArray(outline.chapters[0]?.scenes) && outline.chapters[0]!.scenes.length === 2)
ok('  · 章号范围不由模型产出（留给 fillChapterRanges 填）', outline.volumes[0]?.chapterRange === '',
  outline.volumes[0]?.chapterRange)

// 接续口径（2026-09-20 核心改动）：章号必须从 fromNo 起 —— 这是"第二批接着排第 41-60 章"的地基
payload = OUTLINE_JSON
const ext = await aiPlanOutline('（已有资料：前两卷大纲 + 前 40 章细纲）', {
  volumes: 1, chaptersPerVolume: 1, fromNo: 41, fromVolumeNo: 3, extending: true,
})
ok('🔴 接续时章号从 fromNo 起（第二批排出来的是第 41 章，不是第 1 章）',
  ext.chapters[0]?.no === 41, String(ext.chapters[0]?.no))

// ---------- ③ 负面对照：不带 onToken 的裸 chat 必须是非流式 ----------
payload = '可以'
await chat(CFG, [{ role: 'user', content: '只回复两个字：可以' }], { timeoutMs: 10000 })
const bareReq = seen[seen.length - 1]
ok('负面对照：不传 onToken 时 stream:false（证明「stream 由 onToken 决定」，上面的断言有判别力）',
  bareReq?.stream === false, JSON.stringify(bareReq))

// ---------- ④ 云端混合思考模型（Qwen3 系）必须自动关思考 ----------
// 背景：这类模型思考开着时思考内容不进 content、且吃光输出预算（实测 content 只剩 271 字、
// JSON 必残；更极端的一次 216.8s 拿 0 字）。所以「非本地 + Qwen3 名」必须下发 enable_thinking:false。
const qwenCfg: AIProvider = { ...CFG, model: 'Qwen/Qwen3.5-35B-A3B' }
await chat(qwenCfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 10000 })
ok('🔴 云端 Qwen3 系自动关思考（请求体带 enable_thinking:false）',
  seen[seen.length - 1]?.enableThinking === false, JSON.stringify(seen[seen.length - 1]))

const dsCfg: AIProvider = { ...CFG, model: 'deepseek-chat' }
await chat(dsCfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 10000 })
ok('非 Qwen3 系不下发该字段（不给其它服务商添乱）',
  seen[seen.length - 1]?.enableThinking === undefined, JSON.stringify(seen[seen.length - 1]))

// 逃生口：显式 think:true 时保留思考
await chat(qwenCfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 10000, think: true })
ok('显式 think:true 时不下发该字段（保留思考的逃生口）',
  seen[seen.length - 1]?.enableThinking === undefined, JSON.stringify(seen[seen.length - 1]))

// 本地 OpenAI 兼容服务不干预（local:true 走本机，思考留着有用）
const localCfg: AIProvider = { ...CFG, model: 'Qwen3-8B', local: true, apiKey: '' }
await chat(localCfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 10000 })
ok('本地（local:true）即使模型名是 Qwen3 也不干预',
  seen[seen.length - 1]?.enableThinking === undefined, JSON.stringify(seen[seen.length - 1]))

// ---------- ⑤ 端点不认这个字段（400）→ 必须丢掉它重试，绝不能因此把功能弄坏 ----------
rejectThinking = true
const before = seen.length
let retryOk = true
try { await chat(qwenCfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 10000 }) } catch { retryOk = false }
const attempt = seen.slice(before)
rejectThinking = false
ok('🔴 端点 400 时自动退掉 enable_thinking 重试并成功', retryOk && attempt.length === 2,
  `尝试 ${attempt.length} 次，成功=${retryOk}，字段=${attempt.map(a => String(a.enableThinking)).join('/')}`)
ok('  · 第一次带字段、第二次不带（正是"退掉重试"）',
  attempt[0]?.enableThinking === false && attempt[1]?.enableThinking === undefined,
  attempt.map(a => String(a.enableThinking)).join('/'))

server.close()
console.log(`\n—— aiLongStream 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
