// ============ 「没排满的卷」检测（缺口优先）的回归用例 ============
//
// 🔴 用例直接用**示范项目《吞天神脉》的真实字段值** —— 这是"缺口优先到底能不能实现"的实证：
//    老数据的卷卡没有「本卷章号范围」这一列（2026-09-20 才加的），章号范围只写在
//    「本卷章数预估」的自由文本里，格式还各不相同：
//      · 第一卷：`第1-10章，约四万六千字`            → 完整区间，直接解析
//      · 第三卷：`第21章起（已写第21章，约2200字）`   → 只有起点，得靠「每卷章数」推定上界
//    这两条解析不出来，整个"先把没排满的卷补满"就是空转。
//
// 老大给的原例：规划每卷 10 章、库里 3 卷 21 章 ⇒ 前两卷满、第三卷缺第 22-30 章（9 章）。
import { resolveSlot } from '../src/lib/flow/fieldMap'
import {
  detectVolumeGap, isPlaceholderText, isVolumeOutlineComplete, parseChapterRange,
  volumeBoundOf, volumeBoundTextsOf, type VolumeGap,
} from '../src/lib/outlineCard'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** schema 里的真实键（查不到的话下面全是空转，所以先断言它们存在） */
const EST_KEY = resolveSlot('volume-outline', '本卷章数预估')
const RANGE_KEY = resolveSlot('volume-outline', '本卷章号范围')

/** 按示范项目的真实键名造一张卷大纲卡 */
const cardOf = (estimate: string, range = ''): { data: Record<string, string> } => {
  const data: Record<string, string> = {}
  if (EST_KEY && estimate) data[EST_KEY] = estimate
  if (RANGE_KEY && range) data[RANGE_KEY] = range
  return { data }
}
const volOf = (name: string, estimate: string, range = '') =>
  ({ name, texts: volumeBoundTextsOf(cardOf(estimate, range)) })

// ---------- ① 槽位可查到（查不到 → 后面全空转） ----------
{
  ok('🔴 「本卷章数预估」能在 schema 里定位到真实键', !!EST_KEY, String(EST_KEY))
  ok('🔴 「本卷章号范围」能在 schema 里定位到真实键', !!RANGE_KEY, String(RANGE_KEY))
}

// ---------- ② 示范项目真实文本的解析 ----------
{
  ok('`第1-10章，约四万六千字` → 1~10（完整区间）',
    JSON.stringify(parseChapterRange('第1-10章，约四万六千字')) === JSON.stringify({ from: 1, to: 10 }),
    JSON.stringify(parseChapterRange('第1-10章，约四万六千字')))
  ok('`第21章起（已写第21章，约2200字）` → 21~21（只有起点）',
    JSON.stringify(parseChapterRange('第21章起（已写第21章，约2200字）')) === JSON.stringify({ from: 21, to: 21 }),
    JSON.stringify(parseChapterRange('第21章起（已写第21章，约2200字）')))
  ok('「到 / 至 / ～」都认（作者手改过卷边界就靠这个）',
    parseChapterRange('第11到20章')?.to === 20 && parseChapterRange('第11至20章')?.to === 20
    && parseChapterRange('第11～20章')?.to === 20)
  ok('解析不出章号 → null（不瞎猜）',
    parseChapterRange('约四万六千字') === null && parseChapterRange('') === null)
}

// ---------- ③ 卷边界三级取用 ----------
{
  ok('① 优先用「本卷章号范围」（系统排纲时写的那一列，权威）',
    volumeBoundOf(volumeBoundTextsOf(cardOf('第1-10章', '第5-25章')), 10)?.to === 25)
  ok('② 没有它时用「本卷章数预估」里的完整区间',
    volumeBoundOf(volumeBoundTextsOf(cardOf('第1-10章')), 10)?.to === 10)
  ok('③ 只有起点（`第21章起`）→ 用「每卷章数」把上界补成 21+10-1 = 30',
    volumeBoundOf(volumeBoundTextsOf(cardOf('第21章起（已写第21章）')), 10)?.to === 30)
  ok('两边都没有 → null（边界不可知就不猜）',
    volumeBoundOf(volumeBoundTextsOf({ data: {} }), 10) === null)
}

