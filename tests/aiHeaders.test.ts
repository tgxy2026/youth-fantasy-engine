// 3.1.1 第 4 项 · 自定义请求头：合法性拦截 / 合并 / OpenCode Go 预置
// 🔴 钉住两条承诺：① 浏览器禁止的头**明确拒绝**（不静默丢弃）；② 不填自定义头时**逐字节不变**。
import {
  rejectReasonOf, rejectValueReasonOf, sanitizeCustomHeaders, mergeHeaders,
} from '../src/lib/aiCore/headers'
import {
  ONLINE_PRESETS, OPENCODE_GO_BASE, providerFromPreset, headersForPresetSwitch, PRESET_AUTO_HEADER_KEYS,
} from '../src/lib/aiCore/core'
import { withWebLocalConnectionHint } from '../src/lib/aiCore/transport'

let failures = 0
function check(name: string, condition: boolean) {
  if (condition) console.log(`PASS ${name}`)
  else { failures++; console.error(`FAIL ${name}`) }
}

check('网页本地连接失败提示跨域可能性，不声称确定原因', /可能/.test(withWebLocalConnectionHint('连接失败', true)) && /跨域/.test(withWebLocalConnectionHint('连接失败', true)))
check('桌面便携的原错误文案不变', withWebLocalConnectionHint('连接失败', false) === '连接失败')

// ---- 合法性判据 ----
check('正常自定义头放行', rejectReasonOf('x-opencode-session') === null && rejectReasonOf('X-Api-Key') === null)
check('Authorization 放行（允许覆盖默认鉴权）', rejectReasonOf('Authorization') === null)
check('禁止头：User-Agent', rejectReasonOf('User-Agent') !== null)
check('禁止头：大小写不敏感', rejectReasonOf('user-agent') !== null && rejectReasonOf('COOKIE') !== null)
check('禁止头：Host / Origin / Referer / Content-Length', ['Host', 'Origin', 'Referer', 'Content-Length'].every(h => rejectReasonOf(h) !== null))
check('禁止前缀：Sec-* / Proxy-*', rejectReasonOf('Sec-Fetch-Mode') !== null && rejectReasonOf('Proxy-Authorization') !== null)
check('受保护头：Content-Type 不许改', rejectReasonOf('Content-Type') !== null)
check('空名也算不合法（但会被跳过，不算拒绝）', rejectReasonOf('   ') !== null)

// 独立复核 P2：非法头名必须在这里拦下（否则要等发请求才报错）
check('非法头名：含空格被拒', rejectReasonOf('X Bad Name') !== null)
check('非法头名：含冒号被拒', rejectReasonOf('X-Foo:') !== null)
check('非法头名：含中文被拒', rejectReasonOf('头名') !== null)
check('头值：含换行被拒（头注入）', rejectValueReasonOf('a\r\nX-Evil: 1') !== null && rejectValueReasonOf('a\nb') !== null)
check('头值：含 NUL 被拒', rejectValueReasonOf('a\0b') !== null)
check('头值：正常值放行', rejectValueReasonOf('Bearer abc-123') === null && rejectValueReasonOf('') === null)

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

// 独立复核 P2：头名大小写不敏感 —— 不能出现 `Authorization` 与 `authorization` 并存
const lower = mergeHeaders(base, { 'authorization': 'Bearer custom' })
check('自定义 authorization 覆盖默认 Authorization（不并存）',
  lower.authorization === 'Bearer custom' && !('Authorization' in lower) && Object.keys(lower).filter(k => k.toLowerCase() === 'authorization').length === 1)
check('覆盖后不会出现「逗号拼接」的双值', !String(lower.authorization).includes(','))

// 独立复核 P2：切换平台预设必须带上目标预设的默认头
const deepseek = { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' }
const go = ONLINE_PRESETS.find(p => p.label === 'OpenCode Go')!
const switched = headersForPresetSwitch(go, { 'x-custom': 'keep' })
check('切到 OpenCode Go ⇒ 补上 x-opencode-session', typeof switched?.['x-opencode-session'] === 'string' && !!switched['x-opencode-session'])
check('切换时保留作者自己的自定义头', switched?.['x-custom'] === 'keep')
check('切回普通预设 ⇒ 自动预置的会话头被清掉', headersForPresetSwitch(deepseek, switched)?.['x-opencode-session'] === undefined)
check('切回普通预设 ⇒ 作者自定义头仍在', headersForPresetSwitch(deepseek, switched)?.['x-custom'] === 'keep')
check('切换不覆盖作者已填的会话头',
  headersForPresetSwitch(go, { 'x-opencode-session': 'mine' })?.['x-opencode-session'] === 'mine')
check('自动预置头清单只含会话头', PRESET_AUTO_HEADER_KEYS.length === 1 && PRESET_AUTO_HEADER_KEYS[0] === 'x-opencode-session')

// 第四轮审计 A-11：切换预设的键名比对必须**大小写不敏感**（与 mergeHeaders 同源），
// 否则作者手填 `X-Opencode-Session` 时：切走清不掉、切回又插一条小写副本。
const cased = { 'X-Opencode-Session': 'mine' }
check('切走：手填的大小写变体也会被引掉（不留残留）',
  headersForPresetSwitch(deepseek, cased)?.['X-Opencode-Session'] === undefined)
const reGo = headersForPresetSwitch(go, cased)
check('切回：大小写变体视为已存在 ⇒ 不重复插入小写副本',
  Object.keys(reGo ?? {}).filter(k => k.toLowerCase() === 'x-opencode-session').length === 1)
check('切回：保留作者的大小写写法（不改写键名）', reGo?.['X-Opencode-Session'] === 'mine')

// 第四轮审计 A-10：同名头（大小写不同）必须**点名报出来**，不能静默折叠
const dup = sanitizeCustomHeaders({ 'X-A': '1', 'x-a': '2', 'X-B': '3' })
check('同名（大小写不同）只保留先填的那条', dup.allowed['X-A'] === '1' && dup.allowed['X-B'] === '3')
check('被折叠的那条进 rejected 并说明原因', dup.rejected.some(r => r.name === 'x-a' && /重复/.test(r.reason)))
check('折叠原因是中文点名（不静默）', (dup.rejected.find(r => r.name === 'x-a')?.reason ?? '').includes('X-A'))
const noDup = sanitizeCustomHeaders({ 'X-A': '1', 'X-B': '2' })
check('不同名不误报重复', noDup.rejected.length === 0 && Object.keys(noDup.allowed).length === 2)

// ---- OpenCode Go 预置 ----
const goPreset = ONLINE_PRESETS.find(p => p.label === 'OpenCode Go')
check('平台预设里有 OpenCode Go', !!goPreset && goPreset.baseUrl === OPENCODE_GO_BASE)
const goProvider = providerFromPreset(goPreset!)
check('预置会带上 x-opencode-session', typeof goProvider.headers?.['x-opencode-session'] === 'string' && (goProvider.headers!['x-opencode-session'] ?? '').length > 0)
check('预置的会话 id 每次生成不同（随机会话）', goProvider.headers!['x-opencode-session'] !== providerFromPreset(goPreset!).headers!['x-opencode-session'])
const normal = providerFromPreset({ label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' })
check('普通预设不带 headers（请求头逐字节不变）', normal.headers === undefined)

if (failures) process.exit(1)
