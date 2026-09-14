// ============ 酒馆模式 · 设定更新（AI 建议 + 作者裁决）============
//
// 这一层最重要的性质有两条：
//   ① **白名单闸门**：模型给的字段名必须落在可改字段里 —— 一个拼错的路径会让「采纳」写到一个不存在的键上；
//   ② **同一角色多条要连续应用**：逐条「读卡→写卡」会让后一条基于旧卡覆盖前一条（改动静默丢失）。
import { __resetMockStores } from './mock-memory'
import * as store from '../src/lib/tavern/store'
import {
  CARD_FIELDS, readCardField, writeCardField, isCardField, fieldLabel,
  buildReviseSystem, parseRevisions, recentTranscript, proposeCardRevisions,
} from '../src/lib/tavern/revise'
import type { CardFieldPath } from '../src/lib/tavern/types'
import { saveProviders, saveActiveId, type ChatMessage } from '../src/lib/ai'

const STUB_PROVIDER = { id: 'revise-stub', name: '桩模型', type: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }
import type { FreeCharacter, TavernMessage } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function mkChar(name: string, over: Partial<FreeCharacter> = {}): Promise<FreeCharacter> {
  return store.createFreeChar({
    ...store.emptyFreeCharacter(),
    name,
    world: '现代都市 · 老城区一间便利店',
    profile: {
      externals: '短发，围裙',
      core: '外冷内热',
      speech: '句子短',
      relations: '与楚楠是男女朋友，在一起四个月',
      cannot: '说不出关心的话',
      knowledge: '不知道楚楠的过去',
    },
    conduct: { perspective: '第一人称', bottomLine: '不越界', paceLock: '关系推进慢', rating: '日常向' },
    examples: '对方：这么晚还不下班？\n她把找零推过去。',
    ...over,
  })
}

