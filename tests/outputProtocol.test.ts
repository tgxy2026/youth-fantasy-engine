// 3.2.0 · WQ5 输出协议 · 单测
//
// 盯三件事（方案 §16.6 / 验收 AI-05）：
//   ① 旧 `json:true` 的行为**逐字不变**（关推理 + 低温）—— 迁移不能偷偷改老调用点；
//   ② 🔴 「要 JSON」不再等于「不许思考」：显式声明 `output` 后推理按声明走；
//   ③ 能力未确认时**降级并说明**，不静默下发结构格式、不假装支持「推理＋结构」。
import {
  resolveOutputProtocol, describeProtocol, type OutputDeclaration,
} from '@/lib/ai/outputProtocol'
import { DEFAULT_CAPABILITIES, detectCapabilities, type ModelCapabilities } from '@/lib/ai/modelCapabilities'
import { DEFAULT_TEMPERATURE, JSON_TASK_TEMPERATURE } from '@/lib/aiCore/core'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const UNKNOWN = DEFAULT_CAPABILITIES
const CONFIRMED: ModelCapabilities = {
  ...DEFAULT_CAPABILITIES,
  source: 'isolated-test',
  structuredOutput: 'json-object',
  reasoningWithStructure: true,
}
const SCHEMA_OK: ModelCapabilities = { ...CONFIRMED, structuredOutput: 'json-schema' }

function r(d: Partial<OutputDeclaration>): ReturnType<typeof resolveOutputProtocol> {
  return resolveOutputProtocol({ caps: UNKNOWN, ...d })
}

// ---------- 一、旧 json:true 兼容口径 ----------
{
  const p = r({ json: true })
  ok('① 旧 json:true ⇒ 仍关推理（think=false）', p.think === false)
  ok('① 旧 json:true ⇒ 仍用低温（0.3）', p.temperature === JSON_TASK_TEMPERATURE, String(p.temperature))
  ok('① 旧 json:true 标记为兼容口径', p.legacyJson === true)
  ok('① 旧 json:true 不下发结构格式（与 3.1.x 一致，只靠提示词约束）', p.wireFormat === 'none')
  ok('① 旧 json:true 不产生"降级"提示（它本来就是这么设计的）', p.limitations.length === 0)
}

// ---------- 二、纯文本任务的默认 ----------
{
  const p = r({})
  ok('② 不声明 ⇒ text + 推理按模型默认（think 不下发）',
    p.output === 'text' && p.reasoning === 'default' && p.think === undefined)
  ok('② 文本任务用全局默认温度', p.temperature === DEFAULT_TEMPERATURE)
  const withProvider = r({ providerTemperature: 0.7 })
  ok('② provider 自带温度优先于全局默认', withProvider.temperature === 0.7)
}

// ---------- 三、结构与推理独立（核心修复） ----------
{
  const p = r({ output: 'json-object' })
  ok('🔴 ③ 显式 output=json-object ⇒ 推理回到「模型默认」（不再被 JSON 绑架）',
    p.output === 'json-object' && p.reasoning === 'default' && p.think === undefined,
    JSON.stringify({ reasoning: p.reasoning, think: p.think }))
  ok('③ 结构化任务仍走低温', p.temperature === JSON_TASK_TEMPERATURE)
  ok('③ 未显式声明时不算兼容口径', p.legacyJson === false)

  const need = r({ output: 'json-object', reasoning: 'required' })
  ok('🔴 ③ 声明 required 但端点未确认「推理＋结构」⇒ 降级为 off',
    need.reasoning === 'off' && need.think === false, JSON.stringify(need))
  ok('③ 降级要说明白（并给出可行出路）',
    need.limitations.some(x => x.includes('未确认') && x.includes('text 输出')), JSON.stringify(need.limitations))

  const texts = r({ reasoning: 'required' })
  ok('③ 文本任务要求推理 ⇒ 正常允许（没有结构可冲突）',
    texts.reasoning === 'required' && texts.think === true && texts.limitations.length === 0)
}

