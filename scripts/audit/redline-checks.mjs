// 结构化检查 · 界面与交互红线 10–15（3.7.5 · 审计工具第四轮）
//
// 【为什么要把这 6 条从 legacy 日志升格为硬线】
//   红线 10–15 原先只写在 `legacy/audit-scan.mjs` 的人工日志里，`run.mjs` 只要不报错就会判
//   `complete` —— 导致 3.7.1（CharacterBioPanels 文字按钮 ghost，红线 14）与 3.7.3
//   （ProjectHub 内联 min-h-[55vh]，红线 11）两次回归都在后续专项才被捞出。
//   这 6 条判据全为确定性静态模式（无相似度打分），预期在全仓长期为 0，适合作为硬线纳入自检。
//
// 【六条规则】
//   1. `redline.clipboard`    —— 裸 navigator.clipboard（复制应走 dialogs.tsx 的 copyText()）
//   2. `redline.raw-vh`       —— 内联 vh/vw 长度未走 foldVh() / --ui-zoom 折算
//   3. `redline.svg-css-var`  —— SVG 表现属性直接写 rgb(var(--...))（应走 style={{}}）
//   4. `redline.zindex-magic` —— 硬编码 z-index 魔数（z-[\d / z-50 / z-100+，应走 zLayer.ts 的 Z）
//   5. `redline.ghost-text`   —— <Button variant="ghost"> 但未标 iconOnly（文字按钮应 secondary）
//   6. `redline.ime-enter`    —— 判 'Enter' 的处理器上下 25 行内未见 isComposing 守卫

import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from './source-text.mjs'
import { walkCode } from './dead-exports.mjs'

const COPY_SRC = 'src/components/dialogs/dialogs.tsx'
const IME_WIN = 25

function lineAt(text, idx) {
  return text.slice(0, idx).split('\n').length
}

/**
 * 扫描单个文件的红线 10–15（纯逻辑，导出给单测与全仓扫描共用）。
 * @param {string} file 相对仓库根的 posix 路径
 * @param {string} text 源码全文
 */
export function scanRedlinesSource(file, text) {
  const rel = file.replace(/\\/g, '/')
  const masked = stripComments(text)
  const lines = masked.split(/\r?\n/)
  const findings = []

  // 10. 裸 navigator.clipboard
  if (rel !== COPY_SRC) {
    lines.forEach((l, i) => {
      if (/navigator\.clipboard/.test(l)) {
        findings.push({
          rule: 'redline.clipboard',
          file: rel,
          line: i + 1,
          message: `裸 navigator.clipboard（复制应走 dialogs.tsx 的 copyText()）：${l.trim().slice(0, 90)}`,
        })
      }
    })
  }

  // 11. 内联 vh/vw 未走 foldVh() / --ui-zoom 折算
  if (rel !== 'src/components/dialogs/Modal.tsx') {
    lines.forEach((l, i) => {
      if (/--ui-zoom|foldVh\(/.test(l)) return
      if (/(?:maxHeight|topOffset|maxWidth)\s*=\s*["']\s*\d+(?:\.\d+)?(?:vh|vw)\s*["']/.test(l)) return
      if (!/\b\d+(?:\.\d+)?(?:vh|vw)\b/.test(l)) return
      const def = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(l)
      if (def && new RegExp(`\\$\\{${def[1]}\\}`).test(masked) && /--ui-zoom|foldVh\(/.test(masked)) return
      findings.push({
        rule: 'redline.raw-vh',
        file: rel,
        line: i + 1,
        message: `内联 vh/vw 未折算界面缩放（应走 theme.ts 的 foldVh() 或 --ui-zoom）：${l.trim().slice(0, 90)}`,
      })
    })
  }

  // 12. SVG 表现属性里的 rgb(var(--...))
  lines.forEach((l, i) => {
    if (/(?:fill|stroke|stop-color|flood-color)\s*=\s*["']\s*rgb\(var\(--/.test(l)) {
      findings.push({
        rule: 'redline.svg-css-var',
        file: rel,
        line: i + 1,
        message: `SVG 表现属性直接写 rgb(var(--...))，须改用 style={{}}：${l.trim().slice(0, 90)}`,
      })
    }
  })

  // 13. 硬编码 z-index 魔数
  lines.forEach((l, i) => {
    if (/z-\[\d/.test(l) || /\bz-(?:50|[1-9]\d{2,})\b/.test(l)) {
      findings.push({
        rule: 'redline.zindex-magic',
        file: rel,
        line: i + 1,
        message: `硬编码 z-index 魔数（应走 zLayer.ts 的 Z）：${l.trim().slice(0, 90)}`,
      })
    }
  })

  // 14. variant="ghost" 且非 iconOnly
  const ghostRe = /<Button\b[\s\S]*?>[\s\S]{0,200}?<\/Button>/g
  let gm
  while ((gm = ghostRe.exec(masked))) {
    const tag = gm[0]
    if (!/variant="ghost"/.test(tag)) continue
    if (/iconOnly/.test(tag)) continue
    findings.push({
      rule: 'redline.ghost-text',
      file: rel,
      line: lineAt(masked, gm.index),
      message: `文字按钮误用 variant="ghost"（仅 iconOnly 允许用 ghost，文字按钮应走 secondary）：${tag.replace(/\s+/g, ' ').trim().slice(0, 90)}`,
    })
  }

  // 15. 回车处理器未挡 isComposing
  lines.forEach((l, i) => {
    if (!/key\s*(?:===|!==)\s*['"]Enter['"]/.test(l)) return
    const win = lines.slice(Math.max(0, i - IME_WIN), i + IME_WIN + 1).join('\n')
    if (!/isComposing/.test(win)) {
      findings.push({
        rule: 'redline.ime-enter',
        file: rel,
        line: i + 1,
        message: `回车处理器上下 ${IME_WIN} 行内未见 isComposing 守卫（防中文输入法选字误提交）：${l.trim().slice(0, 90)}`,
      })
    }
  })

  return findings
}

/** 全仓扫描红线 10–15 */
export function scanRedlines(root) {
  const findings = []
  const files = walkCode(path.join(root, 'src'))
  for (const abs of files) {
    const rel = path.relative(root, abs).replace(/\\/g, '/')
    let text = ''
    try { text = fs.readFileSync(abs, 'utf8') } catch { continue }
    findings.push(...scanRedlinesSource(rel, text))
  }
  return { files: files.length, findings, stats: { findings: findings.length } }
}
