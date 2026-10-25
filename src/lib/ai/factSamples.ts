// ============ WQ8 固定样本对照 · 示例样本 ============
// 2026-10-21 · 方案 §11 / WQ8
//
// 🔴 这里的两个样本是**虚构示例**，只为说明格式与通路（`tests/fixedSamples.test.ts` 会跑它们）。
//    真实样本必须用**作者自己的书**：`expectedOutput` 是作者手工改定的版本，
//    不是模型输出 —— 拿模型输出当"期望"，对照就失去了意义（只是让模型给自己打分）。
//
// 🔴 隐私边界：真实样本放**本地不入库**的 `.workbuddy/eval-samples/samples.json`
//    （与 `.workbuddy/` 同级，git 忽略）；**绝不进 `src/`、绝不进 docs/**。
//    规范见 `docs/归档/3.2/3.2.0-WQ8-固定样本对照-评测集规范-2026-10-21.md`。

import type { FixedSample } from './qualityGuard'

/**
 * 示例样本（虚构）。
 *
 * 选它们是因为覆盖了对照最关心的两种失败：
 *   ① 字符数差太多（容差判据）—— 模型爱扩写；
 *   ② 内容面目全非（相似度判据）—— 模型爱"重写"而不是"修订"。
 */
export const DEMO_SAMPLES: readonly FixedSample[] = [
  {
    sampleId: 'demo-typo-fix',
    input: '他按装好机关，走出密室。门外夜色沉沉，远处传来犬吠。',
    expectedOutput: '他安装好机关，走出密室。门外夜色沉沉，远处传来犬吠。',
    tolerance: 4,
  },
  {
    sampleId: 'demo-sensitive-rewrite',
    input: '这是一场血腥的屠杀，血流成河，尸体堆积如山。',
    expectedOutput: '这是一场惨烈的厮杀，伤亡惨重，倒地者不计其数。',
    tolerance: 8,
  },
]

/** 样本集自检：字段齐全、容差非负、id 不重复（纯函数，供测试与工具用） */
export function validateSamples(samples: readonly FixedSample[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const s of samples) {
    if (!s.sampleId?.trim()) problems.push('有样本缺 sampleId')
    if (seen.has(s.sampleId)) problems.push(`sampleId 重复：${s.sampleId}`)
    seen.add(s.sampleId)
    if (!s.input?.trim()) problems.push(`${s.sampleId}：input 为空`)
    if (!s.expectedOutput?.trim()) problems.push(`${s.sampleId}：expectedOutput 为空`)
    if (!(s.tolerance >= 0)) problems.push(`${s.sampleId}：tolerance 为负`)
  }
  return problems
}

/** 一句话描述样本集（给日志/界面用；没有样本就说没有，不编） */
export function describeSampleSet(samples: readonly FixedSample[]): string {
  if (samples.length === 0) return '固定样本 0 条'
  const avg = Math.round(samples.reduce((n, s) => n + s.tolerance, 0) / samples.length)
  return `固定样本 ${samples.length} 条（容差中位约 ${avg} 字）`
}
