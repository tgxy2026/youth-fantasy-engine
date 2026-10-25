import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 契约 `layout.affected` 证据校验（3.2.6）。
 *
 * 方案里这条契约的原义是「本次 UI 改动涉及的布局」：改动不能把某个页签在小窗口 / 高缩放下挤出视口。
 * 现有 `workspace-layout-probe.cjs` 会遍历**全部页签 × 多组窗口/缩放**逐一量主区尺寸与溢出，
 * 比「只看改动过的页面」更严 —— 所以直接用它作证据，但校验必须逐项咬住：
 *   · 指纹要对（否则是上一轮的结果）；
 *   · `stale` 必须为假（探针自己会对比源码指纹）；
 *   · 用例数要够，且**缩放档至少 3 档**（只测 100% 等于没测缩放这条红线）；
 *   · 任何一条用例带 issues 或页面异常都不算过。
 */
export const LAYOUT_MIN_CASES = 100
export const LAYOUT_MIN_ZOOMS = 3

export async function validateLayoutEvidence(root, file, { expectedSourceFingerprint, minCases = LAYOUT_MIN_CASES }) {
  const result = JSON.parse(await fs.readFile(file, 'utf8'))
  if (result.sourceFingerprint !== expectedSourceFingerprint) throw new Error('layout.affected 证据与当前源码不符（重新跑）')
  if (result.stale) throw new Error('layout.affected 证据在跑的过程中源码被改过（stale）')
  if (Array.isArray(result.errors) && result.errors.length) throw new Error('layout.affected 有页面异常：' + result.errors.slice(0, 3).join(' / '))
  const cases = Array.isArray(result.cases) ? result.cases : []
  if (cases.length < minCases) throw new Error(`layout.affected 用例只有 ${cases.length} 条，少于下限 ${minCases}`)
  const zooms = new Set(cases.map(c => `${c.zoom}`))
  if (zooms.size < LAYOUT_MIN_ZOOMS) throw new Error(`layout.affected 只覆盖了 ${zooms.size} 个缩放档（至少要 ${LAYOUT_MIN_ZOOMS}）`)
  const bad = cases.filter(c => !Array.isArray(c.issues) || c.issues.length)
  if (bad.length) {
    const sample = bad.slice(0, 2).map(c => `${c.width}px@${c.zoom}% ${c.id}: ${c.issues.slice(0, 2).join('；')}`).join(' | ')
    throw new Error(`layout.affected 有 ${bad.length} 条用例布局越界：${sample}`)
  }
  const digest = createHash('sha256').update(await fs.readFile(file)).digest('hex')
  return { assertions: cases.length, sha256: digest, result }
}
