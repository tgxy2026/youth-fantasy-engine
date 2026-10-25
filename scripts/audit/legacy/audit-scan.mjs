process.env.YFE_AUDIT_FULL ??= '1'
// 静态审计扫描器（只读）
// 用法：node .workbuddy/tmp/audit-scan.mjs
import fs from 'node:fs'
import path from 'node:path'

// 工作区可用 argv[2] 覆盖（默认本机路径）
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

const files = walk(SRC)
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')
const content = new Map()
const linesMap = new Map()
for (const f of files) {
  const c = fs.readFileSync(f, 'utf8')
  content.set(f, c)
  linesMap.set(f, c.split(/\r?\n/))
}

/**
 * 逐字符剥离注释（`//` 行注释 + 块注释，含 JSX 的 `{ /* *\/ }`），保留行结构。
 * 不做这一步，注释里举例的 `z-[60]`、`getBoundingClientRect`、`fill="rgb(var(--x))"`、
 * 甚至示例 `import … from './Modal'` 都会被当成真代码命中 —— JSX 注释还能跨多行，
 * 靠「行首是不是 //」根本判不出来。
 * ⚠️ 字符串/模板串**保留内容**：`className="…fixed…"` 的类名住在字符串里，剥掉就没法扫了。
 * ⚠️ 需要看注释的小节（§2 TODO、§5 eslint-disable）**不要**用它，继续读 linesMap。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  let st = 'code' // code | line | block | sq | dq | tpl
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

const maskedText = new Map() // 文件 → 去注释后的整段文本（字符串保留）
const maskLines = new Map()  // 文件 → 去注释后的行数组
for (const f of files) {
  const m = stripComments(content.get(f))
  maskedText.set(f, m)
  maskLines.set(f, m.split(/\r?\n/))
}
const lineAt = (text, idx) => { let ln = 1; for (let k = 0; k < idx; k++) if (text.charCodeAt(k) === 10) ln++; return ln }

// 全部参与"被引用"统计的文件（含 tests / electron / scripts）
function walkAny(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'dist-web' || e.name === 'release') continue
    // 🔴 2026-09-19 加固：**生成物与工作区临时文件不算「使用」证据**。
    //    ① tests/.xxx.test.mjs —— build-test.mjs 用 esbuild 打包出的**整份源码副本**，
    //       会把被 import 模块的实现整段抄进去，于是「只在 bundle 里出现」的符号被误判成有人用；
    //    ② .workbuddy/** —— 工作区临时脚本与审计中间产物，更不该影响审计结论。
    //    实测：排掉它们后，死导出候选 178 → 240（多出的 62 个是此前被长期掩盖的真死导出）。
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkAny(p, out)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}
const allCode = walkAny(ROOT)
const allText = allCode.map(f => ({ f, t: fs.readFileSync(f, 'utf8') }))

// 🔴 2026-09-19 加固：**再导出不算使用**。
//    背景：存储层拆分后 src/lib/db.ts 变成门面（只做再导出的索引文件），它会把整层名字"提"一遍，
//    按原始文本计数会让「死导出候选」被一次性掩盖（拆分当天就实测到了：db.ts 两个真死导出凭空消失）。
const stripReexport = s => {
  // 状态机：整段吞掉 export 清单（多行 `export {\n A,\n B,\n} from './x'` 也要吞），
  // 这类语句只是"把名字提一遍"，不是使用。⚠️ 别用单行正则糊弄 —— 门面恰恰是多行写法。
  const out = []
  let inList = false
  for (const l of s.split(/\r?\n/)) {
    if (inList) { out.push(''); if (/\}/.test(l)) inList = false; continue }
    if (/^\s*export\s+(?:\*|type\s*\{|\{)/.test(l)) {
      out.push('')
      inList = !(/\}/.test(l) || /\bfrom\s+['"]/.test(l) || /^\s*export\s+\*/.test(l))
      continue
    }
    out.push(l)
  }
  return out.join('\n')
}
// 引用计数专用语料：去注释（注释里提过 ≠ 使用）+ 去再导出行（见上）
const refCorpus = allCode.map(f => ({ f, t: stripReexport(stripComments(fs.readFileSync(f, 'utf8'))) }))

const out = []
const P = s => out.push(s)

