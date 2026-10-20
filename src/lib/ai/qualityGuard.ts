// ============ WQ8 基础质量与评测 · 证据/文本守卫 ============
// 2026-10-20 · 方案 §11 / WQ8
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 证据校验（伪造引文、重复引文、未知字段）
//    ② 文本守卫（事实保留、误报检测）
//    ③ 固定样本对照
//    ④ 质量评分

// ============ 证据诊断 ============
/**
 * 证据校验自己的诊断形状。
 *
 * 🔴 不复用契约的 `ParseDiagnostic`：那个类型描述的是「模型文本 → 结构化数据」的
 *    解析故障（code = missing-field / truncated / …），而这里是"引文质量"问题
 *    （重复 / 无法定位 / 疑似伪造）。硬塞进解析码表只会让两边都不准。
 */
export interface EvidenceDiagnostic {
  level: 'warn' | 'error'
  message: string
  /** 建议处置（可选） */
  fix?: string
}

// ============ 证据校验结果 ============
export interface EvidenceCheckResult {
  /** 是否通过 */
  passed: boolean
  /** 引文是否伪造 */
  isForged: boolean
  /** 引文是否重复 */
  isDuplicate: boolean
  /** 引文是否可定位 */
  isLocated: boolean
  /** 问题列表 */
  issues: string[]
  /** 诊断信息 */
  diagnostics: EvidenceDiagnostic[]
}

// ============ 引文信息 ============
export interface CitationInfo {
  /** 引文内容 */
  quote: string
  /** 来源（章节/设定项） */
  source: string
  /** 是否可定位 */
  located: boolean
  /** 定位位置 */
  location?: string
}

/** 校验引文（伪造/重复/可定位） */
export function checkEvidence(
  citations: CitationInfo[],
  bodyText: string,
  knownSources: Set<string>,
): EvidenceCheckResult {
  const issues: string[] = []
  const diagnostics: EvidenceDiagnostic[] = []
  let isForged = false
  let isDuplicate = false
  let isLocated = true

  // 检查重复引文
  const seenQuotes = new Set<string>()
  for (const c of citations) {
    if (seenQuotes.has(c.quote)) {
      isDuplicate = true
      issues.push(`重复引文: ${c.quote.slice(0, 30)}…`)
      diagnostics.push({ level: 'warn', message: '重复引文', fix: '合并为同一条' })
    }
    seenQuotes.add(c.quote)
  }

  // 逐字比对正文：命中与否只做提示，不改变 passed
  // 🔴 为什么不直接判伪造：引文可能经过作者人工转述/截断（省略号），
  //    机器逐字对不上不等于伪造；伪造靠"不在正文 **且** 来源也不已知"来判。
  if (bodyText) {
    for (const c of citations) {
      if (c.located && c.quote && !bodyText.includes(c.quote)) {
        issues.push(`引文未在正文逐字出现（需人工核对）: ${c.quote.slice(0, 30)}…`)
        diagnostics.push({ level: 'warn', message: '引文与正文不逐字一致', fix: '确认是否为转述或省略' })
      }
    }
  }

  // 检查可定位
  for (const c of citations) {
    if (!c.located) {
      isLocated = false
      issues.push(`引文无法定位: ${c.quote.slice(0, 30)}…`)
      diagnostics.push({ level: 'error', message: '引文无法定位' })
    }
  }

  // 检查伪造引文（不在正文中且不在已知来源中）
  for (const c of citations) {
    if (!c.located && !knownSources.has(c.source)) {
      isForged = true
      issues.push(`疑似伪造引文: ${c.quote.slice(0, 30)}…`)
      diagnostics.push({ level: 'error', message: '疑似伪造引文' })
    }
  }

  return {
    passed: !isForged && isLocated && !isDuplicate,
    isForged,
    isDuplicate,
    isLocated,
    issues,
    diagnostics,
  }
}

// ============ 文本守卫 ============
export interface TextGuardResult {
  /** 是否通过 */
  passed: boolean
  /** 事实保留率 */
  factRetentionRate: number
  /** 误报数 */
  falsePositives: number
  /** 问题列表 */
  issues: string[]
}

/** 文本守卫：检查事实保留与误报 */
export function guardText(
  original: string,
  revised: string,
  knownFacts: Set<string>,
  newClaims: string[],
): TextGuardResult {
  const issues: string[] = []
  let falsePositives = 0

  // 检查已知事实是否保留
  let retainedFacts = 0
  for (const fact of knownFacts) {
    if (revised.includes(fact)) {
      retainedFacts++
    } else {
      issues.push(`可能丢失事实: ${fact}`)
    }
  }
  const factRetentionRate = knownFacts.size > 0 ? retainedFacts / knownFacts.size : 1

  // 检查新声明是否可验证
  for (const claim of newClaims) {
    if (!knownFacts.has(claim)) {
      // 新声明需要验证
      issues.push(`新声明需验证: ${claim}`)
    }
  }

  // 误报检测：检查是否有不合理的修改
  if (revised.length < original.length * 0.5) {
    falsePositives++
    issues.push('正文被过度缩短，可能误删重要内容')
  }

  return {
    passed: factRetentionRate >= 0.8 && falsePositives === 0,
    factRetentionRate,
    falsePositives,
    issues,
  }
}