async function main() {
  // ---------- 1) 字段表与读写 ----------
  {
    ok('可改字段共 12 个', CARD_FIELDS.length === 12, String(CARD_FIELDS.length))
    ok('不含 name（改名不在白名单里）', !CARD_FIELDS.some(f => (f.path as string) === 'name'))
    ok('isCardField 认白名单内的', isCardField('profile.relations') && isCardField('world'))
    ok('isCardField 拒白名单外的', !isCardField('name') && !isCardField('profile.unknown') && !isCardField(''))
    ok('fieldLabel 给中文名', fieldLabel('profile.relations') === '2.4 关系', fieldLabel('profile.relations'))
    ok('fieldLabel 认不出时原样返回（不抛）', fieldLabel('whatever') === 'whatever')

    const c = await mkChar('洛汐')
    ok('读得到现有值', readCardField(c, 'profile.relations').includes('男女朋友'))

    // 12 个字段全部往返一遍：写进去能读出来
    let cur = c
    const misses: string[] = []
    for (const f of CARD_FIELDS) {
      const v = `新值-${f.path}`
      cur = writeCardField(cur, f.path, v)
      if (readCardField(cur, f.path) !== v) misses.push(f.path)
    }
    ok('12 个字段写后都能读回（逐个验证）', misses.length === 0, misses.join('、'))
    ok('写是纯函数：原卡不被改动', readCardField(c, 'profile.relations').includes('男女朋友'))
    ok('只改目标字段，其它字段原样', readCardField(cur, 'profile.externals') === '新值-profile.externals' && readCardField(cur, 'conduct.rating') === '新值-conduct.rating')
  }

  // ---------- 2) 解析 + 白名单闸门（模型的胡说八道要挡在门外） ----------
  {
    const c = await mkChar('洛汐')

    const good = JSON.stringify({
      changes: [{
        field: 'profile.relations',
        after: '与楚楠已分手（四个月恋情结束），目前是前男女朋友关系',
        reason: '对话中楚楠提出了分手',
        quote: '我们……还是算了吧',
      }],
    })
    const p1 = parseRevisions(good, c)
    ok('解析 {changes:[…]}（模型按我们的格式回）', p1.length === 1)
    ok('带上角色归属（关系是双向的，采纳要知道写哪张卡）', p1[0].charId === c.id && p1[0].charName === '洛汐')
    ok('带上字段中文名', p1[0].fieldLabel === '2.4 关系')
    ok('带上现有值供对照（before）', p1[0].before.includes('男女朋友'))
    ok('保留理由与来源原句', p1[0].reason.includes('分手') && p1[0].quote.includes('算了吧'))
    ok('每条都有独立 id（界面勾选要用）', !!p1[0].id)

    // 白名单闸门：拼错的字段名不能过
    const badField = JSON.stringify({ changes: [{ field: 'profile.relatoins', after: 'x' }] })
    ok('🔴 字段名拼错 → 丢弃（否则采纳会写到不存在的键上）', parseRevisions(badField, c).length === 0)

    const nameChange = JSON.stringify({ changes: [{ field: 'name', after: '洛小汐' }] })
    ok('🔴 想改名字 → 丢弃（改名会牵动索引/记忆键/会话）', parseRevisions(nameChange, c).length === 0)

    const emptyAfter = JSON.stringify({ changes: [{ field: 'profile.relations', after: '   ' }] })
    ok('空 after → 丢弃', parseRevisions(emptyAfter, c).length === 0)

    const same = JSON.stringify({ changes: [{ field: 'profile.relations', after: '与楚楠是男女朋友，在一起四个月' }] })
    ok('与现状一模一样 → 丢弃（不占作者一次裁决）', parseRevisions(same, c).length === 0)

    const dup = JSON.stringify({
      changes: [
        { field: 'profile.relations', after: '第一次' },
        { field: 'profile.relations', after: '第二次' },
      ],
    })
    const p2 = parseRevisions(dup, c)
    ok('同字段多条 → 只留最后一条（采纳是整段替换）', p2.length === 1 && p2[0].after === '第二次', p2.map(x => x.after).join('|'))

    // 模型没按格式来时：单个对象 / 裹代码块 / 纯文字
    const single = JSON.stringify({ field: 'profile.core', after: '分手之后变得沉默了' })
    ok('单个对象（没包 changes）也能解析', parseRevisions(single, c).length === 1)
    ok('裹代码块也能解析', parseRevisions('```json\n' + good + '\n```', c).length === 1)
    ok('纯文字乱答 → 空数组（不抛）', parseRevisions('我觉得他们应该分手了。', c).length === 0)
    ok('空字符串 → 空数组', parseRevisions('', c).length === 0)

    const noReason = parseRevisions(JSON.stringify({ changes: [{ field: 'profile.core', after: '别的内核' }] }), c)
    ok('缺理由时给兜底文案（不留空）', noReason[0].reason.length > 0, noReason[0].reason)
  }

  // ---------- 3) 提示词：宁少勿多 + 字段清单 + 作者原文定界 ----------
  {
    const sys = buildReviseSystem('洛汐')
    ok('告诉模型「宁少勿多」（否则每次都要逐条否掉）', sys.includes('宁少勿多'))
    ok('说明空数组是正常结果', sys.includes('空数组是完全正常的结果'))
    ok('列出全部可改字段路径', CARD_FIELDS.every(f => sys.includes(f.path)), '缺：' + CARD_FIELDS.filter(f => !sys.includes(f.path)).map(f => f.path).join('、'))
    ok('要求 after 是完整文本（不是"加一句"）', sys.includes('完整文本') || sys.includes('整段重写'))
    ok('要来源原句', sys.includes('quote'))
    ok('明说不要改名字', sys.includes('不要改名字'))
  }

  // ---------- 4) 对话渲染与 proposeCardRevisions ----------
  {
    // 这一组会走 resolveTavernProvider（要有个"可用模型"才会往下调 chatFn）
    await saveProviders([{ ...STUB_PROVIDER }])
    await saveActiveId(STUB_PROVIDER.id)
    const c = await mkChar('洛汐')
    const msgs: TavernMessage[] = [
      { id: '1', role: 'user', content: '我们分手吧。', at: 1 },
      { id: '2', role: 'assistant', content: '（她低下头）\n好。', at: 2, speakerId: c.id },
      { id: '3', role: 'system', content: '（系统）', at: 3 },
      { id: '4', role: 'assistant', content: '这句被隐藏了', at: 4, hidden: true },
    ]
    const t = recentTranscript(msgs, 6000, m => (m.speakerId === c.id ? '洛汐' : '角色'))
    ok('用户发言标〖对方〗', t.includes('〖对方〗我们分手吧。'))
    ok('AI 发言标**具体是谁说的**（多角色时「谁对谁说」是关键）', t.includes('〖洛汐〗'))
    ok('system 消息不进', !t.includes('（系统）'))
    ok('隐藏消息不进', !t.includes('被隐藏了'))

    // 截断：只保留最近的部分，并说明被省略了
    const many: TavernMessage[] = Array.from({ length: 50 }, (_, i) => ({ id: String(i), role: 'user' as const, content: '第' + i + '句'.repeat(20), at: i }))
    const t2 = recentTranscript(many, 200)
    ok('超上限时从末尾往前取（最近的优先）', t2.includes('第49句'))
    ok('被截断时给出说明（免得模型以为对话就这么短）', t2.includes('更早的已省略'))

    // 桩模型
    const calls: { messages: ChatMessage[] }[] = []
    const chatFn = async (_cfg: unknown, messages: ChatMessage[]) => {
      calls.push({ messages })
      return JSON.stringify({
        changes: [{ field: 'profile.relations', after: '与楚楠已分手，前男女朋友', reason: '提了分手', quote: '我们分手吧' }],
      })
    }

    const out = await proposeCardRevisions({ char: c, messages: msgs, chatFn: chatFn as never })
    ok('走桩模型：产出一条建议', out.length === 1 && out[0].field === 'profile.relations')
    const sent = calls[0].messages
    ok('提示词带上现有设定（模型才知道要不要改）', sent[1].content.includes('〖现有设定〗') && sent[1].content.includes('男女朋友'))
    ok('对话原文用作者边界块包起来（随机 nonce 防注入）', /<<<A-[a-z0-9]+>>>/.test(sent[1].content))
    // 空字段也要进提示词 —— 对话里新长出来的信息正是要补进空栏的（用一张留空的卡来验，
    // 上面那张卡所有栏都填满了，所以这里单独造一张）
    const sparse = await mkChar('空卡', { examples: '', profile: { ...c.profile, knowledge: '' } })
    const calls3: { messages: ChatMessage[] }[] = []
    const chatFn3 = async (_cfg: unknown, messages: ChatMessage[]) => { calls3.push({ messages }); return '{"changes":[]}' }
    await proposeCardRevisions({ char: sparse, messages: msgs, chatFn: chatFn3 as never })
    ok('空字段也列出来（标「现为空」，好让模型往里补）', calls3[0].messages[1].content.includes('（现为空）'))

    // 没有对话 → 不调模型
    const calls2: unknown[] = []
    const chatFn2 = async () => { calls2.push(1); return '{}' }
    const out2 = await proposeCardRevisions({ char: c, messages: [], chatFn: chatFn2 as never })
    ok('没有对话时：直接返回空且**不调模型**', out2.length === 0 && calls2.length === 0)
  }

  // ---------- 5) 落库采纳：同一角色多条必须连续应用 ----------
  {
    __resetMockStores()
    const a = await mkChar('洛汐')
    const b = await mkChar('楚楠')

    // 🔴 关键：同一张卡两条改动，逐条「读→写」会互相覆盖，必须一次读一次写
    const n = await store.applyCardRevisions([
      { charId: a.id, field: 'profile.relations' as CardFieldPath, after: '与楚楠已分手' },
      { charId: a.id, field: 'profile.core' as CardFieldPath, after: '分手后变得沉默' },
      { charId: b.id, field: 'profile.relations' as CardFieldPath, after: '与洛汐已分手' },
    ])
    ok('返回实际改动条数', n === 3, String(n))

    const a2 = (await store.getFreeChar(a.id))!
    ok('🔴 同角色两条都生效（后一条没覆盖前一条）',
      readCardField(a2, 'profile.relations') === '与楚楠已分手' && readCardField(a2, 'profile.core') === '分手后变得沉默',
      readCardField(a2, 'profile.relations') + ' / ' + readCardField(a2, 'profile.core'))

    const b2 = (await store.getFreeChar(b.id))!
    ok('另一张卡也被改（关系是双向的）', readCardField(b2, 'profile.relations') === '与洛汐已分手')
    ok('未涉及的字段原样保留', readCardField(a2, 'profile.externals') === '短发，围裙')
    ok('改动落库（重新读取仍在）', (await store.getFreeChar(a2.id))!.profile.core === '分手后变得沉默')

    // 卡不存在时不崩、不计入
    const n2 = await store.applyCardRevisions([{ charId: '不存在', field: 'world' as CardFieldPath, after: 'x' }])
    ok('卡不存在时安全跳过', n2 === 0)
  }

  console.log(`\ntavernRevise: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