// ── 规模 ─────────────────────────────────────────
let totalLines = 0
const sizes = []
for (const f of files) {
  const n = linesMap.get(f).length
  totalLines += n
  sizes.push({ f: rel(f), n })
}
sizes.sort((a, b) => b.n - a.n)
P(`# 静态扫描报告\n`)
P(`## 0. 规模\n`)
P(`- src 文件数：${files.length}，总行数：${totalLines}`)
P(`- 超过 400 行的文件：${sizes.filter(s => s.n > 400).length} 个；超过 600 行：${sizes.filter(s => s.n > 600).length} 个\n`)
P(`| 行数 | 文件 |`)
P(`|---|---|`)
for (const s of (process.env.YFE_AUDIT_FULL === '1' ? sizes : sizes.slice(0, 25))) P(`| ${s.n} | ${s.f} |`)
P('')

// ── 1. 死导出探测 ─────────────────────────────────
const exportRe = /^export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm
const exportTypeRe = /^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
const deadCandidates = []
for (const f of files) {
  const t = content.get(f)
  const names = []
  let m
  while ((m = exportRe.exec(t))) names.push(m[1])
  while ((m = exportTypeRe.exec(t))) names.push(m[1])
  for (const n of names) {
    let used = 0
    for (const { f: g, t: gt } of refCorpus) {
      if (g === f) continue // 同文件自用不算"被外部引用"
      const re = new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`, 'g')
      const c = (gt.match(re) || []).length
      used += c
    }
    if (used === 0) deadCandidates.push({ f: rel(f), n })
  }
}
P(`## 1. 死导出候选（未被其他文件引用，同文件自用不计）\n`)
P(`共 ${deadCandidates.length} 个 —— ⚠️ 动态引用 / 字符串引用会误报，需人工确认\n`)
P(`| 文件 | 导出符号 |`)
P(`|---|---|`)
for (const d of deadCandidates) P(`| ${d.f} | ${d.n} |`)
P('')

// ── 2. TODO / FIXME ──────────────────────────────
P(`## 2. TODO / FIXME / HACK\n`)
const todoRe = /(?:\/\/|\/\*)\s*(TODO|FIXME|HACK|XXX|待办|待优化)[：:]?\s*(.*)/gi
let todoCount = 0
P(`| 文件:行 | 类型 | 内容 |`)
P(`|---|---|---|`)
for (const f of files) {
  const ls = linesMap.get(f)
  ls.forEach((l, i) => {
    todoRe.lastIndex = 0
    let m
    while ((m = todoRe.exec(l))) {
      todoCount++
      P(`| ${rel(f)}:${i + 1} | ${m[1]} | ${m[2].slice(0, 90).replace(/\|/g, '\\|')} |`)
    }
  })
}
if (!todoCount) P(`（无）`)
P('')

// ── 3. console 残留 ──────────────────────────────
P(`## 3. console.* 残留（src）\n`)
let consoleCount = 0
P(`| 文件 | 行 | 内容 |`)
P(`|---|---|---|`)
for (const f of files) {
  const ls = linesMap.get(f)
  ls.forEach((l, i) => {
    if (/console\.(log|debug|info|warn|error)/.test(l)) {
      consoleCount++
      P(`| ${rel(f)} | ${i + 1} | ${l.trim().slice(0, 100).replace(/\|/g, '\\|')} |`)
    }
  })
}
if (!consoleCount) P(`（无）`)
P('')

// ── 4. 类型逃逸 ───────────────────────────────────
P(`## 4. 类型逃逸（any / ts-ignore / non-null）\n`)
const anySites = []
const tsIgnore = []
const bangSites = []
/**
 * 🔴 必须用**去注释后**的行（maskLines）：原先读原始行，于是注释里讲解「为什么不用
 *    `as any`」「原先 `data: any`」的说明文字被当成真实类型逃逸。
 *    2026-10-25 全量审计实测：两处命中（schema.ts:30、materialRef.ts:68）全是注释，
 *    真正需要看的 0 处被这两个假报盖住 —— 红线扫描器给出假报比不给更糟。
 */
for (const f of files) {
  const ls = maskLines.get(f)
  ls.forEach((l, i) => {
    if (/:\s*any\b|as\s+any\b|<any>/.test(l)) anySites.push(`${rel(f)}:${i + 1}`)
    if (/@ts-(ignore|expect-error)/.test(l)) tsIgnore.push(`${rel(f)}:${i + 1}`)
    if (/[A-Za-z_$\)\]]!\s*[\.\;\,\)]/.test(l) && !/!==|!=\s/.test(l)) bangSites.push(`${rel(f)}:${i + 1}`)
  })
}
P(`- \`any\` 出现点：${anySites.length}（非空断言与 any 均在测试代码与 \`unknown\` 转换处多为合理，逐条看下表）`)
P(`  - ${anySites.slice(0, 60).join(' , ') || '（无）'}`)
P(`- \`@ts-ignore/@ts-expect-error\`：${tsIgnore.length} → ${tsIgnore.join(' , ') || '（无）'}`)
P(`- 非空断言 \`!\`：${bangSites.length} 处`)
P('')

