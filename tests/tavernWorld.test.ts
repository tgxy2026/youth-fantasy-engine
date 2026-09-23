// ============ 酒馆模式 · 背景设定（第 5 批）============
//
// 这一层有两个必须守住的性质：
//   ① **归属**：剧情那份随项目、自由那份跨项目（口径与既有会话归属一致）；
//   ② **按关键词注入**：不设关键词=总是注入；设了就只在命中时带上 —— 这是「不每次喂一大堆」的落子。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import * as store from '../src/lib/tavern/store'
import { saveProviders, saveActiveId } from '../src/lib/ai'
import {
  EMPTY_WORLD_SETTING, WORLD_MAX_CHARS, isEmptyWorld, worldToText, shouldInjectWorld, worldHaystack,
  keywordHaystackMessages,
  parseWorldDraft, buildWorldDraftSystem, draftWorldSetting, getWorldSetting, saveWorldSetting,
  type WorldSetting,
} from '../src/lib/tavern/world'
import { buildSystemPrompt } from '../src/lib/tavern/prompt'
import { PROTOCOL_CORE } from '../src/lib/tavern/protocol'
import { createStory, saveStory, snapshotStorySetting } from '../src/lib/tavern/story'
import { buildFreeSystem } from '../src/lib/tavern/engine'
import type { ChatMessage } from '../src/lib/ai'
import type { TavernMessage } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const STUB_PROVIDER = { id: 'world-stub', name: '桩模型', type: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }

function mkWorld(over: Partial<WorldSetting> = {}): WorldSetting {
  return {
    ...EMPTY_WORLD_SETTING,
    brief: '现代都市·城南，梅雨季',
    sections: [{ id: 's1', title: '规矩与禁忌', body: '店里不许抽烟。' }],
    keywords: [],
    seed: '',
    draftedAt: 0,
    updatedAt: 0,
    ...over,
  }
}

