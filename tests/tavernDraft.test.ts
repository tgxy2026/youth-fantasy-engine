// ============ 酒馆模式 · 起草管线 + 联网检索 + 对话引导 ============
//
// 三块风险各写一组：
//  ① 检索结果的**提取**（不同接口形状差别很大，而"静默返回 0 条"会让作者以为模型在瞎编）；
//  ② 素材来源的**裁决**（界面要靠它告诉作者「本次用的是哪种模式」—— 判错就是说谎）；
//  ③ 访谈的**字段累积**（一轮一轮攒，攒丢了就等于白聊）。
import {
  harvestItems, webSearch, renderSearchResults, searchBlockedReason, BOCHA_ENDPOINT,
  type SearchSettings,
} from '../src/lib/webSearch'
import {
  prepareDraftMaterial, buildCardDraftSystem, buildCardDraftUser, parseCardDraft,
  mergeCardDraft, isEmptyCardDraft, draftCard, EMPTY_CARD_DRAFT, type CardDraft,
} from '../src/lib/tavern/draft'
import {
  CARD_TOPICS, SCRIPT_TOPICS, buildInterviewSystem, buildInterviewUser, parseInterviewReply,
  interviewProgress, emptyInterview, runInterviewTurn, interviewToCard, interviewToScript,
  filledToText, fieldKeysOf,
} from '../src/lib/tavern/interview'
import { saveProviders, saveActiveId } from '../src/lib/ai'
import type { ChatFn } from '../src/lib/tavern/engine'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const STUB_PROVIDER = { id: 'draft-stub', name: '桩模型', type: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }
const OFF: SearchSettings = { mode: 'off', engine: 'bocha', endpoint: '', apiKey: '', topK: 3 }
const API: SearchSettings = { mode: 'api', engine: 'bocha', endpoint: '', apiKey: 'sk-test', topK: 3 }

function makeFakeChat(reply: string): ChatFn {
  return (async () => reply) as unknown as ChatFn
}

