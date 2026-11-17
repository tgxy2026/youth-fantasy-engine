// 死导出扫描 · 结构化版（2026-11-17）
//
// 为什么重写：`legacy/audit-dead.mjs` 只输出**人读的 Markdown 表**，候选从来没有进过
// `report.json`。于是六维审计的「代码维度」长期显示 `0 候选`，而 log 里躺着几十条
// 零引用导出 —— 报告看起来是绿灯，实际是没人复核。这个文件把同一件事做成**可 disposition
// 的 finding**：进报告、必须给结论（复核理由或删除），而不是躺在日志里靠自觉。
//
// 🔴 与旧脚本的分工（不是替代）：
//   · 本文件 = 结构化候选（规则 id + 行号 + 引用桶），供报告与复核机制消费；
//   · `legacy/audit-dead.mjs` = 人读的细化报告（A/B/C 分类、KEEP 理由长文），继续保留。
//   两者共用 `source-text.mjs` 的文本处理，避免「两份实现各说一套」。
//
// 🔴 引用统计的三个桶（旧脚本只有一个「外部引用」）：
//   · production —— `src/**`（除定义文件自身）：真有人用；
//   · test       —— `tests/**`：**只被测试用**不等于有人用，它是「实现完整但没接入口」
//                   的典型形状（当年 `useFieldAliases` 就是这样被长期掩盖的）；
//   · tooling    —— `electron/` `server/` `scripts/`（**排除 `scripts/audit`**）：
//                   审计工具自己不能给被审对象作证（历史坑：KEEP 表里的字符串把候选洗白）。

import fs from 'node:fs'
import path from 'node:path'
import { definitionLine, exportedSymbols, referenceText } from './source-text.mjs'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-web', 'release', '.workbuddy'])
const isDir = e => e.isDirectory()

