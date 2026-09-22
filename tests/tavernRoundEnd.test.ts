// ============ 酒馆模式 · 「结束本轮对话」收尾编排（老大 2026-09-16 定）============
//
// 这组断言盯的是本次改造的四条硬要求：
//   ① **本场小结与记忆必须分家** —— 六栏记忆每轮进上下文，小结只给作者看；
//      混进记忆就是白烧额度（这是 splitJournalSection 存在的唯一理由）
//   ② **水位线之后才算待整理** —— 收尾过一次再点一次，不能把同一段对话重复吸收
//   ③ **日记是角色级的、带在场名单与会话标题** —— 删了会话也还能溯源
//   ④ **记忆整理失败 = 整场收尾失败**（唯一硬失败点）；数值与设定审查失败一律吞掉，
//      面板少一块也行，绝不能把已经落库的记忆弄丢
//   ⑤ **用户扮演的角色只记记忆、不写日记**（2026-09-16 反馈 #8）——
//      AI 写不好「别人扮演的角色」的第一人称回顾，硬写只会得到视角错乱的文字；
//      改成走 `summarizeMemory`：记忆照记，日记不生成也不落库（顺带省掉一次白生成）
import * as store from '../src/lib/tavern/store'
import { __resetMockStores, __failReads } from './mock-memory'
import { saveProviders, saveActiveId, type ChatMessage } from '../src/lib/ai'
import { runRoundEnd, pendingMessages } from '../src/lib/tavern/roundEnd'
import { JOURNAL_HEAD } from '../src/lib/tavern/summarize'
import { memoryToText } from '../src/lib/tavern/memory'
import { proposeCardRevisions } from '../src/lib/tavern/revise'
import type { ChatFn } from '../src/lib/tavern/provider'
import { JOURNAL_KEEP, type FreeCharacter, type FreeSession, type TavernMessage } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const STUB_PROVIDER = { id: 're-stub', name: '桩模型', type: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }

function makeFakeChat(reply: string, reviseReply = '{"changes":[]}') {
  const calls: { messages: ChatMessage[]; opts: Record<string, unknown> }[] = []
  const chatFn: ChatFn = async (_cfg, messages, opts) => {
    calls.push({ messages, opts: (opts ?? {}) as Record<string, unknown> })
    // 🔴 设定审查（revise）期望的是 JSON（`{"changes":[…]}`），与记忆整理的「六栏文本」**不同形**。
    //    原先一律回六栏文本 ⇒ 审查侧永远解析不出 changes ⇒ 返回空数组、**静默无建议**；
    //    而本组断言只数调用次数，所以这个"模型回了不该回的东西"一直没暴露。
    //    （2026-09-20 修「解析失败 vs 真的没有变更」不可区分时才现形 —— 修完这里立刻红了。）
    const sys = String(messages.find(m => m.role === 'system')?.content ?? '')
    return sys.includes('审查员') ? reviseReply : reply
  }
  return { chatFn, calls }
}

/** 造一段「六栏 + 本场小结」的模型回复，格式与真实提示词要求一致 */
function replyWith(summary: string, journal: string): string {
  return [
    '〖一、长期摘要〗', summary,
    '〖二、关键事实〗', '· 她收了那把伞。',
    '〖三、关系状态〗', '· 与用户：熟客，话变多了。',
    '〖四、未爆的雷〗', '暂无',
    '〖五、纪念日与待办〗', '暂无',
    '〖六、最近日记〗', '- 09-16：留了碗面。',
    JOURNAL_HEAD, journal,
  ].join('\n')
}

async function mkChar(name: string): Promise<FreeCharacter> {
  return store.createFreeChar({
    ...store.emptyFreeCharacter(),
    name,
    world: '现代都市 · 老城区一间凌晨还亮着灯的便利店',
    profile: {
      externals: '短发，围裙', core: '外冷内热', speech: '句子短',
      relations: '独居', cannot: '说不出关心的话', knowledge: '不知道顾客的职业',
    },
    conduct: { perspective: '第一人称', bottomLine: '不越界打听私事', paceLock: '关系推进要慢', rating: '日常向' },
    examples: '对方：还不下班？\n她没抬头：\n「灯还亮着。」',
  })
}

