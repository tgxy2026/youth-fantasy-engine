// ============ 关系图与时间线的可视化算法（2026-10-02 · 2.7.2 可视化升级）============
//
// 这两个模块是四个视图的共同地基，算法错了会**静默画歪**（不像 UI 那样一眼能看出来），
// 所以必须钉住四条最要紧的保证：
//   ① **确定性**：力导向不用随机数 ⇒ 同一份数据每次打开布局逐位一致（读者心智地图不漂移）；
//   ② **不越界**：所有节点坐标钳制在画布内（pad 之内），否则节点会被拖出视野后「消失」；
//   ③ **凸包正确**：内部点与共线点必须被剔除，否则分组轮廓会画出多余的尖角；
//   ④ **弧线方向确定**：正反向边弯曲方向相反 ⇒ 一对节点之间的两条关系能分开、不重叠。
import { convexHull, hullPath, curvedEdge, curveMidpoint, groupBy, groupColor, GROUP_NEUTRAL } from '../src/lib/world/graphGrouping'
import { forceLayout } from '../src/lib/world/forceLayout'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ graphVisual')

// ---------- 1. groupBy ----------
{
  const g = groupBy([{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }], x => x.k)
  ok('groupBy：正确分组', g.size === 2 && g.get('a')!.length === 2 && g.get('b')!.length === 1)
  ok('groupBy：保持首次出现顺序', [...g.keys()].join(',') === 'a,b')
  ok('groupBy：空输入 → 空映射', groupBy([], (x: { k: string }) => x.k).size === 0)
}

// ---------- 2. groupColor ----------
{
  ok('groupColor：同名恒定同色', groupColor('青岚宗') === groupColor('青岚宗'))
  ok('groupColor：空名 → 中性色（不属于任何阵营）', groupColor('') === GROUP_NEUTRAL)
  const set = new Set(['青岚宗', '血魔道', '萧家', '散修盟', '天庭'].map(groupColor))
  ok('groupColor：多个不同分组色值不塌缩为同一色', set.size >= 4, `去重后 ${set.size} 色`)
}

// ---------- 3. convexHull ----------
{
  const square = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    { x: 5, y: 5 },
  ]
  const hull = convexHull(square)
  ok('convexHull：正方形 + 内部点 → 4 个顶点', hull.length === 4, `实得 ${hull.length}`)
  ok('convexHull：内部点被剔除', !hull.some(p => p.x === 5 && p.y === 5))

  const collinear = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
  ok('convexHull：共线中间点被剔除', convexHull(collinear).length === 3, `实得 ${convexHull(collinear).length}`)

  ok('convexHull：单点原样返回', convexHull([{ x: 1, y: 1 }]).length === 1)
  ok('convexHull：两点原样返回', convexHull([{ x: 1, y: 1 }, { x: 2, y: 2 }]).length === 2)
  ok('convexHull：空输入 → 空数组', convexHull([]).length === 0)
}

// ---------- 4. hullPath ----------
{
  ok('hullPath：空顶点 → 空串', hullPath([]) === '')
  const p = hullPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }])
  ok('hullPath：闭合路径（M 开头 / Z 结尾）', p.startsWith('M') && p.endsWith('Z'))
  ok('hullPath：多边形走圆角（含 Q 指令）', p.includes('Q'))
  const single = hullPath([{ x: 50, y: 50 }])
  ok('hullPath：单顶点 → 圆形（含 a 弧线指令）', single.includes('a'))
  const two = hullPath([{ x: 0, y: 0 }, { x: 100, y: 0 }])
  ok('hullPath：两顶点 → 胶囊（含 A 弧线指令）', two.includes('A') && two.endsWith('Z'))
}

// ---------- 5. curvedEdge / curveMidpoint ----------
{
  const forward = curvedEdge(0, 0, 100, 0)
  const backward = curvedEdge(100, 0, 0, 0)
  ok('curvedEdge：M 开头 + Q 二次曲线', forward.startsWith('M 0.0 0.0') && forward.includes('Q'))
  ok(
    'curvedEdge：正反向边弯曲方向相反（平行边可分离）',
    forward.includes('50.0 18.0') && backward.includes('50.0 -18.0'),
    `${forward.split('Q')[1]} vs ${backward.split('Q')[1]}`,
  )
  const mid = curveMidpoint(0, 0, 100, 0)
  ok('curveMidpoint：落在两端点之间', mid.x > 0 && mid.x < 100)
  ok('curveMidpoint：偏离直线（确实是弧线中点）', Math.abs(mid.y) > 1, `y=${mid.y}`)
  ok('curveMidpoint：零长边不产生 NaN', Number.isFinite(curveMidpoint(5, 5, 5, 5).x))
}

// ---------- 6. forceLayout ----------
{
  ok('forceLayout：空输入 → 空映射', forceLayout([], [], { w: 100, h: 100 }).size === 0)

  const one = forceLayout(['A'], [], { w: 200, h: 100 })
  ok('forceLayout：单节点落在画布中心', one.get('A')!.x === 100 && one.get('A')!.y === 50)

  const edges = [{ a: 'A', b: 'B' }, { a: 'B', b: 'C' }]
  const run1 = forceLayout(['A', 'B', 'C', 'D'], edges, { w: 400, h: 300 })
  const run2 = forceLayout(['A', 'B', 'C', 'D'], edges, { w: 400, h: 300 })
  ok(
    '🔴 forceLayout：确定性 —— 两次运行逐位一致（不使用随机数）',
    ['A', 'B', 'C', 'D'].every(n => run1.get(n)!.x === run2.get(n)!.x && run1.get(n)!.y === run2.get(n)!.y),
  )

  ok(
    'forceLayout：全部坐标钳制在 pad 内（节点不会被推出视野）',
    [...run1.values()].every(p => p.x >= 30 && p.x <= 370 && p.y >= 30 && p.y <= 270),
  )

  // 孤立节点（互相排斥、无任何边）：全部被挡在 pad 边界内 → 「防飘出视野」由边界钳制保证。
  // 2026-10-02 探针实测：若给一个「中心弱引力」（d += (center-p)×gravity），要 gravity≈2 才生效
  // （斥力是 k²/dist，量纲不匹配，小值完全无效），故该参数已从 forceLayout 删除。
  const isolated = forceLayout(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], [], { w: 400, h: 400, iterations: 400 })
  const spread = (m: Map<string, { x: number; y: number }>) =>
    Math.max(...[...m.values()].map(p => Math.hypot(p.x - 200, p.y - 200)))
  ok(
    'forceLayout：孤立节点也被挡在边界内（防飘由钳制保证）',
    spread(isolated) <= Math.hypot(170, 170) + 1e-6,
    `spread=${spread(isolated).toFixed(1)} ≤ ${Math.hypot(170, 170).toFixed(1)}`,
  )

  const linkDist = (m: Map<string, { x: number; y: number }>, x: string, y: string) =>
    Math.hypot(m.get(x)!.x - m.get(y)!.x, m.get(x)!.y - m.get(y)!.y)
  const wired = forceLayout(['A', 'B', 'C', 'D', 'E', 'F'], [{ a: 'A', b: 'B' }], { w: 600, h: 400, iterations: 400 })
  ok('forceLayout：有边的两个节点被拉近（引力生效）', linkDist(wired, 'A', 'B') < linkDist(wired, 'A', 'D'))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} graphVisual —— ${pass} PASS / ${fail} FAIL\n`)
if (fail) process.exit(1)
