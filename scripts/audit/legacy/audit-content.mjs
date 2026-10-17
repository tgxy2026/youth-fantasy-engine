process.env.YFE_AUDIT_FULL ??= '1'
// 内容审查扫描器（只读）—— 补「项目内文字说明」这一维
// 用法：node .workbuddy/tmp/audit-content.mjs [工作区路径]
// 覆盖五个可被确定性判定的内容问题：问号提示缺失 / 文案重复 / 术语不一致 / 占位未写完 / 文案里的数字承诺。
// ⚠️ 「文案说得对不对」判不了 —— 那是子代理和实机的活；这里只把「线索」摆出来。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = (process.argv[2] || 'G:/AI软件/youth-fantasy-engine开发源码').replace(/\\/g, '/')
const SRC = path.join(ROOT, 'src')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')

function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  let st = 'code'
  while (i < n) {
    const c = src[i], c2 = src[i + 1]
    if (st === 'code') {
      if (c === '/' && c2 === '/') { st = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && c2 === '*') { st = 'block'; out += '  '; i += 2; continue }
      if (c === "'") { st = 'sq'; out += c; i++; continue }
      if (c === '"') { st = 'dq'; out += c; i++; continue }
      if (c === '`') { st = 'tpl'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c; i++; continue } out += ' '; i++; continue }
    if (st === 'block') { if (c === '*' && c2 === '/') { st = 'code'; out += '  '; i += 2; continue } out += (c === '\n' ? '\n' : ' '); i++; continue }
    if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue }
    if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) { st = 'code'; out += c; i++; continue }
    out += c; i++; continue
  }
  return out
}

const allTs = walk(SRC)
const tsx = allTs.filter(f => /\.tsx$/.test(f))
const masked = new Map()
const raw = new Map()
for (const f of allTs) {
  masked.set(f, stripComments(fs.readFileSync(f, 'utf8')))
  raw.set(f, fs.readFileSync(f, 'utf8'))
}
const CJK = /[\u4e00-\u9fa5]/
const out = []
const P = s => out.push(s)

// ── C0. 抽 UI 文案 ────────────────────────────────────────────────
// 只取「会显示在界面上」的三类：JSX 文本节点、可及名/占位类属性、HelpPopover 的 props。
// 不取提示词（那是给模型的，见 audit-prompt.mjs）。
const texts = [] // {file, line, s}
{
  const attrRe = /(title|aria-label|placeholder|alt|label|description|tips?|note|subTitle|subtitle)="([^"]*)"/g
  const helpRe = /(?:title|content|tips?|note|desc|body)=\{(?:"|')([^"']{4,})(?:"|')\}/g
  for (const f of tsx) {
    const m = masked.get(f)
    const lines = m.split(/\r?\n/)
    lines.forEach((l, i) => {
      for (const mm of l.matchAll(/>([^<>{}]*[\u4e00-\u9fa5][^<>{}]*)</g)) {
        const s = mm[1].trim()
        if (s && CJK.test(s)) texts.push({ file: rel(f), line: i + 1, s })
      }
      for (const mm of l.matchAll(attrRe)) {
        const s = mm[2].trim()
        if (s && CJK.test(s)) texts.push({ file: rel(f), line: i + 1, s })
      }
      for (const mm of l.matchAll(helpRe)) {
        const s = mm[1].trim()
        if (s && CJK.test(s)) texts.push({ file: rel(f), line: i + 1, s })
      }
    })
  }
}
const norm = s => s.replace(/\s+/g, '')

// ── C1. 页级标题缺问号提示 ─────────────────────────────────────────
// 红线：每个页签页头都要 HelpPopover。这里做**可达线索**：文件里有 h1/h2 标题却完全没引 HelpPopover。
{
  const missing = []
  for (const f of tsx) {
    const m = masked.get(f)
    if (!/<h1[\s>]/.test(m) && !/<h2[\s>]/.test(m)) continue      // 不是页级
    if (/HelpPopover/.test(m)) continue
    missing.push(rel(f))
  }
  P(`\n── C1. 页级标题未见 HelpPopover（${missing.length} 个）──`)
  P('  判读：逐个开一遍 —— 弹窗/子组件属合法豁免，真正的页签缺了就是红线（而且这是唯一全员 Agreement 的判据，必须人工）。')
  for (const f of missing) P(`  ▸ ${f}`)
  if (!missing.length) P('  ✅ 所有含页级标题的文件都引用了 HelpPopover')
}

