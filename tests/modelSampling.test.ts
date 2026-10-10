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

// ---------- ① Ollama 原生端点：六个全下发（用原生键名） ----------
{
  const o = samplingOptionsOf({ type: 'ollama', sampling: full })
  ok('① 本地：六个键全部下发', !!o && Object.keys(o).length === 6, JSON.stringify(o))
  ok('① 本地：键名是 Ollama 原生名',
    !!o && o.top_p === 0.9 && o.top_k === 40 && o.repeat_penalty === 1.05 &&
    o.repeat_last_n === 768 && o.frequency_penalty === 0.1 && o.presence_penalty === 0.4,
    JSON.stringify(o))
  // 🔴 命名陷阱：内部 repeatPenalty → Ollama 是 repeat_penalty（**少 "ition"**）
  ok('🔴 命名陷阱：repeatPenalty 下发时必须叫 repeat_penalty（不是 repetition_penalty）',
    !!o && 'repeat_penalty' in o && !('repetition_penalty' in o), JSON.stringify(o))
}

// ---------- ② 非 Ollama（云端 ＋ 本地 OpenAI 兼容）：只下发白名单那三个 ----------
{
  const o = samplingOptionsOf({ type: 'openai', sampling: full })
  ok('② 云端：只下发 3 个（top_p / frequency_penalty / presence_penalty）',
    !!o && Object.keys(o).sort().join(',') === 'frequency_penalty,presence_penalty,top_p',
    JSON.stringify(o))
  ok('🔴 云端：Ollama 专有键（top_k / repeat_penalty / repeat_last_n）必须被丢弃',
    !!o && !('top_k' in o) && !('repeat_penalty' in o) && !('repeat_last_n' in o),
    JSON.stringify(o))
  // type 缺省（undefined）也按「非 Ollama」处理 —— 不能漏判成原生通道
  const o2 = samplingOptionsOf({ sampling: full })
  ok('② type 缺省时按非 Ollama 处理（更保守的一侧）',
    !!o2 && Object.keys(o2).sort().join(',') === 'frequency_penalty,presence_penalty,top_p',
    JSON.stringify(o2))

  // 🔴🔴 2026-10-09 审计修的那个 bug 的判别力证明：
  //    **本地 OpenAI 兼容**（LM Studio / LocalAI / GPT4All / Jan…）也是 `local: true`，
  //    但它走 `openaiChat` 的白名单 ⇒ 三个 Ollama 专有键必须被丢弃。
  //    判据还停留在 `local` 时，这里会下发 **6** 个键 —— 界面显示可编辑、实际被静默丢掉，
  //    正是本轮要修的那一类「调了不生效」。
  const localOpenai = samplingOptionsOf({ type: 'openai', local: true, sampling: full })
  ok('🔴 本地 OpenAI 兼容（type=openai + local=true）仍只下发 3 个（判据必须是 type）',
    !!localOpenai && Object.keys(localOpenai).sort().join(',') === 'frequency_penalty,presence_penalty,top_p',
    JSON.stringify(localOpenai))
}

// ---------- ③ 留空 ＝ 不下发（本功能的核心回归判据） ----------
{
  ok('🔴 完全没有 sampling 字段 ⇒ undefined（请求体与改动前逐字节一致）',
    samplingOptionsOf({ type: 'ollama' }) === undefined)
  ok('🔴 sampling 是空对象 ⇒ undefined', samplingOptionsOf({ type: 'ollama', sampling: {} }) === undefined)
  ok('🔴 全是非法值（NaN / Infinity）⇒ undefined',
    samplingOptionsOf({ type: 'ollama', sampling: { topP: NaN, topK: Infinity } }) === undefined)
  ok('🔴 provider 为 null / undefined ⇒ undefined',
    samplingOptionsOf(null) === undefined && samplingOptionsOf(undefined) === undefined)
  // 只填一个 ⇒ 只下发那一个（不塞 0 之类的占位值）
  const one = samplingOptionsOf({ type: 'ollama', sampling: { topP: 0.9 } })
  ok('③ 只填一个 ⇒ 只下发那一个键', !!one && Object.keys(one).length === 1 && one.top_p === 0.9,
    JSON.stringify(one))
  // 0 是合法值（如 topK=0 表示不限制），不能被当成"没填"
  const zero = samplingOptionsOf({ type: 'ollama', sampling: { topK: 0 } })
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
  const localOut = samplingOptionsOf({ type: 'ollama', sampling: allOn }) ?? {}
  const cloudOut = samplingOptionsOf({ type: 'openai', sampling: allOn }) ?? {}
  ok('🔴 本地下发项数 == 字段表项数（六项都能下去）',
    Object.keys(localOut).length === SAMPLING_FIELDS.length,
    `${Object.keys(localOut).length} vs ${SAMPLING_FIELDS.length}`)
  ok('🔴 云端下发项数 == 标 cloud:true 的项数（界面灰显与下发行为一致）',
    Object.keys(cloudOut).length === SAMPLING_FIELDS.filter(f => f.cloud).length,
    `${Object.keys(cloudOut).length} vs ${SAMPLING_FIELDS.filter(f => f.cloud).length}`)

  // 反向也钉住：凡是 cloud:true 的，云端必须能下去
  ok('🔴 标 cloud:true 的项在云端结果里必须都在',
    SAMPLING_FIELDS.filter(f => f.cloud).every(f => {
      const single = samplingOptionsOf({ type: 'openai', sampling: { [f.key]: 0.5 } as SamplingValues })
      return !!single && Object.keys(single).length === 1
    }))
}

