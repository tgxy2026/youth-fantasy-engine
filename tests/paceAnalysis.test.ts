/**
 * B5（2.4.1）爽点节奏与章末钩子 —— 单测
 *
 * 测的是**最容易算错、且错了最误导人**的那两步：
 *   ① 引文定位（AI 给的 quote → 落在正文哪一段）—— 位置必须由本地算
 *   ② 分布形态判定（后段空转 / 集中前段 …）
 * 以及解析层的兜底：脏数据、截断、缺字段都不能抛。
 *
 * 🔴 另外带**立场断言**：提示词与模块里不许出现"规避检测/命中率/AI 率"一类表述。
 */
import { readFileSync } from 'node:fs'
import {
  PACE_SEGMENTS, PACE_SEG_UNKNOWN, HOOK_KINDS, HOOK_ZONE_RATIO, PACE_BEAT_KINDS,
  locateQuote, segmentAt, locateBeats, buildDistribution, hookZoneSnippet, hookZoneStats,
  normalizeBeats, toStringList, normalizeHookKind, parsePaceReport,
  type PaceBeat,
} from '../src/lib/paceAnalysis'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ paceAnalysis')

// ---------- 0) 受控正文：三段各占一块，位置一目了然 ----------
// 总长 300：前段 [0,120)、中段 [120,220)、后段 [220,300)
const P1 = '春'.repeat(120)
const P2 = '夏'.repeat(100)
const P3 = '秋'.repeat(80)
const TEXT = P1 + P2 + P3

// ---------- 1) locateQuote：精确 / 去空白 / 前缀 / 找不到 ----------
{
  ok('引文在开头 → 下标 0', locateQuote(TEXT, '春'.repeat(6)) === 0)
  ok('引文在中段 → 下标 120', locateQuote(TEXT, '夏'.repeat(6)) === 120,
    String(locateQuote(TEXT, '夏'.repeat(6))))
  ok('引文在后段 → 下标 220', locateQuote(TEXT, '秋'.repeat(6)) === 220,
    String(locateQuote(TEXT, '秋'.repeat(6))))

  // 模型复制引文时常把换行/空格弄丢 → 必须能容错
  const spaced = '一 二 三 四'
  ok('引文去掉空白后能命中（模型复制失真）', locateQuote(spaced, '一二三四') === 0,
    String(locateQuote(spaced, '一二三四')))

  // 引文被模型顺手改写几个字 → 用前 12 字回退
  ok('引文尾部被改写 → 用开头 12 字回退命中', locateQuote(TEXT, '春'.repeat(20) + '尾巴改写了') === 0)

  // 彻底找不到 → -1（宁可标未定位，也不指到错的地方）
  ok('🔴 引文完全不存在 → -1（不瞎指）', locateQuote(TEXT, '这句话正文里根本没有') === -1)
  ok('空引文 → -1', locateQuote(TEXT, '') === -1)
  ok('空正文 → -1', locateQuote('', '任意引文') === -1)
  ok('引文过短（<4 字去空白后）不做模糊 → -1', locateQuote(TEXT, '寒冬') === -1)
}

// ---------- 2) segmentAt：三段边界 ----------
{
  const N = 300
  ok('at=0 → 前段', segmentAt(N, 0) === '前段')
  ok('at=99 → 前段（<1/3）', segmentAt(N, 99) === '前段')
  ok('at=120 → 中段', segmentAt(N, 120) === '中段')
  ok('at=199 → 中段（<2/3）', segmentAt(N, 199) === '中段')
  ok('at=220 → 后段', segmentAt(N, 220) === '后段')
  ok('at=299 → 后段', segmentAt(N, 299) === '后段')
  ok('at=-1（未定位）→ 未定位', segmentAt(N, -1) === PACE_SEG_UNKNOWN)
  ok('正文长度 0 → 未定位', segmentAt(0, 0) === PACE_SEG_UNKNOWN)
}

// ---------- 3) locateBeats：位置一律本地覆盖 ----------
{
  const beats = locateBeats(TEXT, [
    { kind: '打脸', quote: '夏'.repeat(8), note: '中段的一次打脸' },
    { kind: '揭秘', quote: '秋'.repeat(8) },
    { kind: '升级', quote: '这句不在正文里' },
  ])
  ok('三条都保留', beats.length === 3)
  ok('🔴 中段引文 → segment=中段（本地算，非模型说）', beats[0].segment === '中段')
  ok('中段引文 at=120', beats[0].at === 120, String(beats[0].at))
  ok('后段引文 → segment=后段', beats[1].segment === '后段')
  ok('找不到的引文 → segment=未定位', beats[2].segment === PACE_SEG_UNKNOWN)
  ok('找不到的引文 at=-1', beats[2].at === -1)
  ok('缺 kind 时补「未标注」', beats[1].kind === '揭秘' && beats[0].kind === '打脸')
  const b = locateBeats(TEXT, [{ kind: '', quote: '春'.repeat(5) }])
  ok('空 kind → 未标注', b[0].kind === '未标注')
}

