// ============ 2.9.2 · 模型生成参数微调（lib/modelSampling.ts） ============
//
// 覆盖：① 语义名 → 原生键名的转换（本地 / 云端两套）；② **留空 ＝ 不下发**；
//      ③ 云端只下发白名单那三个（Ollama 专有键被丢弃）；④ 字段表与转换行为**一致**
//      （`cloud: false` 的三项在云端结果里一定不出现 —— 界面据此灰显，两边不许漂移）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { SAMPLING_FIELDS, samplingOptionsOf, type SamplingValues } from '../src/lib/modelSampling'

const readSrc = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ modelSampling')

const full: SamplingValues = {
  topP: 0.9, topK: 40, repeatPenalty: 1.05, repeatLastN: 768, frequencyPenalty: 0.1, presencePenalty: 0.4,
}

// ---------- ① 本地：六个全下发（用 Ollama 原生键名） ----------
{
  const o = samplingOptionsOf({ local: true, sampling: full })
  ok('① 本地：六个键全部下发', !!o && Object.keys(o).length === 6, JSON.stringify(o))
  ok('① 本地：键名是 Ollama 原生名',
    !!o && o.top_p === 0.9 && o.top_k === 40 && o.repeat_penalty === 1.05 &&
    o.repeat_last_n === 768 && o.frequency_penalty === 0.1 && o.presence_penalty === 0.4,
    JSON.stringify(o))
  // 🔴 命名陷阱：内部 repeatPenalty → Ollama 是 repeat_penalty（**少 "ition"**）
  ok('🔴 命名陷阱：repeatPenalty 下发时必须叫 repeat_penalty（不是 repetition_penalty）',
    !!o && 'repeat_penalty' in o && !('repetition_penalty' in o), JSON.stringify(o))
}

// ---------- ② 云端：只下发白名单那三个 ----------
{
  const o = samplingOptionsOf({ local: false, sampling: full })
  ok('② 云端：只下发 3 个（top_p / frequency_penalty / presence_penalty）',
    !!o && Object.keys(o).sort().join(',') === 'frequency_penalty,presence_penalty,top_p',
    JSON.stringify(o))
  ok('🔴 云端：Ollama 专有键（top_k / repeat_penalty / repeat_last_n）必须被丢弃',
    !!o && !('top_k' in o) && !('repeat_penalty' in o) && !('repeat_last_n' in o),
    JSON.stringify(o))
  // local 缺省（undefined）也按云端处理 —— 不能漏判成"本地"
  const o2 = samplingOptionsOf({ sampling: full })
  ok('② local 缺省时按云端处理（更保守的一侧）',
    !!o2 && Object.keys(o2).sort().join(',') === 'frequency_penalty,presence_penalty,top_p',
    JSON.stringify(o2))
}

// ---------- ③ 留空 ＝ 不下发（本功能的核心回归判据） ----------
{
  ok('🔴 完全没有 sampling 字段 ⇒ undefined（请求体与改动前逐字节一致）',
    samplingOptionsOf({ local: true }) === undefined)
  ok('🔴 sampling 是空对象 ⇒ undefined', samplingOptionsOf({ local: true, sampling: {} }) === undefined)
  ok('🔴 全是非法值（NaN / Infinity）⇒ undefined',
    samplingOptionsOf({ local: true, sampling: { topP: NaN, topK: Infinity } }) === undefined)
  ok('🔴 provider 为 null / undefined ⇒ undefined',
    samplingOptionsOf(null) === undefined && samplingOptionsOf(undefined) === undefined)
  // 只填一个 ⇒ 只下发那一个（不塞 0 之类的占位值）
  const one = samplingOptionsOf({ local: true, sampling: { topP: 0.9 } })
  ok('③ 只填一个 ⇒ 只下发那一个键', !!one && Object.keys(one).length === 1 && one.top_p === 0.9,
    JSON.stringify(one))
  // 0 是合法值（如 topK=0 表示不限制），不能被当成"没填"
  const zero = samplingOptionsOf({ local: true, sampling: { topK: 0 } })
  ok('🔴 0 是合法值（topK=0 ＝ 不限制），必须下发而不是被当作没填',
    !!zero && zero.top_k === 0, JSON.stringify(zero))
}

