// 结构化检查 · 全局可变量被缓存却没订阅（2026-11-19 · 审计策略化第三轮）
//
// 【它拦的是哪一类问题】
//   组件把「界面缩放 / 窗口尺寸」读进 `useState` 之后就再也不更新 ——
//   值在挂载那一刻是对的，之后用户改了缩放或拉了窗口，它还是旧的，夹取/定位全部按旧值算。
//   实测事故（3.6.1）：颉文姬浮动面板的 zoom 是渲染时现读一次，缩放按钮在侧栏、本组件不重渲染，
//   于是"改了缩放面板还是按旧视口摆位"。修法是**订阅** `yfe:zoom-changed`（applyZoom 会派发）。
//
// 【为什么规则长这样，而不是"渲染期不许读样式"】
//   `currentUiZoom()` 出现在渲染体里**本身是对的**（读到的是当前值）；错的是"读一次存起来就不管了"。
//   若按"渲染期读样式"来判，会把正确写法全判成缺陷 —— 规则必须贴着**根因**写。
//
// 【判据（客观、无启发式）】
//   ① 出现 `useState(() => currentUiZoom())` / `useState(currentUiZoom)` /
//      `useState(() => window.innerWidth…)` 这类"缓存初值"；
//   ② 同文件里**没有任何**变更订阅：`addEventListener('resize' | 'yfe:zoom-changed')`、
//      `subscribeResize(` 或 `matchMedia(`。
//   两条同时成立才报；`src/lib/settings/theme.ts` 是这些 API 的提供者，登记豁免。
//
// 🔴 与旧脚本的关系：`legacy/audit-arch.mjs` 的 A5 只统计"渲染期重算"（人读报告），
//    本文件判的是**订阅缺失**，两者互补、不重叠。

import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from './source-text.mjs'
import { walkCode } from './dead-exports.mjs'

/** 这些文件就是"缩放/尺寸"的提供者，不该要求它们订阅自己 */
export const PROVIDERS = [
  { file: 'src/lib/settings/theme.ts', reason: 'currentUiZoom / foldPx / applyZoom 的实现处：写缩放的是它，订阅自己是循环' },
]

/** 缓存初值的写法（只认 useState，useRef 不算：ref 通常是"每次用时重读"） */
const CACHE_PATTERNS = [
  /useState\(\s*\(\s*\)\s*=>\s*currentUiZoom\(\s*\)\s*\)/,
  /useState\(\s*\(\s*\)\s*=>\s*window\.inner(?:Width|Height)\s*(?:\/\s*currentUiZoom\(\s*\))?\s*\)/,
  /useState\(\s*currentUiZoom\s*\)/,
  /useState\(\s*window\.inner(?:Width|Height)\s*\)/,
]

/** 任何一处订阅都算数（resize / 缩放事件 / 共享 resize 订阅 / 媒体查询） */
const SUBSCRIPTION = /addEventListener\(\s*['"](?:resize|yfe:zoom-changed)['"]|subscribeResize\(|matchMedia\(/

/** 单文件判定（导出给单测用：喂源码片段即可，不必造文件） */
export function scanStaleCacheSource(file, text) {
  if (PROVIDERS.some(p => p.file === file)) return []
  const body = stripComments(text)
  const hit = CACHE_PATTERNS.find(re => re.test(body))
  if (!hit) return []
  if (SUBSCRIPTION.test(body)) return []
  const lines = body.split(/\r?\n/)
  const line = lines.findIndex(l => CACHE_PATTERNS.some(re => re.test(l))) + 1
  return [{
    rule: 'stale.cache',
    file,
    line: line > 0 ? line : 1,
    message: '把界面缩放 / 窗口尺寸缓存进 useState 却没有任何变更订阅（resize 或 yfe:zoom-changed）：改了缩放或拉窗口后这里仍是旧值',
  }]
}

/** 全仓扫描 */
export function scanStaleCache(root) {
  const findings = []
  const files = walkCode(path.join(root, 'src'))
  for (const absolute of files) {
    const rel = path.relative(root, absolute).replace(/\\/g, '/')
    let text = ''
    try { text = fs.readFileSync(absolute, 'utf8') } catch { continue }
    findings.push(...scanStaleCacheSource(rel, text))
  }
  return { files: files.length, findings, stats: { findings: findings.length } }
}

/** 豁免名单自洽：登记了却不存在 ⇒ 名单变谎言（与门面名单同口径） */
export function validateProviders(root) {
  const issues = PROVIDERS
    .filter(p => !fs.existsSync(path.join(root, p.file)))
    .map(p => `豁免登记的文件不存在：${p.file}`)
  return { ok: issues.length === 0, issues }
}
