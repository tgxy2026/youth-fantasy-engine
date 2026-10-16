// 3.1.1 第 4 项 · 自定义请求头：合法性拦截 / 合并 / OpenCode Go 预置
// 🔴 钉住两条承诺：① 浏览器禁止的头**明确拒绝**（不静默丢弃）；② 不填自定义头时**逐字节不变**。
import {
  rejectReasonOf, sanitizeCustomHeaders, mergeHeaders,
} from '../src/lib/aiCore/headers'
import { ONLINE_PRESETS, OPENCODE_GO_BASE, providerFromPreset } from '../src/lib/aiCore/core'

let failures = 0
function check(name: string, condition: boolean) {
  if (condition) console.log(`PASS ${name}`)
  else { failures++; console.error(`FAIL ${name}`) }
}

// ---- 合法性判据 ----
check('正常自定义头放行', rejectReasonOf('x-opencode-session') === null && rejectReasonOf('X-Api-Key') === null)
check('Authorization 放行（允许覆盖默认鉴权）', rejectReasonOf('Authorization') === null)
check('禁止头：User-Agent', rejectReasonOf('User-Agent') !== null)
check('禁止头：大小写不敏感', rejectReasonOf('user-agent') !== null && rejectReasonOf('COOKIE') !== null)
check('禁止头：Host / Origin / Referer / Content-Length', ['Host', 'Origin', 'Referer', 'Content-Length'].every(h => rejectReasonOf(h) !== null))
check('禁止前缀：Sec-* / Proxy-*', rejectReasonOf('Sec-Fetch-Mode') !== null && rejectReasonOf('Proxy-Authorization') !== null)
check('受保护头：Content-Type 不许改', rejectReasonOf('Content-Type') !== null)
check('空名也算不合法（但会被跳过，不算拒绝）', rejectReasonOf('   ') !== null)

// ---- 过滤 ----
const r1 = sanitizeCustomHeaders({ 'x-opencode-session': ' abc ', 'User-Agent': 'x', 'x-keep': 'v' })
check('过滤：合法的留下并去空白', r1.allowed['x-opencode-session'] === 'abc' && r1.allowed['x-keep'] === 'v')
check('过滤：非法的进 rejected 且带原因', r1.rejected.length === 1 && r1.rejected[0].name === 'User-Agent' && !!r1.rejected[0].reason)
check('过滤：非法头不会出现在 allowed 里', !('User-Agent' in r1.allowed))
check('过滤：空名条目直接跳过（不算拒绝）', Object.keys(sanitizeCustomHeaders({ '  ': 'v' }).allowed).length === 0
  && sanitizeCustomHeaders({ '  ': 'v' }).rejected.length === 0)
check('过滤：null / undefined 安全', Object.keys(sanitizeCustomHeaders(undefined).allowed).length === 0 && Object.keys(sanitizeCustomHeaders(null).allowed).length === 0)

// ---- 合并：这是「升级不改变既有行为」的关键 ----
const base = { 'Content-Type': 'application/json', Authorization: 'Bearer k' }
check('不填自定义头 ⇒ 与基础头逐字段一致', JSON.stringify(mergeHeaders(base, undefined)) === JSON.stringify(base))
const merged = mergeHeaders(base, { 'x-opencode-session': 'uuid-1', Authorization: 'Bearer custom' })
check('自定义头叠加进请求头', merged['x-opencode-session'] === 'uuid-1')
check('自定义头可覆盖 Authorization（换一套鉴权）', merged.Authorization === 'Bearer custom')
check('Content-Type 不会被自定义头顶掉', mergeHeaders(base, { 'Content-Type': 'text/plain' })['Content-Type'] === 'application/json')
check('非法自定义头不进最终请求头', !('user-agent' in mergeHeaders(base, { 'user-agent': 'me' })))

// ---- OpenCode Go 预置 ----
const goPreset = ONLINE_PRESETS.find(p => p.label === 'OpenCode Go')
check('平台预设里有 OpenCode Go', !!goPreset && goPreset.baseUrl === OPENCODE_GO_BASE)
const goProvider = providerFromPreset(goPreset!)
check('预置会带上 x-opencode-session', typeof goProvider.headers?.['x-opencode-session'] === 'string' && (goProvider.headers!['x-opencode-session'] ?? '').length > 0)
check('预置的会话 id 每次生成不同（随机会话）', goProvider.headers!['x-opencode-session'] !== providerFromPreset(goPreset!).headers!['x-opencode-session'])
const normal = providerFromPreset({ label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' })
check('普通预设不带 headers（请求头逐字节不变）', normal.headers === undefined)

if (failures) process.exit(1)
