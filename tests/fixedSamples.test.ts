// 3.2.0 · WQ8 固定样本对照 · 通路单测（示例样本 + 本地真实样本）
//
// 这里钉三件事：
//   ① `compareWithFixedSample` / `batchCompare...` 的通路真的能用（示例样本走一遍）；
//   ② 样本集自检能挡住"填错"（缺 id / 重复 id / 空正文 / 负容差）；
//   ③ 🔴 真实样本**只在本地**（`.workbuddy/eval-samples/samples.json`，不入库）：
//      有就跑对照并打印结果，没有就**明确说没提供**，绝不假装"全部通过"。
import { readFileSync, existsSync } from 'node:fs'
import * as path from 'node:path'
import './mock-memory'
import {
  DEMO_SAMPLES, validateSamples, describeSampleSet,
} from '@/lib/ai/factSamples'
import { batchCompareWithFixedSamples, compareWithFixedSample, type FixedSample } from '@/lib/ai/qualityGuard'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 真实样本的本地路径（git 忽略；不存在属正常，不是失败） */
const LOCAL_SAMPLES = path.join(process.cwd(), '.workbuddy', 'eval-samples', 'samples.json')

function readLocalSamples(): FixedSample[] {
  if (!existsSync(LOCAL_SAMPLES)) return []
  try {
    const raw = JSON.parse(readFileSync(LOCAL_SAMPLES, 'utf8')) as { samples?: FixedSample[] }
    return Array.isArray(raw.samples) ? raw.samples : []
  } catch (e) {
    console.log(`  · 本地样本读不动（按"没有"处理，不当作通过）：${e instanceof Error ? e.message : e}`)
    return []
  }
}

async function main() {
  // ---------- 一、示例样本：通路与字段 ----------
  {
    ok('① 示例样本字段齐全（id / 正文 / 期望 / 容差）', validateSamples(DEMO_SAMPLES).length === 0,
      validateSamples(DEMO_SAMPLES).join('；'))
    ok('① 示例样本 id 唯一', new Set(DEMO_SAMPLES.map(s => s.sampleId)).size === DEMO_SAMPLES.length)
    ok('① 摘要说人话', describeSampleSet(DEMO_SAMPLES).includes('固定样本'), describeSampleSet(DEMO_SAMPLES))

    // 完全按期望输出 ⇒ 必过（对照组：证明判据不是"永远不过"）
    const exact = compareWithFixedSample(DEMO_SAMPLES[0], DEMO_SAMPLES[0].expectedOutput)
    ok('🔴 ① 与期望一字不差 ⇒ 通过（对照组）', exact.passed && exact.charDiff === 0, JSON.stringify(exact))

    // 差得远 ⇒ 不过（字符数超容差）
    const far = compareWithFixedSample(DEMO_SAMPLES[0], '完全不同的一句话，长度也差很多很多很多。'.repeat(3))
    ok('① 差得远 ⇒ 字符数超容差判不过', !far.passed && far.issues.length > 0, JSON.stringify(far.issues))
  }

  // ---------- 二、填错要挡住 ----------
  {
    const bad: FixedSample[] = [
      { sampleId: '', input: 'x', expectedOutput: 'y', tolerance: 1 },
      { sampleId: 'dup', input: 'x', expectedOutput: 'y', tolerance: -1 },
      { sampleId: 'dup', input: '', expectedOutput: '', tolerance: 1 },
    ]
    const problems = validateSamples(bad)
    ok('② 缺 id / id 重复 / 空正文 / 负容差 都被点名',
      problems.length >= 4, problems.join('；'))
  }

  // ---------- 三、真实样本（本地，不入库） ----------
  {
    const local = readLocalSamples()
    const problems = validateSamples(local)
    if (local.length === 0) {
      console.log('  · 未提供真实样本（预期：主人按规范填写 .workbuddy/eval-samples/samples.json）')
      ok('🔴 ③ 没有真实样本时**不出结论**（不假装"全部通过"）', true)
    } else {
      ok('③ 本地样本填写合法', problems.length === 0, problems.join('；'))
      // 真实样本的 actual 需要真模型改写结果；此处只跑"期望自对照"通路，
      // 证明文件能被消费，不对模型质量下任何结论。
      const selfCheck = batchCompareWithFixedSamples(local, Object.fromEntries(local.map(s => [s.sampleId, s.expectedOutput])))
      ok('③ 本地样本全量可消费（自对照必过，证明文件格式对）',
        selfCheck.every(r => r.passed), selfCheck.filter(r => !r.passed).map(r => r.sampleId).join(','))
      console.log(`  · ${describeSampleSet(local)}`)
    }
  }

  console.log(`\n———— fixedSamples：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

void main()
