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
