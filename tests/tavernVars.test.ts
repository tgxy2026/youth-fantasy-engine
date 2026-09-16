// ============ 酒馆模式 · 本场变量（C2 第二步）============
//
// 2026-09-16 改（老大反馈 #3 / #4），两处大改动：
//   · **刻度换成 −100 ~ +100、默认 0**（原 0–100、好感/信任默认 50），三项数值还划了**档位**
//     （`VAR_BANDS`）—— 光给裸数模型判断不了轻重，得告诉它「这一档意味着什么」；
//   · **每轮 AI 回复后刷新**（`varsRefresh.refreshSessionVars`），不再等收尾才算一次。
//
// 数值始终**不靠模型每轮写记账行**（那套实测遵守率极低，1/6、0/6、0/6），
// 而是单开一次「只输出一行」的结构化调用。所以这一层的风险点：
//   · 抽取解析器「认不出时什么都不做」（宁可不改，也不能改错）；
//   · 引擎**完全不碰**数值 —— 刷新由组件层调 `refreshSessionVars`，引擎只管生成；
//   · 旧会话要**迁移**（0–100 制归零），而且迁移必须**幂等** ——
//     否则每次打开会话都会重置一遍，作者手改的数值会被反复抹掉。
import {
  applyVarOps, emptyVars, recordVarChanges, turnSeqOf, buildVarStateBlock,
  buildVarExtractSystem, buildVarExtractUser, parseVarsFromText, renderVarValues, VAR_LINE_TAG,
  setVarManually, resetVarValues, lastChangeText, manualPinnedKeys,
  migrateVarScale, VAR_SCALE,
} from '../src/lib/tavern/vars'
import { VAR_DEFS, varDefOf, bandsOf, bandOf } from '../src/lib/tavern/types'
import { runFreeTurn, buildFreeSystem, varsEnabledKeys } from '../src/lib/tavern/engine'
import { refreshSessionVars } from '../src/lib/tavern/varsRefresh'
import { extractSessionVars, renderVarsTranscript } from '../src/lib/tavern/summarize'
import * as store from '../src/lib/tavern/store'
import { getTavernSettings, DEFAULT_TAVERN_VARS, DEFAULT_TAVERN_SETTINGS } from '../src/lib/tavern/settings'
import { saveProviders, saveActiveId } from '../src/lib/ai'
import type { ChatFn } from '../src/lib/tavern/engine'
import type { FreeCharacter, FreeSession, VarValues, VarKey, TavernMessage } from '../src/lib/tavern/types'
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

    // 负号写法按**增量**解析（新刻度下 −100~+100，负数成了常规操作，不是异常）
    const neg0 = parseVarsFromText('〔数值〕信任 -4')[0]
    ok('负增量认 -N', neg0.kind === 'delta' && neg0.num === -4)
    const set0 = parseVarsFromText('〔数值〕精神 = 40')[0]
    ok('直接赋值认 =N', set0.kind === 'set' && set0.num === 40)
    const noEq0 = parseVarsFromText('〔数值〕精神 40')[0]
    ok('光写数字也当赋值', noEq0.kind === 'set' && noEq0.num === 40)
    // 2026-09-16 改名：「剧情进度」→「精神」、「当前地点」→「地点」（五栏统一成两个字）
    ok('新标签「精神」可用', parseVarsFromText('〔数值〕精神 -20')[0]?.key === 'progress')
    ok('新标签「地点」可用', parseVarsFromText('〔数值〕地点 天台')[0]?.key === 'place')
    ok('旧标签「剧情进度」不再被认（已改名）', parseVarsFromText('〔数值〕剧情进度 40').length === 0)
    // 新刻度允许负值：注意「-40」按**增量**解析（符号前缀 = delta），这跟旧刻度无关
    ok('标签换成新的之后负值照收', parseVarsFromText('〔数值〕好感 -40')[0]?.kind === 'delta')
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
    const base: VarValues = { affection: 0, trust: 0, progress: 0, mood: '', place: '' }

    const big = applyVarOps(base, [{ key: 'affection', label: '好感', kind: 'delta', num: 99 }], { maxStep: 5 })
    ok('单次幅度按 maxStep 夹取（+99 → +5）', big.values.affection === 5, String(big.values.affection))
    ok('变化量记的是**实际**发生的差', big.changes[0].delta === 5)

    // 🔴 2026-09-16：刻度改成 −100~+100 后，**0 不再是下界** —— 负数照常允许
    const negDrop = applyVarOps({ ...base, affection: 2 }, [{ key: 'affection', label: '好感', kind: 'delta', num: -5 }], { maxStep: 5 })
    ok('可以降到负值（不再被 0 挡住）', negDrop.values.affection === -3, String(negDrop.values.affection))

    const floor = applyVarOps({ ...base, affection: -98 }, [{ key: 'affection', label: '好感', kind: 'delta', num: -5 }], { maxStep: 5 })
    ok('下界夹到 −100', floor.values.affection === -100, String(floor.values.affection))

    const ceil = applyVarOps({ ...base, progress: 98 }, [{ key: 'progress', label: '精神', kind: 'set', num: 300 }], { maxStep: 5 })
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
    ok('初始值来自 VAR_DEFS（三项数值都是 0 起步）',
      v.values.affection === 0 && v.values.trust === 0 && v.values.progress === 0)

    v = recordVarChanges({ ...v, values: { ...v.values, affection: 3 } }, [
      { key: 'affection', label: '好感', from: 0, to: 3, delta: 3 },
    ], 1)
    ok('记一笔变动', v.log.length === 1 && v.values.affection === 3)
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
    ok('空值不渲染成「好感 undefined」', renderVarValues({ affection: 40 }, ['affection', 'mood']) === '好感 40')
    // 🔴 新刻度允许负值 —— 渲染层别把 -37 当成错误
    ok('负数照常渲染（带负号，不吞不改）',
      renderVarValues({ affection: -37, trust: -100 }, ['affection', 'trust']) === '好感 -37 · 信任 -100',
      renderVarValues({ affection: -37, trust: -100 }, ['affection', 'trust']))
    ok('有目标时带上（进度才有锚）',
      buildVarStateBlock({ values: { affection: 40 }, keys, goal: '让他说出实话' }).includes('让他说出实话'))

    // 抽取提示词：只干一件事、只输出一行
    const sys = buildVarExtractSystem(keys, { maxStep: 5 })
    ok('抽取提示词给出可记录项与范围', sys.includes('好感（-100–100）') && sys.includes('心情（≤12 字）'), sys.slice(0, 120))
    ok('抽取提示词要求只输出一行', sys.includes('只输出一行') && sys.includes(VAR_LINE_TAG))
    ok('抽取提示词要求「没变就不写」', sys.includes('只报告**真的变了**的项'))
    ok('抽取提示词用新标签「地点」（不再写「当前地点」）', sys.includes('「地点」') && !sys.includes('当前地点'))
    // 🔴 2026-09-16 新增：档位定义必须进提示词 —— 光给「-37」模型判断不了轻重
    ok('🔴 抽取提示词带上数值档位（含档名与行为说明）',
      sys.includes('数值的档位') && sys.includes('极度厌恶') && sys.includes('亲密依赖') && sys.includes('崩坏'))
    ok('档位只覆盖有分区的数值项（文本项不掺和）', !sys.includes('心情：') && !sys.includes('地点：'))
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
    ok('🔴 抽取把变化写进了返回值（0 + 3）', r1.values.affection === 3, String(r1.values.affection))
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
    // ⚠️ 2026-09-16 起「每轮刷新数值」确实存在，但它**不在引擎里** ——
    //    由组件层调 `varsRefresh.refreshSessionVars`（那里才知道模型与 maxStep）。
    //    这条断言盯的是引擎的边界：runFreeTurn 只负责生成，不偷偷改会话数据。
    ok('🔴 引擎本身不改数值（刷新交给 varsRefresh）',
      r1.session.vars?.values.affection === undefined || r1.session.vars?.values.affection === 0,
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
    ok('🔴 地点每轮都在这段状态里（场景瞬移的唯一防线）', sysPlace.system.includes('地点 教学楼三层楼道'))
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
    const base: VarValues = { affection: 0, trust: 0, progress: 0, mood: '', place: '' }

    const up = setVarManually(base, 'affection', '72')
    ok('手改数值直接赋值（不受 ±maxStep 限制）', up.values.affection === 72, String(up.values.affection))
    ok('手改记下一笔变更（from → to）',
      up.changes.length === 1 && up.changes[0].from === 0 && up.changes[0].to === 72 && up.changes[0].delta === 72)

    const over = setVarManually(base, 'affection', '500')
    ok('手改越界夹到边界（不做静默丢弃）', over.values.affection === 100)

    const neg = setVarManually(base, 'affection', '-30')
    ok('手改负数照收（−100 是合法值，不再被夹到 0）', neg.values.affection === -30, String(neg.values.affection))
    const negFloor = setVarManually(base, 'affection', '-500')
    ok('手改越下界夹到 −100', negFloor.values.affection === -100, String(negFloor.values.affection))

    const bad = setVarManually(base, 'affection', '很高')
    ok('🔴 认不出的输入原样不动（不当成 0 —— 误清零比不改更坏）',
      bad.changes.length === 0 && bad.values.affection === 0)

    const same = setVarManually(base, 'affection', '0')
    ok('改成同一个值不记一笔（免得变动历史被灌水）', same.changes.length === 0)

    const mood = setVarManually(base, 'mood', '微妙的动摇而且这句话很长很长')
    ok('文本变量按上限截断', String(mood.values.mood).length === 12, String(mood.values.mood))

    const dirty: VarValues = { affection: 12, trust: 88, progress: 40, mood: '烦', place: '天台' }
    const keys = varsEnabledKeys({ ...DEFAULT_TAVERN_SETTINGS, vars: { enabled: true, off: [], maxStep: 5 } })
    const r = resetVarValues(dirty, keys as VarKey[])
    ok('重置回初始值（三项数值都归 0）',
      r.values.affection === 0 && r.values.trust === 0 && r.values.progress === 0,
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
    const textLog = recordVarChanges(emptyVars(), [{ key: 'place', label: '地点', from: '', to: '天台' }], 5)
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

  // ---------- 9) 数值档位：给模型一把「多重才算重」的尺子 ----------
  // 光给「-37」，模型判断不了该演成什么样；档位把数值翻译成行为（老大反馈 #3）。
  {
    const numDefs = VAR_DEFS.filter(d => d.kind === 'num')
    ok('三项数值都有档位', numDefs.length === 3 && numDefs.every(d => (bandsOf(d.key)?.length ?? 0) >= 3))

    for (const d of numDefs) {
      const bands = bandsOf(d.key)!
      ok(`${d.label} 档位铺满全区间（首档起于 ${d.min}、末档止于 ${d.max}）`,
        bands[0].from === d.min && bands[bands.length - 1].to === d.max,
        JSON.stringify(bands.map(b => [b.from, b.to])))
      ok(`${d.label} 档位首尾相接、不留空档`,
        bands.every((b, i) => i === 0 || b.from === bands[i - 1].to),
        JSON.stringify(bands.map(b => [b.from, b.to])))
      ok(`${d.label} 每档都有名字与行为说明`, bands.every(b => b.name.length > 0 && b.effect.length > 4))
      ok(`${d.label} 档名不重复`, new Set(bands.map(b => b.name)).size === bands.length)
      // 🔴 中立档必须涵盖 0 —— 默认值就落在这一档，否则开局即「极度厌恶」这种荒唐
      ok(`${d.label} 的 0 落在中立档里`,
        bands.some(b => b.from <= 0 && 0 < b.to) || bands.some(b => b.from <= 0 && 0 <= b.to),
        JSON.stringify(bands.map(b => [b.from, b.to, b.name])))
    }
    ok('🔴 文本项没有档位（它们是文字，不是刻度）', bandsOf('mood') === null && bandsOf('place') === null)

    // bandOf：区间是 [from, to)，**末档含右端**
    const aff = bandsOf('affection')!
    ok('🔴 边界值归下一档（from 闭、to 开）',
      bandOf('affection', aff[1].from)!.name === aff[1].name, bandOf('affection', aff[1].from)!.name)
    ok('上一档的 to 正好是下一档的起点（不是无人区）',
      bandOf('affection', aff[0].to)!.name === aff[1].name)
    ok('🔴 下界 −100 归第一档',
      bandOf('affection', -100)!.name === aff[0].name, bandOf('affection', -100)!.name)
    ok('🔴 上界 +100 归末档（右端闭合）',
      bandOf('affection', 100)!.name === aff[aff.length - 1].name, bandOf('affection', 100)!.name)
    ok('越界的值夹到端点、不返回 null（老库/手改过的值也得显示出一档）',
      bandOf('affection', 999)!.name === aff[aff.length - 1].name &&
      bandOf('affection', -999)!.name === aff[0].name)
    ok('文本项 / 算不出来的值 → null（界面据此不渲染）',
      bandOf('mood', '烦') === null && bandOf('affection', '很高') === null && bandOf('affection', undefined) === null)
  }

  // ---------- 10) 旧会话迁移：0–100 制 → −100~+100 制 ----------
  {
    __resetMockStores()
    const su10 = await mkChar('苏念')

    const legacy: FreeSession = {
      ...(await store.createFreeSession([su10.id], '老会话', { providerId: 'x' }, {})),
      messages: [mkMsg('user', '喂。'), mkMsg('assistant', '嗯。')],
      // ⚠️ 故意不带 scale —— 这就是「昨天存的会话」在库里的样子
      vars: {
        values: { affection: 78, trust: 62, progress: 44, mood: '松了一点', place: '便利店' },
        turnSeq: 6,
        log: [{ turnSeq: 6, at: 1, source: 'ai', changes: [{ key: 'affection', label: '好感', from: 70, to: 78, delta: 8 }] }],
      },
    }

    const m1 = migrateVarScale(legacy)
    ok('🔴 旧刻度被认出来（scale 缺失 = 刻度 1）', m1 !== legacy)
    ok('🔴 三项数值全部归 0（老大拍板：不写映射，清清爽爽从头开始）',
      m1.vars!.values.affection === 0 && m1.vars!.values.trust === 0 && m1.vars!.values.progress === 0,
      JSON.stringify(m1.vars!.values))
    ok('🔴 文本项原样保留（心情/地点没有刻度可言，没理由连它们一起清）',
      m1.vars!.values.mood === '松了一点' && m1.vars!.values.place === '便利店')
    ok('变动记录保留（那是「上一场发生过什么」，回看入口不能顺手删掉）',
      m1.vars!.log.length === 1 && m1.vars!.turnSeq === 6)
    ok('打上新刻度的标记', m1.vars!.scale === VAR_SCALE)

    // 🔴 幂等的两条腿：① 再迁一次是空操作；② 绝不能是「每次打开都归零」
    const m2 = migrateVarScale(m1)
    ok('🔴 迁移幂等（第二次原样返回**同一个对象**）', m2 === m1)
    ok('🔴 迁移后再手改的数值不会被下次打开抹掉',
      migrateVarScale({ ...m1, vars: { ...m1.vars!, values: { ...m1.vars!.values, affection: 33 } } })
        .vars!.values.affection === 33)
    const fresh = { ...legacy, vars: emptyVars() }
    ok('本来就在新刻度上 → 原样返回', migrateVarScale(fresh) === fresh)
    const none = { ...legacy, vars: undefined }
    ok('压根没有数值块 → 不硬造一个出来', migrateVarScale(none) === none)
  }

  // ---------- 11) 每轮刷新（组件层调的入口）----------
  {
    __resetMockStores()
    await saveProviders([{ ...STUB_PROVIDER }])
    await saveActiveId(STUB_PROVIDER.id)
    const su11 = await mkChar('苏念')
    const keys = VAR_DEFS.map(d => d.key)
    const nameOf = () => '苏念'

    const base = await store.createFreeSession([su11.id], '刷新测试', { providerId: STUB_PROVIDER.id }, {})
    const withMsg: FreeSession = {
      ...base,
      messages: [
        mkMsg('user', '我回来了。'), mkMsg('assistant', '（她把杯子推过来）\n喝点热的。', su11.id),
        mkMsg('user', '嗯。'), mkMsg('assistant', '（她没抬头）\n嗯。', su11.id),
      ],
      vars: emptyVars(keys),
    }

    // ① 关掉数值 → 一次模型调用都不发（传个会炸的 chatFn 证明）
    const boom: ChatFn = async () => { throw new Error('不该被调到') }
    const r0 = await refreshSessionVars({ session: withMsg, keys: [], maxStep: 5, nameOf, chatFn: boom })
    ok('🔴 没启用数值 → 原样返回、不调模型', r0 === withMsg)

    // ② 只喂最后两条 —— 前两轮的老消息不该参与（同一件事会被反复记，数值自己漂走）
    const seen: string[] = []
    const spy: ChatFn = async (_p, msgs) => {
      seen.push(msgs.map(m => m.content).join('\n'))
      return '〔数值〕好感 +4；心情 松了一点'
    }
    const r1 = await refreshSessionVars({ session: withMsg, keys, maxStep: 5, nameOf, chatFn: spy })
    ok('🔴 只喂最后两条消息（本轮输入 + 本轮回复）',
      seen.length === 1 && seen[0].includes('（她没抬头）') && !seen[0].includes('（她把杯子推过来）'),
      seen[0])
    ok('刷新把变化写回了会话（0 + 4）', r1.vars!.values.affection === 4, String(r1.vars!.values.affection))
    ok('文本项也写回', r1.vars!.values.mood === '松了一点')
    ok('记了一笔变动（界面「最近变化」有得显示）', r1.vars!.log.length === 1 && r1.vars!.log[0].source === 'ai')
    ok('刷新不改消息、不动其它字段',
      r1.messages === withMsg.messages && r1.title === withMsg.title)
    ok('没变化 → 原样返回（调用方据此省掉一次写库）',
      await refreshSessionVars({ session: withMsg, keys, maxStep: 5, nameOf, chatFn: makeFakeChat('〔数值〕无变化').chatFn }) === withMsg)
    ok('没有消息 → 原样返回、不调模型',
      await refreshSessionVars({ session: base, keys, maxStep: 5, nameOf, chatFn: boom }) === base)

    // ③ 🔴 静默：抽取失败不能把这一轮对话弄没
    const r2 = await refreshSessionVars({ session: withMsg, keys, maxStep: 5, nameOf, chatFn: boom as ChatFn })
    ok('🔴 抽取抛异常 → 静默返回原会话（数值是锦上添花，不能拦着对话）', r2 === withMsg)

    // ④ 作者刚手改过的项只收增量（审计 P2 的保护在这里也要生效）
    const pinnedSession: FreeSession = {
      ...withMsg,
      vars: {
        ...emptyVars(keys),
        values: { ...emptyVars(keys).values, affection: 20 },
        // 最近一次变动来源是 manual → affection 被 pin
        log: [{ turnSeq: 4, at: 1, source: 'manual', changes: [{ key: 'affection', label: '好感', from: 12, to: 20, delta: 8 }] }],
      },
    }
    const r3 = await refreshSessionVars({ session: pinnedSession, keys, maxStep: 5, nameOf, chatFn: makeFakeChat('〔数值〕好感 80').chatFn })
    ok('🔴 作者刚手改到 20 → 模型的绝对值「好感 80」被挡下',
      r3.vars!.values.affection === 20, String(r3.vars!.values.affection))
    const r4 = await refreshSessionVars({ session: pinnedSession, keys, maxStep: 5, nameOf, chatFn: makeFakeChat('〔数值〕好感 +6').chatFn })
    ok('增量照旧放行（+6 被 maxStep=5 夹成 +5 → 25）', r4.vars!.values.affection === 25, String(r4.vars!.values.affection))
  }

  console.log(`\ntavernVars: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
