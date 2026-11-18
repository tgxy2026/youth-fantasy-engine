/**
 * 并列按钮「文案字数一致性」扫描器（只读）—— 2026-10-04 新增。
 *
 * 【为什么有它】同一功能模块下的并列按钮 / 分段选项，字数参差（如「全选 / 全不选」、
 * 「一句话补全 / 对话引导」）会让工具栏视觉参差。这类问题**任何现有扫描器都看不见** ——
 * audit-ui 只看色值与栅格，audit-content 只看重复文案与超长帮助。
 *
 * 【三类信号源】（由准到宽，误报率递增）：
 *   A. 互斥分段按钮 `<Button variant="toggle">` —— 相邻者**必然**同组，口径最准
 *   B. 同容器内相邻 `<Button>中文</Button>` —— 多为工具栏 / 弹窗底部
 *   C. 选项常量数组 `const NAME = [ ... ]` 内的中文短文案 —— 需回源码确认是否渲染为按钮
 *
 * 🔴 **只给线索，不下判决**：是否真属「同一功能模块的并列按钮」必须回源码看渲染方式。
 *    反例（扫到了但不是按钮）：`PLATFORM_RULES.focusCategories`（分类标签）、
 *    `nameGen.ts` 各姓氏表、`typoWords.ts` 错别字库、`THANKS` 人名表 —— 全是数据。
 *
 * 用法：node audit-label-consistency.mjs [工作区路径] [--all]
 *   默认只报「组内字数不齐」；--all 连齐的一起列。
 */
import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const all = args.includes('--all')
const ROOT = (args.find(a => !a.startsWith('--')) || process.cwd()).replace(/[\\/]+$/, '')
const SRC = path.join(ROOT, 'src')

const han = s => (s.match(/[\u4e00-\u9fa5]/g) || []).length
const BAD = /[，。、；：？！“”‘’]/
const clean = s => s.replace(/\s+/g, '')

function walk(dir, out = []) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
const lineOf = (src, i) => src.slice(0, i).split('\n').length
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')
/**
 * 🔴 2026-11-18 审计修正（工具缺陷）：原先"汉字数只要有差异就算不齐"。
 *    于是「待处理候选」(5) vs「全部留档」(4)、「正文章节摘要」(6) vs「章节细纲卡」(5)
 *    都成了问题 —— 实测 161 组相邻按钮里有 98 组被判不齐，全是正常文案差异。
 *    现在只报**明显失衡**：字数差 ≥3 且相差 ≥2 倍（如「去」vs「逐章确认初稿」）。
 *    这条检查的价值在"一眼看出别扭"，不在"字数必须相等"。
 */
const uneven = (vals, minDiff = 3, minRatio = 2) => {
  if (vals.length < 2) return false
  const ns = vals.map(han)
  const max = Math.max(...ns), min = Math.min(...ns)
  return max - min >= minDiff && max >= min * minRatio
}

/**
 * 取 `<Button …>儿童</Button>` 的可见中文文案。
 * 🔴 不能用 `head.lastIndexOf('>')` 硬切：儿童里只要出现 `{cond ? 'A' : 'B'}` 或 `<Icon />`，
 *    最后一个 `>` 就可能落在表达式或自闭合标签里，切出来的文案会带一个 `}` 前缀 ——
 *    2026-10-25 全量审计实测的「}看板娘设置」「}卸载旧版」全是这种假报。
 * 做法：① 按「花括号深度 + 引号」找到开标签真正结束的 `>`；② 再剥掉儿童里的表达式与标签。
 */
function labelOf(blk) {
  const close = blk.lastIndexOf('</Button>')
  const end = close >= 0 ? close : blk.length
  let i = 0, depth = 0, quote = ''
  for (; i < end; i++) {
    const c = blk[i]
    if (quote) { if (c === quote && blk[i - 1] !== '\\') quote = ''; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) { i++; break }
  }
  let text = blk.slice(i, end), prev
  do { prev = text; text = text.replace(/\{[^{}]*\}/g, ' ') } while (text !== prev)
  // 剥掉表达式后会留下空括号（`正文章节摘要（{n}）` → `正文章节摘要（）`），一并清掉
  return clean(text.replace(/<[^>]*\/>/g, ' ').replace(/<\/?[^>]+>/g, ' ').replace(/[（(]\s*[)）]/g, ''))
}

const files = walk(SRC)

// ───────────── A. <Button variant="toggle"> 相邻组 ─────────────
const groupsA = []
for (const file of files.filter(f => f.endsWith('.tsx'))) {
  const src = fs.readFileSync(file, 'utf8')
  const hits = []
  const re = /<Button\b[^>]*variant="toggle"[\s\S]*?<\/Button>/g
  let m
  while ((m = re.exec(src))) {
    const blk = m[0]
    const txt = labelOf(blk)
    if (!txt || han(txt) === 0 || txt.length > 14) continue
    hits.push({ line: lineOf(src, m.index), val: txt })
  }
  if (hits.length < 2) continue
  let cur = [hits[0]]
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].line - cur[cur.length - 1].line <= 8) cur.push(hits[i])
    else { groupsA.push({ file, g: cur }); cur = [hits[i]] }
  }
  groupsA.push({ file, g: cur })
}