// ── 5. eslint-disable ─────────────────────────────
P(`## 5. eslint-disable\n`)
const dis = []
let disNoReason = 0
for (const f of files) {
  linesMap.get(f).forEach((l, i) => {
    if (!/eslint-disable/.test(l)) return
    // 有 `--` 说明的才算「写清了为什么」；没有的下一轮得回头补（本项目只在 TableSheet 一处写了原因）
    const explained = /eslint-disable[^\n]*--/.test(l)
    if (!explained) disNoReason++
    dis.push(`${rel(f)}:${i + 1}${explained ? '' : ' 〔无原因〕'} ${l.trim().slice(0, 90)}`)
  })
}
P(dis.length ? dis.map(d => `- ${d}`).join('\n') : '（无）')
P(`\n共 ${dis.length} 处，其中 **${disNoReason} 处没写原因**（`+"`-- 为什么可以禁用`"+`）：下次动到这些文件时顺手补，不要为了补注释单独改一遍。`)
P('')

// ── 6. 红线违规：window.prompt/confirm/alert ───────
P(`## 6. 🔴 红线：window.prompt/confirm/alert\n`)
const wpa = []
for (const f of files) {
  maskLines.get(f).forEach((l, i) => {
    if (/\b(window\.)?(prompt|confirm|alert)\s*\(/.test(l) && !/confirmDialog|PromptModal|toast/.test(l)) wpa.push(`${rel(f)}:${i + 1} ${l.trim().slice(0, 90)}`)
  })
}
P(wpa.length ? wpa.map(d => `- ${d}`).join('\n') : '（无 —— 干净）')
P('')

// ── 7. 🔴 红线：getBoundingClientRect ─────────────
P(`## 7. 🔴 红线：getBoundingClientRect 使用点（界面缩放 108%，量尺寸应走 offsetHeight）\n`)
const gbcr = [], gbcrExpected = []
for (const f of files) {
  maskLines.get(f).forEach((l, i) => {
    if (!/getBoundingClientRect/.test(l)) return
    const line = `${rel(f)}:${i + 1}  ${l.trim().slice(0, 110)}`
    // 下拉/浮层定位要的是**视口坐标**，这里用 rect 是对的；红线针对的是「拿它量元素高度/宽度」。
    // 判据取「同一行内交给 computeDropdownPos」这种可静态证实的写法，其余一律留在待复核里人工判。
    if (/computeDropdownPos\(/.test(l)) gbcrExpected.push(line)
    else gbcr.push(line)
  })
}
P(`- 〔预期〕浮层定位（吃视口坐标，必须用 rect）：${gbcrExpected.length} 处`)
P(gbcrExpected.map(d => `  - ${d}`).join('\n') || '  （无）')
P(`- 待复核（可能是量尺寸/布局用途）：${gbcr.length} 处`)
P(gbcr.map(d => `- ${d}`).join('\n') || '- （无）')
P('')

// ── 8. 字符串/数字魔法值 ───────────────────────────
P(`## 8. 界面文案里的 markdown 星号（JSX 文本中出现 \\*\\* 或单个 \\* 包裹）\n`)
const star = []
for (const f of files) {
  maskLines.get(f).forEach((l, i) => {
    // 已去注释；再排一次行首注释符（防御）
    if (/^\s*(\/\/|\*)/.test(l)) return
    if (/\*\*[^*]+\*\*/.test(l) && /<|>|\{/.test(l)) star.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 110)}`)
  })
}
P(star.length ? star.map(d => `- ${d}`).join('\n') : '（无明显违规）')
P('')

// ── 9. 重复文件指纹（近似重复） ────────────────────
P(`## 9. 同尺寸文件（可能重复/复制粘贴）\n`)
const byNum = new Map()
for (const s of sizes) {
  const k = s.n
  if (!byNum.has(k)) byNum.set(k, [])
  byNum.get(k).push(s.f)
}
let dupAny = false
for (const [k, v] of byNum) {
  if (v.length > 1) { dupAny = true; P(`- ${k} 行：${v.join(' , ')}`) }
}
if (!dupAny) P('（无）')
P('')

// ══════════════════════════════════════════════════════════════════
// §10–§17：项目红线「确定性」扫描（2026-09-17 新增）
// 背景：这些红线以前只靠子代理（LLM）审，误报率约 15% 且不可复跑。
// 能确定性判定的，一律落到这里 —— 子代理只审「语义/一致性」这类扫不出来的。
// （去注释工具 stripComments / maskLines 已在文件头定义，此处直接复用）
// ══════════════════════════════════════════════════════════════════

// ── 10. 🔴 复制未走 copyText()（裸 navigator.clipboard）────────────
P(`## 10. 🔴 红线：裸 navigator.clipboard（复制应走 dialogs.tsx 的 copyText()）\n`)
const COPY_SRC = 'src/components/dialogs/dialogs.tsx'
const clip = []
for (const f of files) {
  if (rel(f) === COPY_SRC) continue // 真源本身
  maskLines.get(f).forEach((l, i) => { if (/navigator\.clipboard/.test(l)) clip.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 100)}`) })
}
P(clip.length ? clip.map(d => `- ${d}`).join('\n') : '（无 —— 干净）')
P('')

// ── 11. 🔴 内联 vh/vw 未走 foldVh()（<html> zoom 不缩放 vh）────────
P(`## 11. 🔴 红线：内联 vh/vw 长度（应走 theme.ts 的 foldVh()；手动 calc(... / var(--ui-zoom)) 亦合规）\n`)
const vhSites = []
for (const f of files) {
  const r = rel(f)
  if (r === 'src/components/dialogs/Modal.tsx') continue // foldVh 宿主，其 maxHeight/topOffset 默认值就是喂给 foldVh 的
  maskLines.get(f).forEach((l, i) => {
    if (/--ui-zoom|foldVh\(/.test(l)) return // 已折算
    // 传给 <Modal> 的 prop（maxHeight/topOffset/maxWidth）不在组件里直接生效 ——
    // Modal 内部会 foldVh() 折算，故这些行不算违规（否则每个用 Modal 的地方都误报）。
    if (/(?:maxHeight|topOffset|maxWidth)\s*=\s*["']\s*\d+(?:\.\d+)?(?:vh|vw)\s*["']/.test(l)) return
    if (!/\b\d+(?:\.\d+)?(?:vh|vw)\b/.test(l)) return
    vhSites.push(`${r}:${i + 1}  ${l.trim().slice(0, 110)}`)
  })
}
P(`共 ${vhSites.length} 处（含 CSS 类任意值 [NNvh] 与内联 style；132% 缩放时会溢出视口）`)
P(vhSites.map(d => `- ${d}`).join('\n'))
P('')

// ── 12. 🔴 SVG 表现属性写 rgb(var(--…))（表现属性不解析 var，会静默回退）──
P(`## 12. 🔴 红线：SVG 表现属性里的 rgb(var(--…))（须走 style={{ fill: 'rgb(var(--x))' }}，属性形式会回退黑/透明）\n`)
const svgAttr = []
for (const f of files) {
  maskLines.get(f).forEach((l, i) => {
    if (/(?:fill|stroke|stop-color|flood-color)\s*=\s*["']\s*rgb\(var\(--/.test(l)) svgAttr.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 110)}`)
  })
}
P(svgAttr.length ? svgAttr.map(d => `- ${d}`).join('\n') : '（无 —— 干净，均走 style={{}}）')
P('')

// ── 13. 🔴 硬编码 z-index 魔数（层号走 zLayer.ts 的 Z）────────────
P(`## 13. 🔴 红线：硬编码 z-index 魔数（应走 zLayer.ts 的 Z；仅注释里出现 = 干净）\n`)
const zSites = []
for (const f of files) {
  maskLines.get(f).forEach((l, i) => {
    if (/z-\[\d/.test(l) || /\bz-(?:50|[1-9]\d{2,})\b/.test(l)) zSites.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 100)}`)
  })
}
P(zSites.length ? zSites.map(d => `- ${d}`).join('\n') : '（无 —— 干净）')
P('')

// ── 14. 🔴 文字按钮用 ghost（静止无框的文字按钮应 secondary）────────
P(`## 14. 🔴 红线：variant="ghost" 且非 iconOnly（纯图标键静止无框是既有约定，仅报带文字的）\n`)
const ghost = []
for (const f of files) {
  const text = maskedText.get(f)
  const re = /<Button\b[\s\S]*?>[\s\S]{0,200}?<\/Button>/g // 整段按钮标签（含子节点），跨行也认
  let m
  while ((m = re.exec(text))) {
    const tag = m[0]
    if (!/variant="ghost"/.test(tag)) continue
    if (/iconOnly/.test(tag)) continue // 纯图标键静止无框 = 既有约定
    ghost.push(`${rel(f)}:${lineAt(text, m.index)}  ${tag.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
  }
}
P(ghost.length ? ghost.map(d => `- ${d}`).join('\n') : '（无 —— 干净，ghost 均为 iconOnly）')
P('')

// ── 15. 🔴 回车处理器未挡 isComposing（中文输入法 Enter=选字确认）──────
// 覆盖面要广：不只聊天 <textarea>，<input>（改名/新建）与挂在容器 div 上的 onKey 同样中招 ——
// 选字那一下 keydown 的 isComposing 为 true，不挡就会「选字即提交/跳转」（实测 PromptModal、
// ProjectHub 书名框、FullTextSearch、CheckTools 敏感词框都缺守卫）。
P(`## 15. 🔴 红线：判 'Enter' 的回车处理器未挡 isComposing（±25 行内没出现 isComposing 即计）\n`)
const ime = []
const IME_WIN = 25
for (const f of files) {
  const ls = maskLines.get(f)
  ls.forEach((l, i) => {
    if (!/key\s*(?:===|!==)\s*['"]Enter['"]/.test(l)) return
    const win = ls.slice(Math.max(0, i - IME_WIN), i + IME_WIN + 1).join('\n')
    if (!/isComposing/.test(win)) ime.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 100)}`)
  })
}
P(`共 ${ime.length} 处（Enter 提交/发送路径应挡；与 IME 无关的快捷键可豁免，需人工判）`)
P(ime.map(d => `- ${d}`).join('\n'))
P('')

// ── 16. 裸 JSON.parse（AI 文本解析须走 aiParse.ts / aiChatJson）──────
P(`## 16. JSON.parse 使用点（AI 文本解析须走 aiParse.ts；解析存储/加密载荷属正常，标〔预期〕）\n`)
// ⚠️ 按 basename 匹配，不按路径 —— 免得日后重排目录（如 lib/ → lib/core/）时
//    这些豁免**静默失效**、把「预期」全打成「⚠️ 复核」（2026-09-19 加固）。
const KNOWN_OK_PARSE = new Set([
  'aiParse.ts', 'ai.ts', 'crypto.ts',
  'desktop.ts', 'syncCore.ts', 'syncTransport.ts',
])
const isKnownOkParse = f => KNOWN_OK_PARSE.has(path.basename(f))
const jp = []
for (const f of files) {
  maskLines.get(f).forEach((l, i) => {
    if (!/JSON\.parse\(/.test(l)) return
    jp.push(`${rel(f)}:${i + 1}${isKnownOkParse(f) ? ' 〔预期〕' : ' ⚠️ 复核'}  ${l.trim().slice(0, 100)}`)
  })
}
P(jp.length ? jp.map(d => `- ${d}`).join('\n') : '（无）')
P('')

// ── 17. 全局 fixed 浮层（项目内除左下角 DataDock 外禁全局 fixed 浮层）──
P(`## 17. 全局 fixed 浮层使用点（除左下角 DataDock 外；HelpPopover/下拉浮层/已抽取的保存悬浮球属既有约定，需人工判）\n`)
const fixedSites = []
const classStrsOf = l => {
  const out = []
  let m
  const r1 = /className="([^"]*)"/g
  while ((m = r1.exec(l))) out.push(m[1])
  const r2 = /className=\{`([^`]*)`\}/g
  while ((m = r2.exec(l))) out.push(m[1])
  return out
}
for (const f of files) {
  const r = rel(f)
  if (r === 'src/components/app/DataDock.tsx') continue // 唯一获准的全局浮层
  maskLines.get(f).forEach((l, i) => {
    const hit = classStrsOf(l).some(s => s.split(/\s+/).includes('fixed')) // 精确类名，排除 table-fixed
    if (hit) fixedSites.push(`${r}:${i + 1}  ${l.trim().slice(0, 110)}`)
  })
}
P(fixedSites.length ? fixedSites.map(d => `- ${d}`).join('\n') : '（无）')
P('')

fs.writeFileSync(path.join(ROOT, '.workbuddy/tmp/audit-scan-report.md'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
const { printSupplement } = await import('../compat.mjs')
fs.appendFileSync(path.join(ROOT, '.workbuddy/tmp/audit-scan-report.md'), '\n' + printSupplement(ROOT), 'utf8')
