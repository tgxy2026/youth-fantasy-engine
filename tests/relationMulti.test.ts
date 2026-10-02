// ============ 同一对实体多条关系（2026-10-02 · 2.7.2）============
//
// 本次改造把两张关系表的判重从「无序对 (A,B)」改为「有向对 + 关系类型 (A,B,类型)」，
// 并让两张关系图把同一对的多条关系**分弧铺开 + 箭头标方向**、自定义类型走统一配色。
// 这些保证一旦写错都是**静默**的（AI 少产出条目 / 图上两条边重叠或同色），故单测钉住：
//   ① 判重键含「关系类型」、且配对表是**有向**（不排序）；
//   ② 平行边的曲率序列确定、同号递增（同号才能让正反向边分居两侧）；
//   ③ 自定义类型配色：同图内互不同色、稳定可复现。
import { isDirectedPairTab, organizeKeyColumns } from '../src/lib/aiScope'
import { TABS } from '../src/lib/schema'
import { pairKey, edgeCurveRatios, curveArrow } from '../src/lib/graphGrouping'
import { buildTypeColors, makeColorLookup, hashColor, typeHash, REL_EXTRA_PALETTE } from '../src/lib/relationColors'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ relationMulti')

// ---------- 1. 判重键：有向对 + 关系类型 ----------
{
  const rel = TABS.find(t => t.id === 'relations')!
  const fac = TABS.find(t => t.id === 'faction-rels')!
  ok('人物关系判重键 = 人物A + 人物B + 关系类型',
    organizeKeyColumns(rel).join('|') === '人物A|人物B|关系类型', organizeKeyColumns(rel).join('|'))
  ok('势力关系判重键 = 势力A + 势力B + 关系类型',
    organizeKeyColumns(fac).join('|') === '势力A|势力B|关系类型', organizeKeyColumns(fac).join('|'))
  ok('两张关系表都是「有向对」（不排序、反向算两条）',
    isDirectedPairTab('relations') && isDirectedPairTab('faction-rels'))
  ok('非配对表不是有向对（判重键扩展不误伤其它表）',
    !isDirectedPairTab('nations') && !isDirectedPairTab('history') && !isDirectedPairTab(''))
}

// ---------- 2. 视觉分组用「无序对」键（正反向同走廊）----------
{
  ok('pairKey：A-B 与 B-A 同键（视觉上归一条走廊）', pairKey('张三', '李四') === pairKey('李四', '张三'))
  ok('pairKey：不同对 → 不同键', pairKey('张三', '李四') !== pairKey('张三', '王五'))
}

// ---------- 3. 平行边曲率 ----------
{
  const r1 = edgeCurveRatios(1)
  ok('单条边：给一个基础曲率（与改造前视觉一致，约 0.18）', r1.length === 1 && Math.abs(r1[0] - 0.18) < 1e-9, JSON.stringify(r1))
  const r3 = edgeCurveRatios(3)
  ok('三条边：3 个曲率、逐条递增', r3.length === 3 && r3[0] < r3[1] && r3[1] < r3[2], JSON.stringify(r3))
  ok('🔴 曲率**同号**（同号才能让 A→B 与 B→A 因坐标翻转分居两侧、不重叠）',
    r3.every(v => v > 0), JSON.stringify(r3))
  ok('大 k 不爆：曲率被封顶（≤ 0.75），不会甩出画面',
    edgeCurveRatios(20).every(v => v <= 0.75), String(Math.max(...edgeCurveRatios(20))))
  ok('确定性：同样 k 两次调用逐位一致', JSON.stringify(edgeCurveRatios(4)) === JSON.stringify(edgeCurveRatios(4)))
}

// ---------- 4. 方向箭头 ----------
{
  const d = curveArrow(0, 0, 100, 0, 0.18)
  ok('curveArrow：输出是闭合路径（M ... Z）', d.startsWith('M ') && d.trim().endsWith('Z'), d.slice(0, 24))
  ok('curveArrow：无 NaN（坐标全是有限数）', !/NaN/.test(d))
  const d2 = curveArrow(100, 0, 0, 0, 0.18)
  ok('curveArrow：反向边箭头落在另一端（方向标对）', d2 !== d && !/NaN/.test(d2))
}

// ---------- 5. 类型配色：内置精调 + 自定义互不同色 ----------
{
  const preset: Record<string, string> = { '盟友': '#8fb4e8', '敌对': '#e57070' }
  const types = ['盟友', '敌对', '联姻', '宿敌', '暗中提防']
  const m = buildTypeColors(types, preset)
  ok('内置类型取精调色', m.get('盟友') === '#8fb4e8' && m.get('敌对') === '#e57070')
  const customColors = types.filter(t => !preset[t]).map(t => m.get(t)!)
  ok('🔴 自定义类型在本图内互不同色（撞色兜底生效）',
    new Set(customColors).size === customColors.length, customColors.join(','))
  const all = types.map(t => m.get(t)!)
  ok('🔴 全类型（含内置）在本图内互不同色', new Set(all).size === all.length, all.join(','))
  ok('自定义色不撞内置色', customColors.every(c => c !== '#8fb4e8' && c !== '#e57070'))
  ok('确定性：同输入两次构建同结果',
    JSON.stringify([...buildTypeColors(types, preset)]) === JSON.stringify([...m]))
}

// ---------- 6. 撞色兜底：强行构造两个哈希同槽的类型 ----------
{
  // 找两个落进同一色槽的类型名
  const names = Array.from({ length: 500 }, (_, i) => `类型${i}`)
  const seen = new Map<number, string>()
  let a = '', b = ''
  for (const n of names) {
    const slot = typeHash(n) % REL_EXTRA_PALETTE.length
    const prev = seen.get(slot)
    if (prev) { a = prev; b = n; break }
    seen.set(slot, n)
  }
  ok('测试前提：确实找得到两个哈希同槽的类型', !!a && !!b, `${a} / ${b}`)
  const m = buildTypeColors([a, b], {})
  ok('🔴 哈希撞槽的两个类型仍得到**不同**颜色（线性探测顺延）',
    m.get(a) !== m.get(b), `${m.get(a)} vs ${m.get(b)}`)
  ok('无冲突时颜色 = 纯哈希色（零回归）', m.get(a) === hashColor(a))
  ok('makeColorLookup：未喂入的类型回落哈希色', makeColorLookup(m)('未登记类型') === hashColor('未登记类型'))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} relationMulti 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
