// ============ 酒馆模式 · 端到端功能性测试（P1 验收：整条链路走不走得通）============
//
// 这组断言与前面的单测不同：它**不测单个函数的边界**，而是把新开发的功能串起来跑一遍，
// 看「作者真正要做的动作」能不能走完：
//
//   建示范项目 → 配模型 → 建推演会话（锚点/角色分配/档位/开场）
//     → 组上下文（防剧透）→ 调模型（流式）→ 落库 → 读回
//     → 结束推演生成报告 → 每条 finding 定位回真实条目 → 报告落库
//     → 删项目时报告一并清掉
//
// 数据全部取自**示范项目**（《吞天神脉》示范宇宙）的真实条目：
//   主要角色「陈渊」、次要角色「萧景行」、伏笔「左腕暗金胎记」、名词「玄脉九境」…
// 这样断言测的是真东西，不是我自己造的想象数据。
//
// 模型调用用注入的假 chat 拦截（engine/report 都留了 chatFn 注入点），
// 于是整条链路可以在**不起真实模型**的前提下跑通 —— 同时把「传给模型的参数对不对」
// 也一并锁住（think 必须 false、报告必须 json:true）。
import * as db from '../src/lib/db'
import * as store from '../src/lib/tavern/store'
import { createDemoProject } from '../src/lib/seedData'
import { __resetMockStores } from './mock-memory'
import { saveProviders, saveActiveId, type AIProvider, type ChatMessage } from '../src/lib/ai'
import {
  buildPlotSystem, buildPlotMessages, runPlotTurn, splitCast, type ChatFn,
} from '../src/lib/tavern/engine'
import { generateReport } from '../src/lib/tavern/report'
import { PROTOCOL_CORE } from '../src/lib/tavern/protocol'
import { TABS } from '../src/lib/schema'
import { EMPTY_CAST_SETTING } from '../src/lib/tavern/types'
import type { TavernSession, TavernMessage } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 记录每次模型调用的入参与选项，便于断言「参数传对了没」 */
type Call = { messages: ChatMessage[]; opts: Record<string, unknown> }

/** 造一个假模型：把回复切片通过 onToken 吐出来，模拟真实流式 */
function makeFakeChat(reply: string) {
  const calls: Call[] = []
  const chatFn: ChatFn = async (_cfg, messages, opts) => {
    calls.push({ messages, opts: (opts ?? {}) as Record<string, unknown> })
    for (let i = 0; i < reply.length; i += 7) opts?.onToken?.(reply.slice(i, i + 7))
    return reply
  }
  return { chatFn, calls }
}

const TAVERN_PROVIDER: AIProvider = {
  id: 'tavern-test-p1',
  name: '酒馆测试模型',
  type: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  apiKey: '',
  model: 'qwen2.5:14b',
}

/** 一段典型的角色扮演回复：含动作、对白 */
const PLOT_REPLY = '萧景行嘴角一挑，把茶盏推到你面前：「师弟，测灵大典那日的事，你我都清楚。」他顿了顿，压低声音：「五十灵石，押你赢。」'

/** 报告回复：一条能指回真实条目，一条指向虚空 */
const REPORT_REPLY = JSON.stringify({
  overview: '这场戏成立。萧景行的试探符合其「表面提携、实则死仇」的关系定位，但对白中提到的灵石数目与设定不符。',
  findings: [
    { level: '矛盾', targetTabId: 'char-main', targetLabel: '陈渊', detail: '陈渊此时应为淬体一重，回复中把他当作聚灵境描写', suggestion: '改为淬体一重' },
    { level: '漏洞', targetTabId: 'char-main', targetLabel: '某个不存在的角色', detail: '提到了一个设定里没有的人物', suggestion: '补进角色表或删掉' },
  ],
})

/**
 * 作者侧字段名 —— 沉浸档下必须整列不出现。
 * 用**字段名**而不是内容做断言：字段名只在该表渲染时才会出现，指向明确，不会误判。
 */
const AUTHOR_COLS = ['结局归宿', '隐藏设定', '演变轨迹（按卷）', '关系终点', '剧情作用', '戏剧功能', '活跃卷与出场频率', '角色弧光']

/** 作者侧内容 —— 这些是「尚未发生的事」，沉浸档下必须搜不到 */
const AUTHOR_VALUES = [
  '卷六雨夜再战，兵解',                          // 萧景行的结局归宿
  '第14章败走时，三百年本命血已被陈渊吞去三成',   // 隐藏设定
  '卷一相依→卷五神女觉醒→并肩',                  // 人物关系的演变轨迹
]

