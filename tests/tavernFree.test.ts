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
  buildFreeSystem, buildFreeMessages, runFreeTurn, runFreeAssist, injectDirectorNote, tickDirectorNote, renderFreeCharacter, applyPostRulesForPreview,
} from '../src/lib/tavern/engine'
import type { ChatFn } from '../src/lib/tavern/provider'
import { PROTOCOL_CORE } from '../src/lib/tavern/protocol'
import { DEFAULT_TAVERN_SETTINGS, getTavernSettings, saveTavernSettings, type TavernSettings } from '../src/lib/tavern/settings'
import { emptyVars } from '../src/lib/tavern/vars'
import { DEFAULT_TALKATIVITY, type FreeCharacter, type FreeSession, type TavernMessage, type TavernStory } from '../src/lib/tavern/types'
import { createStory, saveStory, getStory, deleteStory, snapshotStorySetting } from '../src/lib/tavern/story'
import { emptyWorldEntry } from '../src/lib/tavern/worldBook'

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
    ok('渲染出第 1 章 · 角色与设定的关系', text.includes('〖第 1 章 · 角色与设定的关系〗'))
    ok('渲染出第 2 章 · 人物档案且带编号子块', text.includes('〖第 2 章 · 人物档案〗') && text.includes('2.1 外在') && text.includes('2.6 知识边界'))
    ok('渲染出第 3 章 · 行为规范', text.includes('〖第 3 章 · 行为规范〗') && text.includes('进度锁'))
    ok('第 4 章 · 示例对话带「请模仿」引导（杠杆最高的一章）',
      text.includes('〖第 4 章 · 示例对话（请模仿其应对话术与格式）〗') && text.includes('「灯还亮着。」'))
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
    ok('档位是聊天向（追加了即时聊天风格提示）', system.includes('〖本场风格〗'), system.slice(0, 60))
    ok('身份层写明演的是谁', system.includes('你扮演：苏念'))
    ok('没有锚点/信息边界这些剧情模式概念', !system.includes('信息边界'))
    // 🔴 层序新规（2026-09-15）：协议之后还剩一个「记账块」（本场数值）。
    //    探针实测：任务型指令放协议之前会被格式规范压掉，所以它在协议之后。
    const pIdx0 = system.indexOf(PROTOCOL_CORE)
    ok('协议排在身份层之后，记账块紧跟在协议之后',
      pIdx0 > system.indexOf('〖你在戏里的身份与知识边界〗') &&
      system.indexOf('〖本场数值〗') > pIdx0)
    ok('单角色时不加发言规则', !system.includes('〖发言规则〗'))
    ok('记忆为空时不出现长期记忆块', !system.includes('〖长期记忆'))
    ok('角色卡齐全时 missing 为空', missing.length === 0)

    // 记忆按角色分块
    await store.saveMemory({ ...store.emptyMemory(su.id), facts: '她怕黑；店里那只猫叫阿灰', relation: '刚认识，客气', updatedAt: Date.now() })
    const withMem = await buildFreeSystem(session, [su])
    ok('记忆进了 system 且标明归属角色', withMem.system.includes('〖长期记忆 · 苏念〗') && withMem.system.includes('阿灰'))
    ok('记忆在设定层之后、协议之前',
      withMem.system.indexOf('外冷内热') < withMem.system.indexOf('〖长期记忆 · 苏念〗') &&
      withMem.system.indexOf('〖长期记忆 · 苏念〗') < withMem.system.indexOf(PROTOCOL_CORE))

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
    ok('多角色：追加发言规则', system.includes('〖发言规则〗') && system.includes('一次只让一个角色说话'))
    ok('多角色：身份层列出全部扮演对象', system.includes('你同时扮演：苏念、林夏'))
    ok('多角色：各自记忆分别成块',
      system.includes('〖长期记忆 · 苏念〗'))

    // 标注：历史里带 speakerId 的 assistant 消息要带说话人前缀
    const history: TavernMessage[] = [
      { id: 'm1', role: 'user', content: '（我推门进去）', at: 1 },
      { id: 'm2', role: 'assistant', content: '「来了。」', speakerId: su.id, at: 2 },
      { id: 'm3', role: 'assistant', content: '「老板今天好晚！」', speakerId: lin.id, at: 3 },
    ]
    const { messages } = buildFreeMessages(history, two, [su, lin], 100000)
    const joined = messages.map(m => m.content).join('\n')
    ok('多角色：输入侧标注了说话人（〈名〉）', joined.includes('〈苏念〉「来了。」') && joined.includes('〈林夏〉'))
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
    const sysSent = String(calls[0].messages[0].content)
    ok('模型收到 system，且协议之后是记账块（新层序）',
      sysSent.indexOf(PROTOCOL_CORE) >= 0 &&
      sysSent.indexOf('〖本场数值〗') > sysSent.indexOf(PROTOCOL_CORE))
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

  // ---------- 采样参数真的下发了（否则控制面板上的旋钮是死的） ----------
  {
    // 背景：在这之前 params.ts 的 toOllamaOptions 从未被调用过 ——
    // 除了 temperature 能过 chat()，top_p / top_k / 重复惩罚 / presence_penalty /
    // num_ctx 一个都没到模型那里。这组断言钉住「设置 → 请求」这条线。
    const { chatFn, calls } = makeFakeChat('「嗯。」')
    const custom = {
      ...DEFAULT_TAVERN_SETTINGS,
      common: { ...DEFAULT_TAVERN_SETTINGS.common, contextBudget: 6000, numCtx: 8192, timeoutSec: 42 },
      free: {
        ...DEFAULT_TAVERN_SETTINGS.free,
        temperature: 0.5, topP: 0.8, topK: 20, repeatPenalty: 1.2, presencePenalty: 0.1,
      },
    }
    const sess = await store.createFreeSession([su.id], '参数下发测试', { providerId: STUB_PROVIDER.id }, {})
    await runFreeTurn(sess, [su], '（试试参数）', {}, { chatFn, settings: custom })

    const o = calls[0].opts as Record<string, unknown>
    ok('温度按设置下发（不再恒为默认值）', o.temperature === 0.5, String(o.temperature))
    ok('超时按设置下发（秒 → 毫秒）', o.timeoutMs === 42 * 1000, String(o.timeoutMs))
    const ex = (o.extraOptions ?? {}) as Record<string, number>
    ok('top_p / top_k / 重复惩罚 / presence_penalty / num_ctx 一并下发',
      ex.top_p === 0.8 && ex.top_k === 20 && ex.repeat_penalty === 1.2 &&
      ex.presence_penalty === 0.1 && ex.num_ctx === 8192,
      JSON.stringify(ex))
    ok('temperature 不在 extraOptions 里重复出现（chat 的唯一真源）', ex.temperature === undefined)

    // 不传 settings 时用出厂默认 → 与改动前行为一致（0.95 = free 的出厂默认温度，2026-09-15 由 0.9 放宽）
    const dflt = makeFakeChat('「嗯。」')
    const sess2 = await store.createFreeSession([su.id], '默认参数', { providerId: STUB_PROVIDER.id }, {})
    await runFreeTurn(sess2, [su], '（默认）', {}, { chatFn: dflt.chatFn })
    ok('不传设置时用出厂默认温度 0.95', (dflt.calls[0].opts as Record<string, unknown>).temperature === 0.95,
      String((dflt.calls[0].opts as Record<string, unknown>).temperature))
  }

  // ---------- 用户扮演的角色（2026-09-14 新增：可以反过来演 —— 用户演苏念、AI 演楚楠） ----------
  {
    __resetMockStores()
    // 清库会把上面的桩模型一起清掉，这里补回来（会话的 model 留空 → 走活动模型）
    await saveProviders([STUB_PROVIDER])
    await saveActiveId(STUB_PROVIDER.id)
    const chu = await mkChar('楚楠')   // AI 演
    const su = await mkChar('苏念')    // 用户演
    const luo = await mkChar('洛汐')   // AI 演（凑出多角色，才验证得到发言规则）
    // 两边都写点记忆：用户扮演的那个**不该**出现在 AI 的上下文里
    await store.saveMemory({ ...store.emptyMemory(chu.id), facts: '楚楠记得：她左手腕有旧疤。' })
    await store.saveMemory({ ...store.emptyMemory(su.id), facts: '苏念私下知道：那道疤的来历。' })

    const s = await store.createFreeSession([chu.id, su.id], '苏念 × 楚楠', { providerId: '' }, {}, su.id)
    ok('会话记下了「用户扮演谁」', (await store.getFreeSession(s.id))?.userCharId === su.id)

    const sys = (await buildFreeSystem(s, [chu, su])).system
    ok('身份层写明「用户扮演：苏念」', sys.includes('用户扮演：苏念'))
    ok('身份层要求不要代写', sys.includes('不要代写'))
    ok('AI 只演楚楠（用户角色不进 AI 名单）', sys.includes('你扮演：楚楠') && !sys.includes('你同时扮演'))
    ok('用户扮演的角色卡带进设定层（让 AI 知道对面是谁）', sys.includes('〖用户扮演的角色 · 苏念〗'))
    ok('用户扮演角色的记忆**不给 AI**（那是他自己的底牌）',
      sys.includes('〖长期记忆 · 楚楠〗') && !sys.includes('〖长期记忆 · 苏念〗'))

    // 多 AI 角色 + 用户角色：发言规则要点名用户演谁、AI 名单不含他
    const s3 = await store.createFreeSession([chu.id, luo.id, su.id], '三人同场', { providerId: '' }, {}, su.id)
    const sys3 = (await buildFreeSystem(s3, [chu, luo, su])).system
    ok('多 AI 角色时发言规则写明用户扮演谁',
      sys3.includes('〖发言规则〗') && /用户扮演：苏念。/.test(sys3))
    ok('AI 名单是楚楠、洛汐（不含苏念）', /你是下列角色：楚楠、洛汐/.test(sys3))

    // 轮转：绝不能轮到用户扮演的角色（否则 AI 会替他回答）
    const { chatFn } = makeFakeChat('（她把找零推过来。）')
    let cur: FreeSession = (await store.getFreeSession(s.id))!
    const r1 = await runFreeTurn(cur, [chu, su], '（我推门进来。）', {}, { chatFn })
    cur = r1.session
    const r2 = await runFreeTurn(cur, [chu, su], '（我坐下。）', {}, { chatFn })
    ok('单 AI 角色时说话人就是楚楠', r1.speakerId === chu.id && r2.speakerId === chu.id,
      `${r1.speakerId} / ${r2.speakerId}`)

    const { chatFn: chat3, calls: calls3 } = makeFakeChat('（她没抬头。）')
    let c3: FreeSession = (await store.getFreeSession(s3.id))!
    const speakers: string[] = []
    for (let i = 0; i < 4; i++) {
      const r = await runFreeTurn(c3, [chu, luo, su], `第${i}句`, {}, { chatFn: chat3 })
      c3 = r.session
      speakers.push(r.speakerId ?? '')
    }
    ok('多人轮转只在 AI 角色之间来回（不含用户角色）',
      speakers.every(x => x === chu.id || x === luo.id) && new Set(speakers).size === 2,
      speakers.join(' → '))
    ok('输入侧的说话人标注不因用户角色而开启（只有 2 个 AI 才标）',
      !calls3.some(c => c.messages.some(m => m.role === 'user' && /^（楚楠）/.test(m.content))))

    // 旧行为不能被改坏：不设 userCharId 时仍是「用户演用户自己」
    const plain = await store.createFreeSession([chu.id, luo.id], '没设用户角色', { providerId: '' }, {})
    const sysPlain = (await buildFreeSystem(plain, [chu, luo])).system
    ok('不设用户角色时，发言规则仍是「用户扮演用户自己的角色」',
      sysPlain.includes('用户扮演用户自己的角色。'), '')
  }

  // ---------- 8b) 「我的档案」（2026-09-14 新增，替代原「默认『我演』的角色」） ----------
  // 档案描述的是**屏幕后面那个人**，与「这次演哪个角色」是两件事 —— 所以拆开存、分开注入。
  {
    __resetMockStores()
    const a = await mkChar('洛汐')
    const b = await mkChar('楚楠')
    const base = DEFAULT_TAVERN_SETTINGS
    const withProfile = {
      ...base,
      profile: { name: '老巴迪', address: '巴迪哥', persona: '三十出头的编剧，嘴硬心软。', avatar: '' },
    }

    // ① 没演角色 + 有档案 → 档案就是「你」的身份（不再是「没有具体身份的本人」）
    const s1 = await store.createFreeSession([a.id], '一个人', { providerId: '' }, {})
    const sys1 = (await buildFreeSystem(s1, [a], withProfile)).system
    ok('档案：整段挂上〖我的档案 · 用户本人〗', sys1.includes('〖我的档案 · 用户本人〗'))
    ok('档案：三栏都写进去',
      sys1.includes('名字：老巴迪') && sys1.includes('希望被这样称呼：巴迪哥') && sys1.includes('自我设定：三十出头的编剧'))
    ok('没演角色时：说明「Ta 就以这个身份在场」', sys1.includes('就以这个身份在场'))

    // ② 演了角色 → 档案降级为「幕后身份」，且**明确禁止**拿档案名替换角色名
    const s2 = await store.createFreeSession([b.id, a.id], '两个人', { providerId: '' }, {}, a.id)
    const sys2 = (await buildFreeSystem(s2, [b, a], withProfile)).system
    ok('演了角色时：档案说明它是「屏幕后面是谁」', sys2.includes('屏幕后面是谁'))
    ok('演了角色时：明确禁止用档案名替换角色名', sys2.includes('不要用档案里的名字去替换'))
    ok('演了角色时：身份层仍以角色优先（用户扮演：洛汐）', sys2.includes('用户扮演：洛汐'))

    // ③ 空档案 → 整段不出现（不白占 context）
    const sys0 = (await buildFreeSystem(s1, [a], base)).system
    ok('空档案整段不注入', !sys0.includes('我的档案'))

    // ④ 多 AI 角色 + 有档案 → 发言规则里的「用户是谁」用档案里的称呼
    const s3 = await store.createFreeSession([a.id, b.id], '多角色', { providerId: '' }, {})
    const sys3 = (await buildFreeSystem(s3, [a, b], withProfile)).system
    ok('多 AI 角色 + 有档案：发言规则写「用户扮演：巴迪哥」', sys3.includes('用户扮演：巴迪哥。'))

    // ⑤ 没档案时不能把旧文案改坏
    const sys4 = (await buildFreeSystem(s3, [a, b], base)).system
    ok('没档案时发言规则仍是旧文案（不回归）', sys4.includes('用户扮演用户自己的角色。'))
  }

  // ---------- 8c) 档案读取收敛：多套档案 + 镜像故意不同步（W3-4 / §13 F5） ----------
  // 🔴 引擎里凡是要「当前选中的那份档案」都必须走 activeProfileOf，不许直接读 st.profile：
  //    多套档案时 st.profile 只是**镜像**，切过档案后可能与选择不同步（旧镜像仍留在字段里）。
  //    这里把镜像**故意写错**，两条读取路径（多角色发言规则 / assist 代写）都必须取到选中那份。
  {
    __resetMockStores()
    const a = await mkChar('洛汐')
    const b = await mkChar('楚楠')
    const drifted: TavernSettings = {
      ...DEFAULT_TAVERN_SETTINGS,
      profile: { name: '镜像旧份', address: '镜像旧称', persona: '这份是切换后遗留的旧镜像', avatar: '' },
      profiles: [
        { id: 'pf-a', name: '甲', address: '甲称', persona: '第一份', avatar: '' },
        { id: 'pf-b', name: '乙', address: '乙称', persona: '第二份', avatar: '' },
      ],
      activeProfileId: 'pf-b',
    }

    // ① 多 AI 角色（无「我演」）→ 发言规则的「用户是谁」取选中档案，不是镜像
    const s1 = await store.createFreeSession([a.id, b.id], '多角色', { providerId: '' }, {})
    const sys1 = (await buildFreeSystem(s1, [a, b], drifted)).system
    ok('F5① 多角色发言规则取选中档案（activeProfileOf）',
      sys1.includes('用户扮演：乙称。'), sys1.includes('镜像旧称') ? '误用镜像' : '')
    ok('F5① 镜像内容不进提示词', !sys1.includes('镜像旧称'))

    // ② assist 代写 → 「代谁写」也取选中档案
    const s2 = await store.createFreeSession([a.id, b.id], '代写', { providerId: '' }, {})
    const sys2 = (await buildFreeSystem(s2, [a, b], drifted, { assist: 'polish' })).system
    ok('F5② assist 代写取选中档案（activeProfileOf）',
      sys2.includes('代「乙称」'), sys2.includes('镜像旧称') ? '误用镜像' : '')
  }

  // ---------- 9) 同名角色消歧（2026-09-14） ----------
  // 记忆按 id 存 —— 同名卡本来就抢不走彼此的档案；这里锁的是**提示词层**的辨识能力。
  {
    __resetMockStores()
    const a = await mkChar('洛汐', { profile: { externals: '长发，爱穿白裙子', core: '怕生，话少', speech: '句子很轻', relations: '和苏念同校', cannot: '不敢拒绝别人', knowledge: '不知道楚楠的过去' } })
    const b = await mkChar('洛汐', { profile: { externals: '短发，常穿工装外套', core: '爱开玩笑，人来疯', speech: '语速快，爱用网络梗', relations: '和苏念是邻居', cannot: '坐不住', knowledge: '不知道旧城改造的事' } })
    ok('两张同名卡是两条独立记录（不同 id）', a.id !== b.id)

    const s = await store.createFreeSession([a.id, b.id], '两个洛汐', { providerId: STUB_PROVIDER.id }, {})
    const { system } = await buildFreeSystem(s, [a, b])
    ok('角色卡块自带角色名（多角色时不再是无主的两段拼接）', system.includes('〖角色卡 · 洛汐 #'))
    ok('注入同名对照说明', system.includes('〖同名角色〗') && system.includes('不同的人'))
    const tags = [...system.matchAll(/〖角色卡 · 洛汐 #([0-9A-Z]{4})〗/g)].map(m => m[1])
    ok('两张同名卡各挂一个不同的短码', tags.length === 2 && tags[0] !== tags[1], tags.join(' / '))
    ok('两张卡的内容都在（后面的同名卡没有顶掉前面的）',
      system.includes('爱穿白裙子') && system.includes('常穿工装外套'))

    // 记忆块也要能分辨 —— 否则模型看到两块「〖长期记忆 · 洛汐〗」还是不知道谁是谁
    await store.saveMemory({ ...store.emptyMemory(a.id), facts: '她怕黑', updatedAt: Date.now() })
    await store.saveMemory({ ...store.emptyMemory(b.id), facts: '她养了一条狗', updatedAt: Date.now() })
    const withMem = (await buildFreeSystem(s, [a, b])).system
    ok('同名时记忆块也挂短码，且两份记忆都在',
      /〖长期记忆 · 洛汐 #[0-9A-Z]{4}〗/.test(withMem) && withMem.includes('她怕黑') && withMem.includes('她养了一条狗'))

    // 不同名时**不注入**任何消歧内容（别白占上下文）
    const c2 = await mkChar('林夏')
    const s2 = await store.createFreeSession([a.id, c2.id], '不同名', { providerId: STUB_PROVIDER.id }, {})
    const plain = (await buildFreeSystem(s2, [a, c2])).system
    ok('不同名时：不加对照说明、也不挂短码',
      !plain.includes('〖同名角色〗') && !plain.includes('〖角色卡 · 林夏 #'))
    ok('不同名时角色卡仍带名字（便于模型对应关系）', plain.includes('〖角色卡 · 林夏〗'))
  }

  // ---------- 10) 客观描写档位（2026-09-14 新增） ----------
  {
    const su2 = await mkChar('苏念')
    const sess = await store.createFreeSession([su2.id], '电影院门口', { providerId: STUB_PROVIDER.id }, {})

    const std = (await buildFreeSystem(sess, [su2])).system
    ok('默认档下 system 含「客观描写」段（= 本轮新增行为的默认值）', std.includes('〖客观描写〗'))
    ok('三条落点都在（出场 / 环境 / 情绪）',
      std.includes('出场') && std.includes('环境') && std.includes('情绪明显变化时'))
    ok('写明只写观察得到的客观事实、不写任何人的心理（与「不代写」同源）',
      std.includes('不写任何人的心理活动'))
    ok('🔴 写明与协议 O1 是同一套括号（v1.6 起不再分【】与（））',
      std.includes('与协议 O1 是**同一套括号**'))
    ok('写明描写算在协议字数里（不会把 60–160 字撑爆）', std.includes('算在协议的字数里'))
    ok('排在身份之后、协议之前',
      std.indexOf('〖你在戏里的身份与知识边界〗') < std.indexOf('〖客观描写〗') &&
      std.indexOf('〖客观描写〗') < std.indexOf(PROTOCOL_CORE))

    const stOff = { ...DEFAULT_TAVERN_SETTINGS, free: { ...DEFAULT_TAVERN_SETTINGS.free, sceneDescription: 'off' as const } }
    const off = (await buildFreeSystem(sess, [su2], stOff)).system
    ok('关掉档位后整段不出现', !off.includes('〖客观描写〗'), off.slice(0, 0))

    const stRich = { ...DEFAULT_TAVERN_SETTINGS, free: { ...DEFAULT_TAVERN_SETTINGS.free, sceneDescription: 'rich' as const, extraPrompt: '不要写天气。' } }
    const rich = (await buildFreeSystem(sess, [su2], stRich)).system
    ok('丰富档多一句「每回合都至少带一条环境/身体细节」', rich.includes('每个回合都至少带一条写环境或身体细节的'))
    ok('作者的补充要求排在客观描写之后（真冲突以作者为准）',
      rich.indexOf('〖客观描写〗') < rich.indexOf('不要写天气。'))
  }

  // ---------- 11) 本场数值块：只给当前值（数值改由「整理记忆」时算） ----------
  {
    const su3 = await mkChar('苏念')
    const s = await store.createFreeSession([su3.id], '楼道', { providerId: STUB_PROVIDER.id }, {})

    // 起因：实弹里用户说「一起吃饭」，模型把场景从宿舍楼道一步挪到食堂 —— 上下文里从没说过它在哪。
    // 现在不再要求模型每轮写记账行（那套遵守率极低），但**当前值仍每轮进上下文**。
    // ⚠️ 2026-09-16 起刻度改成 −100~+100、起点是 0（原 0–100、好感默认 50）。
    const fresh = (await buildFreeSystem(s, [su3])).system
    ok('新会话就有数值块（初值就是起点）', fresh.includes('〖本场数值〗') && fresh.includes('好感 0'))
    ok('🔴 不再要求模型每轮输出记账行（交给整理变量，协议里也不再有这条）',
      !fresh.includes('〔数值〕') && !fresh.includes('地点还没记下来'))

    const place = '教学楼三层楼道'
    const withPlace = { ...s, vars: { ...emptyVars(), values: { ...emptyVars().values, place } } }
    const sys = (await buildFreeSystem(withPlace, [su3])).system
    ok('地点已记下 → 每轮都注入当前值（这是「不该瞬移」的依据）', sys.includes(`地点 ${place}`))
    ok('数值块排在协议**之后**（离生成点最近）',
      sys.indexOf(PROTOCOL_CORE) < sys.indexOf('〖本场数值〗'))

    // 关掉变量总开关 → 整块不出现（「空层不占额度」）
    const stVarsOff = { ...DEFAULT_TAVERN_SETTINGS, vars: { ...DEFAULT_TAVERN_SETTINGS.vars, enabled: false } }
    const noVars = (await buildFreeSystem(withPlace, [su3], stVarsOff)).system
    ok('关掉变量开关 → 数值块一个字都不出现',
      !noVars.includes('〖本场数值〗') && !noVars.includes(place))
  }

  // ---------- 隐藏不进上下文 + 重说（老大全接受的 A1，2026-09-14） ----------
  {
    __resetMockStores()
    // 复位会清掉桩模型，这里要重新装一遍（否则 resolveTavernProvider 直接抛「未配置模型」）
    await saveProviders([STUB_PROVIDER])
    await saveActiveId(STUB_PROVIDER.id)
    const ch = await store.createFreeChar({ ...store.emptyFreeCharacter(), name: '重说测试' })
    const base = await store.saveFreeSession({
      ...(await store.createFreeSession([ch.id], '重说测试场', { providerId: '' }, {})),
      messages: [
        { id: 'm1', role: 'user', content: '第一句', at: 1 },
        { id: 'm2', role: 'assistant', content: '不该被看见的旧回复', at: 2, hidden: true },
        { id: 'm3', role: 'user', content: '第二句', at: 3 },
        { id: 'm4', role: 'assistant', content: '要被重说的回复', at: 4 },
      ],
    })

    // ① 隐藏的消息不进上下文（但仍在 messages 里，界面拿得到）
    const built = buildFreeMessages(base.messages, base, [ch], 100000)
    ok('隐藏的消息不进上下文（自由模式）',
      !built.messages.some(m => m.content.includes('不该被看见')) &&
      built.messages.some(m => m.content.includes('要被重说的回复')) &&
      base.messages.length === 4)

    // ② 重说：不追加用户消息、替换末尾那条、历史条数不变
    const REPLY = '她换了句说法。'
    const { chatFn, calls } = makeFakeChat(REPLY)
    const res = await runFreeTurn(base, [ch], null, {}, { chatFn })
    const msgs = res.session.messages
    ok('重说：拿到新回复', res.reply === REPLY)
    ok('重说：不新增用户消息（条数不变）', msgs.length === base.messages.length, String(msgs.length))
    ok('重说：末尾换成新的，旧的那条已不在历史里',
      msgs.at(-1)?.content === REPLY && !msgs.some(m => m.content.includes('要被重说')))
    ok('重说：两条用户消息原样保留',
      msgs.filter(m => m.role === 'user').map(m => m.content).join('|') === '第一句|第二句')

    const lastCall = calls.at(-1)!
    const joined = lastCall.messages.map(m => String(m.content)).join('\n')
    ok('重说：模型看到的最后一条仍是用户那句', lastCall.messages.at(-1)?.role === 'user' && joined.includes('第二句'))
    ok('重说：隐藏的那条也没进上下文', !joined.includes('不该被看见'))

    // ③ 重说失败（空回复）→ **保留原来那条**，不能一次失败就删掉
    const { chatFn: emptyChat } = makeFakeChat('')
    const fail = await runFreeTurn(base, [ch], null, {}, { chatFn: emptyChat })
    ok('重说失败（空回复）：原来那条被保留',
      fail.session.messages.length === base.messages.length &&
      fail.session.messages.some(m => m.content.includes('要被重说的回复')))

    // ④ 没有末尾 assistant 时不该动历史（dropTrailingAssistant 原样返回）
    const onlyUser = await store.saveFreeSession({
      ...base,
      messages: [{ id: 'x1', role: 'user', content: '只有一句', at: 1 }],
    })
    let refused = false
    try { await runFreeTurn(onlyUser, [ch], null, {}, { chatFn }) } catch { refused = true }
    ok('没有可重说的回复时：明确报错，而不是凭空造一轮', refused)
  }

  // ---------- A6：在场调度（静音 / 健谈度） ----------
  {
    __resetMockStores()
    await saveProviders([STUB_PROVIDER])
    await saveActiveId(STUB_PROVIDER.id)
    const jia = await mkChar('甲')
    const yi = await mkChar('乙')
    const bing = await mkChar('丙')
    const base = await store.createFreeSession([jia.id, yi.id, bing.id], '调度测试', { providerId: STUB_PROVIDER.id }, {})

    const muted = store.setMuted(base, yi.id, true)
    ok('静音写进会话', (muted.muted ?? []).includes(yi.id))
    const { system } = await buildFreeSystem(muted, [jia, yi, bing])
    ok('🔴 静音角色不进「你是下列角色」名单', !system.includes('你是下列角色：甲、乙、丙'))
    ok('静音角色写进「在场但这一场不出声」', system.includes('在场但这一场不出声：乙'))
    // 剩下 >1 人时才追加发言规则；静音声明必须**同时**出现在规则层（否则模型不知道谁不出声）
    ok('剩下 >1 人时：发言规则里也声明静音（在场但不开口）', system.includes('这一场不开口'))
    ok('静音声明措辞要求「不写成已经离开」', system.includes('不要写成 Ta 们已经离开'))
    ok('取消静音后字段被清掉（不留空数组）', store.setMuted(muted, yi.id, false).muted === undefined)

    const talked = store.setTalkativity(base, jia.id, 90)
    ok('健谈度写进会话', talked.talkativity?.[jia.id] === 90)
    const sys2 = (await buildFreeSystem(talked, [jia, yi])).system
    ok('健谈度进发言规则（发言分量 + 档名）', sys2.includes('发言分量') && sys2.includes('话很多'))
    ok('回到默认就删键（不留一堆 50）', store.setTalkativity(talked, jia.id, DEFAULT_TALKATIVITY).talkativity === undefined)

    // 轮转必须跳过被静音的角色：连跑两轮，说话人始终是没被静音的那个
    // （单独用两角色会话：三人的话轮转会轮到「丙」，断言就不成立了）
    const duo = await store.createFreeSession([jia.id, yi.id], '轮转测试', { providerId: STUB_PROVIDER.id }, {})
    let cur = store.setMuted(duo, yi.id, true)
    const { chatFn } = makeFakeChat('好。')
    for (let i = 0; i < 2; i++) {
      cur = (await runFreeTurn(cur, [jia, yi], '嗯。', {}, { chatFn })).session
    }
    const said = cur.messages.filter(m => m.role === 'assistant')
    ok('🔴 轮转不轮到被静音的角色', said.length === 2 && said.every(m => m.speakerId === jia.id),
      said.map(m => m.speakerId).join(','))
  }

  // ---------- B2 临时导演指令 + B3 输出后处理（第 6 批） ----------
  {
    __resetMockStores()
    await saveProviders([{ ...STUB_PROVIDER }])
    await saveActiveId(STUB_PROVIDER.id)

    // ① 注入：按深度插进历史（1 = 紧贴生成点）
    const hist: { role: string; content: string }[] = [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ]
    const injected = injectDirectorNote(hist, { text: '节奏放慢', depth: 2, turnsLeft: 3 })
    ok('注入到「倒数第 2 条之前」', injected.length === 6 && injected[3].content === '「节奏放慢」',
      injected.map(m => m.content).join('|'))
    ok('按协议 R4 用「」包装（模型照做后继续演，不当成台词）', injected[3].content === '「节奏放慢」')
    ok('role 是 user —— 不塞 system（那会离生成点太远，正是这条功能要避免的）', injected[3].role === 'user')
    ok('depth 超大时至少插在最前（不崩、不丢）', injectDirectorNote(hist, { text: 'x', depth: 99, turnsLeft: 1 })[0].content === '「x」')
    ok('没有指令 → 原样返回', injectDirectorNote(hist, undefined).length === 5)
    ok('空白指令 → 原样返回（等于没写）', injectDirectorNote(hist, { text: '  ', depth: 4, turnsLeft: 3 }).length === 5)

    // ② 倒计时：成功一轮减 1，扣到 0 清掉
    ok('turnsLeft 3 → 2', tickDirectorNote({ text: 'x', depth: 4, turnsLeft: 3 })?.turnsLeft === 2)
    ok('turnsLeft 1 → 清掉（返回 undefined）', tickDirectorNote({ text: 'x', depth: 4, turnsLeft: 1 }) === undefined)
    ok('没有指令 → undefined', tickDirectorNote(undefined) === undefined)

    // ③ 端到端：指令进了 messages、轮次 -1、坏格式被修好
    const ch = await mkChar('洛汐')
    const s6 = await store.createFreeSession([ch.id], 'B2B3', { providerId: STUB_PROVIDER.id }, {})
    const withNote = store.setDirectorNote(s6, { text: '这一段节奏放慢', depth: 2, turnsLeft: 2 })
    await store.saveFreeSession(withNote)
    const fake = makeFakeChat('(她点了点头。)\n**洛汐：你来了。**')
    const res6 = await runFreeTurn(withNote, [ch], '（我推门进来）', {}, { chatFn: fake.chatFn })
    const flat = fake.calls[0].messages.map(m => m.content).join('\n')
    ok('指令被注入到发给模型的 messages 里', flat.includes('「这一段节奏放慢」'), flat.slice(-140))
    ok('成功一轮后 turnsLeft 2 → 1', res6.session.directorNote?.turnsLeft === 1, String(res6.session.directorNote?.turnsLeft))
    const last6 = res6.session.messages[res6.session.messages.length - 1]?.content ?? ''
    ok('🔴 后处理把半角括号 + markdown 都修好了', last6 === '（她点了点头。）\n洛汐：你来了。', JSON.stringify(last6))
    ok('postApplied 记下命中了哪几条', res6.postApplied.length === 2, res6.postApplied.map(a => a.name).join('、'))
    ok('postErrors 为空（出厂正则都是好的）', res6.postErrors.length === 0)

    // ④ 提示关掉：规则照跑、只是不回传命中列表（正则错误仍回传）
    await saveTavernSettings({ ...(await getTavernSettings()), postRuleNotice: false })
    const fake2 = makeFakeChat('(她点了点头。)')
    const res7 = await runFreeTurn(withNote, [ch], '再来一句', {}, { chatFn: fake2.chatFn })
    const last7 = res7.session.messages[res7.session.messages.length - 1]?.content ?? ''
    ok('提示关掉：文本照样被修正', last7 === '（她点了点头。）', JSON.stringify(last7))
    ok('提示关掉：不回传命中列表（作者选了静默）', res7.postApplied.length === 0)
    ok('提示关掉：正则错误仍回传（那是配置问题，不该被静默）', Array.isArray(res7.postErrors))
    await saveTavernSettings({ ...(await getTavernSettings()), postRuleNotice: true })

    // ⑤ 总开关关掉 → 一个字都不改
    await saveTavernSettings({ ...(await getTavernSettings()), postRulesEnabled: false })
    const fake3 = makeFakeChat('(她点了点头。)')
    const res8 = await runFreeTurn(withNote, [ch], '再来一句', {}, { chatFn: fake3.chatFn })
    const last8 = res8.session.messages[res8.session.messages.length - 1]?.content ?? ''
    ok('总开关关掉 → 原样落库（排查格式问题时要的就是这个）', last8 === '(她点了点头。)', JSON.stringify(last8))
    await saveTavernSettings({ ...(await getTavernSettings()), postRulesEnabled: true })
  }

  // ---------- 11) 润色/自动回复 assist 模式：措辞翻转 + 指令内联 ----------
  {
    const ai = await mkChar('楚楠')
    const user = await mkChar('苏念')
    const sessUser = await store.createFreeSession([ai.id, user.id], 'assist-有角色卡', { providerId: STUB_PROVIDER.id }, {}, user.id)
    const st = await getTavernSettings()

    const { system: sAssist } = await buildFreeSystem(sessUser, [ai, user], st, { assist: 'polish' })
    ok('assist 模式：system 含「代这个角色撰写他这一轮」', sAssist.includes('代这个角色撰写他这一轮'))
    ok('assist 模式：userChar 块不再含「不要代写、不要替 Ta 决定」', !sAssist.includes('不要代写、不要替 Ta 决定'))
    ok('assist 模式：self 层钉死「代写」任务且强制第一人称视角', sAssist.includes('第一人称视角') && sAssist.includes('只输出台词本身'))
    ok('assist 模式：点名用户扮演的角色来代写（苏念），不是 AI 角色', sAssist.includes('代「苏念」撰写他这一轮要发送的发言'))
    ok('assist 模式：旧「你扮演：<AI 角色>」框架被整体替换（视角不会反过来）', !sAssist.includes('你扮演：楚楠'))
    ok('assist 模式：括号描写仍要求第三人称（不与协议 O1「描写一律第三人称」冲突）', sAssist.includes('描写仍按协议用第三人称'))

    const { system: sNormal } = await buildFreeSystem(sessUser, [ai, user], st)
    ok('普通模式：userChar 块仍含「不要代写」红线（原行为零改动）', sNormal.includes('不要代写、不要替 Ta 决定'))

    // 无角色卡（纯旁观）assist：追加「主要依据剧本与上下文」说明
    const sessNone = await store.createFreeSession([ai.id], 'assist-无角色卡', { providerId: STUB_PROVIDER.id }, {})
    const { system: sNone } = await buildFreeSystem(sessNone, [ai], st, { assist: 'auto' })
    ok('assist + 无角色卡：system 含「没有专属角色卡」说明', sNone.includes('没有专属角色卡'))

    // runFreeAssist：润色内联原文、自动回复不内联，返回 trimmed
    const hist = await store.createFreeSession([ai.id, user.id], 'assist-run', { providerId: STUB_PROVIDER.id }, {}, user.id)
    hist.messages.push({ id: 'm1', role: 'assistant', content: '（她抬眼）回来了？', at: Date.now() })
    const fakeP = makeFakeChat('（他把手里的袋子放下）顺便带了点吃的。')
    const resP = await runFreeAssist(hist, [ai, user], 'polish', '我回来了', {}, { chatFn: fakeP.chatFn })
    const lastP = fakeP.calls[0].messages[fakeP.calls[0].messages.length - 1].content
    ok('runFreeAssist · 润色指令带出原文且过 promptGuard 边界', lastP.includes('〖润色指令〗') && lastP.includes('我回来了') && /<<<A-[a-z0-9]+>>>/.test(lastP))
    // 默认 postRules 开启，返回文本已套用后处理（可能与原始逐字不同）——只断言核心内容在
    ok('runFreeAssist · 返回文本（经后处理）含核心内容', resP.text.includes('顺便带了点吃的'))

    const fakeA = makeFakeChat('（他笑了笑）今天天气不错。')
    const resA = await runFreeAssist(hist, [ai, user], 'auto', '', {}, { chatFn: fakeA.chatFn })
    const lastA = fakeA.calls[0].messages[fakeA.calls[0].messages.length - 1].content
    ok('runFreeAssist · 自动回复指令不含原文内联', lastA.includes('〖代写指令〗') && !lastA.includes('我回来了'))
    ok('runFreeAssist · auto 同样返回文本（经后处理）含核心内容', resA.text.includes('今天天气不错'))

    // 关键回归：runFreeAssist 走 postRules（含去空行），模型顺手加的空行不会进输入框
    const blanks = makeFakeChat('（他放下伞）\n\n\n\n"你来了。"\n\n')
    const resB = await runFreeAssist(hist, [ai, user], 'auto', '', {}, { chatFn: blanks.chatFn })
    ok('runFreeAssist 产出已无空行（去空行规则兜底）', !/\n\s*\n/.test(resB.text) && resB.text === '（他放下伞）\n"你来了。"')
  }

  // ---------- 12) applyPostRulesForPreview：预览/取消与最终结果同口径（审计 P2-13） ----------
  {
    const st = await getTavernSettings()
    const prev = applyPostRulesForPreview('（他放下伞）\n\n"你来了。"', st)
    ok('预览已去空行（与最终结果同一套规则）', !/\n\s*\n/.test(prev), JSON.stringify(prev))
    ok('预览里「）」后接对白也换行（与最终结果一致）', prev.split('\n').length >= 2, JSON.stringify(prev))
    const off = applyPostRulesForPreview('  （动作）  ', { ...st, postRulesEnabled: false })
    ok('规则总开关关掉 → 只 trim，不改内容', off === '（动作）', JSON.stringify(off))
  }

  // ---------- 🔴 本轮用户输入里的世界书触发词，**这一轮**就要生效 ----------
  // 判据：`buildFreeSystem` 内部按「最近 6 条消息」抽世界书触发词，所以组装 system 时必须传
  // `{ ...session, messages: withUser }`（withUser 已带上本轮用户输入）。传原始 session 会让
  // 本轮刚说到的关键词这一轮不注入、要等下一轮 —— 剧情模式 2026-09-23 已修过同一处
  // （engine.ts 的 buildPlotSystem 有同款注释），自由模式当时漏了、两模式行为分叉。
  // 2026-10-10 六维审计补上并钉住这条。
  {
    const kwStory = await createStory({ name: '关键词注入测试故事' })
    await saveStory({
      ...kwStory,
      setting: '',
      entries: [{
        ...emptyWorldEntry(), id: 'kw-1', title: '暗号',
        body: '这条设定只有在提到「青霜玉」时才该出现。',
        keys: ['青霜玉'], prob: 1, order: 0, recursive: true,
      }],
    })
    const snap = snapshotStorySetting(await getStory(kwStory.id) as TavernStory)
    const kwChar = await mkChar('关键词角色')
    const kwSess = await store.createFreeSession(
      [kwChar.id], '关键词注入测试', { providerId: STUB_PROVIDER.id }, {}, undefined, kwStory.id)
    const live = await store.saveFreeSession({ ...kwSess, storySetting: snap })

    const spy = makeFakeChat('（他把玉收进袖里。）')
    await runFreeTurn(live, [kwChar], '我掏出那枚青霜玉给他看。', {}, { chatFn: spy.chatFn })
    const prompt = (spy.calls[0]?.messages ?? []).map(m => String(m.content)).join('\n')
    ok('🔴 自由模式：本轮用户输入提到的世界书触发词，这一轮就注入',
      prompt.includes('这条设定只有在提到「青霜玉」时才该出现'), prompt.slice(0, 200))

    await store.deleteFreeSession(live.id)
    await deleteStory(kwStory.id)
  }

  console.log(`\ntavernFree: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