/** 往会话里塞几条消息并落库 */
async function push(s: FreeSession, list: { role: 'user' | 'assistant'; speakerId?: string; content: string }[]): Promise<FreeSession> {
  const base = s.messages.length
  const msgs: TavernMessage[] = list.map((m, i) => ({ id: `m-${base + i}`, role: m.role, speakerId: m.speakerId, content: m.content, at: 1000 + base + i }))
  return store.saveFreeSession({ ...s, messages: [...s.messages, ...msgs], updatedAt: Date.now() })
}

async function main() {
  __resetMockStores()
  await saveProviders([{ ...STUB_PROVIDER }])
  await saveActiveId(STUB_PROVIDER.id)

  const A = await mkChar('苏念')
  const B = await mkChar('楚楠')

  // ---------- 1) 待整理 = 水位线之后 ----------
  {
    let s = await store.createFreeSession([A.id], '与苏念的雨夜', { providerId: STUB_PROVIDER.id }, {})
    s = await push(s, [
      { role: 'user', content: '还不下班？' },
      { role: 'assistant', speakerId: A.id, content: '「灯还亮着。」' },
      { role: 'user', content: '那我陪你。' },
    ])
    ok('无水位线时全部计入待整理', pendingMessages(s).length === 3)

    // 手工把水位线推到第 2 条：只剩最后 1 条待整理
    const only = await store.saveFreeSession({
      ...s,
      watermark: { messageId: s.messages[1].id, at: 2000 } as FreeSession['watermark'],
    })
    ok('水位线之后的才计入', pendingMessages(only).length === 1 && pendingMessages(only)[0].content === '那我陪你。')

    const atEnd = await store.saveFreeSession({
      ...only,
      watermark: { messageId: s.messages[2].id, at: 3000 } as FreeSession['watermark'],
    })
    ok('已收到末尾 → 待整理为空（重复点收尾不会重算同一段）', pendingMessages(atEnd).length === 0)
  }

  // ---------- 2) 一次收尾：记忆 + 日记 ----------
  {
    let s = await store.createFreeSession([A.id, B.id], '便利店三人夜', { providerId: STUB_PROVIDER.id }, {})
    s = await push(s, [
      { role: 'user', content: '你们俩怎么都在？' },
      { role: 'assistant', speakerId: A.id, content: '「他躲雨。」' },
      { role: 'assistant', speakerId: B.id, content: '「我只是路过。」' },
    ])
    const cards = [A, B]
    const { chatFn, calls } = makeFakeChat(replyWith('她把伞收进柜台底下。', '她嘴上说只是顺便，其实把最后那碗面留给了他。'))

    const res = await runRoundEnd({
      session: s, cards, providerId: STUB_PROVIDER.id,
      varKeys: [], vars: undefined, maxStep: 5,
      nameOf: (id?: string) => cards.find(c => c.id === id)?.name ?? '角色',
      chatFn,
    })

    // 2 位角色的记忆整理 + 2 位角色的设定审查 = 4 次（本组没开数值，所以没有第 5 次）
    ok('每位角色各整理一次（2 次记忆 + 2 次设定审查）', calls.length === 4)
    const sysOf = (i: number) => String(calls[i].messages.find(m => m.role === 'system')?.content ?? '')
    ok('两次记忆调用带着各自的角色名（不是拿同一个人算两遍）',
      sysOf(0).includes('苏念') && sysOf(1).includes('楚楠'))
    ok('记忆调用要求追加本场日记（收尾专用提示词，不是旧的纯六栏版）',
      sysOf(0).includes(JOURNAL_HEAD) && sysOf(1).includes(JOURNAL_HEAD))

    // 🔴 日记的形态是**产品要求**（老大 2026-09-16 定），不是文风偏好 —— 用断言钉住，
    //    免得哪天有人「顺手精简提示词」把这几条删掉，日记就悄悄变回第三人称摘要。
    {
      const sys = sysOf(0)
      ok('🔴 日记要求第一人称（Ta 自己写的）', sys.includes('第一人称') && sys.includes('自己写的'))
      ok('🔴 日记要写「经过」', sys.includes('经过了什么'))
      ok('🔴 日记要写「主观感受」', sys.includes('我是什么感受'))
      ok('🔴 明确「不再喂回 AI」（不进记忆、不进任何提示词）',
        sys.includes('不进六栏记忆') && sys.includes('不进任何提示词'))
      ok('🔴 日记标题不带序号（带「七、」会被模型当成第七栏记忆）',
        !JOURNAL_HEAD.includes('七') && JOURNAL_HEAD.includes('日记'))
      ok('日记与第六栏「最近日记」明确区分（后者要一行一事）',
        sys.includes('不要') && sys.includes('最近日记'))
      // 反馈 #8：旧提示词没写分段要求，模型就一句一段地吐（像分行写的诗）
      ok('🔴 日记要求按内容层次分段（不要一句一段）',
        sys.includes('按内容层次分段') && sys.includes('不要一句一段'))
    }
    ok('返回了两位角色的记忆', res.memories.length === 2 && res.memories.every(m => m.charId))
    ok('记忆吸收了本场内容', res.memories[0].longTerm.includes('伞收进柜台底下'))
    ok('记忆里不含本场小结（否则每轮白烧额度）', !memoryToText(res.memories[0]).includes('其实把最后那碗面留给了他'))
    ok('两位都产出了本场日记', Object.keys(res.journals).length === 2)

    const memA = await store.getMemory(A.id)
    ok('记忆已落库', !!memA && memA.longTerm.includes('伞收进柜台底下'))

    const jA = await store.getJournal(A.id)
    ok('日记追加了一条', jA.entries.length === 1)
    ok('日记正文 = 模型给的那段回顾', jA.entries[0].text === '她嘴上说只是顺便，其实把最后那碗面留给了他。')
    ok('日记带会话标题（便于溯源）', jA.entries[0].sessionTitle === '便利店三人夜')
    ok('日记带在场名单（含用户）', jA.entries[0].cast.includes('苏念') && jA.entries[0].cast.includes('楚楠'))
    ok('日记带会话 id', jA.entries[0].sessionId === s.id)
    ok('没有启用数值时不产变更', res.varChanges.length === 0 && res.vars === undefined)

    // 水位线推进是**调用方**的责任（组件里做），这里确认收尾本身没偷偷改会话
    const back = await store.getFreeSession(s.id)
    ok('收尾不自行推进水位线（由界面统一处理）', back?.watermark === s.watermark)
    ok('收尾不自行打归档戳（由界面统一处理）', back?.endedAt === undefined)
  }

  // ---------- 3) 日记滚动上限与删除 ----------
  {
    for (let i = 0; i < JOURNAL_KEEP + 3; i++) {
      await store.appendJournalEntry(A.id, {
        id: `jr-x-${i}`, at: i, sessionId: `s-x-${i}`, sessionTitle: `第${i}场`, cast: ['苏念'], text: `第 ${i} 条`,
      })
    }
    const j = await store.getJournal(A.id)
    ok(`日记滚动到上限 ${JOURNAL_KEEP} 条`, j.entries.length === JOURNAL_KEEP)
    ok('新的在最前（倒序）', j.entries[0].text === `第 ${JOURNAL_KEEP + 2} 条`)
    ok('最老的被丢掉', !j.entries.some(e => e.text === '第 0 条'))

    const dropped = await store.dropJournalEntry(A.id, j.entries[0].id)
    ok('删单条生效', dropped.entries.length === JOURNAL_KEEP - 1 && !dropped.entries.some(e => e.id === j.entries[0].id))

    // 🔴 同一场对话重复写日记 → 只留一条（审计 P0-5：收尾失败后作者重跑不能写第二遍）
    await store.appendJournalEntry(A.id, {
      id: 'jr-dup-old', at: 1, sessionId: 's-dup', sessionTitle: '重跑场', cast: [], text: '旧版',
    })
    const after = await store.appendJournalEntry(A.id, {
      id: 'jr-dup-new', at: 2, sessionId: 's-dup', sessionTitle: '重跑场', cast: [], text: '新版',
    })
    const dup = (await store.getJournal(A.id)).entries.filter(e => e.sessionId === 's-dup')
    ok('同一场只留一条（收尾重跑不产生重复日记）', dup.length === 1 && after.entries[0].text === '新版')

    await store.clearJournal(A.id)
    ok('清空日记生效', (await store.getJournal(A.id)).entries.length === 0)
  }

  // ---------- 4) 硬失败点：记忆整理不出来，整场收尾就该失败 ----------
  {
    let s = await store.createFreeSession([A.id], '会失败的一场', { providerId: STUB_PROVIDER.id }, {})
    s = await push(s, [{ role: 'user', content: '在吗' }])
    let threw = false
    try {
      await runRoundEnd({
        session: s, cards: [A], providerId: STUB_PROVIDER.id,
        varKeys: [], vars: undefined, maxStep: 5,
        nameOf: () => '角色',
        chatFn: async () => { throw new Error('模型挂了') },
      })
    } catch { threw = true }
    ok('记忆整理失败 → 收尾整体抛出（界面据此报错，且不归档）', threw)

    const untouched = await store.getJournal(A.id)
    ok('失败时不会留下半截日记', untouched.entries.length === 0)
  }

  // ---------- 5) 软失败点：设定审查挂了也要把记忆与日记交出去 ----------
  {
    let s = await store.createFreeSession([B.id], '审查会挂的一场', { providerId: STUB_PROVIDER.id }, {})
    s = await push(s, [{ role: 'user', content: '在吗' }])
    // 第 1 次调用（记忆）正常，第 2 次（设定审查）抛错
    let n = 0
    const chatFn: ChatFn = async () => {
      n++
      if (n === 1) return replyWith('她记住了这一晚。', '她记住了这一晚。')
      throw new Error('审查挂了')
    }
    const res = await runRoundEnd({
      session: s, cards: [B], providerId: STUB_PROVIDER.id,
      varKeys: [], vars: undefined, maxStep: 5,
      nameOf: () => '角色', chatFn,
    })
    ok('审查失败不拖累记忆', res.memories.length === 1)
    ok('审查失败时建议为空', res.proposals.length === 0)
    ok('审查失败仍写出日记', !!res.journals[B.id])
  }

  // ---------- 6) 用户扮演的角色：记忆照记，日记不写（老大 2026-09-16 反馈 #8）----------
  //
  // AI 写不好「别人扮演的角色」的第一人称回顾（它不知道那个人当时心里怎么想），
  // 所以收尾时那一位走**只出六栏**的通路：记忆照记，日记不生成、也不落库。
  {
    const U = await mkChar('阿岩')
    let s = await store.createFreeSession(
      [A.id, U.id], '用户也在场的一场', { providerId: STUB_PROVIDER.id }, {}, U.id,
    )
    s = await push(s, [
      { role: 'user', content: '我先说。' },
      { role: 'assistant', speakerId: A.id, content: '「你说。」' },
    ])
    const cards = [A, U]
    const { chatFn, calls } = makeFakeChat(replyWith('她记住了这段。', '她把这句话记在了心里。'))

    const res = await runRoundEnd({
      session: s, cards, providerId: STUB_PROVIDER.id,
      varKeys: [], vars: undefined, maxStep: 5,
      nameOf: (id?: string) => cards.find(c => c.id === id)?.name ?? '角色',
      chatFn,
    })

    ok('用户扮演的角色**记忆照记**', res.memories.some(m => m.charId === U.id))
    ok('🔴 用户扮演的角色**不产日记**，AI 那位照旧产',
      !res.journals[U.id] && !!res.journals[A.id])
    ok('用户扮演的角色日记库为空（根本没落库）', (await store.getJournal(U.id)).entries.length === 0)

    // calls[1] = 第二位角色（阿岩）的记忆调用 —— 他走的是「只出六栏」版提示词，
    // 里面不该有日记段落：那 200–600 字本地 27B 要白跑一分多钟。
    const sysU = String(calls[1].messages.find(m => m.role === 'system')?.content ?? '')
    ok('先确认第 2 次调用确实是阿岩（不是拿苏念算两遍）', sysU.includes('阿岩'))
    ok('用户角色的整理提示词不含日记段落（走 summarizeMemory，不白生成）',
      !sysU.includes(JOURNAL_HEAD))
    ok('AI 角色的整理提示词仍含日记段落', String(calls[0].messages.find(m => m.role === 'system')?.content ?? '').includes(JOURNAL_HEAD))
  }

  // ---------- 6.5) 读记忆失败的那位不能连累别人（2026-09-22 六维审计 P0）----------
  //
  // 🔴 原先 `computed` 只 push 成功项，而落库循环按 `cards[i]` 取 `computed[i]` ——
  //    读记忆失败会 `continue`（不占位），于是**数组比 cards 短、下标整体前移**：
  //    中间那位失败 ⇒ 后面那位的记忆被写进前一位的档案（不可逆），末位还越界抛 TypeError。
  //    下面用「3 位角色、只让中间那位读失败」精确锁住这个错位：
  //    末尾那位的内容必须落在末尾那位身上，且第 1 位的记忆不能被第 3 位覆盖。
  {
    const M1 = await mkChar('田青')
    const M2 = await mkChar('陆迟')
    const M3 = await mkChar('白露')
    let s = await store.createFreeSession([M1.id, M2.id, M3.id], '三人错位局', { providerId: STUB_PROVIDER.id }, {})
    s = await push(s, [
      { role: 'user', content: '都到齐了？' },
      { role: 'assistant', speakerId: M1.id, content: '「到了。」' },
      { role: 'assistant', speakerId: M2.id, content: '「嗯。」' },
      { role: 'assistant', speakerId: M3.id, content: '「刚到。」' },
    ])

    // 打桩：只让 M2 的记忆读取抛错（其余照常）。
    // 🔴 不能 `store.getMemory = …` —— ESM 命名空间对象只有 getter，赋值会 `TypeError`；
    //    从最底层 StoreOps 注入，上面的每一层都会如实把异常抛上来（2026-09-22 实测）。
    __failReads((s, key) => s === 'meta' && key === `tavern.free.mem.${M2.id}`)

    // 模型按被问的角色名回不同内容 —— 这样才能分辨"谁的记忆进了谁的档案"
    const { chatFn } = (() => {
      const chatFn: ChatFn = async (_cfg, messages) => {
        const sys = String(messages.find(m => m.role === 'system')?.content ?? '')
        if (sys.includes('审查员')) return '{"changes":[]}'
        if (sys.includes('田青')) return replyWith('田青记住了这一晚。', '田青的日记。')
        if (sys.includes('白露')) return replyWith('白露记住了这一晚。', '白露的日记。')
        return replyWith('不该有人拿到这段。', '不该有人拿到这段。')
      }
      return { chatFn }
    })()

    let res: Awaited<ReturnType<typeof runRoundEnd>> | undefined
    let threw = ''
    try {
      res = await runRoundEnd({
        session: s, cards: [M1, M2, M3], providerId: STUB_PROVIDER.id,
        varKeys: [], vars: undefined, maxStep: 5,
        nameOf: (id?: string) => [M1, M2, M3].find(c => c.id === id)?.name ?? '角色',
        chatFn,
      })
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    } finally {
      __failReads(null)
    }

    ok('读记忆失败不抛错（跳过那一位即可）', threw === '', threw || '(抛错了)')
    ok('失败那一位被如实上报', (res?.warnings ?? []).some(w => w.includes('陆迟')))
    ok('只有 2 位成功（失败的陆迟不在结果里）',
      (res?.memories.length ?? -1) === 2 && !res?.memories.some(m => m.charId === M2.id))

    // 🔴 核心断言：内容与角色必须一一对应（错位的话这两条必红）
    const m1 = res?.memories.find(m => m.charId === M1.id)
    const m3 = res?.memories.find(m => m.charId === M3.id)
    ok('🔴 第 1 位的记忆是自己的（没被后面那位冲掉）',
      !!m1 && m1.longTerm.includes('田青') && !m1.longTerm.includes('白露'))
    ok('🔴 第 3 位的记忆是自己的（没被写到第 2 位名下）',
      !!m3 && m3.longTerm.includes('白露'))

    // 落库侧同样一一对应
    const dbM1 = await store.getMemory(M1.id)
    const dbM3 = await store.getMemory(M3.id)
    ok('🔴 落库后第 1 位档案里是自己的内容',
      dbM1.longTerm.includes('田青') && !dbM1.longTerm.includes('白露'))
    ok('🔴 落库后第 3 位档案里是自己的内容（未错位到别人的 key）',
      dbM3.longTerm.includes('白露'))
    ok('失败那一位的日记没被写（也没被别人的日记顶上）',
      (await store.getJournal(M2.id)).entries.length === 0)
    ok('另外两位的日记各归各位',
      (await store.getJournal(M1.id)).entries.length === 1 &&
      (await store.getJournal(M3.id)).entries.length === 1)
  }

  // ---------- 设定审查：解析失败必须与「真的没有变更」区分开（2026-09-20 六维审计 P2） ----------
  //
  // 两者原先都表现为"返回空数组" ⇒ 界面统一说「这段对话没有需要改的设定」，
  // 而其中一种是**模型输出压根没解析出来**（被截断 / 格式不符）。作者据此以为"查过了、没事"，
  // 实际是漏检。下面用**正反对照**钉住：非 JSON 要抛错，真空才静默。
  {
    const C = await mkChar('苏念')
    const rvMsgs: TavernMessage[] = [
      { id: 'rv-1', role: 'user', content: '我今天升职了。', at: 1 },
      { id: 'rv-2', role: 'assistant', speakerId: C.id, content: '「哦。」她把伞骨一根根捋直。', at: 2 },
    ]
    const run = async (reply: string) => {
      // ⚠️ 第二个参数才是「审查」那一路的回复（makeFakeChat 按 system 分流：审查要 JSON、记忆要六栏文本）
      const { chatFn } = makeFakeChat('（记忆用的六栏文本，本用例不关心）', reply)
      return proposeCardRevisions({ char: C, messages: rvMsgs, chatFn })
    }

    let threw = ''
    try {
      await run('好的，我看看……（这里本该是 JSON，但模型这回吐了散文）')
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    ok('🔴 模型输出不是 JSON ⇒ **抛错**（原先静默返回 []：「没检出来」被说成「没有要改的」）',
      /未能解析成变更列表/.test(threw), threw || '(没抛错)')

    let empty: unknown = 'not-run'
    try {
      empty = await run('{"changes":[]}')
    } catch (e) {
      empty = 'threw: ' + (e instanceof Error ? e.message : String(e))
    }
    ok('反例：模型明确回「没有变更」⇒ 正常返回空数组（不能把这条也当成解析失败）',
      Array.isArray(empty) && empty.length === 0, JSON.stringify(empty))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