async function main() {
  // ---------- 1) 渲染与截断 ----------
  {
    ok('空设定识别为空', isEmptyWorld(EMPTY_WORLD_SETTING) && isEmptyWorld(null))
    ok('只有 brief 也不算空', !isEmptyWorld(mkWorld()))
    ok('全空的分节不算内容', isEmptyWorld({ ...EMPTY_WORLD_SETTING, sections: [{ id: 'x', title: '', body: '  ' }] }))

    ok('渲染出 brief 与分节标题（标题用输入侧符号〖〗，不教模型写【】）',
      worldToText(mkWorld()).includes('现代都市') && worldToText(mkWorld()).includes('〖规矩与禁忌〗') &&
      !worldToText(mkWorld()).includes('【规矩与禁忌】'))
    ok('空设定渲染为空串（不留空标题）', worldToText(EMPTY_WORLD_SETTING) === '')

    // 超上限：截断并**注明**（悄悄吞掉会让作者以为写进去了）
    const huge = mkWorld({ sections: [{ id: 's', title: '长', body: '字'.repeat(WORLD_MAX_CHARS + 500) }] })
    const t = worldToText(huge)
    ok('超上限时截断', t.length < huge.sections[0].body.length + 100, String(t.length))
    ok('截断时留下说明（不许静默吞）', t.includes('已截断'))
  }

  // ---------- 2) 关键词命中 ----------
  {
    const always = mkWorld({ keywords: [] })
    ok('关键词为空 = 总是注入', shouldInjectWorld(always, '什么上下文都没有'))
    const gated = mkWorld({ keywords: ['便利店', '城南'] })
    ok('命中任一关键词 → 注入', shouldInjectWorld(gated, '她走进那家便利店'))
    ok('一个都没命中 → 不注入', !shouldInjectWorld(gated, '今天天气不错'))
    ok('空关键词项被忽略（不会把「空串命中一切」算进来）', shouldInjectWorld(mkWorld({ keywords: ['', '  '] }), '随便'))
    ok('空设定一律不注入', !shouldInjectWorld(EMPTY_WORLD_SETTING, '便利店'))

    const h = worldHaystack(['标题', undefined, '场景描述'], ['最近一句', '最近二句'])
    ok('取材串：跳过 undefined，拼上最近消息', h.includes('标题') && !h.includes('undefined') && h.includes('最近二句'))
  }

  // ---------- 3) 归属：随项目（2026-09-15 起只有这一份） ----------
  {
    __resetMockStores()
    db.setCurrentProject('world-proj-a')
    await saveWorldSetting(mkWorld({ brief: 'A 书的世界' }))
    ok('能读回', (await getWorldSetting()).brief === 'A 书的世界')

    // 🔴 用「换一个项目」来验归属，而不是去直查物理表 ——
    //    前者验的是**语义**（换书就该看不到），后者依赖 db 内部实现（换过一次实现就失效，
    //    而且写错 API 名会静默跳过断言，得到一个假绿）。
    db.setCurrentProject('world-proj-b')
    ok('🔴 随项目（换项目读不到 A 书那份）', (await getWorldSetting()).brief !== 'A 书的世界')

    // 回到 A 项目，那份还在（确实是「随项目」而不是「被覆盖了」）
    db.setCurrentProject('world-proj-a')
    ok('切回来仍在（不是被覆盖）', (await getWorldSetting()).brief === 'A 书的世界')

    // 🔴 收口回归：旧的「自由对话」那一份**不再被读取**。
    //    数据保留在库里（不动用户数据），但引擎与界面都到不了了 —— 这里直接往那个老键写一份，
    //    再读一次，读到的必须是剧情那份。这条断言就是「收口有没有真的收干净」的哨兵。
    await db.setMeta('tavern.world.free', mkWorld({ brief: '早已废弃的自由世界' }))
    ok('🔴 旧的自由那份写进老键后，getWorldSetting 拿到的仍是剧情那份',
      (await getWorldSetting()).brief === 'A 书的世界')
  }

  // ---------- 4) 解析一键录入的结果 ----------
  {
    const good = parseWorldDraft(JSON.stringify({
      brief: '现代都市·城南',
      sections: [{ title: '规矩', body: '不许抽烟。' }, { title: '', body: '' }],
      keywords: ['便利店', '', '城南'],
    }))
    ok('解析 brief 与分节', !!good && good.brief === '现代都市·城南' && good.sections.length === 1)
    ok('空白分节被丢掉', !!good && good.sections.every(s => s.body || s.title))
    ok('关键词去掉空项', !!good && good.keywords.join(',') === '便利店,城南')
    ok('分节都带 id（界面增删要用）', !!good && good.sections.every(s => !!s.id))

    ok('纯文字 → null（不乱猜）', parseWorldDraft('这个世界的设定是……') === null)
    ok('空对象 → null', parseWorldDraft('{}') === null)
    ok('裹代码块也能解析', !!parseWorldDraft('```json\n' + JSON.stringify({ brief: 'x', sections: [], keywords: [] }) + '\n```'))
    ok('只有 brief 也算有效', !!parseWorldDraft(JSON.stringify({ brief: '只有一句' })))
    ok('只有分节也算有效', !!parseWorldDraft(JSON.stringify({ sections: [{ title: 't', body: 'b' }] })))

    const many = parseWorldDraft(JSON.stringify({
      brief: 'x',
      sections: Array.from({ length: 20 }, (_, i) => ({ title: 't' + i, body: 'b' })),
    }))
    ok('分节数量有上限（防模型一次给 20 节）', !!many && many.sections.length <= 8, String(many?.sections.length))
  }

  // ---------- 5) 提示词：只服务剧情推演 ----------
  {
    const sys = buildWorldDraftSystem()
    ok('强调「提炼」而非摘抄', sys.includes('精简整合') && sys.includes('提炼'))
    ok('要求 JSON 输出', sys.includes('{"brief"'))
    ok('写明「宁少勿滥」', sys.includes('宁少勿滥') || sys.includes('宁少'))
    ok('要求每节 ≤300 字（怕撑爆上下文）', sys.includes('300'))
  }

  // ---------- 6) draftWorldSetting：材料为空要报错，桩模型要能跑通 ----------
  {
    __resetMockStores()
    await saveProviders([{ ...STUB_PROVIDER }])
    await saveActiveId(STUB_PROVIDER.id)

    let threw = false
    try { await draftWorldSetting({ seed: '', projectDigest: '', chatFn: (async () => '{}') as never }) } catch { threw = true }
    ok('没有项目资料 → 明确报错（不空跑）', threw)

    const calls: ChatMessage[][] = []
    const chatFn = async (_c: unknown, messages: ChatMessage[]) => {
      calls.push(messages)
      return JSON.stringify({ brief: '按基础信息扩写的世界', sections: [{ title: '基调', body: '慢、克制。' }], keywords: ['便利店'] })
    }
    const { fields: out, source } = await draftWorldSetting({
      seed: '', projectDigest: '现代都市·城南，梅雨季。一堆原始资料。', chatFn: chatFn as never,
    })
    ok('桩模型：拿到 brief 与分节', out.brief.includes('基础信息') && out.sections.length === 1)
    ok('不带检索设置时如实标注来源（未联网）', source.mode === 'off' && source.used === false, JSON.stringify(source))
    ok('提示词带上项目资料', calls[0][1].content.includes('梅雨季'))
    ok('作者文本用边界块包起来（防注入）', /<<<A-[a-z0-9]+>>>/.test(calls[0][1].content))
    ok('备注为空时不带「额外要求」段', !calls[0][1].content.includes('作者的额外要求'))

    const calls2: ChatMessage[][] = []
    await draftWorldSetting({
      seed: '重点写学园那条线',
      projectDigest: '资料正文',
      chatFn: (async (_c: unknown, m: ChatMessage[]) => { calls2.push(m); return JSON.stringify({ brief: 'x' }) }) as never,
    })
    ok('填了备注就带上这一句', calls2[0][1].content.includes('作者的额外要求') && calls2[0][1].content.includes('学园'))

    const bad = async () => '模型今天不想干活，随便聊了两句'
    let threw3 = false
    try { await draftWorldSetting({ seed: 'x', projectDigest: '有资料', chatFn: bad as never }) } catch { threw3 = true }
    ok('模型乱答 → 抛错（让调用方保留作者现有内容）', threw3)
  }

  // ---------- 7) 提示词层：空则不出现 ----------
  {
    const base = { tone: 'narrative' as const, protocol: 'PROTO' }
    const noWorld = buildSystemPrompt({ ...base, setting: '设定' })
    ok('没给背景设定 → 整层不出现', !noWorld.includes('本场背景设定'))
    const withWorld = buildSystemPrompt({ ...base, setting: '设定', world: '现代都市·城南' })
    ok('给了 → 带标题注入', withWorld.includes('〖本场背景设定〗') && withWorld.includes('现代都市'))
    ok('层序：设定 → 背景设定 → 协议', withWorld.indexOf('世界与角色设定') < withWorld.indexOf('本场背景设定'))
    ok('空串等同没给（不留空标题）', !buildSystemPrompt({ ...base, world: '   ' }).includes('本场背景设定'))
  }

  // ---------- 8) 引擎接线：自由模式**不再**注入背景设定（收口哨兵） ----------
  {
    __resetMockStores()
    const c = await store.createFreeChar({
      ...store.emptyFreeCharacter(),
      name: '洛汐',
      world: '现代都市·城南',
      profile: { externals: '', core: '', speech: '', relations: '', cannot: '', knowledge: '' },
      conduct: { perspective: '', bottomLine: '', paceLock: '', rating: '' },
      examples: '',
    })
    const session = await store.createFreeSession([c.id], '便利店夜谈', { providerId: '' }, {})

    // 把「剧情那份」写成「总是注入」，再让自由模式去组装：**它一个字的背景设定都不该带**
    await saveWorldSetting(mkWorld({ brief: '总是带上我', keywords: [] }))
    const s1 = (await buildFreeSystem(session, [c])).system
    ok('🔴 自由模式的 system 里没有「本场背景设定」层（收口了）', !s1.includes('本场背景设定'))
    ok('🔴 也不带那份内容（不是「带了但不带标题」）', !s1.includes('总是带上我'))
    ok('世界观改由角色卡第 1 章承担（角色卡的「世界」仍在）', s1.includes('现代都市·城南'))

    // 老的自定义 free 键同样读不到
    await db.setMeta('tavern.world.free', mkWorld({ brief: '废弃字段别冒出来', keywords: [] }))
    const s2 = (await buildFreeSystem(session, [c])).system
    ok('🔴 老键 tavern.world.free 的内容也不会冒出来', !s2.includes('废弃字段别冒出来'))
  }

  // ---------- 9) 🔴 但自由模式**有**「故事的世界设定」这一层（#5 / D1，2026-09-16）----------
  // 上面第 8 节盯的是「剧情那份背景设定」不许进自由模式；这两件事不矛盾：
  // 自由模式的世界来自**故事**（跨项目的那份），与项目内的背景设定是两套东西。
  // 本节盯的是「故事设定有没有真的进上下文」—— 在这之前 `getStory` 是零调用，这一层根本不存在。
  {
    __resetMockStores()
    const c = await store.createFreeChar({
      ...store.emptyFreeCharacter(),
      name: '苏念',
      world: '现代都市·城南',
      profile: { externals: '', core: '', speech: '', relations: '', cannot: '', knowledge: '' },
      conduct: { perspective: '', bottomLine: '', paceLock: '', rating: '' },
      examples: '',
    })
    const story = await createStory({ name: '奉阳大学', setting: '校园里有一条老槐树路，夏天走一趟满身汗。' })
    const session = await store.createFreeSession([c.id], '便利店夜谈', { providerId: '' }, {}, undefined, story.id)

    const r = await buildFreeSystem(session, [c])
    ok('🔴 故事的世界设定进了 system（#5 之前这一层是零）',
      r.system.includes('校园里有一条老槐树路'), r.system.slice(0, 80))
    ok('🔴 用自己的层标题「故事的世界设定 · 故事名」（叫「本场背景设定」是错的）',
      r.system.includes('〖故事的世界设定 · 奉阳大学〗'))
    ok('层序：角色卡 → 故事设定 → 这一场（先知道世界如何，再知道这一场是什么）',
      r.system.indexOf('现代都市·城南') < r.system.indexOf('故事的世界设定'))
    ok('用量口径：storyChars 量到了真实字数',
      r.storyChars === '校园里有一条老槐树路，夏天走一趟满身汗。'.length, String(r.storyChars))
    ok('协议正文也单独量得出来（不再是「其他固定部分」里的黑洞）',
      r.protocolChars === PROTOCOL_CORE.length, `${r.protocolChars} vs ${PROTOCOL_CORE.length}`)

    // 没挂故事的会话 → 整层不出现（不留空标题、不占额度）
    const bare = await store.createFreeSession([c.id], '没挂故事', { providerId: '' }, {})
    const rb = await buildFreeSystem(bare, [c])
    ok('没挂故事 → 整层不出现（0 字，不留空标题）',
      rb.storyChars === 0 && !rb.system.includes('故事的世界设定'))

    // 故事设定是空的 → 同样整层不出现
    const blank = await createStory({ name: '空故事', setting: '   ' })
    const sb = await store.createFreeSession([c.id], '空故事', { providerId: '' }, {}, undefined, blank.id)
    ok('故事存在但设定为空 → 也不留空标题', (await buildFreeSystem(sb, [c])).storyChars === 0)

    // 🔴 快照语义：会话里存了快照就用快照 —— 作者后来改故事，已建的那一场不跟着变
    const snap = snapshotStorySetting(story)
    const frozen = { ...session, storySetting: snap }
    await saveStory({ ...story, setting: '改过之后的新设定' })
    const rf = await buildFreeSystem(frozen, [c])
    ok('🔴 有快照 → 用快照（作者改故事不改写历史会话）',
      rf.system.includes('老槐树路') && !rf.system.includes('改过之后的新设定'))
    const rl = await buildFreeSystem(session, [c])
    ok('没快照（老会话）→ 实时读，读到改过之后的', rl.system.includes('改过之后的新设定'))
  }

  // ---------- 关键词取材：隐藏消息与 system 不得参与「是否注入背景设定」的判定 ----------
  //
  // 2026-09-23 六维审计 P1：engine 原先直接 `messages.slice(-6).map(m => m.content)`，
  // 与全项目「hidden / system 不进上下文」的口径不一致 ⇒ 作者特意藏起来的内容
  // 仍会影响注入判定。口径已收进 `world.keywordHaystackMessages`，这里直接钉住它。
  {
    const msgs = [
      { id: 'm1', role: 'system', content: '系统提示：老槐树路', at: 1 },
      { id: 'm2', role: 'user', content: '普通人说了一句', at: 2 },
      { id: 'm3', role: 'assistant', content: '被作者隐藏的内容：老槐树路', at: 3, hidden: true },
      { id: 'm4', role: 'user', content: '最后一条正常消息', at: 4 },
    ] as unknown as TavernMessage[]

    const out = keywordHaystackMessages(msgs)
    ok('🔴 system 消息不进关键词取材', !out.some(t => t.includes('系统提示')), out.join(' | '))
    ok('🔴 作者隐藏的消息不进关键词取材', !out.some(t => t.includes('被作者隐藏')), out.join(' | '))
    ok('正常消息照常参与', out.includes('普通人说了一句') && out.includes('最后一条正常消息'))

    const many = keywordHaystackMessages([...msgs, ...msgs, ...msgs])
    ok('默认最多取最近 6 条', many.length === 6, String(many.length))
    ok('取的是**最近**的（老的被丢掉）', many[5] === '最后一条正常消息', JSON.stringify(many.slice(0, 2)))

    // 🔴 反面：同一个 haystack 喂给 shouldInjectWorld —— 只出现在**隐藏内容**里的关键词不该触发注入
    const hay = worldHaystack(['会话标题'], keywordHaystackMessages(msgs))
    const wHide = { ...EMPTY_WORLD_SETTING, brief: '背景', keywords: ['老槐树路'] } as WorldSetting
    ok('🔴 关键词只出现在被隐藏的内容里 ⇒ 不该注入背景设定', !shouldInjectWorld(wHide, hay), hay)

    // ✅ 对照：同样一条消息但**没被隐藏**时，就该正常注入（否则上面那条可能只是「haystack 恰好为空」）
    const shown = msgs.map(m => ({ ...m, hidden: false }))
    const hayShown = worldHaystack(['会话标题'], keywordHaystackMessages(shown))
    ok('对照：同一条消息不隐藏时 ⇒ 正常注入（证明上面不是「空了所以不注入」）',
      shouldInjectWorld(wHide, hayShown), hayShown)

    // 对照 2：关键词只在 system 里出现，同样不该注入
    const wSys = { ...EMPTY_WORLD_SETTING, brief: '背景', keywords: ['系统提示'] } as WorldSetting
    ok('🔴 关键词只出现在 system 里 ⇒ 也不该注入', !shouldInjectWorld(wSys, hay), hay)
  }

  console.log(`\ntavernWorld: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
