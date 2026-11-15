// ============ 3.5.6 · ACP 上下文预算专项 ============
//
// 覆盖：
//  · 窗口来源判定（手填 > 会话回报 > 未知），未知不得冒充 32K 标称；
//  · 发送/输出预算的自动推算与手填收敛；
//  · 保存预算不改代次（旧请求按快照继续落地）；
//  · 运行层持久化 + IPC/UI 接线静态契约。
//
// 🔴 不启动真实 Agent：预算解析与保存都不需要 launch。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpRuntime } from '../scripts/agent-host/acp-runtime.mjs'
import {
  ACP_FALLBACK_WINDOW,
  budgetFieldError,
  parseBudgetNumber,
  readAdapterWindow,
  resolveAcpBudget,
} from '../scripts/agent-host/acp-budget.mjs'

let pass = 0
let fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 1. 数字解析 ----------
ok('空串表示自动', parseBudgetNumber('') === null)
ok('纯数字字符串', parseBudgetNumber('131072') === 131072)
ok('数字入参', parseBudgetNumber(65536) === 65536)
ok('0 视为未填', parseBudgetNumber('0') === null)
ok('负数视为未填', parseBudgetNumber(-5) === null)
ok('非数字视为未填', parseBudgetNumber('128K') === null)

// ---------- 2. 字段校验 ----------
ok('窗口 128 提示换算', (budgetFieldError('budgetWindow', '128') ?? '').includes('131072'))
ok('窗口 2000 合法', budgetFieldError('budgetWindow', '2000') === null)
ok('窗口超 2M 拒绝', (budgetFieldError('budgetWindow', '3000000') ?? '').includes('2M'))
ok('发送上限过小拒绝', budgetFieldError('budgetSend', '100') !== null)
ok('输出预留过小拒绝', budgetFieldError('budgetOutput', '10') !== null)
ok('空串恢复自动合法', budgetFieldError('budgetSend', '') === null)
ok('未知字段拒绝', budgetFieldError('budgetOther', '1') !== null)

// ---------- 3. 窗口来源 ----------
const unknown = resolveAcpBudget({ agentName: '假 Agent', model: 'gemini', config: {} })
ok('未配置：窗口未知', unknown.windowTokens === null && unknown.windowSource === 'unknown')
ok('未配置：兜底 32K', unknown.effectiveWindow === ACP_FALLBACK_WINDOW)
ok('未配置：如实标记 fallback', unknown.fallbackUsed === true && unknown.notice.includes('实际窗口未知'))
ok('未配置：发送按兜底推算', unknown.sendBudgetTokens === 16384 && unknown.outputReserveTokens === 8192)

const user = resolveAcpBudget({
  agentName: '假 Agent', model: 'gemini-3.8-flash', modelLabel: 'Gemini 3.8 Flash',
  config: { budgetWindow: '131072' },
})
ok('手填窗口：来源是 user', user.windowTokens === 131072 && user.windowSource === 'user')
ok('手填窗口：发送 50%', user.sendBudgetTokens === 65536)
ok('手填窗口：提示含模型名', user.notice.includes('Gemini 3.8 Flash'))
ok('手填窗口：不再标记 fallback', user.fallbackUsed === false)

const adapter = resolveAcpBudget({ config: {}, sessionOptions: { contextWindow: 65536 } })
ok('会话回报窗口被采信', adapter.windowTokens === 65536 && adapter.windowSource === 'adapter')
ok('会话回报：发送按窗口推算', adapter.sendBudgetTokens === 32768)
ok('会话回报：只认合理范围', readAdapterWindow({ contextWindow: 128 }) === null)

const clamped = resolveAcpBudget({ config: { budgetWindow: '131072', budgetSend: '999999' } })
const windowCeiling = 131072 - 8192 - Math.floor(131072 * 0.05)
// 3.5.6 复核补：窗口额度与运行层传输上限取小者（131072 窗口算出的 116327 仍高于 87K 的传输上限）
ok('手填发送上限被收敛到「窗口额度与传输上限」的较小者',
  clamped.sendBudgetTokens === Math.min(windowCeiling, clamped.runtimeTokenCeiling),
  `${clamped.sendBudgetTokens} vs ${windowCeiling}`)
ok('收敛后有说明', clamped.notice.includes('已收敛'))

// 3.5.6 复核补：窗口很大时还要守住运行层单次请求 256 KiB 的上限（中文 3 字节/字）
const runtimeCapped = resolveAcpBudget({ config: { budgetWindow: '1048576', budgetSend: '500000' } })
ok('发送额度被运行层传输上限收敛', runtimeCapped.sendBudgetTokens === runtimeCapped.runtimeTokenCeiling,
  String(runtimeCapped.sendBudgetTokens))
ok('传输上限换算按 256 KiB ÷ 3 字节', runtimeCapped.runtimeTokenCeiling === Math.floor((256 * 1024) / 3))
ok('收敛原因写进说明（窗口本身不受限，建议分批）',
  runtimeCapped.notice.includes('256 KiB') && runtimeCapped.notice.includes('分批'))
