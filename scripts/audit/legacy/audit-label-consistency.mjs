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
const uneven = vals => vals.length >= 2 && new Set(vals.map(han)).size >= 2

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
    const head = blk.slice(0, blk.lastIndexOf('</Button>'))
    const txt = clean(head.slice(head.lastIndexOf('>') + 1))
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
    const head = blk.slice(0, blk.lastIndexOf('</Button>'))
    const txt = clean(head.slice(head.lastIndexOf('>') + 1))
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
const dump = (title, rows) => {
  console.log('\n######## ' + title + ' ########')
  let bad = 0
  for (const r of rows) {
    const vals = r.vals ?? r.g.map(x => x.val)
    const un = uneven(vals)
    if (!un && !all) continue
    if (un) bad++
    if (un) console.log('⚠ ' + rel(r.file) + (r.name ? ' :: ' + r.name : '') +
      '  (L' + (r.line ?? r.g[0].line) + ')')
    else console.log('  ' + rel(r.file))
    console.log('    ' + vals.map(v => han(v) + '字·' + v).join('  |  '))
  }
  console.log(`→ ${title}：共 ${rows.length} 组，不齐 ${bad} 组`)
}

console.log('工作区：' + ROOT)
dump('A. 互斥分段按钮（variant="toggle"）', groupsA.filter(r => r.g.length >= 2))
dump('B. 相邻 Button 组', groupsB.filter(r => r.g.length >= 2))
// C 类噪音最多（lib 下有大量数据表常量）⇒ 组件目录的排前面，先看它们
groupsC.sort((a, b) =>
  (a.file.includes('components') ? 0 : 1) - (b.file.includes('components') ? 0 : 1))
dump('C. 选项常量数组（组件目录优先）', groupsC)

console.log('\n🔴 只给线索：回源码确认是否真渲染为「同一功能模块的并列按钮」再动手。')
console.log('   排除项：主操作+取消 的异类配对、含数字/英文的规格类、数据表（人名/错别字/主题名）。')
