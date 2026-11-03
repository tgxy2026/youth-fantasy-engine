/**
 * 2.5.0 · A2 全书结构配比对照 —— 单测（纯本地计算层）
 *
 * 测的是最容易算错、且错了最误导人的四块：
 *   ① 占比与累计轴：share 之和恒为 100（最大余数法）、轴连续无缝、words=0 的章不参与
 *   ② 位置归属：每章**恰归一拍**（既不重复计、也不漏计）、拍的实际占比之和恒为 100
 *   ③ 偏差能显现：前重后轻的数据必须量得出「建置偏多 / 解决偏少」
 *      （🔴 回归警示：字数累计轴中点归属是同义反复，量不出任何偏差 —— 别改回去）
 *   ④ 偏差三档与方向：delta 正负与 note 文案一致（偏多/偏少不能说反）
 * 以及立场断言：note 是描述性观察，不得出现「达标 / 评分 / 不合格」一类判定表述。
 */
import { STORY_TEMPLATES, getStoryTemplate } from '../src/lib/outline/storyStructures'
import {
  buildChapterShares, alignBeats, alignHooks, PACE_MIN_CHAPTERS, PACE_LEVEL_LABEL,
  type PaceChapterInput, type ChapterShare,
} from '../src/lib/outline/structurePace'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const mk = (words: number[], base = '章'): PaceChapterInput[] =>
  words.map((w, i) => ({ id: `c${i}`, title: `${base}${i + 1}`, words: w }))

console.log('\n▶ structurePace')

// ---------- 1) buildChapterShares：占比与累计轴 ----------
{
  const { shares, totalWords } = buildChapterShares(mk([100, 200, 300, 400]))
  ok('总字数正确', totalWords === 1000)
  ok('share 之和 = 100（最大余数法，精确）', shares.reduce((s, c) => s + c.share, 0) === 100,
    shares.map(c => c.share).join(','))
  ok('累计轴连续无缝', shares.every((c, i) => i === 0 || shares[i - 1].to === c.from))
  ok('首章从 0 起、末章到 100 收', shares[0].from === 0 && shares[shares.length - 1].to === 100)
  ok('序号从 1 起', shares.every((c, i) => c.no === i + 1))
  ok('share 与字数成正比', shares[3].share === 40)
}
{
  // 非整除数据（逐章 round1 会漂移的场景）：20 章 100+(i%3)，总 2010
  const { shares } = buildChapterShares(mk(Array.from({ length: 20 }, (_, i) => 100 + (i % 3))))
  ok('非整除 20 章 share 之和仍 = 100', shares.reduce((s, c) => s + c.share, 0) === 100,
    shares.map(c => c.share).join(','))
  ok('每章与真实占比偏差 < 0.1pp', shares.every((c) => {
    const real = (c.words / 2010) * 100
    return Math.abs(c.share - real) < 0.1
  }))
}
{
  const { shares, totalWords } = buildChapterShares(mk([100, 0, 300]))
  ok('words=0 的章不参与', shares.length === 2 && totalWords === 400)
  ok('words=0 的章不占轴', shares.every(c => c.share > 0))
}
{
  const r = buildChapterShares([])
  ok('空数组不炸', r.shares.length === 0 && r.totalWords === 0)
  const r2 = buildChapterShares(mk([0, 0]))
  ok('全 0 不炸（占比全 0）', r2.shares.length === 0 && r2.totalWords === 0)
}

// ---------- 2) 位置归属：每章恰归一拍 ----------
const uniform = buildChapterShares(mk(Array.from({ length: 20 }, (_, i) => 100 + (i % 3)))).shares
for (const tpl of STORY_TEMPLATES) {
  const al = alignBeats(tpl, uniform)
  const covered = al.reduce((s, a) => s + a.chapters.length, 0)
  ok(`[${tpl.id}] 每章恰归一拍（无重复无遗漏）`, covered === uniform.length, `${covered}/${uniform.length}`)
  ok(`[${tpl.id}] 各拍实际占比之和 = 100`, al.reduce((s, a) => s + a.actualPct, 0) === 100)
  ok(`[${tpl.id}] 理想占比之和 = 100`, al.reduce((s, a) => s + a.idealPct, 0) === 100)
}