// ---------- ④ 核心场景：示范项目 3 卷 21 章 → 该补第三卷 9 章 ----------
{
  const vols = [
    volOf('第一卷 风起云州', '第1-10章，约四万六千字'),
    volOf('第二卷 剑鸣中州', '第11-20章，约四万六千字'),
    volOf('第三卷 剑锁中州', '第21章起（已写第21章，约2200字）'),
  ]
  const gap: VolumeGap | null = detectVolumeGap(vols, 21, 10)
  ok('🔴 缺口卷＝第三卷（前两卷已排满）', gap?.title === '第三卷 剑锁中州', String(gap?.title))
  ok('🔴 该卷目标范围＝第21-30章（起点 + 每卷章数推定）',
    gap?.from === 21 && gap?.to === 30, `${gap?.from}-${gap?.to}`)
  ok('🔴 缺口＝第22-30章，共 9 章（老大给的原例）',
    gap?.gapFrom === 22 && gap?.gapTo === 30 && (gap.gapTo - gap.gapFrom + 1) === 9,
    `${gap?.gapFrom}-${gap?.gapTo}`)

  ok('细纲只排到第 25 章 → 缺口收敛为 26-30（不重复已排的章）',
    (() => { const g = detectVolumeGap(vols, 25, 10); return g?.gapFrom === 26 && g?.gapTo === 30 })())
  ok('三卷都排满（细纲到 30）→ 无缺口（该轮到新卷了）', detectVolumeGap(vols, 30, 10) === null)
  ok('细纲已超出卷范围（到 40）→ 无缺口', detectVolumeGap(vols, 40, 10) === null)
  ok('细纲只到第 5 章 → 缺口在第一卷（第 6-10 章）',
    (() => {
      const g = detectVolumeGap(vols, 5, 10)
      return g?.title === '第一卷 风起云州' && g.gapFrom === 6 && g.gapTo === 10
    })())
  ok('所有卷都没有范围信息 → null（宁可退回"新开卷"，也不瞎猜）',
    detectVolumeGap([volOf('第一卷', ''), volOf('第二卷', '')], 21, 10) === null)
  ok('每卷章数改了，推定出的上界跟着变（M=20 → 21-40，缺 19 章）',
    detectVolumeGap(vols, 21, 20)?.gapTo === 40)
  ok('「本卷章号范围」优先于「本卷章数预估」（系统写的赢过作者的自由文本）',
    detectVolumeGap([volOf('第一卷', '第1-10章', '第1-30章')], 21, 10)?.to === 30)
}

// ---------- ⑤ 卷大纲「完整性」：决定缺口补齐时要不要顺带补卷大纲 ----------
{
  const coreOf = (climax1: string, turn: string, climax2: string, ending: string): { data: Record<string, string> } => {
    const data: Record<string, string> = {}
    const put = (slot: string, v: string) => { const k = resolveSlot('volume-outline', slot); if (k) data[k] = v }
    put('第一大高潮', climax1)
    put('卷中转折', turn)
    put('卷末高潮', climax2)
    put('本卷结尾（卷末状态）', ending)
    return { data }
  }
  ok('`（待写）` / `（待定）` / 空串都算占位',
    isPlaceholderText('（待写）') && isPlaceholderText('（待定）') && isPlaceholderText(''))
  ok('但有实质内容的不算 —— `凝罡一重 → （待定）` 给出了信息，不能判成"没写"',
    !isPlaceholderText('凝罡一重 → （待定）'))
  ok('🔴 四个关键字段全是「（待写）」→ 判为不完整（示范项目第三卷就是这个样子）',
    isVolumeOutlineComplete(coreOf('（待写）', '（待写）', '（待写）', '（待写）')) === false)
  ok('🔴 第一卷那种写实的卷大纲 → 判为完整（一个字都不该被覆盖）',
    isVolumeOutlineComplete(coreOf(
      '第4章雨夜截杀：神体爆发反杀聚灵一重，重伤昏迷三日',
      '第5章外门大比夺魁打脸全场（回收F0004桂花糖）',
      '第9章南荒道夜袭血魔教暗桩；第10章秘境入口反杀顾长风',
      '聚灵一重、携两道残简出秘境，立誓封回封仙路',
    )) === true)
  ok('四个核心字段都没值 → 判为不完整（这张卷卡确实还没规划）',
    isVolumeOutlineComplete({ data: {} }) === false)
  ok('只有一个字段是「（待写）」也判为不完整（够不够细看的是最弱的那一项）',
    isVolumeOutlineComplete(coreOf('第4章雨夜截杀', '（待写）', '第9章夜袭', '聚灵一重出秘境')) === false)
}

console.log(`\n—— volumeGap 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