// ---------- 4) buildDistribution：分布形态 ----------
{
  const mk = (segs: Array<'前段' | '中段' | '后段' | typeof PACE_SEG_UNKNOWN>): PaceBeat[] =>
    segs.map((s, i) => ({ kind: '打脸', quote: `q${i}`, segment: s, at: 0, note: '' }))

  const d0 = buildDistribution([])
  ok('0 个爆点 → 数据不足', d0.shape === '数据不足')
  ok('0 个爆点时给出说明', d0.note.includes('未识别到'))

  const d1 = buildDistribution(mk(['前段']))
  ok('1 个爆点 → 数据不足（不硬判形态）', d1.shape === '数据不足')

  const dTail = buildDistribution(mk(['前段', '中段', '中段']))
  ok('🔴 后段为 0 → 后段空转', dTail.shape === '后段空转')
  ok('后段空转的说明含"后段"', dTail.note.includes('后段'))
  ok('未定位计数为 0', dTail.未定位 === 0)

  const dHead = buildDistribution(mk(['前段', '前段', '前段', '中段', '后段']))
  ok('前段过半 → 集中于前段', dHead.shape === '集中于前段')

  const dEnd = buildDistribution(mk(['前段', '后段', '后段']))
  ok('后段最多 → 集中于后段', dEnd.shape === '集中于后段')

  const dEven = buildDistribution(mk(['前段', '中段', '后段']))
  ok('三段各一 → 分布均匀', dEven.shape === '分布均匀')

  const dUnknown = buildDistribution(mk(['前段', '中段', '未定位']))
  ok('未定位不计入三段（后段仍为 0 → 空转）', dUnknown.shape === '后段空转')
  ok('未定位在 note 里如实说明', dUnknown.note.includes('未计入'), dUnknown.note)
  ok('三段计数正确', dUnknown.前段 === 1 && dUnknown.中段 === 1 && dUnknown.后段 === 0)
}

// ---------- 5) 章末钩子区（本地事实） ----------
{
  const st = hookZoneStats(TEXT)
  const expect = Math.floor(TEXT.length * (1 - HOOK_ZONE_RATIO))
  ok('钩子区字符数 = 末段长度', st.chars === TEXT.length - expect, String(st.chars))
  ok('钩子区有内容', st.hasContent)
  ok('空正文 → 钩子区为空', hookZoneStats('').tail === '' && !hookZoneStats('').hasContent)
  ok('hookZoneSnippet 只取末尾片段', hookZoneSnippet(TEXT, 30).length <= 30)
  ok('hookZoneSnippet 落在正文末段', TEXT.endsWith(hookZoneSnippet(TEXT, 30)))
}

// ---------- 6) 宽松校验：normalizeBeats / toStringList / normalizeHookKind ----------
{
  ok('非数组 → []', normalizeBeats('不是数组').length === 0)
  ok('缺 quote 的条目被丢弃（无法定位）', normalizeBeats([
    { kind: '打脸', note: '没有引文' }, { kind: '升级', quote: '有引文' },
  ]).length === 1)
  ok('非对象条目被丢弃', normalizeBeats([1, null, 'x', { quote: 'y' }]).length === 1)
  ok('超量截断（max=3）', normalizeBeats(
    Array.from({ length: 10 }, (_, i) => ({ quote: `q${i}` })), 3,
  ).length === 3)

  ok('toStringList 非数组 → []', toStringList({}).length === 0)
  ok('toStringList 过滤非字符串与空串', toStringList(['a', '', 3, 'b ', null]).join(',') === 'a,b')
  ok('toStringList 截断', toStringList(['1', '2', '3', '4', '5'], 2).length === 2)

  ok('钩子枚举内的原样保留', normalizeHookKind('信息缺口') === '信息缺口')
  ok('枚举外的落回「悬念」（不抛）', normalizeHookKind('随便写的类型') === '悬念')
  ok('非字符串落回「悬念」', normalizeHookKind(123) === '悬念')
  ok('枚举覆盖 5 项', HOOK_KINDS.length === 5)
  ok('爽点类型与 hookpoints 表对齐（8 项）', PACE_BEAT_KINDS.length === 8)
  ok('三段枚举为 前/中/后', PACE_SEGMENTS.join('') === '前段中段后段')
}