/** 递归收集源码文件；跳过产物目录、dot 目录（`.xxx` 是 esbuild 打出的整份源码副本，会把死代码洗白） */
export function walkCode(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    if (isDir(e) && SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (isDir(e)) { walkCode(p, out); continue }
    if (e.name.startsWith('dist_bak_')) continue
    if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

const rel = (root, f) => path.relative(root, f).replaceAll('\\', '/')

/**
 * 扫一遍仓库里的「零引用导出」。
 *
 * @param root 仓库根
 * @param opts.files 注入文件列表（单测用；不传则按约定目录收集）
 * @param opts.readFile 注入读取函数（单测用）
 * @returns {{ findings: object[], stats: { files: number, exports: number, used: number, testOnly: number, dead: number } }}
 */
export function scanDeadExports(root, opts = {}) {
  const readFile = opts.readFile ?? (f => fs.readFileSync(f, 'utf8'))
  const files = opts.files ?? [
    ...walkCode(path.join(root, 'src')),
    ...walkCode(path.join(root, 'tests')),
    ...walkCode(path.join(root, 'electron')),
    ...walkCode(path.join(root, 'server')),
    // 审计工具不是引用来源：它们为了「说明某个符号」而写下的字符串会把候选洗白
    ...walkCode(path.join(root, 'scripts')).filter(f => !/[\\/]scripts[\\/]audit[\\/]/.test(f)),
  ]

  const buckets = files.map(f => {
    const file = rel(root, f)
    const text = referenceText(readFile(f))
    const tier = file.startsWith('src/') ? 'production'
      : file.startsWith('tests/') ? 'test'
        : 'tooling'
    return { file, tier, text }
  })

  const findings = []
  let exports = 0, used = 0, testOnly = 0, dead = 0

  for (const unit of buckets) {
    if (unit.tier !== 'production') continue
    for (const { name, kind } of exportedSymbols(unit.text)) {
      exports++
      const re = new RegExp(`\\b${name}\\b`, 'g')
      const hits = { production: 0, test: 0, tooling: 0 }
      for (const other of buckets) {
        if (other.file === unit.file) continue
        hits[other.tier] += (other.text.match(re) ?? []).length
      }
      // 同文件自用不算死：它确实在跑，只是导出面可以收窄（那属于风格问题，不进候选）
      const line = definitionLine(unit.text, name)
      /**
       * 同文件自用：排除**定义行里的那一次声明**，其余次数都算自用。
       * 🔴 不能整行跳过：`export function f() { return f }` 这种单行实现会把唯一的自用
       *    一起跳过，结果把活代码判成死代码（本扫描器的首版就踩了，夹具用例抓到）。
       */
      const selfUse = (() => {
        const lines = unit.text.split(/\r?\n/)
        let n = 0
        for (let i = 0; i < lines.length; i++) {
          const hits = (lines[i].match(re) ?? []).length
          n += (line && i === line - 1) ? Math.max(0, hits - 1) : hits
        }
        return n
      })()

      if (hits.production > 0) { used++; continue }
      if (hits.test > 0) {
        testOnly++
        findings.push({
          rule: 'dead.test-only', confidence: 'review', file: unit.file, line: line || 1,
          symbol: name, kind,
          message: `导出 \`${name}\`（${kind}）只被测试引用，生产代码没有调用点；核对是「实现完整但没接入口」还是「测试在用就该收进测试内部」`,
        })
        continue
      }
      if (selfUse > 0) { used++; continue }
      dead++
      findings.push({
        rule: 'dead.export', confidence: 'review', file: unit.file, line: line || 1,
        symbol: name, kind,
        message: `导出 \`${name}\`（${kind}）零引用（生产 ${hits.production} / 测试 ${hits.test} / 工具 ${hits.tooling}）；`
          + '确认是否该接入口、进复核清单，或直接删除',
      })
    }
  }

  return { findings, stats: { files: buckets.length, exports, used, testOnly, dead } }
}

/**
 * 复核结论的格式校验（纯逻辑，单测直接用）。
 *
 * 🔴 为什么按**符号**而不是行号复核：行号随任何一次编辑漂移，按行号匹配的复核会静默失效
 *   （症状：明明复核过，报告又变 unreviewed）。符号名稳定得多。
 * 🔴 理由必须写够：写不出理由的复核等于自己给自己发免责条款（项目历史踩过）。
 */
export function validateDeadReviews(entries, opts = {}) {
  const issues = []
  const minReason = opts.minReason ?? 10
  if (!Array.isArray(entries)) return { ok: false, issues: ['复核清单必须是数组'] }
  const seen = new Set()
  for (const [i, e] of entries.entries()) {
    if (!e || typeof e !== 'object') { issues.push(`第 ${i + 1} 项不是对象`); continue }
    if (typeof e.file !== 'string' || !e.file.startsWith('src/')) issues.push(`第 ${i + 1} 项 file 必须是 src/ 下的相对路径`)
    if (typeof e.symbol !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(e.symbol)) issues.push(`第 ${i + 1} 项 symbol 非法`)
    if (typeof e.reason !== 'string' || e.reason.trim().length < minReason) {
      issues.push(`第 ${i + 1} 项（${e.symbol ?? '?'}）缺理由：至少 ${minReason} 字，写清「为什么留着不删」`)
    }
    const key = `${e.file}:${e.symbol}`
    if (seen.has(key)) issues.push(`重复复核项：${key}`)
    seen.add(key)
  }
  return { ok: issues.length === 0, issues }
}

/**
 * 复核项是否还指向**真实存在**的导出。
 *
 * 🔴 这是防「复核静默失效」：符号被删掉或改名后，旧复核项会永远匹配不到任何 finding，
 *   看起来像"已复核"，实际是空气。宁可让自检失败，也不要留一条假装生效的白名单。
 */
export function staleDeadReviews(entries, root, opts = {}) {
  const readFile = opts.readFile ?? (f => fs.readFileSync(f, 'utf8'))
  const exists = opts.exists ?? (f => fs.existsSync(f))
  const stale = []
  for (const e of entries ?? []) {
    const abs = path.join(root, e.file)
    if (!exists(abs)) { stale.push({ ...e, why: '文件不存在' }); continue }
    const text = referenceText(readFile(abs))
    if (!exportedSymbols(text).some(s => s.name === e.symbol)) stale.push({ ...e, why: '该文件已不再导出此符号' })
  }
  return stale
}
