// 审计工具共享的源码文本处理（2026-11-17 抽出）
//
// 背景：`legacy/audit-dead.mjs` 里那套「剥注释 + 剥再导出 + 排除审计自身」的逻辑，
// 原本只有它自己在用，而且**只输出人读的 Markdown 表**——候选永远进不了报告，
// 等于六维审计在「代码维度」上长期没有可复核结论。
//
// 现在把它抽成共享工具，新扫描器（`dead-exports.mjs`）与旧脚本共用同一份实现：
// 两份各写一套的话，迟早出现「旧脚本说 32 个、新扫描器说 25 个」却没人说得清谁对。
//
// 🔴 纪律：只做纯文本变换，不读业务状态、不判断业务语义。

/**
 * 剥离注释（`//` / 块注释 / JSX `{/* *\/}`），**保留行结构**（换行换空格）。
 *
 * 🔴 不剥注释会**低估**死代码：某符号若只在注释里被提过一次，就会被当成「有人在用」而漏报。
 *    实测案例：`useFieldAliases` 只在 `useFieldRenames.ts` 的文件头注释里被提到，
 *    不剥注释就会把它当成「有外部引用」——它是真的没接入口。
 * 字符串/模板串**保留内容**（`data-*`、类名字符串里出现符号名仍算命中）。
 */
export function stripComments(src) {
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

/**
 * 把「再导出清单」整段吞掉（`export { A, B } from './x'` / 多行 / `export *`）。
 *
 * 🔴 再导出只是把名字**提一遍**，不是使用。典型受害场景：`src/lib/db.ts` 这类门面文件，
 *    会把整层名字再导出一遍；按原始文本计数会让整层死导出一次性消失（拆分当天实测到过）。
 * ⚠️ 必须整段处理：门面几乎都是多行写法，单行正则会漏掉中间那些名字。
 */
export function stripReexport(src) {
  const out = []
  let inList = false
  for (const l of src.split(/\r?\n/)) {
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

/** 供引用统计用：去注释 + 去再导出（顺序不能反：先剥注释，避免注释里的 `export {` 误触发） */
export function referenceText(src) {
  return stripReexport(stripComments(src))
}

/** 从一段源码里列出它的具名导出（值 / 类型分开，便于报告里说清是什么） */
export function exportedSymbols(text) {
  const out = []
  const reFn = /^export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm
  const reType = /^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = reFn.exec(text))) out.push({ name: m[1], kind: 'value' })
  while ((m = reType.exec(text))) out.push({ name: m[1], kind: 'type' })
  return out
}

/**
 * 该符号在文件里的**定义行号**（1 基）。找不到返回 0。
 * 报告要给人定位，行号必须对得上源码；直接拿 AST 也行，但这里已有现成文本，够用且无依赖。
 */
export function definitionLine(text, name) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|class|let|var|interface|type|enum)\\s+${name}\\b`).test(lines[i])) return i + 1
  }
  return 0
}
