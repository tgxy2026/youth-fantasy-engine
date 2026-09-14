// ============ 酒馆模式 · 本场变量（C2 第二步：变量 + AI 输出增量）============
//
// 这一层的风险全在**解析**上：模型输出是本系统里最不可控的东西，而变量行的解析器
// 要在一段作者要读的正文里"精准地只吃掉一行"。
// 所以测试的重点不是"能不能解析"，而是**认不出时有没有一个字都不动**
// （变量是锦上添花，正文是命根子），以及**重说有没有把数值一起退回去**。
import {
  parseVarLine, applyVarOps, emptyVars, recordVarChanges, undoLastVarChanges,
  shouldAskVars, turnSeqOf, buildVarsBlock, renderVarValues, VAR_LINE_TAG,
} from '../src/lib/tavern/vars'
import { VAR_DEFS, varDefOf } from '../src/lib/tavern/types'
import { runFreeTurn, buildFreeSystem, varsEnabledKeys } from '../src/lib/tavern/engine'
import * as store from '../src/lib/tavern/store'
import { getTavernSettings, DEFAULT_TAVERN_VARS } from '../src/lib/tavern/settings'
import { saveProviders, saveActiveId } from '../src/lib/ai'
import type { ChatFn } from '../src/lib/tavern/engine'
import type { FreeCharacter, VarValues } from '../src/lib/tavern/types'
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

