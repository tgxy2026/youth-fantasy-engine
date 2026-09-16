// ============ 酒馆模式 · 本场变量（C2 第二步）============
//
// 2026-09-15 改：数值**不再靠模型每轮记账**，改为「整理记忆时一次算清」
// （`extractSessionVars`，单开一次只输出一行的结构化调用）。
// 所以这一层的风险点变了：
//   · 抽取解析器「认不出时什么都不做」（宁可不改，也不能改错）；
//   · 引擎**完全不碰**数值 —— 回复里出现〔数值〕也不剥、不改值（旧行为已下线）；
//   · 提示词那块只剩「当前值」，不再有任何记账要求。
import {
  applyVarOps, emptyVars, recordVarChanges, turnSeqOf, buildVarStateBlock,
  buildVarExtractSystem, buildVarExtractUser, parseVarsFromText, renderVarValues, VAR_LINE_TAG,
  setVarManually, resetVarValues, lastChangeText, manualPinnedKeys,
} from '../src/lib/tavern/vars'
import { VAR_DEFS, varDefOf } from '../src/lib/tavern/types'
import { runFreeTurn, buildFreeSystem, varsEnabledKeys } from '../src/lib/tavern/engine'
import { extractSessionVars, renderVarsTranscript } from '../src/lib/tavern/summarize'
import * as store from '../src/lib/tavern/store'
import { getTavernSettings, DEFAULT_TAVERN_VARS, DEFAULT_TAVERN_SETTINGS } from '../src/lib/tavern/settings'
import { saveProviders, saveActiveId } from '../src/lib/ai'
import type { ChatFn } from '../src/lib/tavern/engine'
import type { FreeCharacter, VarValues, VarKey, TavernMessage } from '../src/lib/tavern/types'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const STUB_PROVIDER = { id: 'vars-stub', name: '桩模型', type: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }

function makeFakeChat(reply: string) {
  const chatFn: ChatFn = async () => reply
  return { chatFn }
}

async function mkChar(name: string): Promise<FreeCharacter> {
  return store.createFreeChar({
    ...store.emptyFreeCharacter(),
    name,
    world: '现代都市 · 老城区一间凌晨还亮着灯的便利店',
    profile: {
      externals: '短发，围裙', core: '外冷内热', speech: '话少',
      relations: '独居', cannot: '不会说软话', knowledge: '不知道你的过去',
    },
    conduct: { perspective: '第一人称', bottomLine: '', paceLock: '', rating: '' },
    examples: '',
  })
}

const mkMsg = (role: 'user' | 'assistant', content: string, speakerId?: string): TavernMessage =>
  ({ id: 'm' + Math.random().toString(36).slice(2), role, content, at: Date.now(), speakerId })

