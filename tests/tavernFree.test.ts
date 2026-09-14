// ============ 酒馆模式 · 自由模式引擎（方案 §7）============
//
// 与剧情模式的三处根本差异，就是这组断言要钉住的东西：
//   ① 设定层 = 作者手写的**角色卡四章**（不是项目资料）
//   ② 记忆是**角色级**的（「她记得什么」，不是这场戏的公共档案）
//   ③ 档位 = **聊天向**（剧情默认叙事向）
import * as store from '../src/lib/tavern/store'
import { __resetMockStores } from './mock-memory'
import { saveProviders, saveActiveId, type ChatMessage } from '../src/lib/ai'
import {
  buildFreeSystem, buildFreeMessages, runFreeTurn, renderFreeCharacter, type ChatFn,
} from '../src/lib/tavern/engine'
import { PROTOCOL_CORE } from '../src/lib/tavern/protocol'
import type { FreeCharacter, FreeSession, TavernMessage } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const STUB_PROVIDER = { id: 'free-stub', name: '桩模型', type: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }

function makeFakeChat(reply: string) {
  const calls: { messages: ChatMessage[]; opts: Record<string, unknown> }[] = []
  const chatFn: ChatFn = async (_cfg, messages, opts) => {
    calls.push({ messages, opts: (opts ?? {}) as Record<string, unknown> })
    return reply
  }
  return { chatFn, calls }
}

async function mkChar(name: string, over: Partial<FreeCharacter> = {}): Promise<FreeCharacter> {
  return store.createFreeChar({
    ...store.emptyFreeCharacter(),
    name,
    world: '现代都市 · 老城区一间凌晨还亮着灯的便利店',
    profile: {
      externals: '短发，围裙，左手腕有旧疤',
      core: '外冷内热，嘴上不留情但会记得你爱吃什么',
      speech: '句子短，习惯用反问，不说软话',
      relations: '独居，父母在老家',
      cannot: '说不出关心的话，只能换成别的方式',
      knowledge: '不知道顾客的职业与过去',
    },
    conduct: { perspective: '第一人称，只描写她自己的动作与感官', bottomLine: '不越界打听私事', paceLock: '关系推进要慢', rating: '日常向' },
    examples: '对方：这么晚还不下班？\n她把找零推过去，没抬头：\n「灯还亮着。」',
    ...over,
  })
}

