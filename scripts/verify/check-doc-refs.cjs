/**
 * 文档引用健康检查 v2（只读）
 * v1 的坑：把 `schema.ts` 这种裸文件名当成根目录路径 ⇒ 误报一片。
 * v2：① 带目录前缀的路径直接查存在性；② 裸文件名查全仓同名索引（有同名即视为可定位）。
 */
const fs = require('node:fs')
const path = require('node:path')

const rootAt = process.argv.indexOf('--root')
if (rootAt >= 0 && (!process.argv[rootAt + 1] || process.argv[rootAt + 1].startsWith('--'))) throw new Error('--root requires a directory')
const ROOT = path.resolve(rootAt >= 0 ? process.argv[rootAt + 1] : path.join(__dirname, '../..'))
const SKIP_DIR = new Set(['node_modules', '.git', 'release', 'eb-cache', 'dist', '.workbuddy', '.arts', '.opencode'])

// ============ 0. 源码注释模式（--source）============
//
// 为什么要它（3.3.3 · B2）：注释里写 `docs/xxx.md` 是给后来者指路的，
// 文档归档后路径失效 ⇒ 看着像还在、点开找不到。这类腐坏没有任何现有门禁能发现。
//
// 🔴 三条纪律：
//   ① **只解析注释**：字符串字面量、URL、正则里的同形文本一律不算（用状态机切，不靠正则猜）；
//   ② **模板不算引用**：含 `*` `…` `<` `>` 的是占位写法，跳过不判；
//   ③ **不在真实源码里造假样本测试**：夹具建在临时目录（见 tests/docRefSourceGate.test.ts）。
const SOURCE_MODE = process.argv.includes('--source')
const SOURCE_DIRS = ['src', 'server', 'electron', 'scripts']
const SOURCE_EXTS = /\.(ts|tsx|mjs|cjs|js)$/
/** 注释内的文档引用：中文路径、空格以外都能带；到 `.md` 为止 */
const SRC_REF = /docs\/[^\s`'"<>*…，。；：、）(）【】「」！？]+?\.md/g
/** 占位/模板写法：说明"这里该写个文档"而不是真的引用某份文档 */
const SRC_PLACEHOLDER = /[<>*…]|\bxxx\b|\bXXX\b|X\.Y\.Z|待定|示例|YYYY/

/**
 * 从源码里切出注释（行注释 + 块注释），返回 [{ line, text }]。
 * 状态机顺序很重要：先认字符串，才不会被 `"http://…"` 里的 `//` 骗成注释。
 * ⚠️ 模板串按普通字符串处理（不展开 `${}`）—— 注释定位够用；模板里写文档路径的属于极少数。
 */
function extractComments(src) {
  const out = []
  let i = 0
  let line = 1
  let state = 'code'
  let buf = ''
  let startLine = 1
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; buf = ''; startLine = line; i += 2; continue }
      if (c === '/' && n === '*') { state = 'block'; buf = ''; startLine = line; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl'; i++; continue }
      if (c === '\n') line++
      i++
      continue
    }
    if (state === 'line') {
      if (c === '\n') { out.push({ line: startLine, text: buf }); state = 'code'; line++; i++; continue }
      buf += c; i++; continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { out.push({ line: startLine, text: buf }); state = 'code'; i += 2; continue }
      if (c === '\n') { line++; buf += '\n'; i++; continue }
      buf += c; i++; continue
    }
    // 字符串内部：跳过转义；遇到结束引号回 code
    if (c === '\\') { if (n === '\n') line++; i += 2; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) { state = 'code'; i++; continue }
    if (c === '\n') line++
    i++
  }
  if (state === 'line' || state === 'block') out.push({ line: startLine, text: buf })
  return out
}

/**
 * 从一段注释里取文档引用。
 * 分两级：① 反引号包裹的（可含空格、项目文档常用这种写法）优先且整段取；
 *        ② 裸写的走 SRC_REF（不含空格）。
 * 反引号里的取走后从原文抹掉，避免被第二级重复计一次。
 */