// ---------- 3) 偏差能显现 + 三档方向 ----------
{
  const tpl = getStoryTemplate('three-act')!
  const even = buildChapterShares(mk(Array.from({ length: 20 }, () => 100))).shares
  const al = alignBeats(tpl, even)
  ok('均匀 20 章 → 三幕 5/10/5 章', al.map(a => a.chapters.length).join('/') === '5/10/5',
    al.map(a => a.chapters.length).join('/'))
  ok('均匀 20 章 → 三档全「贴合」', al.every(a => a.level === 'ok'))
  ok('各拍理想占比 25/50/25', al.map(a => a.idealPct).join('/') === '25/50/25')
}
{
  // 温和前重后轻：前 10 章每章 3000、后 10 章每章 1000 → 前 10 章占 75% 字数。
  // 位置轴归属：建置 = 第 1-5 章（37.5% vs 25% → 轻微偏多）、
  //             对抗 = 第 6-15 章（50% vs 50% → 贴合）、解决 = 第 16-20 章（12.5% vs 25% → 轻微偏少）。
  const tpl = getStoryTemplate('three-act')!
  const skewed = buildChapterShares(mk([
    ...Array.from({ length: 10 }, () => 3000),
    ...Array.from({ length: 10 }, () => 1000),
  ])).shares
  const al = alignBeats(tpl, skewed)
  ok('温和前重后轻 → 建置 37.5% 轻微偏多',
    al[0].actualPct === 37.5 && al[0].level === 'slight' && al[0].delta > 0,
    `${al[0].actualPct}% (${al[0].delta > 0 ? '+' : ''}${al[0].delta})`)
  ok('温和前重后轻 → 对抗 50% 贴合', al[1].actualPct === 50 && al[1].level === 'ok',
    `${al[1].actualPct}%`)
  ok('温和前重后轻 → 解决 12.5% 偏少', al[2].actualPct === 12.5 && al[2].delta < 0,
    `${al[2].actualPct}% (${al[2].delta})`)
}
{
  // 极端前重后轻：前 5 章每章 3000、后 15 章每章 500 → 前 5 章占 2/3 字数。
  // 位置轴归属：建置 = 第 1-5 章 → 67%（vs 25%，明显偏多）、解决 = 第 16-20 章 → 11%（偏少）。
  const tpl = getStoryTemplate('three-act')!
  const extreme = buildChapterShares(mk([
    ...Array.from({ length: 5 }, () => 3000),
    ...Array.from({ length: 15 }, () => 500),
  ])).shares
  const al = alignBeats(tpl, extreme)
  ok('极端前重后轻 → 建置明显偏多（notable）', al[0].level === 'notable' && al[0].delta > 0,
    `${al[0].actualPct}% (${al[0].delta > 0 ? '+' : ''}${al[0].delta})`)
  ok('极端前重后轻 → 解决偏少', al[2].delta < 0)
  ok('偏少的 note 说「少」、偏多的 note 说「多」',
    (al[0].note.includes('多') && !al[0].note.includes('少')) &&
    (al[2].note.includes('少') && !al[2].note.includes('多')))
  ok('note 带具体数字', al[0].note.includes(String(Math.round(Math.abs(al[0].delta) * 10) / 10)))
}

