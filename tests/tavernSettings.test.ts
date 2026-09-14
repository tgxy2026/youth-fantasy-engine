// ============ 酒馆模式 · 控制面板设置（默认值 / 合并 / 派生量）============
//
// 这一层最重要的性质是「**默认值必须等于原来的硬编码值**」——
// 否则加了这个面板就等于升个版本悄悄改了所有人的风格。
// 所以第 1 组断言逐条比对这些数字，改动其中之一必须是有意识的。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import {
  DEFAULT_TAVERN_SETTINGS, K_TAVERN_SETTINGS, DEFAULT_COMMON_EXTRA,
  getTavernSettings, saveTavernSettings, resetTavernSettings,
  commonParamsLayer, modeParamsLayer, memoryLimitsOf, timeoutMsOf,
  DEFAULT_PROTOCOL, thinkOptOf, summaryLockTtlOf,
} from '../src/lib/tavern/settings'
import { FIXED_OVERHEAD_CHARS } from '../src/lib/tavern/budget'
import { PROTOCOL_CORE } from '../src/lib/tavern/protocol'
import { resolveParams } from '../src/lib/tavern/params'
import {
  TAVERN_DEFAULTS, MEMORY_SOFT_LIMIT, MEMORY_HARD_LIMIT, MEMORY_LONGTERM_LIMIT,
  MEMORY_DIARY_DAYS, SUMMARY_TRIGGER_MESSAGES, SUMMARY_MIN_INTERVAL_MS, SUMMARY_LOCK_TTL_MS,
  DAILY_ADVANCE_MS, DAILY_LOG_KEEP,
} from '../src/lib/tavern/types'
import { TONE_HINT, buildSystemPrompt } from '../src/lib/tavern/prompt'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  // ---------- 1) 出厂默认 = 原硬编码值（改这里必须是有意识的） ----------
  {
    const d = DEFAULT_TAVERN_SETTINGS
    ok('通用：上下文预算沿用 TAVERN_DEFAULTS', d.common.contextBudget === TAVERN_DEFAULTS.free.contextBudget, String(d.common.contextBudget))
    ok('通用：num_ctx 沿用 TAVERN_DEFAULTS', d.common.numCtx === TAVERN_DEFAULTS.free.numCtx, String(d.common.numCtx))
    ok('通用：超时 180 秒（= 原 CHAT_TIMEOUT_MS / 1000）', d.common.timeoutSec === 180, String(d.common.timeoutSec))
    ok('通用：默认模型留空 = 跟随全局活动模型', d.common.defaultProviderId === '')
    ok('通用：默认含「标点适用范围」那条', d.common.extraPrompt === DEFAULT_COMMON_EXTRA && d.common.extraPrompt.includes('标点照常用'))

    ok('剧情：温度 0.85 / presence 0.4（叙事要稳）',
      d.plot.temperature === 0.85 && d.plot.presencePenalty === 0.4,
      `${d.plot.temperature}/${d.plot.presencePenalty}`)
    ok('剧情：叙事向风格默认留空（不追加就是协议默认）', d.plot.styleHint === '')
    ok('自由：温度 0.9 / presence 0.45（陪伴要松）',
      d.free.temperature === 0.9 && d.free.presencePenalty === 0.45,
      `${d.free.temperature}/${d.free.presencePenalty}`)
    ok('自由：聊天向风格取 prompt 里的内置默认（单一真源）', d.free.styleHint === TONE_HINT.chat && d.free.styleHint.includes('【本场风格】'))

    ok('记忆：触发条数沿用 SUMMARY_TRIGGER_MESSAGES', d.free.triggerMessages === SUMMARY_TRIGGER_MESSAGES, String(d.free.triggerMessages))
    ok('记忆：软 / 硬 / 长期摘要上限沿用常量',
      d.free.softLimit === MEMORY_SOFT_LIMIT && d.free.hardLimit === MEMORY_HARD_LIMIT && d.free.longTermLimit === MEMORY_LONGTERM_LIMIT,
      `${d.free.softLimit}/${d.free.hardLimit}/${d.free.longTermLimit}`)
    ok('记忆：日记保留天数沿用常量', d.free.diaryDays === MEMORY_DIARY_DAYS, String(d.free.diaryDays))
    ok('记忆：自动整理间隔 = 原 600 秒换算成 10 分钟', d.free.summaryMinIntervalMin === SUMMARY_MIN_INTERVAL_MS / 60000, String(d.free.summaryMinIntervalMin))
    ok('日常：推进间隔 = 原 8 小时', d.free.dailyAdvanceHours === DAILY_ADVANCE_MS / 3600000, String(d.free.dailyAdvanceHours))
  }

  // ---------- 2) 读写往返 ----------
  {
    __resetMockStores()
    const fresh = await getTavernSettings()
    ok('没存过时读到出厂默认', fresh.common.timeoutSec === 180)

    const custom = {
      ...fresh,
      common: { ...fresh.common, timeoutSec: 60, defaultProviderId: 'p1' },
      free: { ...fresh.free, temperature: 0.5 },
    }
    await saveTavernSettings(custom)
    const back = await getTavernSettings()
    ok('改完能读回', back.common.timeoutSec === 60 && back.free.temperature === 0.5 && back.common.defaultProviderId === 'p1')

    await resetTavernSettings()
    ok('恢复默认后回到出厂值', (await getTavernSettings()).common.timeoutSec === 180)
  }

  // ---------- 3) 部分存储 → 与默认深合并（旧数据不会读出 undefined） ----------
  {
    __resetMockStores()
    // 只写了 free.temperature，其余字段一概没有 —— 模拟将来新增字段后的旧数据
    await db.setMeta(K_TAVERN_SETTINGS, { free: { temperature: 0.3 } } as never)
    const st = await getTavernSettings()
    ok('写过的字段生效', st.free.temperature === 0.3, String(st.free.temperature))
    ok('没写的字段回落到默认（不会一路 undefined）',
      st.free.topP === DEFAULT_TAVERN_SETTINGS.free.topP &&
      st.common.timeoutSec === 180 &&
      st.plot.temperature === 0.85,
      JSON.stringify(st.common))
    ok('整个缺失的分组也补全', st.common.extraPrompt === DEFAULT_COMMON_EXTRA)
  }

  // ---------- 4) 派生量 ----------
  {
    __resetMockStores()
    const st = DEFAULT_TAVERN_SETTINGS

    const lim = memoryLimitsOf(st)
    ok('memoryLimitsOf：分钟 → 毫秒', lim.minIntervalMs === SUMMARY_MIN_INTERVAL_MS, String(lim.minIntervalMs))
    ok('memoryLimitsOf：小时 → 毫秒', lim.dailyAdvanceMs === DAILY_ADVANCE_MS, String(lim.dailyAdvanceMs))
    ok('memoryLimitsOf：条数/上限原样带出',
      lim.triggerMessages === SUMMARY_TRIGGER_MESSAGES && lim.softLimit === MEMORY_SOFT_LIMIT && lim.hardLimit === MEMORY_HARD_LIMIT,
      `${lim.triggerMessages}/${lim.softLimit}/${lim.hardLimit}`)

    ok('timeoutMsOf：秒 → 毫秒', timeoutMsOf(st) === 180 * 1000, String(timeoutMsOf(st)))
    ok('timeoutMsOf 有下限保护（填 0 也不会变成 0 超时）', timeoutMsOf({ ...st, common: { ...st.common, timeoutSec: 0 } }) === 5000)

    const base = resolveParams('free', commonParamsLayer(st.common), modeParamsLayer('free', st))
    ok('参数继承：控制面板层能落到结果上', base.temperature === 0.9 && base.contextBudget === 8000 && base.numCtx === 32768,
      `${base.temperature}/${base.contextBudget}/${base.numCtx}`)

    const over = resolveParams('free', commonParamsLayer(st.common), modeParamsLayer('free', st), { temperature: 0.11 })
    ok('参数继承：会话层优先级高于控制面板层', over.temperature === 0.11, String(over.temperature))

    const plotBase = resolveParams('plot', commonParamsLayer(st.common), modeParamsLayer('plot', st))
    ok('两种模式的模式层互不串台（剧情仍是 0.85）', plotBase.temperature === 0.85, String(plotBase.temperature))
  }

  // ---------- 5) 本轮新增的项：逐条等于原硬编码值 ----------
  {
    const d = DEFAULT_TAVERN_SETTINGS
    ok('通用：固定开销预留 = budget.ts 的常量',
      d.common.fixedOverheadChars === FIXED_OVERHEAD_CHARS, String(d.common.fixedOverheadChars))
    ok('通用：默认关闭思考链（engine 原本恒传 think:false）', d.common.disableThink === true)
    ok('剧情：设定层占比 = 原写死的 0.6', d.plot.settingRatio === 0.6, String(d.plot.settingRatio))
    ok('自由：整理模型默认为空（跟随默认模型）', d.free.summaryProviderId === '')
    ok('自由：整理锁有效期 = 原 1800 秒换算成 30 分钟',
      d.free.summaryLockTtlMin === SUMMARY_LOCK_TTL_MS / 60000, String(d.free.summaryLockTtlMin))
    ok('自由：日常生活记录条数 = 原 DAILY_LOG_KEEP',
      d.free.dailyLogKeep === DAILY_LOG_KEEP, String(d.free.dailyLogKeep))
    ok('协议：默认就是内置常量', d.protocol === PROTOCOL_CORE && d.protocol === DEFAULT_PROTOCOL)
  }

  // ---------- 6) 派生量：本轮新增两项 ----------
  {
    const lim = memoryLimitsOf(DEFAULT_TAVERN_SETTINGS)
    ok('memoryLimitsOf：整理锁有效期（分钟 → 毫秒）', lim.lockTtlMs === SUMMARY_LOCK_TTL_MS, String(lim.lockTtlMs))
    ok('memoryLimitsOf：日常记录条数', lim.dailyLogKeep === DAILY_LOG_KEEP, String(lim.dailyLogKeep))
    ok('summaryLockTtlOf 与 memoryLimitsOf 口径一致',
      summaryLockTtlOf(DEFAULT_TAVERN_SETTINGS) === lim.lockTtlMs)
    ok('thinkOptOf：默认关闭 → 传 false', thinkOptOf(DEFAULT_TAVERN_SETTINGS) === false)
    ok('thinkOptOf：开回来后 → undefined（不下发该字段，模型保持思考）',
      thinkOptOf({ ...DEFAULT_TAVERN_SETTINGS, common: { ...DEFAULT_TAVERN_SETTINGS.common, disableThink: false } }) === undefined)
  }

  // ---------- 7) 协议可被设置覆盖（控制面板的编辑口子） ----------
  {
    ok('不传 protocol 时仍是内置常量（既有调用零变化）',
      buildSystemPrompt({ tone: 'narrative' }) === PROTOCOL_CORE)
    const custom = buildSystemPrompt({ tone: 'narrative', protocol: '【我的协议】只此一句' })
    ok('传了 protocol 就整体替换', custom === '【我的协议】只此一句', custom.slice(0, 30))
    ok('清空 protocol 时回退内置常量（不让 system 尾部空掉）',
      buildSystemPrompt({ tone: 'narrative', protocol: '   ' }) === PROTOCOL_CORE)
  }

  console.log(`\ntavernSettings: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