let PID = ''
let anchorId = ''
let anchorLabel = ''
let chenYuanId = ''
let chenYuanName = ''

function mkSession(over: Partial<TavernSession> = {}): TavernSession {
  return {
    id: 'sess-flow-1',
    title: '雨夜对决',
    mode: 'immersive',
    anchorChapterId: anchorId,
    anchorChapterLabel: anchorLabel,
    cast: [
      { cardId: chenYuanId, role: 'user', tabId: 'char-main', name: chenYuanName },
      { cardId: 'rec-xiaojingxing', role: 'ai', tabId: 'char-secondary', name: '萧景行' },
      { cardId: 'rec-chenyao', role: 'silent', tabId: 'char-secondary', name: '陈瑶' },
    ],
    scene: { place: '青岚宗外门偏院', time: '入夜', present: [chenYuanName, '萧景行'], description: '雨停了，廊下有积水' },
    messages: [
      { id: 'm0', role: 'user', content: '（我握紧拳头，抬眼看向萧景行）「萧师兄深夜到访，有何指教？」', at: Date.now() },
    ],
    model: { providerId: TAVERN_PROVIDER.id },
    // 给足预算，避免上下文被裁掉导致断言失真
    params: { contextBudget: 40000 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }
}

async function main() {
  __resetMockStores()

  // ---------- 0) 准备：示范项目 + 模型配置 ----------
  PID = await createDemoProject()
  db.setCurrentProject(PID)
  await saveProviders([{ ...TAVERN_PROVIDER }])
  await saveActiveId(TAVERN_PROVIDER.id)

  const chapters = await db.getAllChapters()
  const mainCards = await db.getCardRecords('char-main')
  chenYuanId = mainCards[0]?.id ?? ''
  chenYuanName = mainCards[0]?.name ?? ''

  ok('示范项目建起来了', !!PID && chapters.length > 0, `章节=${chapters.length}`)
  ok('示范项目里读到主要角色「陈渊」', chenYuanName === '陈渊' && !!chenYuanId, `实际=${chenYuanName}/${chenYuanId}`)

  // 取第 2 章做锚点（用真实章节 id / 标题）
  const anchor = chapters[1] ?? chapters[0]
  anchorId = anchor.id
  anchorLabel = `${anchor.title}`
  ok('锚点取到真实章节', !!anchorId, anchorLabel)

  // ---------- 1) 防剧透：沉浸档不带作者侧资料（段落级 + 字段级） ----------
  {
    const session = mkSession()
    const { system, settingChars } = await buildPlotSystem(session)

    ok('上下文确实组装出了内容', settingChars > 0, `chars=${settingChars}`)
    ok('沉浸档带入了角色设定（能找到陈渊）', system.includes('陈渊'))
    ok('沉浸档带入了名词设定（能找到玄脉九境）', system.includes('玄脉九境'))

    const leakedCols = AUTHOR_COLS.filter(c => system.includes(c))
    ok('沉浸档隐藏作者侧字段（结局/隐藏设定/关系走向等整列不出现）', leakedCols.length === 0, `漏了=${leakedCols.join('、')}`)

    const leakedVals = AUTHOR_VALUES.filter(k => system.includes(k))
    ok('沉浸档搜不到「尚未发生的事」（角色结局 / 隐藏设定 / 关系走向）', leakedVals.length === 0, `漏了=${leakedVals.join('、')}`)

    // 档位切换，同一会话改成导演档 → 作者侧字段应当回来
    const dir = await buildPlotSystem({ ...session, mode: 'director' })
    const dirCols = AUTHOR_COLS.filter(c => dir.system.includes(c))
    ok('导演档保留作者侧字段（与沉浸档形成对照）', dirCols.length > 0, `带回=${dirCols.join('、')}`)

    // 协议必须钉在绝对末尾（手册实测层序：格式与禁令收尾）
    const tailOk = system.trimEnd().endsWith(PROTOCOL_CORE.trimEnd())
    ok('协议钉在 system 末尾（格式提醒紧贴生成点）', tailOk)
    ok('协议正文完整出现且只出现一次', system.split(PROTOCOL_CORE).length - 1 === 1)
    ok('协议在设定之后（设定 → 记忆 → 身份 → 协议）', system.indexOf('陈渊') < system.indexOf(PROTOCOL_CORE))
  }

  // ---------- 2) 角色分配拆分 ----------
  {
    const c = splitCast(mkSession().cast)
    ok('splitCast：作者演 1 个', c.user.length === 1 && c.user[0].name === '陈渊')
    ok('splitCast：AI 演 1 个', c.ai.length === 1 && c.ai[0].name === '萧景行')
    ok('splitCast：在场不出声 1 个', c.silent.length === 1 && c.silent[0].name === '陈瑶')
  }

  // ---------- 2b) 历史预算裁剪 ----------
  {
    const long = mkSession({
      messages: [
        { id: 'open', role: 'user', content: '（开场）雨停了，檐角还在滴水。', at: 1 },
        ...Array.from({ length: 39 }, (_, i) => ({
          id: `m${i}`,
          role: (i % 2 === 0 ? 'assistant' : 'user') as 'assistant' | 'user',
          content: '这是一句用来把历史撑长的测试对白。'.repeat(12),
          at: 100 + i,
        } satisfies TavernMessage)),
      ],
    })
    const wide = buildPlotMessages(long, 200000)
    const tight = buildPlotMessages(long, 3000)
    ok('预算充足时不裁历史（40 条全在）', wide.messages.length === 40, `实际=${wide.messages.length}`)
    ok('预算收紧时裁剪历史', tight.messages.length < wide.messages.length, `宽=${wide.messages.length} 紧=${tight.messages.length}`)
    ok('裁剪有如实回报条数', tight.dropped > 0, `dropped=${tight.dropped}`)
    ok('被裁掉的是中段旧轮次，最新一条仍在',
      tight.messages[tight.messages.length - 1].content === wide.messages[wide.messages.length - 1].content)
  }

  // ---------- 2c) 扮演设定：填了就要真进 system（方案 §6.4） ----------
  {
    const probe = mkSession({ id: 'sess-cast' })
    await store.saveCastSetting('rec-xiaojingxing', {
      voice: '句子短，爱用反问', address: '叫你师弟', unknown: '不知道胎记的事',
      taboo: '提到家人会沉默', care: '在意被质疑', never: '绝不会主动示弱',
    })
    const { system } = await buildPlotSystem(probe)
    ok('扮演设定进了 system', system.includes('句子短，爱用反问'))
    ok('带角色名与用途标题', system.includes('〖扮演设定 · 萧景行〗'))
    ok('空栏不产生噪音', !system.includes('称呼你的方式：')  || system.includes('叫你师弟'))
    ok('排在协议之前（不打断末尾格式提醒）', system.indexOf('〖扮演设定') < system.indexOf(PROTOCOL_CORE))

    // 作者自己演的角色也会带，但必须明示不得代写（否则 AI 会把你的角色也演了）
    await store.saveCastSetting(chenYuanId, { ...EMPTY_CAST_SETTING, voice: '说话直接' })
    const { system: s2 } = await buildPlotSystem(probe)
    ok('作者角色的设定只作理解之用，并明示不得代写', s2.includes('〖对方的扮演设定 · 陈渊〗') && s2.includes('不要代写'))

    // 清空后整层消失
    await store.saveCastSetting(chenYuanId, { ...EMPTY_CAST_SETTING })
    await store.saveCastSetting('rec-xiaojingxing', { ...EMPTY_CAST_SETTING })
    const { system: s3 } = await buildPlotSystem(probe)
    ok('六栏全空时整层跳过（不占上下文）', !s3.includes('〖扮演设定') && !s3.includes('〖对方的扮演设定'))
  }
  // ---------- 3) 跑一轮推演（流式 + 参数 + 落库） ----------
  let session = mkSession()
  {
    const { chatFn, calls } = makeFakeChat(PLOT_REPLY)
    const chunks: string[] = []
    const phases: string[] = []
    const res = await runPlotTurn(session, '（我盯着他的眼睛，不说话，等他继续）', {
      onToken: d => chunks.push(d),
      onPhase: p => phases.push(p),
    }, { chatFn })

    ok('一轮跑通：拿到了回复', res.reply === PLOT_REPLY)
    ok('流式分片拼起来等于完整回复', chunks.join('') === PLOT_REPLY, `片数=${chunks.length}`)
    ok('阶段回调报过进度', phases.length > 0, phases.join('→'))
    ok('用的是酒馆指定的模型（未回退）', res.fellBack === false && res.modelName === TAVERN_PROVIDER.model, `model=${res.modelName} fellBack=${res.fellBack}`)

    const call = calls[0]
    ok('模型收到 system 在第一条', call.messages[0].role === 'system')
    ok('模型收到的 system 末尾是协议', String(call.messages[0].content).trimEnd().endsWith(PROTOCOL_CORE.trimEnd()))
    const joined = call.messages.map(m => m.content).join('\n')
    ok('用户本轮输入进了上下文', joined.includes('我盯着他的眼睛'))
    ok('开场消息也在上下文里', joined.includes('萧师兄深夜到访'))

    // 🔴 角色扮演的有意例外：关闭思考（否则正文带分析腔、轮次越多越明显）
    ok('think 显式传 false（角色扮演的既定例外）', call.opts.think === false)
    ok('未误传 json:true（角色扮演是自由文本，不是结构化任务）', call.opts.json === undefined)

    ok('会话追加了两条消息（user + assistant）', res.session.messages.length === 3, `实际=${res.session.messages.length}`)
    ok('新消息顺序正确（user 在前、assistant 在后）',
      res.session.messages[1].role === 'user' && res.session.messages[2].role === 'assistant')

    // 落库 → 读回
    session = await store.saveSession(res.session)
    const back = await store.getSession(session.id)
    ok('会话落库后能读回', !!back && back.messages.length === 3)
    ok('读回的最后一句话就是模型回复', back?.messages[2].content === PLOT_REPLY)
    const idx = await store.listSessions()
    ok('会话出现在列表索引里', idx.some(x => x.id === session.id))
    ok('索引带上了参演角色摘要', idx[0].castBrief.includes('陈渊') && idx[0].castBrief.includes('萧景行'), idx[0].castBrief)
  }

  // ---------- 4) 第二轮：历史累积 ----------
  {
    const { chatFn, calls } = makeFakeChat('萧景行笑了笑，没有回答，只是把袖子里的手抽了出来。')
    const res = await runPlotTurn(session, '（我向前半步）「师兄到底想说什么？」', {}, { chatFn })

    ok('第二轮在上一轮基础上继续（消息 3 → 5）', res.session.messages.length === 5, `实际=${res.session.messages.length}`)
    const joined = calls[0].messages.map(m => m.content).join('\n')
    ok('第二轮模型看到了第一轮的对白（上下文连续）', joined.includes('五十灵石'))

    session = await store.saveSession(res.session)
  }

  // ---------- 4b) 多角色同场：输入侧标注说话人 ----------
  {
    // 双 AI 角色 + 历史里带 speakerId 的 assistant 消息 → 才该出现标注
    const twoAi = mkSession({
      id: 'sess-two-ai',
      cast: [
        { cardId: chenYuanId, role: 'user', tabId: 'char-main', name: '陈渊' },
        { cardId: 'a1', role: 'ai', tabId: 'char-secondary', name: '萧景行' },
        { cardId: 'a2', role: 'ai', tabId: 'char-secondary', name: '洛清欢' },
      ],
      messages: [
        { id: 'm0', role: 'user', content: '（我推门进去）', at: 1 },
        { id: 'm1', role: 'assistant', speakerId: 'a1', content: '「师弟来了。」', at: 2 },
      ],
    })
    const { chatFn, calls } = makeFakeChat('「坐吧。」洛清欢抬了抬下巴。')
    await runPlotTurn(twoAi, '（我坐下）', {}, { chatFn })
    const joined = calls[0].messages.map(m => m.content).join('\n')
    ok('多角色同场：输入侧标注了 AI 说话人（〈名〉，与输出标记分开）', joined.includes('〈萧景行〉'), joined.slice(0, 100))

    // 单 AI 角色时不加标注（避免无谓噪音）——这是有意的设计，顺带钉住
    const oneAi = mkSession()
    const one = makeFakeChat('（点头）')
    await runPlotTurn({ ...oneAi, messages: [{ id: 'm1', role: 'assistant', speakerId: 'x', content: '「嗯。」', at: 2 }] }, '继续', {}, { chatFn: one.chatFn })
    ok('只有一个 AI 角色时不加说话人标注（不制造噪音）',
      !one.calls[0].messages.some(m => m.content.startsWith('（')))
  }

  // ---------- 5) 单独指定模型失效时回退全局（并如实回报） ----------
  {
    const { chatFn } = makeFakeChat('（试探）')
    const res = await runPlotTurn({ ...session, model: { providerId: '已被删掉的模型' } }, '测试回退', {}, { chatFn })
    ok('指定的模型不存在时回退全局活动模型，并回报 fellBack', res.fellBack === true)
  }

  // ---------- 6) 取消：不落半截回复、不留空消息 ----------
  {
    const cancelErr = new Error('用户取消')
    cancelErr.name = 'AICancelled'
    const cancelChat: ChatFn = async () => { throw cancelErr }
    const before = session.messages.length
    const res = await runPlotTurn(session, '（取消这一轮）', {}, { chatFn: cancelChat })
    ok('取消被识别（不抛给上层）', res.cancelled === true)
    ok('取消时只保留用户输入、不追加半截回复', res.session.messages.length === before + 1, `实际=${res.session.messages.length}`)
    ok('取消时不会留下空内容消息（否则界面上是个空气泡）',
      res.session.messages.every(m => m.content.length > 0))
  }

  // ---------- 7) 结束推演 → 生成报告（每条 finding 定位回真实条目） ----------
  {
    const { chatFn, calls } = makeFakeChat(REPORT_REPLY)
    const rep = await generateReport(session, { chatFn })

    ok('报告有概览', rep.overview.length > 10, rep.overview.slice(0, 40))
    ok('报告关联到当前项目', rep.projectId === PID)
    ok('报告记住了锚点', rep.anchorChapterId === anchorId && rep.anchorChapterLabel === anchorLabel)
    ok('报告记住了参演角色', rep.cast.length === 3)

    // 结构化任务必须走 json:true（由 ai.ts 统一注入低温，避免格式漂移）
    ok('报告调用走 json:true（结构化任务）', calls[0].opts.json === true)

    const [f1, f2] = rep.findings
    ok('解析出两条问题', rep.findings.length === 2, `实际=${rep.findings.length}`)
    // 🔑 核心：能指回真实条目 —— 回表查到示范项目里陈渊的真实记录 id
    ok('可定位的那条回填了真实记录 id', f1?.targetRecordId === chenYuanId, `得到=${f1?.targetRecordId} 期望=${chenYuanId}`)
    ok('可定位的那条保留了「矛盾」等级', f1?.level === '矛盾', `实际=${f1?.level}`)
    ok('可定位的那条的 targetTabId 是合法页签（UI 能跳过去）',
      !!TABS.find(t => t.id === f1?.targetTabId && (t.type === 'card' || t.type === 'table')), f1?.targetTabId)
    // 🔑 指不回去的一律降级存疑、且不留假 id（否则作者点了跳空）
    ok('指不回具体条目的那条降级为「存疑」', f2?.level === '存疑', `实际=${f2?.level}`)
    ok('降级的那条不留假 id', f2?.targetRecordId === undefined, `实际=${f2?.targetRecordId}`)

    await store.saveReport(rep)
    const list = await store.listReports()
    ok('报告出现在列表里', list.some(r => r.id === rep.id))
    ok('列表三档计数正确（矛盾 1 / 漏洞 0 / 存疑 1）',
      list[0].counts['矛盾'] === 1 && list[0].counts['漏洞'] === 0 && list[0].counts['存疑'] === 1,
      JSON.stringify(list[0].counts))
    const back = await store.getReport(rep.id)
    ok('报告能完整读回（含 findings 的 id 回填）', back?.findings[0].targetRecordId === chenYuanId)
  }

  // ---------- 8) 自由模式：建角色 → 起会话 → 记忆往返 ----------
  {
    const fc = await store.createFreeChar({
      ...store.emptyFreeCharacter(),
      name: '苏念',
      world: '现代都市 · 雨夜便利店',
      profile: { externals: '短发，围裙', core: '外冷内热', speech: '话少', relations: '独居', cannot: '不会说软话', knowledge: '不知道你的过去' },
      conduct: { perspective: '第一人称', bottomLine: '不越界', paceLock: '慢', rating: '日常' },
      examples: '',
    })
    ok('自由角色建起来并能读回', (await store.getFreeChar(fc.id))?.name === '苏念')

    await store.setGreeting(fc.id, '（她把伞递过来）「拿着。」')
    ok('开场白只投递一次', (await store.takeGreeting(fc.id)) !== null && (await store.takeGreeting(fc.id)) === null)

    const fsess = await store.createFreeSession([fc.id], '与苏念的雨夜', { providerId: TAVERN_PROVIDER.id }, {})
    ok('自由会话建起来', (await store.getFreeSession(fsess.id))?.charIds[0] === fc.id)

    const mem = await store.getMemory(fc.id)
    ok('记忆六栏初始为空', mem.facts === '')
    await store.saveMemory({ ...mem, facts: '她怕黑', relation: '刚认识' })
    ok('记忆能存能读', (await store.getMemory(fc.id)).facts === '她怕黑')

    await store.saveCastSetting(fc.id, { voice: '简短', address: '你', unknown: '', taboo: '', care: '', never: '' })
    ok('扮演设定能存能读', (await store.getCastSetting(fc.id)).voice === '简短')
  }

  // ---------- 9) 删项目：报告随项目一起清掉 ----------
  {
    await db.deleteProject(PID)
    const left = await db.listProjectReports(PID)
    ok('删项目后其报告被一并清理（不留孤儿数据）', left.length === 0, `残留=${left.length}`)
  }

  console.log(`\ntavernFlow: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