async function main() {
  // ---------- 1) 解析：正常情况 ----------
  {
    const r = parseVarLine('（她把杯子推过来）\n喝点热的。\n〔数值〕好感 +3；心情 松了一点')
    ok('命中最后一行、剥掉它', !r.text.includes(VAR_LINE_TAG) && r.text.includes('喝点热的。'), JSON.stringify(r.text))
    ok('解出两个操作', r.ops.length === 2, JSON.stringify(r.ops))
    // 取到局部变量再判：TS 对 `arr[0].kind === 'x' && arr[0].y` 这种重复下标不保证收窄
    const op0 = r.ops[0]
    const op1 = r.ops[1]
    ok('数值增量认 +N', op0.kind === 'delta' && op0.num === 3)
    ok('文本变量认中文名', op1.kind === 'text' && op1.text === '松了一点')
    ok('rawLine 留了原文（调试用）', r.rawLine.startsWith(VAR_LINE_TAG))

    const neg = parseVarLine('好。\n〔数值〕信任 -4')
    const neg0 = neg.ops[0]
    ok('负增量认 -N', neg0.kind === 'delta' && neg0.num === -4)
    const setv = parseVarLine('好。\n〔数值〕剧情进度 = 40')
    const set0 = setv.ops[0]
    ok('直接赋值认 =N', set0.kind === 'set' && set0.num === 40)
    const noEq = parseVarLine('好。\n〔数值〕剧情进度 40')
    const noEq0 = noEq.ops[0]
    ok('光写数字也当赋值', noEq0.kind === 'set' && noEq0.num === 40)
    const half = parseVarLine('好。\n〔数值〕affection +2')
    const half0 = half.ops[0]
    ok('英文键也认（模型偶尔会写键名）', half0.key === 'affection' && half0.kind === 'delta' && half0.num === 2)
    const semi = parseVarLine('好。\n〔数值〕好感 +1;信任 +1')
    ok('半角分号也认', semi.ops.length === 2)
  }

  // ---------- 2) 解析：认不出时必须一个字都不动 ----------
  {
    const mid = '〔数值〕好感 +9\n（她抬头）\n你回来了。'
    const m = parseVarLine(mid)
    ok('🔴 只有**最后一行**才算 —— 正文中间的同样字样不碰',
      m.ops.length === 0 && m.text === mid, JSON.stringify(m.text))

    const wrongTag = '（她点头）\n〔状态〕好感 +3'
    ok('🔴 记号不对 → 原样返回（那是角色的状态块，不是数值行）',
      parseVarLine(wrongTag).text === wrongTag && parseVarLine(wrongTag).ops.length === 0)

    const unknown = '（她点头）\n好。\n〔数值〕金钱 +500'
    const u = parseVarLine(unknown)
    ok('🔴 白名单外的变量 → 整个认不出、原样返回（不吃正文）',
      u.ops.length === 0 && u.text === unknown)

    const noChange = '（她点头）\n好。\n〔数值〕无变化'
    const nc = parseVarLine(noChange)
    ok('「无变化」是**认得出**的写法：行剥掉、不产生操作',
      nc.ops.length === 0 && !nc.text.includes(VAR_LINE_TAG) && nc.text.includes('好。'), JSON.stringify(nc.text))

    const noTail = '（她点头）\n好。\n\n  \n'
    const nt = parseVarLine(noTail)
    ok('末尾空行被跳过（找的是最后一个**非空**行）', nt.ops.length === 0)

    const empty = parseVarLine('')
    ok('空回复不炸', empty.text === '' && empty.ops.length === 0)

    const numNoSign = '好。\n〔数值〕好感 三'
    ok('数值位写了中文数字 → 认不出、不动',
      parseVarLine(numNoSign).ops.length === 0)
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

  // ---------- 4) 会话块：重说能撤销 ----------
  {
    let v = emptyVars()
    ok('初始值来自 VAR_DEFS', v.values.affection === 50 && v.values.progress === 0)

    v = recordVarChanges({ ...v, values: { ...v.values, affection: 53 } }, [
      { key: 'affection', label: '好感', from: 50, to: 53, delta: 3 },
    ], 1)
    ok('记一笔变动', v.log.length === 1 && v.values.affection === 53)
    ok('同时记下**前值**（重说要用）', v.prev?.values.affection === 50)

    const undone = undoLastVarChanges(v)!
    ok('🔴 撤销把被改过的键还原成前值', undone.values.affection === 50, String(undone.values.affection))
    ok('撤销后日志也回退一条', undone.log.length === 0)
    ok('撤销后没有前值可再撤（幂等）', undoLastVarChanges(undone)!.values.affection === 50)

    let many = emptyVars()
    for (let i = 0; i < 60; i++) {
      many = recordVarChanges({ ...many, values: { ...many.values, affection: i } }, [
        { key: 'affection', label: '好感', from: i - 1, to: i, delta: 1 },
      ], i)
    }
    ok('日志有上限（不会无限长）', many.log.length === 50, String(many.log.length))
  }

  // ---------- 5) 节流与渲染 ----------
  {
    ok('每 3 轮：第 3/6 轮才请求', shouldAskVars(3, 3) && shouldAskVars(6, 3) && !shouldAskVars(4, 3))
    ok('everyTurns=1 = 每轮', shouldAskVars(1, 1) && shouldAskVars(7, 1))
    ok('非法值兜底成每轮', shouldAskVars(5, 0) && shouldAskVars(5, -3))
    ok('turnSeq = 已有 AI 回复数 + 1',
      turnSeqOf([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]) === 2)

    const keys = VAR_DEFS.map(d => d.key)
    const on = buildVarsBlock({ values: { affection: 62, trust: 40, mood: '微妙的动摇' }, keys, ask: true, everyTurns: 3, maxStep: 5 })
    ok('请求增量时给规则与格式示例', on.includes(VAR_LINE_TAG) && on.includes('好感 +2'))
    ok('带上当前值', on.includes('好感 62') && on.includes('心情 微妙的动摇'))
    ok('带上可用项与范围', on.includes('好感（0–100）') && on.includes('心情（≤12 字）'))
    ok('提示了这一行不会展示给用户', on.includes('不会展示给用户'))

    const off = buildVarsBlock({ values: { affection: 62 }, keys, ask: false, everyTurns: 3, maxStep: 5 })
    ok('不请求时只给当前值、不提输出格式', off.includes('好感 62') && !off.includes(VAR_LINE_TAG))

    const none = buildVarsBlock({ values: {}, keys: [], ask: true, everyTurns: 3, maxStep: 5 })
    ok('🔴 没启用任何变量 → 空串（一个字都不占额度）', none === '')

    ok('空值不渲染成「好感 undefined」', renderVarValues({ affection: 50 }, ['affection', 'mood']) === '好感 50')
    ok('有目标时带上（进度才有锚）',
      buildVarsBlock({ values: {}, keys, ask: false, everyTurns: 3, maxStep: 5, goal: '让他说出实话' }).includes('让他说出实话'))
  }

  // ---------- 6) 引擎端到端：剥行 / 落库 / 重说撤销 ----------
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
    ok('🔴 数值行被剥掉，正文只剩对白',
      !r1.reply.includes(VAR_LINE_TAG) && r1.reply.includes('喝点热的。'), JSON.stringify(r1.reply))
    ok('变量写进了会话（50 + 3）', r1.session.vars?.values.affection === 53, String(r1.session.vars?.values.affection))
    ok('文本变量也写进去了', r1.session.vars?.values.mood === '松了一点')
    ok('返回了变化清单（界面据此提示）', r1.varChanges.length === 2 && r1.varChanges[0].delta === 3)
    ok('没有误报解析失败', !r1.varParseFailed)

    // 重说：先撤销上一次变化，再应用新的
    const saved = await store.saveFreeSession(r1.session)
    const r2 = await runFreeTurn(
      saved, [su], null, {},
      { chatFn: makeFakeChat('（她没抬头）\n嗯。\n〔数值〕好感 +1').chatFn, settings: st },
    )
    ok('🔴 重说把上一次的变化先退回去（53 → 50），再加这一轮的 +1 = 51',
      r2.session.vars?.values.affection === 51, String(r2.session.vars?.values.affection))
    ok('重说后的变动日志仍只有一条', (r2.session.vars?.log ?? []).length === 1)

    // 关掉开关：数值行**原样留在正文里**（一个字都不动）
    const offSt = { ...st, vars: { ...st.vars, enabled: false } }
    const r3 = await runFreeTurn(
      saved, [su], '再说什么。', {},
      { chatFn: makeFakeChat('好。\n〔数值〕好感 +9').chatFn, settings: offSt },
    )
    ok('🔴 关掉开关后：数值行原样留在正文里（不解析、不剥行）',
      r3.reply.includes(VAR_LINE_TAG) && r3.varChanges.length === 0)
    ok('关掉开关后变量一个都不动', r3.session.vars?.values.affection === 53)

    // 格式没对上：正文原样保留，只记一笔"没记账"
    const r4 = await runFreeTurn(
      saved, [su], '再说什么。', {},
      { chatFn: makeFakeChat('好。\n〔数值〕随便写点什么').chatFn, settings: st },
    )
    ok('🔴 认不出的数值行原样保留（绝不吞正文）',
      r4.reply.includes('随便写点什么') && r4.varChanges.length === 0, JSON.stringify(r4.reply))
    ok('但会标记「解析失败」供界面提示', r4.varParseFailed === true)

    // 提示词层：开关打开才有数值块（关掉 = 一个字都不加，等价于 0 成本）
    const sysOn = await buildFreeSystem(saved, [su], st)
    const sysOff = await buildFreeSystem(saved, [su], offSt)
    ok('🔴 开关打开 → 提示词里带数值块', sysOn.system.includes('〖本场数值〗'))
    ok('🔴 开关关掉 → 提示词里一个字都不带（0 字成本）',
      !sysOff.system.includes('〖本场数值〗') && !sysOff.system.includes(VAR_LINE_TAG))
    ok('关掉时 system 确实更短', sysOff.system.length < sysOn.system.length,
      `${sysOff.system.length} vs ${sysOn.system.length}`)
  }

  ok('VAR_DEFS 一共 5 项（老大定的集合，改动要同步提示词与界面）', VAR_DEFS.length === 5)
  ok('DEFAULT_TAVERN_VARS 与文档一致（每 3 轮 / ±5）',
    DEFAULT_TAVERN_VARS.everyTurns === 3 && DEFAULT_TAVERN_VARS.maxStep === 5)

  console.log(`\ntavernVars: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