// ───────────── B. 相邻 <Button>中文</Button> ─────────────
const groupsB = []
for (const file of files.filter(f => f.endsWith('.tsx'))) {
  const src = fs.readFileSync(file, 'utf8')
  const hits = []
  const re = /<Button\b[^>]*>[\s\S]*?<\/Button>/g
  let m
  while ((m = re.exec(src))) {
    const blk = m[0]
    const txt = labelOf(blk)
    if (!txt || han(txt) === 0 || txt.length > 12 || BAD.test(txt)) continue
    hits.push({ line: lineOf(src, m.index), val: txt })
  }
  if (hits.length < 2) continue
  let cur = [hits[0]]
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].line - cur[cur.length - 1].line <= 6) cur.push(hits[i])
    else { groupsB.push({ file, g: cur }); cur = [hits[i]] }
  }
  groupsB.push({ file, g: cur })
}

// ───────────── C. 选项常量数组 ─────────────
const groupsC = []
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const re = /const\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=\n]*)?=\s*\[/g
  let m
  while ((m = re.exec(src))) {
    const name = m[1]
    const i = src.indexOf('[', m.index + m[0].length - 1)
    let depth = 0, j = i
    for (; j < src.length; j++) {
      const c = src[j]
      if (c === '[') depth++
      else if (c === ']') { depth--; if (depth === 0) break }
    }
    const body = src.slice(i + 1, j)
    const vals = []
    const reV = /'([^'\n]{1,10})'|"([^"\n]{1,10})"|`([^`\n]{1,10})`/g
    let v
    while ((v = reV.exec(body))) {
      const s = v[1] || v[2] || v[3]
      if (!s || han(s) === 0 || BAD.test(s) || /^[a-z-]+$/.test(s)) continue
      vals.push(s)
    }
    const uniq = [...new Set(vals)]
    // 🔴 启发式降噪：真实选项组一般 2–14 项；超过 14 项的基本是**数据表**
    //    （人名库 / 错别字库 / 姓氏表 / 主题名表）—— 它们不是按钮，报出来只会淹没有效信号。
    if (uniq.length >= 2 && uniq.length <= 14) {
      groupsC.push({ file, name, line: lineOf(src, m.index), vals: uniq })
    }
  }
}

// ───────────── 输出 ─────────────
/**
 * 📌 2026-11-18：只有 A（互斥分段按钮）参与判定。
 *
 * 为什么 B/C 降级为「信息」：它们的成员本来就不是等宽语义 ——
 * B 是相邻动作（「去」「逐章确认初稿」「括号后换行」），C 是字段标签/致谢名单/正则数组
 * （「口吻」「称呼你的方式」）。用字数差去判它们，只能判出"文案不一样"，那不是缺陷。
 * 实测：B 98 组、C 102 组被判不齐，逐组看全是正常差异 —— 这种量级的假阳性会训练人无视整条规则。
 * 现在 B/C 用更严的阈值（差 ≥4 且 ≥3 倍）只列「一眼别扭」的，且标为不判定。
 */
const dump = (title, rows, opts = {}) => {
  console.log('\n######## ' + title + ' ########')
  if (opts.info) console.log('（信息 · 不判定：成员本来不等宽，只列明显失衡供一瞥）')
  let bad = 0
  for (const r of rows) {
    const vals = r.vals ?? r.g.map(x => x.val)
    /**
     * 「label：状态」型开关（去 AI 味儿：已开启 / 逐章确认初稿：已关闭）不算不齐：
     * 冒号前是名字、冒号后是状态，本来就不该等宽。这类在界面上是**开关**，不是互斥分段选项。
     */
    if (opts.skipColon && vals.every(v => /[：:]\s*$/.test(v))) continue
    const un = uneven(vals, opts.minDiff ?? 3, opts.minRatio ?? 2)
    if (!un && !all) continue
    if (un) bad++
    if (un) console.log((opts.info ? '▸ ' : '⚠ ') + rel(r.file) + (r.name ? ' :: ' + r.name : '') +
      '  (L' + (r.line ?? r.g[0].line) + ')')
    else console.log('  ' + rel(r.file))
    console.log('    ' + vals.map(v => han(v) + '字·' + v).join('  |  '))
  }
  console.log(`→ ${title}：共 ${rows.length} 组，不齐 ${bad} 组`)
}

console.log('工作区：' + ROOT)
dump('A. 互斥分段按钮（variant="toggle"）', groupsA.filter(r => r.g.length >= 2), { skipColon: true })
dump('B. 相邻 Button 组', groupsB.filter(r => r.g.length >= 2), { info: true, minDiff: 4, minRatio: 3 })
// C 类噪音最多（lib 下有大量数据表常量）⇒ 组件目录的排前面，先看它们
groupsC.sort((a, b) =>
  (a.file.includes('components') ? 0 : 1) - (b.file.includes('components') ? 0 : 1))
dump('C. 选项常量数组（组件目录优先）', groupsC, { info: true, minDiff: 5, minRatio: 3 })

console.log('\n🔴 只给线索：回源码确认是否真渲染为「同一功能模块的并列按钮」再动手。')
console.log('   排除项：主操作+取消 的异类配对、含数字/英文的规格类、数据表（人名/错别字/主题名）。')