// ---------- 4) 阈值边界：5pp 贴合 / 15pp 轻微，越界升档 ----------
{
  // 受控构造：N=100 个章，位置 = i+0.5（%）。位置粒度 1% ⇒ 任何 ≥1% 宽的拍都恰有
  // 整数个章落位（宽 w% 的拍含 w 个位置）——给「落在本拍内的第一个章」指定
  // share = actualPct、本拍内其余章 share = 0，即可精确控制该拍实际占比，
  // 单独验证 alignBeats 的档位判定（归属正确性已由第 2、3 节覆盖）。
  const caseOf = (tplId: string, beatName: string, actualPct: number) => {
    const tpl = getStoryTemplate(tplId)!
    const n = 100
    const focus = tpl.beats.findIndex(b => b.name === beatName)
    let used = false
    const rows: ChapterShare[] = Array.from({ length: n }, (_, i) => {
      const pos = ((i + 0.5) / n) * 100
      const bi = tpl.beats.findIndex(b => pos >= b.from && pos < b.to)
      const share = bi === focus ? (used ? 0 : (used = true, actualPct)) : 1
      return { id: `s${i}`, title: `s${i}`, words: 1000, no: i + 1, share, from: pos, to: pos + 1 }
    })
    return alignBeats(tpl, rows).find(a => a.name === beatName)!
  }
  // 正向（十五拍 · 催化剂，理想 2%）
  ok('+5pp 仍为贴合（边界含）', caseOf('stc-15', '催化剂', 7).level === 'ok', `delta=${caseOf('stc-15', '催化剂', 7).delta}`)
  ok('+10pp 为轻微偏移', caseOf('stc-15', '催化剂', 12).level === 'slight', `delta=${caseOf('stc-15', '催化剂', 12).delta}`)
  ok('+20pp 为明显偏移', caseOf('stc-15', '催化剂', 22).level === 'notable', `delta=${caseOf('stc-15', '催化剂', 22).delta}`)
  // 负向（三幕式 · 建置，理想 25%）
  ok('-12pp 为轻微偏移', caseOf('three-act', '建置', 13).level === 'slight', `delta=${caseOf('three-act', '建置', 13).delta}`)
  ok('-22pp 为明显偏移', caseOf('three-act', '建置', 3).level === 'notable', `delta=${caseOf('three-act', '建置', 3).delta}`)
  // 窄拍不虚报：理想 2% 实际 0 只差 -2pp ⇒ 仍是贴合（不能因为"完全没有"就升档）
  ok('-2pp 仍为贴合（窄拍不虚报）', caseOf('stc-15', '催化剂', 0).level === 'ok', `delta=${caseOf('stc-15', '催化剂', 0).delta}`)
}

// ---------- 5) 立场断言：只描述不判定 ----------
{
  const tpl = getStoryTemplate('three-act')!
  const al = alignBeats(tpl, uniform)
  const banned = ['达标', '评分', '不合格', '应达到', '必须达到']
  ok('note 无判定性措辞', al.every(a => banned.every(w => !a.note.includes(w))))
  ok('三档标签齐备且无判定语气',
    PACE_LEVEL_LABEL.ok === '贴合' && PACE_LEVEL_LABEL.slight === '轻微偏移' && PACE_LEVEL_LABEL.notable === '明显偏移')
  ok('门槛常量 = 10（面板层判，lib 不硬算）', PACE_MIN_CHAPTERS === 10)
}

console.log(`\n  结果：${pass} pass / ${fail} fail`)
if (fail > 0) process.exit(1)

// ---------- 6) alignHooks：爽点分布逐拍归属（R4b · 2.6.0） ----------
{
  const tpl = getStoryTemplate('three-act')!
  // 基本归属：M = 已写 10 章；章 1(pos 5)→建置 / 章 5(pos 45)→对抗 / 章 9(pos 85)→解决
  const r1 = alignHooks(tpl, [
    { no: 1, kind: '打脸' }, { no: 5, kind: '升级' }, { no: 9, kind: '打脸' },
  ], 10)
  ok('爽点归属·建置 1 个', r1[0].count === 1, `got ${r1[0].count}`)
  ok('爽点归属·对抗 1 个', r1[1].count === 1, `got ${r1[1].count}`)
  ok('爽点归属·解决 1 个', r1[2].count === 1, `got ${r1[2].count}`)
  ok('爽点 pct = 行数占比', r1[0].pct === 33.3, `got ${r1[0].pct}`)
  ok('爽点 kinds 保序去重', r1[0].kinds.length === 1 && r1[0].kinds[0] === '打脸'
    && r1[2].kinds[0] === '打脸')
  // 尺度扩展：爽点表排到章 15 > 已写 10 ⇒ M 取 15，pos(15)≈96.7 → 解决（不溢出丢失）
  const r2 = alignHooks(tpl, [{ no: 15, kind: '逆转' }], 10)
  ok('爽点表领先正文·M 取最大章号', r2[2].count === 1 && r2[0].count === 0 && r2[1].count === 0)
  // 空：无爽点行 ⇒ 全 0（面板据此不渲染爽点带）
  const r3 = alignHooks(tpl, [], 10)
  ok('无爽点行·全 0', r3.every(b => b.count === 0 && b.pct === 0))
  // 立场：归属覆盖 [0,100) 无缝 —— 任何章号都不丢（抽 30 个章号全落进某一拍）
  const r4 = alignHooks(tpl, Array.from({ length: 30 }, (_, i) => ({ no: i + 1, kind: '升级' })), 30)
  ok('30 行爽点全部归位不丢', r4.reduce((s, b) => s + b.count, 0) === 30)
}