function refsInComment(text) {
  const out = []
  let rest = text
  for (const m of text.matchAll(/`([^`\n]{3,200})`/g)) {
    const raw = m[1].trim()
    if (/^docs\/[\s\S]*\.md(#.*|:\d+)?$/.test(raw)) {
      out.push(raw)
      rest = rest.replace(m[0], ' '.repeat(m[0].length))
    }
  }
  for (const m of rest.matchAll(SRC_REF)) out.push(m[0])
  return out
}

function runSourceMode() {
  const files = []
  function walk(dir) {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue
        walk(path.join(dir, e.name))
      } else if (SOURCE_EXTS.test(e.name)) files.push(path.join(dir, e.name))
    }
  }
  for (const d of SOURCE_DIRS) walk(path.join(ROOT, d))

  // 🔴 一个文件都没扫到 ⇒ 根路径错了或目录被挪走，**不能当绿灯**
  if (files.length === 0) {
    console.log(`扫描 0 个源码文件 —— 根路径 ${ROOT} 下没有可扫目录（${SOURCE_DIRS.join(' / ')}），视为工具异常`)
    return -1
  }

  let refs = 0
  const missing = new Map() // file -> Set("line|ref")
  for (const f of files) {
    let text = ''
    try { text = fs.readFileSync(f, 'utf8') } catch { continue }
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    for (const c of extractComments(text)) {
      for (const rawRef of refsInComment(c.text)) {
        const raw = rawRef.trim()
        if (SRC_PLACEHOLDER.test(raw)) continue                // 模板/占位
        const clean = raw.replace(/(#.*|:\d+)$/, '').trim()    // 剥行号与锚点
        if (!clean || /^[a-zA-Z]:\//.test(clean)) continue
        refs++
        if (!fs.existsSync(path.join(ROOT, clean))) {
          if (!missing.has(rel)) missing.set(rel, new Set())
          missing.get(rel).add(`${c.line}|${raw}`)
        }
      }
    }
  }

  const count = [...missing.values()].reduce((a, s) => a + s.size, 0)
  console.log(`扫描 ${files.length} 个源码文件 · 注释内可判定引用 ${refs} 处`)
  console.log(`\n===== 源码注释引用失效（真失效）：${count} 处 / ${missing.size} 份文件 =====`)
  for (const [f, set] of [...missing].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`[${set.size}] ${f}`)
    for (const s of [...set].sort()) {
      const [ln, ref] = s.split('|')
      console.log(`    :${ln}  ${ref}`)
    }
  }
  if (count === 0) console.log('（无）')
  return count
}

if (SOURCE_MODE && !process.argv.includes('--with-md')) {
  const rc = runSourceMode()
  // 0 通过 / 1 确定失效 / 2 工具异常（扫不到文件等）—— 2 绝不能当绿灯
  process.exit(rc < 0 ? 2 : rc > 0 ? 1 : 0)
}


// ---------- 1. 全仓文件名索引 ----------
const baseIndex = new Map() // basename -> 出现次数
function indexAll(dir) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.isDirectory()) {
      const rel = path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, '/')
      if (SKIP_DIR.has(e.name) || SKIP_DIR.has(rel)) continue
      indexAll(path.join(dir, e.name))
    } else {
      baseIndex.set(e.name, (baseIndex.get(e.name) || 0) + 1)
    }
  }
}
indexAll(ROOT)

// ---------- 2. 待检文档 ----------
const TARGETS = [path.join(ROOT, 'README.md')]
if (fs.existsSync(path.join(ROOT, 'docs'))) for (const f of fs.readdirSync(path.join(ROOT, 'docs'))) if (f.endsWith('.md')) TARGETS.push(path.join(ROOT, 'docs', f))
/** --inuse：只查在用文档（归档里的路径是当时快照，不该按现行源码判错） */
const INUSE = process.argv.includes('--inuse')
function walkMd(dir) {
  if (INUSE) return
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkMd(full)
    else if (/\.md$/.test(e.name)) TARGETS.push(full)
  }
}
walkMd(path.join(ROOT, 'docs', '归档'))
if (process.argv.includes('--include-memory')) for (const f of ['MEMORY.md', 'MEMORY-REF.md', 'HANDOFF.md', 'TESTING-GUIDE.md']) {
  TARGETS.push(path.join(ROOT, '.workbuddy/memory', f))
}

const DIRP = /^(docs|src|tests|server|scripts|release|electron|portable|build|dev-seed|public|assets|\.workbuddy)\//
const BARE = /^[\w.\-]+\.(ts|tsx|mjs|cjs|js|json|md|sh|ps1|css|yml|yaml|html|py)$/
const BAD = /[<*>…]|\.\.\.|\s|\bXXX\b|待定|示例|YYYY/

let total = 0
const missingDir = new Map() // 带路径前缀但不存在
const missingBare = new Map() // 裸名全仓都没有
for (const f of TARGETS) {
  if (!fs.existsSync(f)) continue
  const text = fs.readFileSync(f, 'utf8')
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  for (const m of text.matchAll(/`([^`\n]{3,140})`/g)) {
    const raw = m[1].trim()
    if (BAD.test(raw)) continue
    const p = raw.replace(/^\.\//, '').split('#')[0].trim()
    if (/^[a-zA-Z]:\//.test(p) || p.startsWith('/')) continue
    if (DIRP.test(p)) {
      total++
      if (!fs.existsSync(path.join(ROOT, p))) {
        if (!missingDir.has(rel)) missingDir.set(rel, new Set())
        missingDir.get(rel).add(raw)
      }
    } else if (BARE.test(p)) {
      total++
      if (!baseIndex.has(path.basename(p))) {
        if (!missingBare.has(rel)) missingBare.set(rel, new Set())
        missingBare.get(rel).add(raw)
      }
    }
  }
}

const show = (title, map) => {
  const count = [...map.values()].reduce((a, s) => a + s.size, 0)
  console.log(`\n===== ${title}：${count} 处 / ${map.size} 份文档 =====`)
  let n = 0
  for (const [f, set] of [...map].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`[${set.size}] ${f}`)
    for (const s of set) { console.log('    ' + s); if (++n >= 40) break }
    if (n >= 40) { console.log('  …（截断）'); break }
  }
}
console.log(`扫描 ${TARGETS.filter((f) => fs.existsSync(f)).length} 份文档 · 可判定引用 ${total} 处 · 索引文件 ${baseIndex.size} 个名字`)
show('带目录前缀但文件不存在（真失效）', missingDir)
show('裸文件名全仓都没有', missingBare)