async function main() {
  // ---------- 1) 检索结果提取：三种接口形状都要认 ----------
  {
    const bocha = {
      code: 200,
      data: {
        webPages: {
          value: [
            { name: '蒂法·洛克哈特 - 百科', url: 'https://example.com/tifa', snippet: '第七天堂的店主，格斗家。' },
            { name: '最终幻想 VII', url: 'https://example.com/ff7', summary: '1997 年的角色扮演游戏。' },
          ],
        },
      },
    }
    const b = harvestItems(bocha, 5)
    ok('认博查的 data.webPages.value 形状', b.length === 2 && b[0].title.includes('蒂法'), JSON.stringify(b[0] ?? {}))
    ok('同时认 name/snippet 与 title/summary 两套键名', b[1].snippet.includes('1997'))

    const zhipu = { search_result: [{ title: '梁山伯与祝英台', link: 'https://example.com/liangzhu', content: '民间四大爱情故事之一。' }] }
    const z = harvestItems(zhipu, 5)
    ok('认智谱的 search_result 形状', z.length === 1 && z[0].url.includes('liangzhu'))

    const odd = { result: { items: [{ heading: '奇怪的形状', website: 'https://x.test', description: '也能挖出来' }] } }
    ok('陌生形状也能靠通用遍历挖出来', harvestItems(odd, 5).length === 1)

    const dup = { a: [{ title: 'T', url: 'https://same', snippet: 'x' }, { title: 'T2', url: 'https://same', snippet: 'y' }] }
    ok('同一个网址去重', harvestItems(dup, 5).length === 1)

    const many = { a: Array.from({ length: 20 }, (_, i) => ({ title: 'T' + i, url: 'https://u' + i })) }
    ok('按 limit 截断', harvestItems(many, 3).length === 3)
    ok('垃圾输入不炸', harvestItems(null, 3).length === 0 && harvestItems({ a: 1 }, 3).length === 0)
  }

  // ---------- 2) 检索方式：能不能用要提前判出来 ----------
  {
    ok('off 档永远可用', searchBlockedReason(OFF) === null)
    ok('model 档不用配密钥', searchBlockedReason({ ...OFF, mode: 'model' }) === null)
    ok('🔴 api+博查 没填密钥 → 提前说明会退回', (searchBlockedReason({ ...API, apiKey: '' }) ?? '').includes('退回'))
    ok('api+自定义 没填地址 → 提前说明会退回', (searchBlockedReason({ ...API, engine: 'custom', endpoint: '' }) ?? '').includes('退回'))
    ok('api+博查 有密钥 → 可用', searchBlockedReason(API) === null)

    const r = renderSearchResults({ used: true, engine: 'bocha', query: '蒂法', results: [{ title: 'T', url: 'https://u', snippet: 's' }] })
    ok('渲染出检索词与编号', r.includes('蒂法') && r.includes('1. T'))
    ok('渲染出网址', r.includes('https://u'))
    ok('🔴 明确要求「当参考不当圣旨、没提到别编」', r.includes('不要编') || r.includes('不要把这些编号'))
    ok('没查到结果就渲染空串（不占额度）', renderSearchResults({ used: false, engine: 'bocha', query: 'x', results: [] }) === '')
  }

  // ---------- 3) webSearch：桩 fetch 走通博查形状 + 失败要如实回传 ----------
  {
    const realFetch = globalThis.fetch
    const settings = { ...API }
    try {
      const calls: { url: string; body: string; auth: string }[] = []
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        const h = (init.headers ?? {}) as Record<string, string>
        calls.push({ url: String(url), body: String(init.body), auth: h.Authorization ?? '' })
        return new Response(JSON.stringify({
          data: { webPages: { value: [{ name: '结果一', url: 'https://r1', snippet: '摘要一' }] } },
        }), { status: 200 })
      }) as unknown as typeof fetch

      const out = await webSearch('蒂法 最终幻想', settings)
      ok('发起时带上博查地址', calls[0].url === BOCHA_ENDPOINT, calls[0].url)
      ok('带上 Bearer 密钥', calls[0].auth === 'Bearer sk-test')
      ok('请求体带 query 与 count', calls[0].body.includes('蒂法') && calls[0].body.includes('"count"'))
      ok('拿到结果并标记 used', out.used && out.results.length === 1, JSON.stringify(out))

      // HTTP 错误 → 带 error 回来（不抛、不静默）
      globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'Invalid API KEY' }), { status: 401 })) as unknown as typeof fetch
      const bad = await webSearch('x', settings)
      ok('🔴 接口报错时回传原因（绝不静默）', !bad.used && (bad.error ?? '').includes('Invalid API KEY'), JSON.stringify(bad))

      // 网络异常 → 提示可能是跨域
      globalThis.fetch = (async () => { throw new Error('Failed to fetch') }) as unknown as typeof fetch
      const net = await webSearch('x', settings)
      ok('🔴 网络/跨域失败时给出可行动的提示', !net.used && (net.error ?? '').includes('跨域'), net.error ?? '')

      const off = await webSearch('x', OFF)
      ok('off 档直接拒绝（不该偷偷查）', !off.used && (off.error ?? '').includes('不是「搜索接口」'))
      const empty = await webSearch('   ', settings)
      ok('空检索词拒绝', !empty.used && (empty.error ?? '').includes('太空'))
    } finally {
      globalThis.fetch = realFetch
    }
  }

  // ---------- 4) prepareDraftMaterial：三种模式的裁决 ----------
  {
    const off = await prepareDraftMaterial({ idea: '一个旧书店老板', refs: '他有一只瘸腿的猫', settings: OFF })
    ok('off 档：标注未联网', off.source.mode === 'off' && off.source.used === false, JSON.stringify(off.source))
    ok('off 档：把粘贴素材包进边界块', off.blocks.includes('作者粘贴的参考素材') && /<<<A-[a-z0-9]+>>>/.test(off.blocks))

    const model = await prepareDraftMaterial({ idea: '按 FF7 的蒂法做一张卡', settings: { ...OFF, mode: 'model' } })
    ok('model 档：如实标注「是否真联网取决于模型」', model.source.mode === 'model' && (model.source.note ?? '').includes('取决于'), JSON.stringify(model.source))

    const okSearch = async () => ({
      used: true, engine: 'bocha' as const, query: '蒂法',
      results: [{ title: '蒂法', url: 'https://t', snippet: '格斗家' }],
    })
    const api = await prepareDraftMaterial({ idea: '按 FF7 的蒂法做一张卡', settings: API, searchFn: okSearch as never })
    ok('api 档：检索结果进了素材块', api.blocks.includes('联网检索结果') && api.blocks.includes('格斗家'))
    ok('api 档：source 标 used 并给出检索词', api.source.used && (api.source.note ?? '').includes('蒂法'), JSON.stringify(api.source))

    const failSearch = async () => ({ used: false, engine: 'bocha' as const, query: 'x', results: [], error: '检索失败：Failed to fetch' })
    const apiFail = await prepareDraftMaterial({ idea: 'x', refs: '我自己的备忘', settings: API, searchFn: failSearch as never })
    ok('🔴 检索失败不中断起草：仍带粘贴素材', apiFail.blocks.includes('我自己的备忘'))
    ok('🔴 但把失败原因带回去（界面要如实告诉作者）', !apiFail.source.used && (apiFail.source.error ?? '').includes('检索失败'))

    const withExisting = await prepareDraftMaterial({
      idea: '', existing: '【内核】外冷内热', settings: OFF,
    })
    ok('补完模式：现有内容进素材块并声明「不是从零开始」', withExisting.blocks.includes('现有内容') && withExisting.blocks.includes('外冷内热'))
    ok('补完模式：明确要求保留已写好的部分', withExisting.blocks.includes('照原样保留'))
  }

  // ---------- 5) 角色卡起草：模板 / 解析 / 合并 ----------
  {
    const sys = buildCardDraftSystem()
    ok('系统提示含四章模板', sys.includes('第 1 章') && sys.includes('第 2 章') && sys.includes('第 4 章'))
    ok('🔴 示例对话必须遵守输出规范（模型会照它模仿）', sys.includes('不带说话人名字') && sys.includes('「Ta」'))
    ok('要求 JSON 输出且键名固定', sys.includes('"name"') && sys.includes('"examples"'))
    ok('写明拿不准就写「待作者补充」', sys.includes('待作者补充'))
    ok('点名已有作品时不要编造情节', sys.includes('编造'))

    const user = buildCardDraftUser({ idea: '按 FF7 的蒂法做一张卡', material: '〖联网检索结果〗…' })
    ok('用户消息包住作者想法并带上素材', user.includes('<<<A-') && user.includes('联网检索结果'))

    const parsed = parseCardDraft(JSON.stringify({
      name: '蒂法', world: '米德加', core: '外柔内刚', examples: '（她把杯子推过来）喝点热的。',
    }))
    ok('解析出十三栏（缺的留空）', !!parsed && parsed.name === '蒂法' && parsed.core === '外柔内刚')
    ok('缺的栏是空串而不是 undefined', !!parsed && parsed.speech === '')
    ok('🔴 十三栏全空 → null（不猜）', parseCardDraft('{}') === null && parseCardDraft('我觉得这个人应该……') === null)
    ok('带围栏也能解', !!parseCardDraft('```json\n{"name":"x"}\n```'))

    const merged = mergeCardDraft(
      { ...EMPTY_CARD_DRAFT, name: '我自己起的', core: '我写的内核' },
      { ...EMPTY_CARD_DRAFT, name: '', core: 'AI 的内核', speech: '话少' } as CardDraft,
    )
    ok('🔴 AI 空着的栏不覆盖作者写的', merged.name === '我自己起的')
    ok('AI 写了的栏覆盖', merged.core === 'AI 的内核' && merged.speech === '话少')
    ok('isEmptyCardDraft 认空/认有', isEmptyCardDraft(EMPTY_CARD_DRAFT) && !isEmptyCardDraft({ ...EMPTY_CARD_DRAFT, name: 'x' }))
  }

  // ---------- 6) draftCard：桩模型走通 + 边界 ----------
  {
    __resetMockStores()
    await saveProviders([{ ...STUB_PROVIDER }])
    await saveActiveId(STUB_PROVIDER.id)

    const good = await draftCard({
      idea: '按 FF7 的蒂法做一张卡',
      settings: OFF,
      chatFn: makeFakeChat(JSON.stringify({ name: '蒂法', core: '外柔内刚' })),
    })
    ok('起草走通并解出字段', good.fields.name === '蒂法' && good.fields.core === '外柔内刚')
    ok('来源如实标注为「模型已有知识 + 粘贴素材」', good.source.label.includes('模型已有知识'), good.source.label)

    let threw = false
    try { await draftCard({ idea: '   ', settings: OFF, chatFn: makeFakeChat('{}') }) } catch { threw = true }
    ok('想法与素材都空 → 抛错（不浪费一次调用）', threw)

    threw = false
    try { await draftCard({ idea: 'x', settings: OFF, chatFn: makeFakeChat('我不会写。') }) } catch { threw = true }
    ok('模型乱答 → 抛错', threw)
  }

  // ---------- 7) 访谈：提纲推进与字段累积 ----------
  {
    ok('角色卡提纲覆盖十三栏中的大部分', CARD_TOPICS.flatMap(t => t.fields).length >= 13 - 1)
    ok('剧本提纲覆盖六栏', SCRIPT_TOPICS.flatMap(t => t.fields).length === 6)
    ok('剧本提纲的栏名都是真栏名', SCRIPT_TOPICS.flatMap(t => t.fields).every(f => fieldKeysOf('script').includes(f)))

    const sys = buildInterviewSystem('card')
    ok('🔴 system 写明「一次只问 1–3 个相关问题」', sys.includes('1–3'))
    ok('🔴 system 要求按提纲推进、接住上一句', sys.includes('顺着') || sys.includes('先接住'))
    ok('system 给出累积字段的输出契约', sys.includes('"filled"') && sys.includes('"question"') && sys.includes('"done"'))
    ok('剧本 system 用剧本提纲（不出现角色卡的栏）', !buildInterviewSystem('script').includes('paceLock'))

    const st = emptyInterview('card')
    ok('初始进度为 0', interviewProgress(st).got === 0 && interviewProgress(st).total === 13)
    const user0 = buildInterviewUser(st)
    ok('第一轮提示「还没开始，从最开头的话题问起」', user0.includes('还没开始'))
    const user1 = buildInterviewUser({ ...st, filled: { name: '蒂法' }, turns: [{ role: 'user', text: '她叫蒂法' }] })
    ok('已收集的字段会摊给模型', user1.includes('name：蒂法'))
    ok('提纲进度标出还缺哪些栏', user1.includes('还缺') || user1.includes('已有信息'))

    const rep = parseInterviewReply(JSON.stringify({
      filled: { name: '蒂法', core: '外柔内刚', 不存在的栏: 'x' },
      question: '她平时怎么说话？', done: false,
    }), { world: '米德加' })
    ok('解析出本轮累积字段', !!rep && rep.filled.name === '蒂法' && rep.filled.world === '米德加')
    ok('🔴 白名单外的键被丢掉（模型会自己发明栏名）', !!rep && !('不存在的栏' in rep.filled))
    ok('解析出提问与 done', !!rep && rep.question.includes('怎么说话') && rep.done === false)
    ok('done=true 也认', parseInterviewReply('{"filled":{},"question":"可以了","done":true}')?.done === true)
    ok('既没 question 也没 done → null（不猜）', parseInterviewReply('{"filled":{}}') === null)
    ok('非 JSON → null', parseInterviewReply('我们接着聊？') === null)

    // 一轮真实调用（桩模型）：开场 → 提问 → 作者回答 → 字段累积
    __resetMockStores()
    await saveProviders([{ ...STUB_PROVIDER }])
    await saveActiveId(STUB_PROVIDER.id)
    const r1 = await runInterviewTurn(emptyInterview('card'), null, {
      chatFn: makeFakeChat(JSON.stringify({ filled: {}, question: 'Ta 叫什么名字？', done: false })),
    })
    ok('开场：AI 主动问了第一个问题', r1.state.turns.length === 1 && r1.state.turns[0].role === 'ai')
    ok('开场没有作者发言', !r1.state.turns.some(t => t.role === 'user'))

    const r2 = await runInterviewTurn(r1.state, '她叫蒂法，第七天堂的老板', {
      chatFn: makeFakeChat(JSON.stringify({ filled: { name: '蒂法', core: '外柔内刚' }, question: '她怎么说话？', done: false })),
    })
    ok('第二轮：作者的发言进了历史', r2.state.turns.some(t => t.role === 'user' && t.text.includes('第七天堂')))
    ok('🔴 字段被累积下来（不是每轮重算）', r2.state.filled.name === '蒂法' && r2.state.filled.core === '外柔内刚')
    ok('进度跟着涨', interviewProgress(r2.state).got === 2)
    ok('收尾后 done 为真', (await runInterviewTurn(r2.state, '随便你', {
      chatFn: makeFakeChat(JSON.stringify({ filled: { speech: '话少' }, question: '信息够了，可以生成草稿了。', done: true })),
    })).state.done === true)

    let threw = false
    try {
      await runInterviewTurn(emptyInterview('card'), null, { chatFn: makeFakeChat('我不想按格式来') })
    } catch { threw = true }
    ok('引导模型不按格式 → 抛错（界面提示重试）', threw)

    // 汇总
    const card = interviewToCard({ name: '蒂法', core: '外柔内刚', 脏数据: 'x' })
    ok('汇总成角色卡草稿（只取白名单栏）', card.name === '蒂法' && card.core === '外柔内刚' && !('脏数据' in card))
    ok('缺的栏留空', card.examples === '')
    const script = interviewToScript({ situation: '雨夜便利店', goal: '让她开口' })
    ok('汇总成剧本草稿', script.situation === '雨夜便利店' && script.goal === '让她开口' && script.taboo === '')
    ok('摊平文本用中文栏名', filledToText({ name: '蒂法' }, 'card').includes('名字') && filledToText({ situation: 'x' }, 'script').includes('情境'))
  }

  console.log('')
  console.log(`共 ${pass + fail} 条：PASS ${pass} · FAIL ${fail}`)
  if (fail > 0) process.exit(1)
}

void main()
