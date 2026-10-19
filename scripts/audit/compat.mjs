import fs from 'node:fs'
import { scanAst } from './ast.mjs'

/** Append to legacy text output without moving entrypoints or changing positional root arguments. */
export function printSupplement(root, family = 'all') {
  const contracts = JSON.parse(fs.readFileSync(new URL('./contracts.json', import.meta.url), 'utf8'))
  const result = scanAst(root, contracts)
  const filters = { func: /^(draft|wiring)\./, ui: /^(mono|coverage|cssom)\./, coverage: /^coverage\./ }
  const candidates = filters[family] ? result.findings.filter(f => filters[family].test(f.rule)) : result.findings
  const lines = [`\n── 深化审计补充（AST · ${family} · ${result.files} 文件）──`]
  for (const f of candidates) lines.push(`  ▸ ${f.file}:${f.line} [${f.rule}/${f.confidence}] ${f.message}`)
  lines.push(`  ${candidates.length} 项候选，须回源码及运行路径确认；零候选不表示实机通过。`)
  if (family === 'all') {
    lines.push('  必验边界：请求头大小写/语法、预设新增与编辑入口、严格黑白真实绘制、草稿保存失败、导入导出往返。')
    lines.push('  统一JSON/Markdown证据报告：node scripts/audit/run.mjs --probes（不会替代本入口）。')
    if (fs.existsSync(`${root}/server/index.mjs`)) lines.push('  三端兼容专项：node .workbuddy/tmp/audit-platform.mjs --matrix（桌面/便携/网页云端/游客分别取证）。')
  }
  const text = lines.join('\n')
  console.log(text)
  return text
}
