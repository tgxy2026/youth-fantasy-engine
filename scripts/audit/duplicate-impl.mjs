// 结构化检查 · 同名导出且函数体完全相同（2026-11-19 · 审计策略化第三轮）
//
// 【它拦的是哪一类问题】
//   同一份实现被复制到两个模块，函数体**逐字节相同**。看上去"只是多了一处代码"，
//   真正的代价是：改了其中一份，另一份还是旧口径，而调用方分不清该信哪个。
//   实测事故（3.6.1）：`stableHash` 在 `audit/repetition` 与 `tasks/unitLedger` 各一份、完全相同；
//   task 台账里**存过这个散列值** —— 哪天一边改了口径，去重与台账就互相不认。
//
// 【判据】
//   ① 只认 `export function`（`export const x = () =>` 形态差异太大，先不收）；
//   ② 函数体**去注释、压缩空白后逐字符相同**；
//   ③ 归一化后长度 ≥ `MIN_BODY_CHARS`（滤掉 `return ''` 这类一句话小工具 ——
//      它们相同是巧合，合并反而制造跨域耦合）；
//   ④ 跨文件（同文件内不可能同名）。
//   三条全中才报 —— 判据客观，不含相似度打分，所以可以直接当硬线（预期长期为 0）。
//
// 🔴 刻意**不做**"相似但不相同"的模糊比对：那种必须人工抽样，塞进报告只会制造噪音
//    （同类启发式仍留在 `legacy/audit-dead.mjs` 的日志里）。

import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from './source-text.mjs'
import { walkCode } from './dead-exports.mjs'

/** 低于这个长度（归一化后）视为"一句话小工具"，相同也不算缺陷 */
export const MIN_BODY_CHARS = 120

/**
 * 抽出 `export function name(...) { ... }` 的函数体。
 * 手写括号配平（含字符串感知），不引 AST：本规则只需要"函数体文本"，用 AST 反而更重。
 * 已知局限（可接受）：模板字符串里的 `${...}` 会被当成普通字符，极端嵌套下可能多算一个 `}`；
 * 命中后会人工确认，误报代价只是"看一眼"。
 */
export function extractExportedFunctions(text) {
  const out = []
  const re = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm
  let m
  while ((m = re.exec(text))) {
    const name = m[1]
    // 从 ( 开始配平参数括号，找到函数体起点
    let i = m.index + m[0].length - 1
    let paren = 0
    for (; i < text.length; i++) {
      const ch = text[i]
      if (ch === '(') paren++
      else if (ch === ')') { paren--; if (paren === 0) { i++; break } }
    }
    // 跳过返回类型标注，找第一个 {
    while (i < text.length && text[i] !== '{' && text[i] !== ';') i++
    if (text[i] !== '{') continue
    const bodyStart = i
    let depth = 0
    let quote = null
    for (; i < text.length; i++) {
      const ch = text[i]
      if (quote) {
        if (ch === '\\') { i++; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { i++; break }
      }
    }
    const body = text.slice(bodyStart, i)
    out.push({ name, body, line: text.slice(0, m.index).split('\n').length })
  }
  return out
}

/** 归一化：压掉所有空白（注释在调用方已剥），保证"排版不同、实现相同"也能对上 */
export function normalizeBody(body) {
  return body.replace(/\s+/g, '')
}

/** 跨文件比对（导出给单测：喂 [{file,text}] 即可） */
export function findDuplicateImpls(sources) {
  const groups = new Map()
  for (const { file, text } of sources) {
    for (const fn of extractExportedFunctions(stripComments(text))) {
      const normalized = normalizeBody(fn.body)
      if (normalized.length < MIN_BODY_CHARS) continue
      const key = `${fn.name}\u0000${normalized}`
      const list = groups.get(key) ?? []
      list.push({ file, line: fn.line, name: fn.name })
      groups.set(key, list)
    }
  }
  const findings = []
  for (const list of groups.values()) {
    const files = [...new Set(list.map(x => x.file))]
    if (files.length < 2) continue
    const first = list[0]
    findings.push({
      rule: 'dup.impl',
      file: first.file,
      line: first.line,
      message: `函数 ${first.name} 的实现与 ${files.slice(1).join('、')} 完全相同：合并到一处（如 lib/app 下的零依赖模块）或明确写出为何要各留一份`,
    })
  }
  return findings
}

/** 全仓扫描 */
export function scanDuplicateImpls(root) {
  const sources = []
  const files = walkCode(path.join(root, 'src'))
  for (const absolute of files) {
    let text = ''
    try { text = fs.readFileSync(absolute, 'utf8') } catch { continue }
    sources.push({ file: path.relative(root, absolute).replace(/\\/g, '/'), text })
  }
  const findings = findDuplicateImpls(sources)
  return { files: files.length, findings, stats: { findings: findings.length } }
}