// ---------- 7) parsePaceReport：完整 / 缺字段 / 截断 / 散文 ----------
{
  const good = JSON.stringify({
    hook: { present: true, kind: '信息缺口', evidence: '他抬头，看见城墙上站着一个不该出现的人', note: '抛出了新信息' },
    beats: [
      { kind: '打脸', quote: '夏'.repeat(8), note: '中段打脸' },
      { kind: '揭秘', quote: '秋'.repeat(8), note: '末段揭秘' },
    ],
    increments: ['揭示主角身世线索', '新增一名敌对角色'],
    observations: ['爆点集中在中后段', '章末留了信息缺口'],
    summary: '节奏偏后，章末钩子成立。',
  })
  const r = parsePaceReport(good, TEXT)
  ok('钩子类型解析正确', r.hookKind === '信息缺口')
  ok('钩子成立', r.hookPresent === true)
  ok('钩子依据保留', r.hookEvidence.includes('不该出现的人'))
  ok('爆点 2 条', r.beats.length === 2)
  ok('🔴 爆点位置由本地算（中段）', r.beats[0].segment === '中段')
  ok('分布形态算出（两条都在中后段 → 无前段）', r.distribution.shape === '集中于后段',
    r.distribution.shape)
  ok('信息增量 2 条', r.increments.length === 2)
  ok('观察 2 条', r.observations.length === 2)
  ok('summary 保留', r.summary.includes('节奏偏后'))
  ok('章末钩子区为本地事实（非 AI 提供）', r.hookZone.chars > 0)

  // 缺字段 → 全部兜底，不抛
  const bare = parsePaceReport('{}', TEXT)
  ok('空对象不抛且钩子按「无」处理前的默认值可用', typeof bare.hookKind === 'string')
  ok('空对象时爆点为空', bare.beats.length === 0)
  ok('空对象时分布为数据不足', bare.distribution.shape === '数据不足')
  ok('空对象时 summary 为空串', bare.summary === '')

  // 截断 JSON → 解析层兜底（不抛）
  const truncated = good.slice(0, Math.floor(good.length * 0.6))
  let threw = false
  let rt: ReturnType<typeof parsePaceReport> | null = null
  try { rt = parsePaceReport(truncated, TEXT) } catch { threw = true }
  ok('🔴 截断 JSON 不抛异常', !threw)
  ok('截断时也能给出某种结果', rt !== null)

  // 模型回了散文（完全不是 JSON）
  const prose = '本章节奏整体偏平，章末没有明显钩子。'
  let threw2 = false
  let rp: ReturnType<typeof parsePaceReport> | null = null
  try { rp = parsePaceReport(prose, TEXT) } catch { threw2 = true }
  ok('🔴 回散文时不抛异常', !threw2)
  ok('散文时降级为 summary（宁可少给，不给假的）', !!rp && rp.summary.includes('节奏'), rp?.summary ?? '')
  ok('散文时爆点为空（不臆造）', !!rp && rp.beats.length === 0)

  // present=false 与 kind='无' 的交叉
  const noHook = parsePaceReport(JSON.stringify({ hook: { present: false, kind: '无' } }), TEXT)
  ok('present=false + kind=无 → 不成立', !noHook.hookPresent)
  const lie = parsePaceReport(JSON.stringify({ hook: { present: true, kind: '无' } }), TEXT)
  ok('kind=无 时不因 present=true 而判成立', !lie.hookPresent)
}

// ---------- 8) 🔴 立场断言：不许出现反检测类表述 ----------
{
  const readAll = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
  const srcPace = readAll('src/lib/aiTasks/pace.ts')
  const srcLocal = readAll('src/lib/paceAnalysis.ts')
  const banned = ['规避检测', '降低AI命中', '降低 AI 命中', '命中率', '反检测', 'AI率', 'AI 率', '洗稿']

  ok('🔴 pace.ts 不含反检测类表述', banned.every(w => !srcPace.includes(w)),
    banned.filter(w => srcPace.includes(w)).join('/'))
  ok('🔴 paceAnalysis.ts 不含反检测类表述', banned.every(w => !srcLocal.includes(w)),
    banned.filter(w => srcLocal.includes(w)).join('/'))
  ok('提示词明确要求「不评分不排名」', srcPace.includes('不评分'))
  ok('提示词明确要求 quote 逐字照抄（位置靠它算）', srcPace.includes('逐字照抄'))
  ok('本地层注明「只描述形态，不做好坏评价」', srcLocal.includes('不做好坏评价') || srcLocal.includes('不含"好/差"评价'))
}

console.log(`\n  paceAnalysis: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
