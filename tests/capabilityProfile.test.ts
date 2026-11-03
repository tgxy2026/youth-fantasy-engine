// ============ 3.3.3 · A3 能力来源、缓存与诊断 ============
//
// 钉住：
//   ① 优先级：用户覆盖 > 未过期实测 > 内置推断 > 保守默认；
//   ② 缓存按「端点 + 模型 + 协议 + 配置」隔离，端点规范化后同一端点不产生两套；
//   ③ 401/429/网络/超时/取消 ⇒ 仍是未知，**不写"不支持"**，文案要带下一步；
//   ④ 实测缓存是本机专属、不含密钥；重启能读回；
//   ⑤ 界面必须说明"会调用模型、可能计费、可取消、非必经"。
import { __resetMockStores, memoryOps } from './mock-memory'
import {
  CAPABILITY_META_PREFIX, CAPABILITY_TTL_MS, capabilityConfigFingerprint, capabilityKeyOf,
  classifyCapabilityError, describeCapability, getCachedCapability, hydrateCapabilityCacheFromStore,
  hydrateCapabilityTests, isCapabilityFresh, loadCapabilityTests, normalizeEndpoint, persistCapabilityTest,
  resetCapabilityMemory, sourceLabel, type CapabilityTestRecord,
} from '../src/lib/ai/capabilityProfile'
import { capabilitiesOf } from '../src/lib/ai/modelCapabilities'
import { isLocalOnlyMetaKey } from '../src/lib/storage/sensitiveMeta'
import { saveProviders } from '../src/lib/aiCore/session'
import type { AIProvider } from '../src/lib/aiCore/core'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const ENDPOINT = 'https://api.example.com/v1/'
const CFG = capabilityConfigFingerprint({ type: 'openai', structuredOutput: '', reasoningWithStructure: false })

function rec(over: Partial<CapabilityTestRecord> = {}): CapabilityTestRecord {
  const now = Date.now()
  const key = over.key ?? capabilityKeyOf({ endpoint: ENDPOINT, modelId: 'qwen-max', protocol: 'openai', configFingerprint: CFG })
  return {
    key,
    endpointKey: normalizeEndpoint(ENDPOINT),
    modelId: 'qwen-max',
    protocol: 'openai',
    configFingerprint: CFG,
    state: 'supported',
    jsonObject: true,
    jsonSchema: 'unknown',
    reasoningWithStructure: 'unknown',
    at: now,
    expiresAt: now + CAPABILITY_TTL_MS,
    ...over,
  }
}