// ---------- ④ 字段表与转换行为必须一致（界面灰显与否 ⟺ 能不能下发） ----------
{
  ok('④ 字段表共 6 项且 key 不重复',
    SAMPLING_FIELDS.length === 6 && new Set(SAMPLING_FIELDS.map(f => f.key)).size === 6,
    String(SAMPLING_FIELDS.length))
  ok('④ 每项的范围自洽（min < max、step > 0）',
    SAMPLING_FIELDS.every(f => f.min < f.max && f.step > 0))
  ok('④ 每项都有推荐值与因果说明（主人要求：给出推荐值和参数调试说明）',
    SAMPLING_FIELDS.every(f => f.recommend.length > 0 && f.effect.length > 20))

  // 🔴 关键一致性：标了「仅本地」的三项，在云端下发结果里一个都不许出现
  const cloudOnly = SAMPLING_FIELDS.filter(f => !f.cloud).map(f => f.key)
  ok('🔴 标「仅本地」的正好是 3 项（候选词上限 / 重复惩罚 / 惩罚回看窗口）',
    cloudOnly.length === 3 && cloudOnly.includes('topK') &&
    cloudOnly.includes('repeatPenalty') && cloudOnly.includes('repeatLastN'),
    cloudOnly.join(','))

  const allOn: SamplingValues = Object.fromEntries(SAMPLING_FIELDS.map(f => [f.key, 1])) as SamplingValues
  const localOut = samplingOptionsOf({ local: true, sampling: allOn }) ?? {}
  const cloudOut = samplingOptionsOf({ local: false, sampling: allOn }) ?? {}
  ok('🔴 本地下发项数 == 字段表项数（六项都能下去）',
    Object.keys(localOut).length === SAMPLING_FIELDS.length,
    `${Object.keys(localOut).length} vs ${SAMPLING_FIELDS.length}`)
  ok('🔴 云端下发项数 == 标 cloud:true 的项数（界面灰显与下发行为一致）',
    Object.keys(cloudOut).length === SAMPLING_FIELDS.filter(f => f.cloud).length,
    `${Object.keys(cloudOut).length} vs ${SAMPLING_FIELDS.filter(f => f.cloud).length}`)

  // 反向也钉住：凡是 cloud:true 的，云端必须能下去
  ok('🔴 标 cloud:true 的项在云端结果里必须都在',
    SAMPLING_FIELDS.filter(f => f.cloud).every(f => {
      const single = samplingOptionsOf({ local: false, sampling: { [f.key]: 0.5 } as SamplingValues })
      return !!single && Object.keys(single).length === 1
    }))
}

// ---------- ⑤ 源码断言：界面灰显 ⟺ 下发行为（这类一致性破了不会报错，只会静默误导） ----------
// 🔴 为什么用源码断言而不是实机：实机跑在**某一种**模型形态下，
//    「本地模型 ⇒ 0 项灰显」会让「根本没实现灰显」也通过 —— 判别力不足（本轮真踩过）。
//    这里直接钉住「三处 Ollama 专有参数都按 local 分了两态」，与实机互补。
{
  const modes = readSrc('src/components/TavernControlModes.tsx')
  const three = ['候选词上限', '重复惩罚', '惩罚射程']
  const ternaryCount = (modes.match(/local \? \(/g) || []).length
  ok('🔴 酒馆：三项 Ollama 专有参数 × 两个模式 ＝ 6 处都按 local 分了两态',
    ternaryCount === 6, String(ternaryCount))
  const naCount = (modes.match(/<CloudOnlyNA /g) || []).length
  ok('🔴 酒馆：6 处灰显占位走同一个 CloudOnlyNA 组件（不各写各的样式）',
    modes.includes('function CloudOnlyNA') && naCount === 6, String(naCount))
  ok('🔴 酒馆：三项都在灰显清单里',
    three.every(l => (modes.match(new RegExp(`<CloudOnlyNA label="${l}"`, 'g')) || []).length === 2),
    three.map(l => `${l}:${(modes.match(new RegExp(`<CloudOnlyNA label="${l}"`, 'g')) || []).length}`).join(' '))
  ok('🔴 酒馆：云端判定由父组件统一传入（不是各组件各自判断）',
    readSrc('src/components/TavernControl.tsx').includes('local={!!cap.local}'))

  const cfg = readSrc('src/components/AIConfigPanel.tsx')
  ok('🔴 模型配置页：「文本生成微调」区块在位且位于自定义系统提示词之后',
    cfg.includes('文本生成微调') &&
    cfg.indexOf('文本生成微调') > cfg.indexOf('自定义系统提示词'))
  ok('🔴 模型配置页：三项 Ollama 专有参数按 editing.local 灰显',
    cfg.includes('const usable = f.cloud || !!editing.local') && cfg.includes('对云端模型不适用'))
  ok('🔴 模型配置页：说明里写清「留空 ＝ 不下发」与结构化任务不受影响',
    cfg.includes('留空 ＝ 不下发') && cfg.includes('结构化任务'))
  ok('🔴 装配层：chat() 确实用 provider 兜底（否则界面填了也白填）',
    readSrc('src/lib/aiCore/chat.ts').includes('opts.extraOptions ?? samplingOptionsOf(config)'))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
// assert 目前未直接使用，保留 import 以便后续扩展时随手断言
void assert
