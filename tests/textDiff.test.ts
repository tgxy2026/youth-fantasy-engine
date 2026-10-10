// ============ 行级差异（2.4.0 · A3）============
//
// 「时光机」升级后要回答的问题只有一个：**这一版到那一版，改了哪些段落**。
// 所以本用例盯四件事：
//   ① 差异必须**精确定位**（只改一行时，其余行必须原样标为 same，不能整段报"全变了"）；
//   ② 纯新增 / 纯删除 / 空内容的边界；
//   ③ 🔴 **公共前后缀剪枝有效**（这是性能保护的核心：长篇两版通常只差中间一小段）；
//   ④ 规模超限时退化为"整段替换"仍要返回**结构正确**的结果（不能抛错、不能卡死）。
import { diffLines, diffStats, type DiffLine } from '../src/lib/editor/textDiff'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const shape = (d: DiffLine[]) => d.map(l => `${l.kind[0]}:${l.text}`).join('|')
const kinds = (d: DiffLine[]) => d.map(l => l.kind).join(',')

// ---------- ① 完全相同 ----------
{
  const text = ['第一段', '第二段', '第三段'].join('\n')
  const d = diffLines(text, text)
  ok('① 完全相同时全部标 same', kinds(d) === 'same,same,same', shape(d))
  ok('① content 原样返回', d.map(l => l.text).join('\n') === text)
  const st = diffStats(d)
  ok('① 统计为 0 / 0', st.added === 0 && st.deleted === 0, JSON.stringify(st))
}

// ---------- ② 只改中间一行：其余必须保持 same（精确定位） ----------
{
  const before = ['第一段', '第二段', '第三段'].join('\n')
  const after = ['第一段', '第二段改了', '第三段'].join('\n')
  const d = diffLines(before, after)
  console.log('  · 单行改动：' + shape(d))
  ok('🔴 只改一行时首行仍为 same（没有被整段判成"全变了"）', d[0].kind === 'same', kinds(d))
  ok('🔴 只改一行时末行仍为 same', d[d.length - 1].kind === 'same', kinds(d))
  ok('🔴 中间那行被标为"一删一增"', kinds(d) === 'same,del,add,same', kinds(d))
  const st = diffStats(d)
  ok('② 统计：新增 1 / 删除 1 / 改动约 1', st.added === 1 && st.deleted === 1 && st.changed === 1, JSON.stringify(st))
}

// ---------- ③ 纯新增 / 纯删除 ----------
{
  const d1 = diffLines('甲\n乙', '甲\n乙\n丙')
  ok('③ 尾部纯新增', kinds(d1) === 'same,same,add', kinds(d1))

  const d2 = diffLines('甲\n乙\n丙', '甲\n乙')
  ok('③ 尾部纯删除', kinds(d2) === 'same,same,del', kinds(d2))

  const d3 = diffLines('', '新的一行')
  ok('③ 旧为空 → 全部新增', kinds(d3) === 'add' && d3[0].text === '新的一行', kinds(d3))

  const d4 = diffLines('要删掉的', '')
  ok('③ 新为空 → 全部删除', kinds(d4) === 'del', kinds(d4))
}

// ---------- ④ 多行替换 + 公共前后缀剪枝 ----------
{
  const before = ['A', 'B', 'C', 'D', 'E', 'F'].join('\n')
  const after = ['A', 'B', 'X', 'Y', 'F'].join('\n')   // 中间 C/D/E → X/Y
  const d = diffLines(before, after)
  console.log('  · 中段替换：' + kinds(d))
  ok('④ 前缀 A/B 保持 same', d.slice(0, 2).every(l => l.kind === 'same'))
  ok('④ 后缀 F 保持 same', d[d.length - 1].kind === 'same' && d[d.length - 1].text === 'F')
  ok('④ 中段确实报了增删', d.some(l => l.kind === 'add') && d.some(l => l.kind === 'del'))
  // 剪枝的直接证据：相同的行**只出现一次 same**，没有被重复输出
  const sameTexts = d.filter(l => l.kind === 'same').map(l => l.text)
  ok('④ 剪枝后公共行各只出现一次', JSON.stringify(sameTexts) === JSON.stringify(['A', 'B', 'F']), JSON.stringify(sameTexts))
}

// ---------- ⑤ 前后缀同时变化（退化为纯 DP） ----------
{
  const d = diffLines('甲\n乙\n丙', '甲改\n乙\n丙改')
  ok('⑤ 首尾都变、中间不变 → 中间仍为 same', d.some(l => l.kind === 'same' && l.text === '乙'), kinds(d))
  const sameTexts = d.filter(l => l.kind === 'same').map(l => l.text)
  ok('⑤ 中间公共行只出现一次', sameTexts.filter(t => t === '乙').length === 1, JSON.stringify(sameTexts))
}

// ---------- ⑥ 换行归一：\r\n 不应把整篇判成"全变了" ----------
{
  const d = diffLines('甲\r\n乙', '甲\n乙')
  // split('\n') 会留下 \r；这里仅确认不会崩、且结果结构完整（调用方负责先归一换行）
  ok('⑥ 含 \\r 的输入不抛错、输出覆盖两行', d.length >= 2 && d.some(l => l.text.includes('甲')), shape(d))
}

// ---------- ⑦ 规模保护：超限时退化为整段替换，但结果结构仍正确 ----------
{
  // 造 2200 × 2200 ≈ 484 万单元 > MAX_DP_CELLS(400 万)
  const big = Array.from({ length: 2200 }, (_, i) => `旧-${i}`).join('\n')
  const big2 = Array.from({ length: 2200 }, (_, i) => `新-${i}`).join('\n')
  const t0 = Date.now()
  const d = diffLines(big, big2)
  const ms = Date.now() - t0
  ok('🔴 超大规模不抛错且有输出', d.length > 0, String(d.length))
  ok('🔴 超大规模退化时：旧行全删 + 新行全增（结果仍然正确）',
    d.filter(l => l.kind === 'del').length === 2200 && d.filter(l => l.kind === 'add').length === 2200,
    `del=${d.filter(l => l.kind === 'del').length} add=${d.filter(l => l.kind === 'add').length}`)
  ok('🔴 超大规模在 1 秒内返回（不卡界面）', ms < 1000, `${ms}ms`)
}

// ---------- ⑧ 剪枝真的把规模降下来了（性能保护的核心） ----------
{
  // 3000 行、只在正中间改一行 —— 若没剪枝，DP 会是 3000×3000＝900 万（超上限、退化）
  const lines = Array.from({ length: 3000 }, (_, i) => `第 ${i} 段`)
  const mid = 1500
  const before = lines.join('\n')
  const after = [...lines.slice(0, mid), '第 1500 段（改过）', ...lines.slice(mid + 1)].join('\n')
  const t0 = Date.now()
  const d = diffLines(before, after)
  const ms = Date.now() - t0
  const st = diffStats(d)
  console.log(`  · 3000 行改 1 行：耗时 ${ms}ms，统计 ${JSON.stringify(st)}`)
  ok('🔴 3000 行只改一行 → 精确识别（没退化成整篇增删）',
    st.added === 1 && st.deleted === 1, JSON.stringify(st))
  ok('🔴 且在 300 毫秒内返回（剪枝生效）', ms < 300, `${ms}ms`)
}

console.log(`\n—— textDiff：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exitCode = 1