// ---------- ⑤ 源码断言：界面灰显 ⟺ 下发行为（这类一致性破了不会报错，只会静默误导） ----------
// 🔴 为什么用源码断言而不是实机：实机跑在**某一种**模型形态下，
//    「本地模型 ⇒ 0 项灰显」会让「根本没实现灰显」也通过 —— 判别力不足（本轮真踩过）。
//    这里直接钉住「三处 Ollama 专有参数都按 local 分了两态」，与实机互补。
{
  const modes = readSrc('src/components/tavern/TavernControlModes.tsx')
  const three = ['候选词上限', '重复惩罚', '惩罚射程']
  const ternaryCount = (modes.match(/ollamaNative \? \(/g) || []).length
  ok('🔴 酒馆：三项 Ollama 专有参数 × 两个模式 ＝ 6 处都按 ollamaNative 分了两态',
    ternaryCount === 6, String(ternaryCount))
  const naCount = (modes.match(/<CloudOnlyNA /g) || []).length
  ok('🔴 酒馆：6 处灰显占位走同一个 CloudOnlyNA 组件（不各写各的样式）',
    modes.includes('function CloudOnlyNA') && naCount === 6, String(naCount))
  ok('🔴 酒馆：三项都在灰显清单里',
    three.every(l => (modes.match(new RegExp(`<CloudOnlyNA label="${l}"`, 'g')) || []).length === 2),
    three.map(l => `${l}:${(modes.match(new RegExp(`<CloudOnlyNA label="${l}"`, 'g')) || []).length}`).join(' '))
  ok('🔴 酒馆：判定由父组件统一传入，且用 type（不是 local —— LM Studio 也是 local）',
    readSrc('src/components/tavern/TavernControl.tsx').includes("ollamaNative={m.activeProvider?.type === 'ollama'}"))

  const cfg = readSrc('src/components/AIConfigPanel.tsx')
  ok('🔴 模型配置页：「文本生成微调」区块在位且位于自定义系统提示词之后',
    cfg.includes('文本生成微调') &&
    cfg.indexOf('文本生成微调') > cfg.indexOf('自定义系统提示词'))
  ok('🔴 模型配置页：三项 Ollama 专有参数按 type 灰显（判据与下发同源）',
    cfg.includes('isOllamaSamplingChannel(editing)') && cfg.includes('<SamplingUnavailable'))
  ok('🔴 模型配置页：说明里写清「留空 ＝ 不下发」与结构化任务不受影响',
    cfg.includes('留空 ＝ 不下发') && cfg.includes('结构化任务'))
  ok('🔴 装配层：chat() 确实用 provider 兜底（否则界面填了也白填）',
    readSrc('src/lib/aiCore/chat.ts').includes('samplingOptionsOf(config)'))
  ok('🔴 结构化任务（json）不下发兜底参数 —— 与界面「结构化任务不受影响」的承诺同口径',
    readSrc('src/lib/aiCore/chat.ts').includes('opts.json ? undefined : samplingOptionsOf(config)'))
  ok('🔴 只抑制兜底来源：显式传入的 extraOptions 一律照发（酒馆有自己的参数面板）',
    readSrc('src/lib/aiCore/chat.ts').includes('opts.extraOptions ?? ('))

  // 🔴 三处灰显必须共用同一文案与样式，判据也必须只有一个真源 ——
  //    分开写就会「一处改了判据、另两处没跟上」（2026-10-09 审计即因此发现本地 OpenAI 兼容漏判）。
  ok('🔴 三处灰显共用 SamplingUnavailable（文案与样式只此一处）',
    ['src/components/AIConfigPanel.tsx', 'src/components/tavern/TavernControlBasics.tsx', 'src/components/tavern/TavernControlModes.tsx']
      .every(f => readSrc(f).includes('SamplingUnavailable')))
  ok('🔴 灰显判据只有一个真源 isOllamaSamplingChannel（定义 + 下发处都调它）',
    readSrc('src/lib/modelSampling.ts').includes('export function isOllamaSamplingChannel') &&
    readSrc('src/lib/modelSampling.ts').includes('if (isOllamaSamplingChannel(p))'))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
// assert 目前未直接使用，保留 import 以便后续扩展时随手断言
void assert