// ============ 固定样本对照 ============
export interface FixedSample {
  /** 样本 ID */
  sampleId: string
  /** 输入 */
  input: string
  /** 期望输出 */
  expectedOutput: string
  /** 容差（字符数） */
  tolerance: number
}

export interface SampleComparisonResult {
  /** 样本 ID */
  sampleId: string
  /** 是否通过 */
  passed: boolean
  /** 字符数差异 */
  charDiff: number
  /** 相似度（0-1） */
  similarity: number
  /** 问题列表 */
  issues: string[]
}

/** 计算字符串相似度（简单 Jaccard） */
function similarity(a: string, b: string): number {
  const setA = new Set(a.split(''))
  const setB = new Set(b.split(''))
  const intersection = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return union.size > 0 ? intersection.size / union.size : 0
}

/** 对照固定样本 */
export function compareWithFixedSample(
  sample: FixedSample,
  actualOutput: string,
): SampleComparisonResult {
  const charDiff = Math.abs(actualOutput.length - sample.expectedOutput.length)
  const sim = similarity(actualOutput, sample.expectedOutput)
  const issues: string[] = []

  let passed = true
  if (charDiff > sample.tolerance) {
    passed = false
    issues.push(`字符数差异 ${charDiff} 超过容差 ${sample.tolerance}`)
  }
  if (sim < 0.5) {
    passed = false
    issues.push(`相似度 ${sim.toFixed(2)} 低于阈值 0.5`)
  }

  return {
    sampleId: sample.sampleId,
    passed,
    charDiff,
    similarity: sim,
    issues,
  }
}

/** 批量对照固定样本 */
export function batchCompareWithFixedSamples(
  samples: FixedSample[],
  actualOutputs: Record<string, string>,
): SampleComparisonResult[] {
  return samples.map(sample => {
    const actual = actualOutputs[sample.sampleId] ?? ''
    return compareWithFixedSample(sample, actual)
  })
}

// ============ 质量评分 ============
export interface QualityScore {
  /** 总分（0-100） */
  score: number
  /** 证据质量分 */
  evidenceScore: number
  /** 文本质量分 */
  textScore: number
  /** 事实保留分 */
  factRetentionScore: number
  /** 问题列表 */
  issues: string[]
}

/** 计算质量评分 */
export function calculateQualityScore(
  evidenceResult: EvidenceCheckResult,
  textResult: TextGuardResult,
  sampleResults: SampleComparisonResult[],
): QualityScore {
  const issues: string[] = []

  // 证据质量分（40 分）
  let evidenceScore = 40
  if (!evidenceResult.isLocated) evidenceScore -= 15
  if (evidenceResult.isDuplicate) evidenceScore -= 10
  if (evidenceResult.isForged) evidenceScore -= 20
  evidenceScore = Math.max(0, evidenceScore)

  // 文本质量分（30 分）
  let textScore = 30
  if (textResult.falsePositives > 0) textScore -= 10 * textResult.falsePositives
  textScore = Math.max(0, textScore)

  // 事实保留分（30 分）
  const factRetentionScore = Math.round(30 * textResult.factRetentionRate)

  // 样本对照分（额外）
  const samplePassRate = sampleResults.length > 0
    ? sampleResults.filter(r => r.passed).length / sampleResults.length
    : 1
  const sampleBonus = Math.round(10 * samplePassRate)

  const score = evidenceScore + textScore + factRetentionScore + sampleBonus

  // 收集问题
  issues.push(...evidenceResult.issues)
  issues.push(...textResult.issues)
  for (const r of sampleResults) {
    if (!r.passed) issues.push(...r.issues)
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    evidenceScore,
    textScore,
    factRetentionScore,
    issues,
  }
}

// ============ 未知字段检测 ============
export interface UnknownFieldResult {
  /** 是否发现未知字段 */
  hasUnknownFields: boolean
  /** 未知字段列表 */
  unknownFields: string[]
  /** 建议 */
  suggestions: string[]
}

/** 检测模型返回的未知字段 */
export function detectUnknownFields(
  result: Record<string, unknown>,
  knownFields: Set<string>,
  knownFieldAliases: Map<string, string>,
): UnknownFieldResult {
  const unknownFields: string[] = []
  const suggestions: string[] = []

  for (const key of Object.keys(result)) {
    if (knownFields.has(key)) continue

    // 检查别名
    let isAlias = false
    for (const [alias, canonical] of knownFieldAliases) {
      if (alias === key || canonical === key) {
        isAlias = true
        suggestions.push(`字段 "${key}" 可能是 "${canonical}" 的别名`)
        break
      }
    }

    if (!isAlias) {
      unknownFields.push(key)
    }
  }

  return {
    hasUnknownFields: unknownFields.length > 0,
    unknownFields,
    suggestions,
  }
}