const roomyWindow = resolveAcpBudget({ config: { budgetWindow: '1048576', budgetOutput: '8192' } })
ok('窗口很大时自动发送额度也不越过传输上限', roomyWindow.sendBudgetTokens <= roomyWindow.runtimeTokenCeiling,
  String(roomyWindow.sendBudgetTokens))
ok('普通窗口不触发传输上限收敛', adapter.sendClampedByRuntime === false)

const bigOutput = resolveAcpBudget({ config: { budgetWindow: '65536', budgetOutput: '20000' } })
ok('输出预留取手填值', bigOutput.outputReserveTokens === 20000)
// 自动发送上限本身只占窗口 50%，不会被输出预留「挤压」；只有手填发送上限超过剩余额度时才收敛。
ok('自动发送上限仍按 50%', bigOutput.sendBudgetTokens === 32768)
const squeezed = resolveAcpBudget({ config: { budgetWindow: '65536', budgetOutput: '20000', budgetSend: '50000' } })
ok('手填发送上限被输出预留挤压', squeezed.sendBudgetTokens === 65536 - 20000 - Math.floor(65536 * 0.05))

// ---------- 4. 运行层持久化 ----------
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yfe-356-acp-budget-'))
try {
  const runtime = createAcpRuntime({
    root,
    adapters: [{ id: 'fake-agent', name: '假 Agent' }],
  })
  const before = await runtime.status()
  const beforeBudget = before.budget
  assert.ok(beforeBudget, 'status 应返回预算')
  ok('status 暴露预算', beforeBudget.agentId === 'fake-agent')
  ok('初始窗口未知', beforeBudget.windowTokens === null && beforeBudget.fallbackUsed === true)
  const generation = before.generation

  await runtime.configureBudget({ budgetWindow: '131072' })
  const after = await runtime.status()
  const afterBudget = after.budget
  assert.ok(afterBudget, 'status 应返回预算')
  ok('手填窗口已持久化', afterBudget.windowTokens === 131072 && afterBudget.windowSource === 'user')
  ok('保存预算不换代次', after.generation === generation, `${after.generation} vs ${generation}`)
  ok('保存后发送额度生效', afterBudget.sendBudgetTokens === 65536)

  await assert.rejects(() => runtime.configureBudget({ budgetWindow: '128' }))
  await assert.rejects(() => runtime.configureBudget({ budgetWindow: 'abc' }))
  await assert.rejects(() => runtime.configureBudget({ notABudgetField: '1' }))
  ok('非法预算不写坏设置', (await runtime.status()).budget?.windowTokens === 131072)

  await runtime.configureBudget({ budgetWindow: '', budgetOutput: '12000' })
  const reset = await runtime.status()
  const resetBudget = reset.budget
  assert.ok(resetBudget, 'status 应返回预算')
  ok('清空窗口回到未知', resetBudget.windowTokens === null && resetBudget.windowSource === 'unknown')
  ok('手填输出预留保留', resetBudget.outputReserveTokens === 12000)
} finally {
  await fsp.rm(root, { recursive: true, force: true })
}

// ---------- 5. 接线静态契约 ----------
const runtimeSrc = read('scripts/agent-host/acp-runtime.mjs')
ok('运行层引入预算解析', runtimeSrc.includes('resolveAcpBudget') && runtimeSrc.includes('budgetFieldError'))
ok('status 输出 budget', /budget,\s*\n/.test(runtimeSrc))
const budgetFn = runtimeSrc.slice(runtimeSrc.indexOf('async configureBudget'), runtimeSrc.indexOf('async disconnect'))
ok('configureBudget 不调用 saveSettings（否则会换代次）', budgetFn.length > 0 && !budgetFn.includes('saveSettings('))
ok('settings 写入串行化', runtimeSrc.includes('withSettingsWrite'))
ok('主进程注册预算 IPC', read('electron/main.cjs').includes("acp:configure-budget"))
ok('preload 暴露预算保存', read('electron/preload.cjs').includes('configureBudget:'))
const settingsSrc = read('src/components/settings/AcpSettings.tsx')
ok('设置页有窗口/发送/输出三项', ['上下文窗口（tokens）', '发送上限（tokens）', '输出预留（tokens）'].every(text => settingsSrc.includes(text)))
ok('设置页调用 configureBudget', settingsSrc.includes('api.configureBudget'))
const engineSrc = read('src/lib/tavern/engine.ts')
ok('酒馆三处读 ACP 窗口', (engineSrc.match(/runChat\.acp\?\.windowTokens/g) ?? []).length === 3)
ok('酒馆预算进入系统装配', engineSrc.includes('provider?.contextWindow ?? runChat.acp?.windowTokens'))
ok('正文续写读取 ACP 预算', read('src/lib/creative/continuationPlan.ts').includes('acpBudgetSnapshot'))
ok('ChatFn 携带可选窗口', read('src/lib/tavern/provider.ts').includes('windowTokens?: number'))
ok('渲染层未知返回 null', read('src/lib/agentHost/acpBudget.ts').includes('windowTokens ?? null'))

console.log(`\nACP_BUDGET ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