// ── C2. 重复 UI 文案 ──────────────────────────────────────────────
{
  const buckets = new Map()
  for (const t of texts) {
    if (t.s.length < 6) continue
    const k = norm(t.s)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(t)
  }
  const dup = [...buckets.values()]
    .filter(v => v.length >= 3 && new Set(v.map(x => x.file)).size >= 2)
    .sort((a, b) => b.length - a.length)
  P(`\n── C2. 重复 UI 文案（≥6 字、≥3 次、跨 ≥2 文件 · ${dup.length} 组 TOP15）──`)
  P('  判读：同一句话撒在多处 = 改一处漏三处。要么抽常量，要么说明这里该有多份（如 tab.tips 天然复用）。')
  for (const v of (process.env.YFE_AUDIT_FULL === '1' ? dup : dup.slice(0, 15))) {
    const where = [...new Set(v.map(x => x.file))]
    P(`  ▸ 「${v[0].s.slice(0, 40)}」 ×${v.length}  (${where.length} 文件)  ${where.slice(0, 3).join(' / ')}`)
  }
  const total = texts.length, uniq = buckets.size + texts.filter(t => t.s.length < 6).length
  P(`  规模：抽到 ${total} 条中文 UI 文案，去重后约 ${uniq} 条`)
}

// ── C3. 术语不一致 ────────────────────────────────────────────────
// 同一功能两套叫法，读者会当成两个东西。只在**真的出现了两种以上写法**时才报告。
{
  const GROUPS = [
    ['云同步', ['云盘同步', '云端同步', '云同步', 'Sync']],
    ['角色卡', ['角色卡', '人物卡']],
    ['章节细纲', ['章节细纲', '细纲', '章纲']],
    ['AI 续写', ['AI 续写', '一键续写', '自动续写', '智能续写']],
    ['总纲 / 大纲', ['总纲', '大纲', '总览大纲']],
    ['灵感工具', ['灵感工具', '灵感素材', '素材资料']],
    ['全域检索', ['全文检索', '全域检索', '全局搜索']],
    ['设定', ['设定册', '设定集', '设定表']],
  ]
  P(`\n── C3. 术语不一致（同名多写法）──`)
  P('  判读：优先统一到一个主名；如果两处**语义真的不同**就保持现状并写进「判定不改」。')
  for (const [name, terms] of GROUPS) {
    const used = terms.map(t => {
      // ⚠️ 纯 ASCII 词（如 'Sync'）会命中 91 个标识符，纯噪声 → 只统计含中文的说法
      if (!CJK.test(t)) return { t, n: 0, files: [] }
      let n = 0
      const files = new Set()
      for (const f of allTs) {
        const c = masked.get(f)
        const k = [...c.matchAll(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length
        if (k) { n += k; files.add(rel(f)) }
      }
      return { t, n, files: [...files] }
    })    .filter(x => x.n > 1)                                  // 只出现一次可能是笔误，不值得报告
    if (used.length >= 2) {
      P(`  ▸ ${name}：` + used.map(x => `${x.t}(${x.n})`).join(' / '))
      for (const u of (process.env.YFE_AUDIT_FULL === '1' ? used : used.slice(0, 2))) P(`       「${u.t}」见 ${u.files.slice(0, 3).join('、')}`)
    }
  }
}

// ── C4. 占位 / 未实现文案（幽灵功能）──────────────────────────────
{
  const RE = /敬请期待|暂未实现|暂不支持|开发中|待补充|待完善|即将上线|功能筹划中|TODO|FIXME|XXX/
  // ⚠️ 界面文案里的「敬请期待」= 幽灵功能；但 lib 里的命中多半是提示词/数据字典的**合法用词**
  //    （如 HistoryTimeline 的「待补充」是 states 枚举值、tavern 提示词要求模型别写「待补充」）→ 分两栏报。
  const hits = [], other = []
  for (const f of allTs) {
    const m = masked.get(f)
    m.split(/\r?\n/).forEach((l, i) => {
      if (RE.test(l) && CJK.test(l)) (/\.tsx$/.test(f) ? hits : other).push({ f: rel(f), i: i + 1, l: l.trim().slice(0, 90) })
    })
  }
  P(`\n── C4. 占位与未实现标记 ──`)
  P('  判读：界面里出现 = 幽灵功能（说明承诺了没做的东西）。lib 那栏多为合法用词，看上下文再判。')
  P(`  ▸ 界面（.tsx）${hits.length} 处`)
  for (const h of (process.env.YFE_AUDIT_FULL === '1' ? hits : hits.slice(0, 12))) P(`       ${h.f}:${h.i}  ${h.l}`)
  P(`  ▸ 非界面（lib/ts）${other.length} 处 —— 多为提示词/枚举，通常合法`)
  for (const h of (process.env.YFE_AUDIT_FULL === '1' ? other : other.slice(0, 8))) P(`       ${h.f}:${h.i}  ${h.l}`)
  if (!hits.length) P('  ✅ 界面文案中无占位标记')
}

// ── C5. 文案里的硬编码数量承诺 ────────────────────────────────────
// 「共 12 项」「支持 5 种」写死在文案里 → 加了功能但数字没动 = 说明失真。
{
  const RE = /(?:共|支持|包含|分为|提供)\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:项|个|种|类|步|阶段|章|张|条|处)/
  const hits = []
  for (const f of tsx) {
    const m = masked.get(f)
    m.split(/\r?\n/).forEach((l, i) => {
      if (!/[<>{}=]/.test(l)) return                       // 纯逻辑行不算界面文案
      if (/\$\{/.test(l)) return                            // 已插值的不要管
      const mm = l.match(RE)
      if (mm) hits.push({ f: rel(f), i: i + 1, s: mm[0], l: l.trim().slice(0, 90) })
    })
  }
  P(`\n── C5. 界面文案里的硬编码数量（${hits.length} 处）──`)
  P('  判读：逐条确认数字是否仍成立；能改成 `.length` / 常量派生的一律改成派生（派生 = 结构上不可能失真）。')
  for (const h of (process.env.YFE_AUDIT_FULL === '1' ? hits : hits.slice(0, 15))) P(`  ▸ ${h.f}:${h.i}  「${h.s}」  ${h.l}`)
  if (!hits.length) P('  ✅ 无硬编码数量')
}

// ── C6. 帮助文案超长 ──────────────────────────────────────────────
{
  const long = []
  for (const f of tsx) {
    const m = masked.get(f)
    // ⚠️ 只认**字符串字面量**属性。`content={m.content}` 这类 JSX 表达式会被宽松正则一路吃到下一个引号，
    //    实测能吐出 766 字的"假帮助文案"（其实是一行 props 展开）。
    const re = /(?:content|tips?|note|desc|title|subtitle|subTitle)="([^"\n]{60,})"/g
    for (const mm of m.matchAll(re)) {
      const before = m.slice(0, mm.index).split('\n').length
      long.push({ f: rel(f), i: before, n: mm[1].length, s: mm[1].replace(/\s+/g, ' ').slice(0, 60) })
    }
  }
  long.sort((a, b) => b.n - a.n)
  P(`\n── C6. 帮助/提示文案超长 TOP10（>80 字）──`)
  P('  判读：HelpPopover 是纯文本渲染（不解析 markdown）。太长＝没人看；考虑拆条或用列表式短句。')
  for (const l of (process.env.YFE_AUDIT_FULL === '1' ? long : long.slice(0, 10))) P(`  ▸ ${l.n} 字  ${l.f}:${l.i}  ${l.s}…`)
  if (!long.length) P('  ✅ 无超长帮助文案')
}

console.log(out.join('\n'))
console.log('\n⚠️ 本脚本给的是「线索」不是「结论」：C1/C4/C5 每条都要人工判一次；判为豁免的务必写进报告的「判定不改」节，免下轮重复提案。')