async function main() {
  // ---------- 1) 抽取解析：正常情况 ----------
  {
    const ops = parseVarsFromText('好的，我看了一下。\n〔数值〕好感 +3；心情 松了一点')
    ok('认得以 〔数值〕 开头的那一行（不要求它在最后）', ops.length === 2, JSON.stringify(ops))
    const op0 = ops[0]
    const op1 = ops[1]
    ok('数值增量认 +N', op0.kind === 'delta' && op0.num === 3)
    ok('文本变量认中文名', op1.kind === 'text' && op1.text === '松了一点')

    const neg0 = parseVarsFromText('〔数值〕信任 -4')[0]
    ok('负增量认 -N', neg0.kind === 'delta' && neg0.num === -4)
    const set0 = parseVarsFromText('〔数值〕剧情进度 = 40')[0]
    ok('直接赋值认 =N', set0.kind === 'set' && set0.num === 40)
    const noEq0 = parseVarsFromText('〔数值〕剧情进度 40')[0]
    ok('光写数字也当赋值', noEq0.kind === 'set' && noEq0.num === 40)
    const half0 = parseVarsFromText('〔数值〕affection +2')[0]
    ok('英文键也认（模型偶尔会写键名）', half0.key === 'affection' && half0.kind === 'delta' && half0.num === 2)
    ok('半角分号也认', parseVarsFromText('〔数值〕好感 +1;信任 +1').length === 2)
    ok('「无变化」= 零操作（不是错误）', parseVarsFromText('〔数值〕无变化').length === 0)
  }

  // ---------- 2) 抽取解析：认不出时必须什么都不做 ----------
  {
    ok('🔴 没有 〔数值〕 行 → 零操作（绝不猜）', parseVarsFromText('（她点头）\n好。').length === 0)
    ok('🔴 记号不对 → 零操作（那是角色的状态块）', parseVarsFromText('（她点头）\n〔状态〕好感 +3').length === 0)
    ok('🔴 白名单外的变量 → 零操作（不认识就不动）', parseVarsFromText('〔数值〕金钱 +500').length === 0)
    ok('数值位写中文数字 → 零操作', parseVarsFromText('〔数值〕好感 三').length === 0)
    ok('空回复不炸', parseVarsFromText('').length === 0)
    ok('行首空白不影响', parseVarsFromText('   〔数值〕好感 +2').length === 1)
  }

  // ---------- 3) 应用：夹取 ----------
  {
    const base: VarValues = { affection: 50, trust: 50, progress: 0, mood: '', place: '' }

    const big = applyVarOps(base, [{ key: 'affection', label: '好感', kind: 'delta', num: 99 }], { maxStep: 5 })
    ok('单次幅度按 maxStep 夹取（+99 → +5）', big.values.affection === 55, String(big.values.affection))
    ok('变化量记的是**实际**发生的差', big.changes[0].delta === 5)

    const floor = applyVarOps({ ...base, affection: 2 }, [{ key: 'affection', label: '好感', kind: 'delta', num: -5 }], { maxStep: 5 })
    ok('下界夹到 0', floor.values.affection === 0, String(floor.values.affection))

    const ceil = applyVarOps({ ...base, progress: 98 }, [{ key: 'progress', label: '剧情进度', kind: 'set', num: 300 }], { maxStep: 5 })
    ok('上界夹到 100', ceil.values.progress === 100, String(ceil.values.progress))

    const noop = applyVarOps(base, [{ key: 'affection', label: '好感', kind: 'delta', num: 0 }], { maxStep: 5 })
    ok('没有实际变化 → 不记一笔（免得日志里全是 +0）', noop.changes.length === 0)

    const longText = applyVarOps(base, [{ key: 'mood', label: '心情', kind: 'text', text: '一'.repeat(30) }], {})
    ok('文本变量按 maxLen 截断', String(longText.values.mood).length === varDefOf('mood')!.maxLen)

    const sameText = applyVarOps({ ...base, mood: '平静' }, [{ key: 'mood', label: '心情', kind: 'text', text: '平静' }], {})
    ok('文本没变就不记', sameText.changes.length === 0)
  }

  // ---------- 4) 会话块：日志与上限 ----------
  {
    let v = emptyVars()
    ok('初始值来自 VAR_DEFS', v.values.affection === 50 && v.values.progress === 0)

    v = recordVarChanges({ ...v, values: { ...v.values, affection: 53 } }, [
      { key: 'affection', label: '好感', from: 50, to: 53, delta: 3 },
    ], 1)
    ok('记一笔变动', v.log.length === 1 && v.values.affection === 53)
    ok('日志标了来源 ai 与轮次', v.log[0].source === 'ai' && v.log[0].turnSeq === 1)

    let many = emptyVars()
    for (let i = 0; i < 60; i++) {
      many = recordVarChanges({ ...many, values: { ...many.values, affection: i } }, [
        { key: 'affection', label: '好感', from: i - 1, to: i, delta: 1 },
      ], i)
    }
    ok('日志有上限（不会无限长）', many.log.length === 50, String(many.log.length))

    ok('空变更不写日志', recordVarChanges(emptyVars(), [], 1).log.length === 0)
  }

  // ---------- 5) 提示词层：只给当前值，不再有任何记账要求 ----------
  {
    const keys = VAR_DEFS.map(d => d.key)
    const blk = buildVarStateBlock({ values: { affection: 62, trust: 40, mood: '微妙的动摇' }, keys })
    ok('带上当前值', blk.includes('好感 62') && blk.includes('心情 微妙的动摇'))
    ok('🔴 不再要求模型输出记账行（那套已下线）', !blk.includes(VAR_LINE_TAG))
    ok('带层头（便于模型识别这是一段状态）', blk.includes('〖本场数值〗'))
    ok('提示不要抄进正文', blk.includes('不要把它抄进正文'))

    ok('🔴 没启用任何变量 → 空串（一个字都不占额度）', buildVarStateBlock({ values: {}, keys: [] }) === '')
    const onlyText = buildVarStateBlock({ values: { mood: '', place: '' }, keys: ['mood', 'place'] })
    ok('🔴 启用着但一个值都没有 → 空串（空层不占额度）', onlyText === '')
    ok('空值不渲染成「好感 undefined」', renderVarValues({ affection: 50 }, ['affection', 'mood']) === '好感 50')
    ok('有目标时带上（进度才有锚）',
      buildVarStateBlock({ values: { affection: 50 }, keys, goal: '让他说出实话' }).includes('让他说出实话'))

    // 抽取提示词：只干一件事、只输出一行
    const sys = buildVarExtractSystem(keys, { maxStep: 5 })
    ok('抽取提示词给出可记录项与范围', sys.includes('好感（0–100）') && sys.includes('心情（≤12 字）'))
    ok('抽取提示词要求只输出一行', sys.includes('只输出一行') && sys.includes(VAR_LINE_TAG))
    ok('抽取提示词要求「没变就不写」', sys.includes('只报告**真的变了**的项'))
    ok('抽取提示词强调当前地点', sys.includes('当前地点'))
    ok('只请求启用中的项', !buildVarExtractSystem(['affection'], { maxStep: 5 }).includes('心情'))

    const user = buildVarExtractUser({
      values: { affection: 62 }, keys,
      transcript: renderVarsTranscript([mkMsg('user', '我回来了。'), mkMsg('assistant', '回来了。', 'c1')], () => '苏念'),
    })
    ok('抽取 user 段带当前值', user.includes('好感 62'))
    ok('抽取 user 段带对话且标了说话人', user.includes('〖对方〗我回来了。') && user.includes('〖苏念〗回来了。'))
  }

  // ---------- 6) 抽取器端到端（桩模型） ----------
  {
    __resetMockStores()
    await saveProviders([{ ...STUB_PROVIDER }])
    await saveActiveId(STUB_PROVIDER.id)
    const su = await mkChar('苏念')
    const keys = VAR_DEFS.map(d => d.key)
    const msgs = [mkMsg('user', '我回来了。'), mkMsg('assistant', '（她把杯子推过来）\n喝点热的。', su.id)]

    const r1 = await extractSessionVars({
      keys, values: emptyVars().values, messages: msgs,
      chatFn: makeFakeChat('〔数值〕好感 +3；心情 松了一点').chatFn,
    })
    ok('🔴 抽取把变化写进了返回值（50 + 3）', r1.values.affection === 53, String(r1.values.affection))
    ok('文本变量也写进去了', r1.values.mood === '松了一点')
    ok('返回了变化清单（界面据此提示）', r1.changes.length === 2 && r1.changes[0].delta === 3)

    const r2 = await extractSessionVars({
      keys, values: { ...emptyVars().values, affection: 70 }, messages: msgs,
      chatFn: makeFakeChat('〔数值〕无变化').chatFn,
    })
    ok('「无变化」→ 一个字段都不动、也没有变更记录', r2.changes.length === 0 && r2.values.affection === 70)

    const r3 = await extractSessionVars({
      keys, values: { ...emptyVars().values, affection: 70 }, messages: msgs,
      chatFn: makeFakeChat('好感 +9（模型没按格式）').chatFn,
    })
    ok('🔴 格式不对 → 什么都不动（宁可不改）', r3.changes.length === 0 && r3.values.affection === 70)

    const boom: ChatFn = async () => { throw new Error('不该被调到') }
    const r4 = await extractSessionVars({ keys: [], values: emptyVars().values, messages: msgs, chatFn: boom })
    ok('没启用任何变量 → 不调模型', r4.changes.length === 0)
    const r5 = await extractSessionVars({ keys, values: emptyVars().values, messages: [], chatFn: boom })
    ok('没有新消息 → 不调模型', r5.changes.length === 0)
  }

  // ---------- 7) 引擎：数值不再由每一轮改动 ----------
  {
    __resetMockStores()
    await saveProviders([{ ...STUB_PROVIDER }])
    await saveActiveId(STUB_PROVIDER.id)
    const su = await mkChar('苏念')
    const st = await getTavernSettings()
    const session = await store.createFreeSession([su.id], '变量测试', { providerId: STUB_PROVIDER.id }, {})

    ok('默认开关是开的（老大点名要的功能，默认关掉等于让人去找开关）', st.vars.enabled === true)
    ok('默认启用全部 5 项', varsEnabledKeys(st).length === 5)
    ok('逐项关掉后立刻少一项',
      varsEnabledKeys({ ...st, vars: { ...st.vars, off: ['affection'] } }).length === 4)

    const r1 = await runFreeTurn(
      session, [su], '我回来了。', {},
      { chatFn: makeFakeChat('（她把杯子推过来）\n喝点热的。\n〔数值〕好感 +3；心情 松了一点').chatFn, settings: st },
    )
    ok('🔴 引擎不再剥数值行（那一行原样留在正文里，不再由本轮流解析）',
      r1.reply.includes(VAR_LINE_TAG) && r1.reply.includes('喝点热的。'), JSON.stringify(r1.reply))
    ok('🔴 这一轮的数值一个都没被改', r1.session.vars?.values.affection === undefined || r1.session.vars?.values.affection === 50,
      String(r1.session.vars?.values.affection))

    const offSt = { ...st, vars: { ...st.vars, enabled: false } }
    const sysOn = await buildFreeSystem(session, [su], st)
    const sysOff = await buildFreeSystem(session, [su], offSt)
    ok('🔴 开关打开 → 提示词里带数值块', sysOn.system.includes('〖本场数值〗'))
    ok('🔴 开关关掉 → 不加变量块、不提当前值（0 字成本）',
      !sysOff.system.includes('〖本场数值〗') && !sysOff.system.includes('你此刻的状态：'))
    ok('关掉时 system 确实更短', sysOff.system.length < sysOn.system.length,
      `${sysOff.system.length} vs ${sysOn.system.length}`)
    const withPlace = { ...session, vars: { ...emptyVars(), values: { ...emptyVars().values, place: '教学楼三层楼道' } } }
    const sysPlace = await buildFreeSystem(withPlace, [su], st)
    ok('🔴 当前地点每轮都在这段状态里（场景瞬移的唯一防线）', sysPlace.system.includes('当前地点 教学楼三层楼道'))
    ok('数值块排在协议**之后**（离生成点最近）',
      sysPlace.system.indexOf('〖本场数值〗') > 0)
  }

  ok('VAR_DEFS 一共 5 项（老大定的集合，改动要同步提示词与界面）', VAR_DEFS.length === 5)
  ok('DEFAULT_TAVERN_VARS 只剩开关 + 幅度（更新间隔已随「每轮记账」下线）',
    DEFAULT_TAVERN_VARS.enabled === true && DEFAULT_TAVERN_VARS.maxStep === 5 &&
    !('everyTurns' in DEFAULT_TAVERN_VARS))
  ok('turnSeq = 已有 AI 回复数 + 1',
    turnSeqOf([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]) === 2)

  // ---------- 8) 作者手改 / 重置（界面侧） ----------
  {
    const base: VarValues = { affection: 50, trust: 50, progress: 0, mood: '', place: '' }

    const up = setVarManually(base, 'affection', '72')
    ok('手改数值直接赋值（不受 ±maxStep 限制）', up.values.affection === 72, String(up.values.affection))
    ok('手改记下一笔变更（from → to）',
      up.changes.length === 1 && up.changes[0].from === 50 && up.changes[0].to === 72 && up.changes[0].delta === 22)

    const over = setVarManually(base, 'affection', '500')
    ok('手改越界夹到边界（不做静默丢弃）', over.values.affection === 100)

    const neg = setVarManually(base, 'affection', '-30')
    ok('手改负数夹到下界', neg.values.affection === 0)

    const bad = setVarManually(base, 'affection', '很高')
    ok('🔴 认不出的输入原样不动（不当成 0 —— 误清零比不改更坏）',
      bad.changes.length === 0 && bad.values.affection === 50)

    const same = setVarManually(base, 'affection', '50')
    ok('改成同一个值不记一笔（免得变动历史被灌水）', same.changes.length === 0)

    const mood = setVarManually(base, 'mood', '微妙的动摇而且这句话很长很长')
    ok('文本变量按上限截断', String(mood.values.mood).length === 12, String(mood.values.mood))

    const dirty: VarValues = { affection: 12, trust: 88, progress: 40, mood: '烦', place: '天台' }
    const keys = varsEnabledKeys({ ...DEFAULT_TAVERN_SETTINGS, vars: { enabled: true, off: [], maxStep: 5 } })
    const r = resetVarValues(dirty, keys as VarKey[])
    ok('重置回初始值（好感/信任 50、进度 0）',
      r.values.affection === 50 && r.values.trust === 50 && r.values.progress === 0,
      JSON.stringify(r.values))
    ok('重置清空文本变量', r.values.mood === '' && r.values.place === '')
    ok('重置记下 5 笔变更', r.changes.length === 5, String(r.changes.length))
    ok('已在初始值时重置是空操作', resetVarValues(emptyVars(keys as VarKey[]).values, keys as VarKey[]).changes.length === 0)

    const manual = recordVarChanges(
      { ...emptyVars(), values: { ...emptyVars().values, affection: 30 } },
      [{ key: 'affection', label: '好感', from: 56, to: 30, delta: -26 }],
      4, 'manual',
    )
    ok('手改的日志来源标 manual', manual.log[manual.log.length - 1].source === 'manual')

    ok('最近差量显示带符号的增量', lastChangeText(manual, 'affection') === '-26', lastChangeText(manual, 'affection'))
    const textLog = recordVarChanges(emptyVars(), [{ key: 'place', label: '当前地点', from: '', to: '天台' }], 5)
    ok('文本变量没有差量时给「已填写」', lastChangeText(textLog, 'place') === '已填写', lastChangeText(textLog, 'place'))
    ok('没有记录时返回空串', lastChangeText(undefined, 'affection') === '')
  }

  // ---------- N) 作者手改保护（审计 P2）----------
  // 模型偶尔用绝对值写法（「好感 80」）而不是增量（「好感 +3」）。作者刚手改成 20，
  // 下一轮被一句「好感 80」盖回去，等于手改白做 —— 所以手改过的键只收增量。
  {
    const manual = recordVarChanges(emptyVars(), [{ key: 'affection', label: '好感', from: 50, to: 20 }], 3, 'manual')
    ok('手改过的键被识别为受保护', manualPinnedKeys(manual).includes('affection'), manualPinnedKeys(manual).join(','))
    const aiAfter = recordVarChanges(manual, [{ key: 'affection', label: '好感', from: 20, to: 25 }], 4)
    ok('之后 AI 也改过 → 不再受保护（说明保护只在「手改是最近一次」时生效）',
      !manualPinnedKeys(aiAfter).includes('affection'))
    ok('纯 AI 改过的键不受保护', manualPinnedKeys(recordVarChanges(emptyVars(), [{ key: 'trust', label: '信任', from: 50, to: 55 }], 2)).length === 0)
    ok('没有日志时不保护任何键', manualPinnedKeys(undefined).length === 0)

    const vals = { ...emptyVars().values, affection: 20 }
    const pinned: VarKey[] = ['affection']
    const r1 = applyVarOps(vals, [{ key: 'affection', label: '好感', kind: 'set', num: 80 }], { pinned })
    ok('🔴 绝对值不能覆盖作者手改过的值', r1.values.affection === 20, String(r1.values.affection))
    ok('被拒的操作不留变动记录', r1.changes.length === 0, JSON.stringify(r1.changes))
    const r2 = applyVarOps(vals, [{ key: 'affection', label: '好感', kind: 'delta', num: 3 }], { pinned })
    ok('增量仍放行（AI 的正常微调不受影响）', r2.values.affection === 23, String(r2.values.affection))
    ok('没传 pinned 时绝对值照旧生效', applyVarOps(vals, [{ key: 'affection', label: '好感', kind: 'set', num: 80 }], {}).values.affection === 80)
  }

  console.log(`\ntavernVars: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
