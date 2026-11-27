// 结构化检查 · 高风险零覆盖文件自动对账（3.7.5 · 审计工具第四轮）
//
// 【它拦的是哪一类盲区】
//   `self-check.mjs` 原本只核对 `coverage-ledger.json` 既有条目是否合法/失效，
//   却不检查是否新出现了「A 类 · 安全/数据/算法类」零覆盖文件漏登（3.7.3/3.7.4 新增的
//   WcpImportModal / WcpExportModal / useWcpWorkspaceSync 就曾静默落在日志里而自检全绿）。
//   现在把 A 类扫描与台账对账纳入硬线：新增高风险零覆盖文件必须要么补测、要么登记风险与触发条件。

import fs from 'node:fs'
import path from 'node:path'
import { walkCode } from './dead-exports.mjs'

/** 与 legacy/audit-coverage.mjs 同源的 A 类（安全/数据/算法类）文件正则 */
export const HOT_COVERAGE_RE = /(crypto|backup|sync|db|migrat|export|import|store|budget|parse|guard|lock|tombstone)/i

/** 收集仓库测试与闸文件（口径与 legacy/audit-coverage.mjs 一致） */
export function collectCoverageTestFiles(root) {
  const testsDir = path.join(root, 'tests')
  if (!fs.existsSync(testsDir)) return []
  return fs.readdirSync(testsDir)
    .filter(f => /\.test\.ts$/.test(f) || (/-check\.mjs$/.test(f) && !f.startsWith('.')))
    .map(f => path.join(testsDir, f))
}

/**
 * 扫描零测试提及的高风险文件（A 类）。
 * @param {string} root 仓库根目录
 * @param {{ srcFiles?: string[]; testFiles?: string[]; readFile?: (p: string) => string }} [opts]
 */
export function scanHotUncoveredFiles(root, opts = {}) {
  const readFile = opts.readFile ?? (f => fs.readFileSync(f, 'utf8'))
  const srcFiles = opts.srcFiles
    ? opts.srcFiles.map(p => ({ rel: p.replace(/\\/g, '/'), abs: path.join(root, p) }))
    : walkCode(path.join(root, 'src')).map(f => ({ rel: path.relative(root, f).replace(/\\/g, '/'), abs: f }))
  const testFiles = opts.testFiles
    ? opts.testFiles.map(p => path.join(root, p))
    : collectCoverageTestFiles(root)

  const imported = new Set()
  const testTexts = []
  for (const tf of testFiles) {
    let text = ''
    try { text = readFile(tf) } catch { continue }
    testTexts.push(text)
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) imported.add(m[1])
  }
  const allTestText = testTexts.join('\n')

  const hotUncovered = []
  for (const { rel, abs } of srcFiles) {
    if (!rel.startsWith('src/')) continue
    const norm = rel.replace(/\.(ts|tsx)$/, '')
    const base = path.posix.basename(norm)
    const stem = norm.replace(/^src\//, '')
    const byImport = [...imported].some(imp => {
      const i = imp.replace(/^[./]+/, '').replace(/\.(ts|tsx)$/, '')
      return i === stem || i.endsWith('/' + stem) || i === norm || i.endsWith('/' + norm)
    })
    const byText = allTestText.includes(stem)
      || new RegExp('\\b' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(allTestText)
    if (!byImport && !byText && HOT_COVERAGE_RE.test(rel)) {
      let lines = 0
      try { lines = readFile(abs).split(/\r?\n/).length } catch { lines = 0 }
      hotUncovered.push({ file: rel, lines })
    }
  }

  hotUncovered.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file))
  return { files: srcFiles.length, hotUncovered }
}

/**
 * 将高风险零覆盖扫描结果与台账对账：找出未登记的高风险零覆盖文件。
 * @param {{ file: string; lines?: number }[]} hotUncovered
 * @param {{ file: string }[] | null | undefined} ledgerEntries
 */
export function reconcileHotCoverage(hotUncovered, ledgerEntries) {
  const registered = new Set((ledgerEntries ?? []).map(e => e.file))
  const unregistered = (hotUncovered ?? []).filter(x => !registered.has(x.file))
  return { unregistered }
}