async function main() {
  __resetMockStores()
  resetCapabilityMemory()

  // ───────────────── ① 端点规范化与键隔离 ─────────────────
  {
    ok('协议/大小写/尾斜杠视为同一端点',
      normalizeEndpoint('HTTPS://API.Example.com/v1/') === normalizeEndpoint('https://api.example.com/v1'))
    ok('userinfo / query / hash 不参与端点标识',
      normalizeEndpoint('https://u:p@host/v1?x=1#y') === 'https://host/v1')
    const base = { endpoint: ENDPOINT, modelId: 'm', protocol: 'openai', configFingerprint: CFG }
    const k1 = capabilityKeyOf(base)
    ok('同输入同键', k1 === capabilityKeyOf({ ...base, endpoint: 'https://api.example.com/v1' }))
    ok('http 与 https 不串缓存', k1 !== capabilityKeyOf({ ...base, endpoint: 'http://api.example.com/v1' }))
    ok('路径大小写不串缓存', k1 !== capabilityKeyOf({ ...base, endpoint: 'https://api.example.com/V1' }))
    ok('换端点 ⇒ 换键', k1 !== capabilityKeyOf({ ...base, endpoint: 'https://relay.example.com/v1' }))
    ok('同名模型不同端点不串缓存', k1 !== capabilityKeyOf({ ...base, endpoint: 'https://other/v1' }))
    ok('换模型 ⇒ 换键', k1 !== capabilityKeyOf({ ...base, modelId: 'qwen-plus' }))
    ok('换协议 ⇒ 配置指纹变（并据此换键）',
      capabilityConfigFingerprint({ type: 'ollama' }) !== capabilityConfigFingerprint({ type: 'openai' })
      && k1 !== capabilityKeyOf({ ...base, configFingerprint: capabilityConfigFingerprint({ type: 'ollama' }) }))
    ok('换配置指纹 ⇒ 换键', k1 !== capabilityKeyOf({ ...base, configFingerprint: 'other' }))
    const provider: AIProvider = { id: 'credential-test', name: 'test', type: 'openai', baseUrl: ENDPOINT, apiKey: 'key-one', model: 'qwen-max' }
    await saveProviders([provider])
    const first = provider.capabilityVersion
    await saveProviders([provider])
    ok('凭据不变保留能力代次', !!first && provider.capabilityVersion === first)
    const changed = { ...provider, apiKey: 'key-two' }
    await saveProviders([changed])
    ok('凭据变化使能力代次与缓存键变化', !!changed.capabilityVersion && changed.capabilityVersion !== first
      && capabilityConfigFingerprint(changed) !== capabilityConfigFingerprint(provider))
    ok('能力指纹不包含凭据', !capabilityConfigFingerprint(changed).includes('key-two'))
    ok('配置指纹不含密钥字段（只拼类型/结构/推理）',
      !/key|token|secret/i.test(capabilityConfigFingerprint({ type: 'openai', structuredOutput: '', reasoningWithStructure: false })))
  }

  // ───────────────── ② 优先级与过期 ─────────────────
  {
    const model = 'qwen-max'
    const unknown = capabilitiesOf(model, undefined, ENDPOINT, CFG)
    ok('未实测 ⇒ 内置推断但来源 unknown', unknown.source === 'unknown' && unknown.structuredOutput === 'none')

    await persistCapabilityTest(rec(), memoryOps)
    const tested = capabilitiesOf(model, undefined, ENDPOINT, CFG)
    ok('有未过期实测 ⇒ 来源 isolated-test', tested.source === 'isolated-test')
    ok('提示词返回 JSON 不证明结构化参数可用', tested.structuredOutput === 'none' && tested.jsonOutput === true)
    ok('带查询参数的端点不复用被剥离参数的记录', !getCachedCapability({ endpoint: ENDPOINT + '?account=other', modelId: model, configFingerprint: CFG }))
    ok('schema 未测就不冒充', tested.structuredOutput !== 'json-schema')

    const user = capabilitiesOf(model, { structuredOutput: 'json-schema', reasoningWithStructure: true }, ENDPOINT, CFG)
    ok('用户覆盖优先级最高', user.source === 'user-config' && user.structuredOutput === 'json-schema')
    ok('用户覆盖保留推理+结构确认', user.reasoningWithStructure === true)

    resetCapabilityMemory()
    const expired = rec({ expiresAt: Date.now() - 1 })
    hydrateCapabilityTests([expired])
    ok('过期记录不命中', getCachedCapability({ endpoint: ENDPOINT, modelId: model, protocol: 'openai', configFingerprint: CFG }) === null)
    ok('过期判断按 now 可注入', isCapabilityFresh(expired, expired.expiresAt - 1) && !isCapabilityFresh(expired, expired.expiresAt))

    resetCapabilityMemory()
    hydrateCapabilityTests([rec()])
    const otherEndpoint = capabilitiesOf(model, undefined, 'https://relay.example.com/v1', CFG)
    ok('别的端点不会拿这条记录', otherEndpoint.source === 'unknown')
  }

  // ───────────────── ③ 失败归类：只说明这次没测成 ─────────────────
  {
    const auth = classifyCapabilityError(Object.assign(new Error('HTTP 401 unauthorized'), { status: 401 }))
    ok('401 ⇒ 鉴权失败、不可重试', auth.reason === 'auth' && auth.retriable === false)
    ok('401 文案说明"不改变能力结论"', auth.message.includes('不改变能力结论'))
    const limit = classifyCapabilityError(Object.assign(new Error('429 too many requests'), { status: 429 }))
    ok('429 ⇒ 限流、可重试', limit.reason === 'rate-limit' && limit.retriable)
    ok('网络错误可重试', classifyCapabilityError(new TypeError('Failed to fetch')).reason === 'network')
    ok('超时可重试', classifyCapabilityError(new Error('request timeout')).reason === 'timeout')
    const abort = classifyCapabilityError(Object.assign(new Error('x'), { name: 'AbortError' }))
    ok('取消单独归类', abort.reason === 'cancelled')
    ok('未知错误也不判定不支持', !/不支持/.test(classifyCapabilityError(new Error('boom')).message))
  }

  // ───────────────── ④ 持久化：本机、不含密钥、重启可读 ─────────────────
  {
    __resetMockStores()
    resetCapabilityMemory()
    const r = rec()
    await persistCapabilityTest(r, memoryOps)
    const rows = await memoryOps.getAll<{ key: string; value: CapabilityTestRecord }>('meta')
    const saved = rows.find(x => x.key === `${CAPABILITY_META_PREFIX}${r.key}`)
    ok('记录写进本机 meta 前缀', !!saved)
    ok('记录不含密钥字段', !!saved && !/apiKey|secret|token|password/i.test(JSON.stringify(saved.value)))
    ok('前缀被登记为本机专属', isLocalOnlyMetaKey(`${CAPABILITY_META_PREFIX}abc`))

    resetCapabilityMemory()
    await hydrateCapabilityCacheFromStore(memoryOps)
    ok('重启 hydrate 后能命中', !!getCachedCapability({
      endpoint: ENDPOINT, modelId: r.modelId, protocol: r.protocol, configFingerprint: r.configFingerprint,
    }))
    ok('loadCapabilityTests 只给未过期记录', (await loadCapabilityTests(memoryOps)).length === 1)
  }

  // ───────────────── ⑤ 诊断文案 ─────────────────
  {
    const diagCaps = { ...capabilitiesOf('qwen-max', undefined, ENDPOINT, CFG), source: 'isolated-test' as const, structuredOutput: 'json-object' as const }
    const d = describeCapability(diagCaps, rec())
    ok('来源有中文说明', d.sourceLabel.includes('实测'))
    ok('说明本次下发什么', d.explain.includes('JSON 对象格式'))
    ok('说明下一步', d.explain.includes('下一步'))
    ok('三种来源都有文案',
      ['user-config', 'isolated-test', 'unknown'].every(s => sourceLabel(s as 'unknown').length > 0))
  }

  // ───────────────── ⑥ 静态契约：接线与界面 ─────────────────
  {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
    const chat = read('src/lib/aiCore/chat.ts')
    ok('真实请求带上端点与配置指纹',
      /capabilitiesOf\(config\.model, config, config\.baseUrl, capabilityConfigFingerprint\(config\)\)/.test(chat))
    const app = read('src/App.tsx')
    ok('启动只读缓存、不发请求', /hydrateCapabilityCacheFromStore/.test(app))
    const panel = read('src/components/settings/ModelCapabilityPanel.tsx')
    ok('面板明确"可能计费 / 可取消 / 非必经"',
      /可能产生少量费用/.test(panel) && /可随时取消|取消/.test(panel) && /不是使用前必经步骤/.test(panel))
    ok('面板显示来源与下一步', /sourceLabel/.test(panel) && /diagnosis\.explain/.test(panel))
    ok('面板支持取消实测', /abortRef\.current\?\.abort\(\)/.test(panel))
  }

  console.log(`\nCAPABILITY ${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
}

main().catch(e => { console.error(e); process.exitCode = 1 })