// ---------- 四、能力确认后才下发结构格式 ----------
{
  const unknown = r({ output: 'json-object' })
  ok('④ 能力未知 ⇒ 不下发 format（只走提示词约束）', unknown.wireFormat === 'none')

  const confirmed = resolveOutputProtocol({ output: 'json-object', caps: CONFIRMED })
  ok('④ 已确认（实测/配置）⇒ 下发 json-object', confirmed.wireFormat === 'json-object')

  const schemaUnknown = r({ output: 'json-schema' })
  ok('④ 未知端点要 schema ⇒ 降级到提示词并说明', schemaUnknown.wireFormat === 'none'
    && schemaUnknown.limitations.some(x => x.includes('schema')), JSON.stringify(schemaUnknown.limitations))

  const schemaOnlyObject = resolveOutputProtocol({ output: 'json-schema', caps: CONFIRMED })
  ok('④ 端点只确认到 json-object ⇒ schema 细约束退回提示词',
    schemaOnlyObject.wireFormat === 'json-object'
    && schemaOnlyObject.limitations.some(x => x.includes('schema')), JSON.stringify(schemaOnlyObject))

  const schemaFull = resolveOutputProtocol({ output: 'json-schema', caps: SCHEMA_OK })
  ok('④ 端点确认到 json-schema ⇒ 全量下发',
    schemaFull.wireFormat === 'json-schema' && schemaFull.limitations.length === 0)

  const both = resolveOutputProtocol({ output: 'json-object', reasoning: 'required', caps: CONFIRMED })
  ok('🔴 ④ 端点确认「推理＋结构」共存 ⇒ 推理与 JSON 同时成立',
    both.reasoning === 'required' && both.think === true && both.wireFormat === 'json-object',
    JSON.stringify(both))
}

// ---------- 五、显式参数优先 ----------
{
  ok('⑤ 显式 think 覆盖推理声明', r({ output: 'json-object', reasoning: 'off', think: true }).think === true)
  ok('⑤ 显式 think=false 覆盖 required', r({ reasoning: 'required', think: false }).think === false)
  ok('⑤ 显式温度覆盖一切', r({ json: true, temperature: 0.9 }).temperature === 0.9)
}

// ---------- 六、能力检测不按模型名"认证"能力 ----------
{
  const known = detectCapabilities('qwen3:8b')
  ok('⑥ 已知模型名也只算 unknown 来源（名字不是证据）', known.source === 'unknown')
  ok('⑥ 未知来源不下发结构格式', (known.structuredOutput ?? 'none') === 'none')
  ok('⑥ 未知来源不假设推理与结构可共存', known.reasoningWithStructure === false)

  const qwen3 = resolveOutputProtocol({ output: 'json-object', reasoning: 'required', caps: known })
  ok('⑥ 因此"qwen3"上的 required 一样会被降级并说明（不靠名字蒙）',
    qwen3.reasoning === 'off' && qwen3.limitations.length > 0)
}

// ---------- 七、人话描述 ----------
{
  const d = describeProtocol(r({ json: true }))
  ok('⑦ 描述含输出形态/推理/约束方式', /JSON/.test(d) && /不推理/.test(d) && /提示词约束/.test(d), d)
  const withLim = describeProtocol(r({ output: 'json-schema' }))
  ok('⑦ 有降级时点出条数', withLim.includes('降级'), withLim)
}

// ---------- 八、结构闸：不允许把「JSON ⇒ 关思考」写回 chat() ----------
{
  const src = readFileSync('src/lib/aiCore/chat.ts', 'utf8')
  ok('⑧ chat() 不再按 json 标记直接决定 think（口径只在 outputProtocol）',
    !/opts\.json \? false : undefined/.test(src) && /resolveOutputProtocol\(/.test(src),
    'still hardcoded')
  ok('⑧ chat() 的温度也走协议解析（不再各写一遍）',
    !/opts\.json \? JSON_TASK_TEMPERATURE/.test(src) && /protocol\.temperature/.test(src))
}

console.log(`\n———— outputProtocol：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
