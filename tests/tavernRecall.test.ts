// ============ 酒馆 · 自由对话语义召回（T2，2026-10-05）============
//
// 这一层要证明三件事：
//   ① **查询与索引的取材口径**：只取会进上下文的消息（滤 system / hidden）——
//      作者特意藏起来的段落既不该被嵌入、也不该影响查询（否则「隐藏」等于失效）；
//   ② **分区是固定哨兵**：自由对话是全局数据，不能挂在某本书的 projectId 下；
//   ③ **守卫与节流**：开关关 / 消息太少 / 新增不够 都不该发嵌入请求（省钱），
//      但**消息变少（回滚）必须重建**（否则召回已回退的内容，比不召回更糟）。
//
// 🔴 全程注入 deps，一次真实嵌入请求都不发。
import {
  TAVERN_VEC_PROJECT, INDEX_MIN_MESSAGES, INDEX_MIN_NEW,
  freeSessionIndexText, freeRecallQuery, autoIndexFreeSession, buildFreeRecallBlock,
  __resetTavernIndexMemo,
} from '../src/lib/tavern/recall'
import type { FreeSession, TavernMessage } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const mkMsg = (n: number, role: TavernMessage['role'], content: string, hidden = false): TavernMessage =>
  ({ id: `m${n}`, role, content, at: n, ...(hidden ? { hidden: true } : {}) })

const mkSession = (messages: TavernMessage[], title = '探针场'): FreeSession => ({
  id: 'fs-recall-probe', charIds: ['c1'], title, messages,
  model: { providerId: '' }, params: {}, lastActiveAt: 0, createdAt: 0, updatedAt: 0,
})

const CFG = { model: 'probe-embed' } as never

/** 造一份「够长、内容各异」的会话（默认够过 INDEX_MIN_MESSAGES） */
const longSession = () => mkSession(
  Array.from({ length: INDEX_MIN_MESSAGES + 2 }, (_, i) =>
    mkMsg(i + 1, i % 2 === 0 ? 'user' : 'assistant', `第 ${i + 1} 句：这是一句足够长的探针内容，用来过短消息过滤。`)),
)