async function main() {
  __resetMockStores()
  await saveProviders([{ ...STUB_PROVIDER }])
  await saveActiveId(STUB_PROVIDER.id)

  const su = await mkChar('苏念')

  // ---------- 1) 角色卡四章渲染 ----------
  {
    const text = renderFreeCharacter(su)
    ok('渲染出第 1 章 · 世界', text.includes('【第 1 章 · 世界】'))
    ok('渲染出第 2 章 · 人物档案且带编号子块', text.includes('【第 2 章 · 人物档案】') && text.includes('2.1 外在') && text.includes('2.6 知识边界'))
    ok('渲染出第 3 章 · 行为规范', text.includes('【第 3 章 · 行为规范】') && text.includes('进度锁'))
    ok('第 4 章 · 示例对话带「请模仿」引导（杠杆最高的一章）',
      text.includes('【第 4 章 · 示例对话（请模仿其应对话术与格式）】') && text.includes('「灯还亮着。」'))
    ok('没有第 0 章（协议已是内置常量）', !text.includes('第 0 章'))

    // 空章跳过：只填内核时不该出现另外三章的标题
    const bare = renderFreeCharacter({ ...su, world: '', conduct: { perspective: '', bottomLine: '', paceLock: '', rating: '' }, examples: '' })
    ok('空章整块跳过（不留「（未填）」噪音）', !bare.includes('第 1 章') && !bare.includes('第 3 章') && !bare.includes('第 4 章'))
    ok('填了的章照常出现', bare.includes('第 2 章'))

    const empty = renderFreeCharacter({
      ...su, world: '', examples: '',
      profile: { externals: '', core: '', speech: '', relations: '', cannot: '', knowledge: '' },
      conduct: { perspective: '', bottomLine: '', paceLock: '', rating: '' },
    })
    ok('全空角色卡渲染为空串', empty === '')
  }

  // ---------- 2) 自由模式 system 组装 ----------
  let session: FreeSession
  {
    session = await store.createFreeSession([su.id], '与苏念的雨夜', { providerId: STUB_PROVIDER.id }, {})

    const { system, missing } = await buildFreeSystem(session, [su])
    ok('system 含角色卡内容', system.includes('外冷内热') && system.includes('「灯还亮着。」'))
    ok('档位是聊天向（追加了即时聊天风格提示）', system.includes('【本场风格】'), system.slice(0, 60))
    ok('身份层写明演的是谁', system.includes('你扮演：苏念'))
    ok('没有锚点/信息边界这些剧情模式概念', !system.includes('信息边界'))
    ok('协议仍钉在绝对末尾', system.trimEnd().endsWith(PROTOCOL_CORE.trimEnd()))
    ok('单角色时不加发言规则', !system.includes('【发言规则】'))
    ok('记忆为空时不出现长期记忆块', !system.includes('【长期记忆'))
    ok('角色卡齐全时 missing 为空', missing.length === 0)

    // 记忆按角色分块
    await store.saveMemory({ ...store.emptyMemory(su.id), facts: '她怕黑；店里那只猫叫阿灰', relation: '刚认识，客气', updatedAt: Date.now() })
    const withMem = await buildFreeSystem(session, [su])
    ok('记忆进了 system 且标明归属角色', withMem.system.includes('【长期记忆 · 苏念】') && withMem.system.includes('阿灰'))
    ok('记忆在设定层之后、协议之前',
      withMem.system.indexOf('外冷内热') < withMem.system.indexOf('【长期记忆 · 苏念】') &&
      withMem.system.indexOf('【长期记忆 · 苏念】') < withMem.system.indexOf(PROTOCOL_CORE))

    // 角色卡被删（引用了不存在的 id）
    const gone = await buildFreeSystem({ ...session, charIds: [su.id, '已删除的卡'] }, [su])
    ok('引用了已删除的角色时 missing 如实回报', gone.missing.includes('已删除的卡'), JSON.stringify(gone.missing))
    ok('剩余角色照常组装', gone.system.includes('苏念'))
  }

  // ---------- 3) 多角色同场 ----------
  let two: FreeSession
  {
    const lin = await mkChar('林夏', { profile: { externals: '高马尾，学生气', core: '嘴甜，爱笑', speech: '话多，爱用感叹号', relations: '常来买夜宵', cannot: '藏不住事', knowledge: '不知道苏念的过去' } })
    two = await store.createFreeSession([su.id, lin.id], '便利店三人夜', { providerId: STUB_PROVIDER.id }, {})

    const { system } = await buildFreeSystem(two, [su, lin])
    ok('多角色：两张角色卡都拼进设定层', system.includes('你扮演成这样的人') === false && system.includes('外冷内热') && system.includes('嘴甜，爱笑'))
    ok('多角色：追加发言规则', system.includes('【发言规则】') && system.includes('一次只让一个角色说话'))
    ok('多角色：身份层列出全部扮演对象', system.includes('你同时扮演：苏念、林夏'))
    ok('多角色：各自记忆分别成块',
      system.includes('【长期记忆 · 苏念】'))

    // 标注：历史里带 speakerId 的 assistant 消息要带说话人前缀
    const history: TavernMessage[] = [
      { id: 'm1', role: 'user', content: '（我推门进去）', at: 1 },
      { id: 'm2', role: 'assistant', content: '「来了。」', speakerId: su.id, at: 2 },
      { id: 'm3', role: 'assistant', content: '「老板今天好晚！」', speakerId: lin.id, at: 3 },
    ]
    const { messages } = buildFreeMessages(history, two, [su, lin], 100000)
    const joined = messages.map(m => m.content).join('\n')
    ok('多角色：输入侧标注了说话人', joined.includes('（苏念）「来了。」') && joined.includes('（林夏）'))
  }

  // ---------- 4) 跑一轮（单角色） ----------
  let live: FreeSession
  {
    const REPLY = '她把手里的烟按灭在易拉罐上，没看你。\n「雨这么大，伞呢。」'
    const { chatFn, calls } = makeFakeChat(REPLY)
    const res = await runFreeTurn(session, [su], '（我把湿透的外套挂在门边）', {}, { chatFn })

    ok('一轮跑通，拿到回复', res.reply === REPLY)
    ok('单角色：回复归属该角色', res.speakerId === su.id)
    ok('单角色：消息上标了 speakerId', res.session.messages.at(-1)?.speakerId === su.id)
    ok('用酒馆指定的模型', res.fellBack === false && res.modelName === STUB_PROVIDER.model)
    ok('模型收到 system 且末尾是协议', String(calls[0].messages[0].content).trimEnd().endsWith(PROTOCOL_CORE.trimEnd()))
    ok('用户输入进了上下文', calls[0].messages.some(m => m.content.includes('湿透的外套')))
    ok('自由模式也关思考（陪伴要像人说话）', calls[0].opts.think === false)
    ok('未误传 json', calls[0].opts.json === undefined)
    ok('会话追加两条消息', res.session.messages.length === 2, `实际=${res.session.messages.length}`)

    live = await store.saveFreeSession(res.session)
    const back = await store.getFreeSession(live.id)
    ok('落库后能读回', !!back && back.messages.length === 2)
  }

  // ---------- 5) 多角色轮转与手动指定 ----------
  {
    // 第一轮：历史里 0 条 assistant → 归 charIds[0]（苏念）
    const a = makeFakeChat('「……」')
    const r1 = await runFreeTurn(two, [su, await store.getFreeChar(two.charIds[1]) as FreeCharacter], '谁在？', {}, { chatFn: a.chatFn })
    ok('多角色第一轮按顺序归第一位', r1.speakerId === two.charIds[0], `实际=${r1.speakerId}`)

    // 第二轮（带上第一轮的回复）→ 应轮到第二位
    const b = makeFakeChat('「我在我在！」')
    const r2 = await runFreeTurn(await store.saveFreeSession(r1.session), [su, await store.getFreeChar(two.charIds[1]) as FreeCharacter], '还有谁？', {}, { chatFn: b.chatFn })
    ok('多角色第二轮轮到下一位（轮转，可预测）', r2.speakerId === two.charIds[1], `实际=${r2.speakerId}`)

    // 手动指定：即便轮转该到别人，也听指定的
    const c = makeFakeChat('「……」')
    const r3 = await runFreeTurn(await store.saveFreeSession(r2.session), [su, await store.getFreeChar(two.charIds[1]) as FreeCharacter], '苏念你说', { speakerId: two.charIds[0] }, { chatFn: c.chatFn })
    ok('手动指定说话人优先于轮转', r3.speakerId === two.charIds[0], `实际=${r3.speakerId}`)
    ok('指定下一位时在输入侧给了提示（模型据此接话）',
      c.calls[0].messages.some(m => m.content.includes('下一位由')), c.calls[0].messages.at(-1)?.content.slice(0, 40))
  }

  // ---------- 6) 取消不留空消息 ----------
  {
    const cancelErr = new Error('取消'); cancelErr.name = 'AICancelled'
    const cancelChat: ChatFn = async () => { throw cancelErr }
    const before = live.messages.length
    const res = await runFreeTurn(live, [su], '（没说完）', {}, { chatFn: cancelChat })
    ok('取消被识别', res.cancelled === true)
    ok('取消时只留用户输入、不留空回复', res.session.messages.length === before + 1)
    ok('取消时没有空内容消息', res.session.messages.every(m => m.content.length > 0))
  }

  // ---------- 7) 预算裁剪 ----------
  {
    const long: TavernMessage[] = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`, role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: '这是一句用来撑长历史的测试话。'.repeat(10), at: i,
    }))
    const wide = buildFreeMessages(long, session, [su], 100000)
    const tight = buildFreeMessages(long, session, [su], 2000)
    ok('预算充足时不裁', wide.messages.length === 30, `实际=${wide.messages.length}`)
    ok('预算收紧时裁剪', tight.messages.length < wide.messages.length && tight.dropped > 0)
  }

  console.log(`\ntavernFree: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