async function main() {
  // ---------- 1) 索引文本：只取会进上下文的消息 ----------
  {
    const s = mkSession([
      mkMsg(1, 'user', '正常的一句用户发言'),
      mkMsg(2, 'system', '系统提示不该进索引'),
      mkMsg(3, 'assistant', '正常的一句角色回复'),
      mkMsg(4, 'user', '这句被作者藏起来了不该进索引', true),
      mkMsg(5, 'user', '短'), // ≤3 字，滤掉（没有语义价值）
    ])
    const text = freeSessionIndexText(s)
    ok('🔴 system 消息不进索引', !text.includes('系统提示不该进索引'))
    ok('🔴 作者隐藏的消息不进索引（否则「隐藏」等于失效）', !text.includes('这句被作者藏起来了'))
    ok('太短的消息不进索引（没有语义价值）', !text.includes('短'))
    ok('用户 / 角色都进索引、且带归属前缀',
      text.includes('用户：正常的一句用户发言') && text.includes('角色：正常的一句角色回复'), text)
  }

  // ---------- 2) 查询文本：最近几条、同样滤 system/hidden ----------
  {
    const s = mkSession([
      mkMsg(1, 'user', '很早的一句'),
      mkMsg(2, 'user', '最近的第一句'),
      mkMsg(3, 'assistant', '最近的第二句'),
      mkMsg(4, 'user', '最后一句被藏了', true),
    ])
    const q = freeRecallQuery(s.messages, 2)
    ok('查询取最近 N 条', q.includes('最近的第一句') && q.includes('最近的第二句'), q)
    ok('🔴 查询不取被隐藏的那条', !q.includes('最后一句被藏了'))
    ok('空会话拿不出查询（返回空串，调用方据此跳过）', freeRecallQuery([]) === '')
    ok('只要 system 时也拿不出查询', freeRecallQuery([mkMsg(1, 'system', 'x')]) === '')
  }

  // ---------- 3) 分区是固定哨兵（不是项目 id） ----------
  {
    ok('🔴 自由对话用固定哨兵分区', TAVERN_VEC_PROJECT === '__tavern__', TAVERN_VEC_PROJECT)
    ok('🔴 哨兵长得不像项目 id（防误传当前项目）', TAVERN_VEC_PROJECT.startsWith('__') && TAVERN_VEC_PROJECT.endsWith('__'))
    ok('两个阈值关系合理：建索引门槛 > 重建步长', INDEX_MIN_MESSAGES > INDEX_MIN_NEW,
      `${INDEX_MIN_MESSAGES} vs ${INDEX_MIN_NEW}`)
  }

  // ---------- 4) autoIndexFreeSession 的守卫 ----------
  {
    __resetTavernIndexMemo()
    const calls: string[] = []
    const spyIndex = (async (doc: { refId: string }) => { calls.push(doc.refId); return { ok: true, chunks: 1 } }) as never

    // ① 开关关 ⇒ 一次都不建
    await autoIndexFreeSession(longSession(), { loadSettings: async () => ({ free: { semanticRecall: false } }), resolveConfig: async () => CFG, indexOne: spyIndex })
    ok('🔴 开关关 ⇒ 不建索引（默认关，不烧额度）', calls.length === 0, String(calls.length))

    // ② 开关开但消息太少 ⇒ 不建
    await autoIndexFreeSession(mkSession([mkMsg(1, 'user', '只有一句'), mkMsg(2, 'assistant', '也只有一句')]),
      { loadSettings: async () => ({ free: { semanticRecall: true } }), resolveConfig: async () => CFG, indexOne: spyIndex })
    ok('开关开、消息太少 ⇒ 不建（短对话整段都在窗口里）', calls.length === 0, String(calls.length))

    // ③ 开关开 + 够长 ⇒ 建
    await autoIndexFreeSession(longSession(), { loadSettings: async () => ({ free: { semanticRecall: true } }), resolveConfig: async () => CFG, indexOne: spyIndex })
    ok('开关开 + 够长 ⇒ 建索引', calls.length === 1 && calls[0] === 'fs-recall-probe', JSON.stringify(calls))

    // ④ 只多 1 条（不够 INDEX_MIN_NEW）⇒ 跳过
    const s4 = longSession()
    s4.messages = [...s4.messages, mkMsg(99, 'user', '又补了一句足够长的探针内容。')]
    await autoIndexFreeSession(s4, { loadSettings: async () => ({ free: { semanticRecall: true } }), resolveConfig: async () => CFG, indexOne: spyIndex })
    ok('🔴 新增不够 INDEX_MIN_NEW ⇒ 跳过（防每说一句嵌一次）', calls.length === 1, String(calls.length))

    // ⑤ 新增够多 ⇒ 重建
    const s5 = longSession()
    for (let i = 0; i < INDEX_MIN_NEW; i++) s5.messages.push(mkMsg(200 + i, 'user', `补的第 ${i} 句，长度足够过过滤。`))
    await autoIndexFreeSession(s5, { loadSettings: async () => ({ free: { semanticRecall: true } }), resolveConfig: async () => CFG, indexOne: spyIndex })
    ok('新增够 INDEX_MIN_NEW ⇒ 重建', calls.length === 2, String(calls.length))

    // ⑥ 🔴 消息变少（回滚）⇒ 必须重建
    const s6 = { ...s5, messages: s5.messages.slice(0, INDEX_MIN_MESSAGES) }
    await autoIndexFreeSession(s6, { loadSettings: async () => ({ free: { semanticRecall: true } }), resolveConfig: async () => CFG, indexOne: spyIndex })
    ok('🔴 消息变少（回滚）⇒ 仍然重建（否则召回已回退的内容，比不召回更糟）',
      calls.length === 3, String(calls.length))

    // ⑦ 没配嵌入模型 ⇒ 不建
    __resetTavernIndexMemo()
    const before = calls.length
    await autoIndexFreeSession(longSession(), { loadSettings: async () => ({ free: { semanticRecall: true } }), resolveConfig: async () => null, indexOne: spyIndex })
    ok('没配嵌入模型 ⇒ 不建（静默跳过，不是错误）', calls.length === before)

    // ⑧ 永不抛：读设置炸了也不冒泡
    let threw = false
    try {
      await autoIndexFreeSession(longSession(), { loadSettings: async () => { throw new Error('boom') }, resolveConfig: async () => CFG, indexOne: spyIndex })
    } catch { threw = true }
    ok('🔴 读设置失败 ⇒ 静默吞掉（索引问题绝不影响对话）', !threw)
  }

  // ---------- 5) buildFreeRecallBlock ----------
  {
    const s = mkSession(Array.from({ length: 30 }, (_, i) =>
      mkMsg(i + 1, i % 2 === 0 ? 'user' : 'assistant', `第 ${i + 1} 句探针内容，长度足够参与语义匹配。`)))

    // ① 没配嵌入 ⇒ ''
    ok('未配嵌入模型 ⇒ 空串（整层不出现）',
      await buildFreeRecallBlock({ session: s, deps: { resolveConfig: async () => null } }) === '')

    // ② 召回为空 ⇒ ''
    ok('召回为空 ⇒ 空串',
      await buildFreeRecallBlock({ session: s, deps: { resolveConfig: async () => CFG, recall: async () => [] } }) === '')

    // ③ 🔴 命中的块**起点落在最近窗口里** ⇒ 剔除 ⇒ 空串（不会重复占预算）
    //    造数据要真实：索引块的头 60 字就是那条消息的正文（别加后缀 —— 加了就变成
    //    "一条不同的文本"，测出来是假红/假绿都不可信）。
    const recentText = freeRecallQuery(s.messages, 12)
    const hitText = recentText.split('\n')[0]
    const dup = await buildFreeRecallBlock({
      session: s,
      deps: {
        resolveConfig: async () => CFG,
        recall: async () => [{ kind: 'tavern' as const, refId: s.id, chunkIdx: 0, text: hitText, title: '探针场', score: 0.9, secret: false }],
      },
    })
    ok('🔴 命中落在「最近窗口」⇒ 剔除（它本来就在上下文里，再塞一遍纯属重复）', dup === '', dup.slice(0, 60))

    // ④ 命中是早期内容 ⇒ 渲染出来，且带自由模式自己的自述句
    const early = await buildFreeRecallBlock({
      session: s,
      deps: {
        resolveConfig: async () => CFG,
        recall: async () => [{ kind: 'tavern' as const, refId: s.id, chunkIdx: 0, text: '很久以前说过的一句话，现在早就不在窗口里了。', title: '探针场', score: 0.88, secret: false }],
      },
    })
    ok('🔴 早期命中会被渲染（这就是本项要救的东西）', early.includes('很久以前说过的一句话'), early.slice(0, 80))
    ok('带自由模式自己的自述句（不是全书召回那句）',
      early.includes('本场早先的对话') && !early.includes('从全书捞出'), early.slice(0, 60))
    ok('标注来源类别为「对话」（VecKind 扩了 tavern）', early.includes('◆ 对话｜'), early.slice(0, 80))

    // ⑤ 永不抛
    let threw = false
    try {
      await buildFreeRecallBlock({ session: s, deps: { resolveConfig: async () => CFG, recall: async () => { throw new Error('boom') } } })
    } catch { threw = true }
    ok('🔴 检索抛错 ⇒ 静默吞掉返回空串', !threw)
  }

  console.log(`\ntavernRecall: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
