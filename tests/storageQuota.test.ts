// ============ 存储配额 · 单测（3.6.2 · W4）============
//
// 这块最容易犯的错是"把未知当已满"：浏览器隐私模式 / WebView 会给 quota=0，
// 若判成 critical，用户每天都会看到"立刻导出备份"——那条提示的信用一次就没了。
// 所以下面第一条就是 quota=0 → unknown，且 unknown 永不提示。
import {
  quotaLevel,
  quotaPercent,
  quotaNoticeKey,
  shouldNotifyQuota,
  readQuota,
  QUOTA_WARN_RATIO,
  QUOTA_CRITICAL_RATIO,
} from '../src/lib/app/storageQuota'
import { checkQuotaNotice, quotaNoticeText } from '../src/lib/app/quotaNotice'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 1. 档位判定 ----------
{
  const GB = 1024 ** 3
  ok('🔴 quota=0（隐私模式/WebView）→ unknown，不当已满', quotaLevel(0, 0) === 'unknown')
  ok('quota 缺失（NaN）→ unknown', quotaLevel(100, Number.NaN) === 'unknown')
  ok('quota 负数 → unknown', quotaLevel(100, -1) === 'unknown')
  ok('usage 负数 → unknown', quotaLevel(-5, GB) === 'unknown')
  ok('usage 非有限 → unknown', quotaLevel(Number.POSITIVE_INFINITY, GB) === 'unknown')

  ok('0% → ok', quotaLevel(0, GB) === 'ok')
  ok(`79% → ok`, quotaLevel(GB * 0.79, GB) === 'ok')
  ok(`刚好 ${QUOTA_WARN_RATIO * 100}% → warn`, quotaLevel(GB * QUOTA_WARN_RATIO, GB) === 'warn')
  ok('90% → warn', quotaLevel(GB * 0.9, GB) === 'warn')
  ok(`刚好 ${QUOTA_CRITICAL_RATIO * 100}% → critical`, quotaLevel(GB * QUOTA_CRITICAL_RATIO, GB) === 'critical')
  ok('99% → critical', quotaLevel(GB * 0.99, GB) === 'critical')
  ok('超出配额（100%+）→ critical（不抛、不溢出）', quotaLevel(GB * 1.2, GB) === 'critical')
}

// ---------- 2. 百分比 ----------
{
  ok('50% → 50', quotaPercent(500, 1000) === 50)
  ok('80.4% → 80（四舍五入到整数）', quotaPercent(804, 1000) === 80)
  ok('🔴 配额未知 → null（不是 0）', quotaPercent(100, 0) === null)
  ok('超过 100% 时封顶 100', quotaPercent(2000, 1000) === 100)
}

// ---------- 3. 提示频次 ----------
{
  const today = '2026-11-21'
  ok('ok 不提示', shouldNotifyQuota('ok', null, today) === false)
  ok('unknown 不提示', shouldNotifyQuota('unknown', null, today) === false)
  ok('warn 首次提示', shouldNotifyQuota('warn', null, today) === true)
  ok('同一天 warn 提过 → 不再提示', shouldNotifyQuota('warn', quotaNoticeKey('warn', today), today) === false)
  ok('同一天 warn 提过，升到 critical → 仍要提示（更严重）',
    shouldNotifyQuota('critical', quotaNoticeKey('warn', today), today) === true)
  ok('🔴 跨天 → 再提一次（不是永远闭嘴）',
    shouldNotifyQuota('warn', quotaNoticeKey('warn', '2026-11-20'), today) === true)
  ok('键里带档位与日期', quotaNoticeKey('critical', today) === `critical@${today}`)
}

// ---------- 4. readQuota 的容错 ----------
{
  ok('🔴 estimate 返回空对象 → null', await readQuota(async () => ({})) === null)
  ok('estimate 返回 undefined → null', await readQuota(async () => undefined) === null)
  ok('estimate 抛错 → null（不冒泡）', await readQuota(async () => { throw new Error('denied') }) === null)
  ok('quota=0 → null', await readQuota(async () => ({ usage: 0, quota: 0 })) === null)
  const good = await readQuota(async () => ({ usage: 100, quota: 1000 }))
  ok('正常值原样返回', good?.usage === 100 && good?.quota === 1000, JSON.stringify(good))
}

// ---------- 5. 文案 ----------
{
  const warn = quotaNoticeText('warn', 82)
  const crit = quotaNoticeText('critical', 97)
  ok('warn 文案带百分比与动作', warn.includes('82%') && warn.includes('导出'), warn)
  ok('🔴 critical 明说「保存随时可能失败」', crit.includes('保存随时可能失败'), crit)
  ok('🔴 文案不说「你的作品占了 N%」（estimate 是整个源的用量）',
    !/你的作品/.test(warn) && !/你的作品/.test(crit))
}

// ---------- 6. checkQuotaNotice 的端到端行为 ----------
{
  // 用一个内存版偏好存储，验证"当天只提一次"
  const mem = new Map<string, string>()
  const readPref = (k: string) => mem.get(k) ?? null
  const writePref = (k: string, v: string) => { mem.set(k, v); return true }
  const info = { usage: 850, quota: 1000 }   // 85% → warn

  const first = await checkQuotaNotice({ info, today: '2026-11-21', readPref, writePref })
  ok('6a 85% 首次 → 提示 warn', first?.level === 'warn', JSON.stringify(first))
  ok('6b 提示里写明百分比', !!first && first.text.includes('85%'), first?.text ?? '')

  const second = await checkQuotaNotice({ info, today: '2026-11-21', readPref, writePref })
  ok('6c 同一天第二次 → 不再提示', second === null, JSON.stringify(second))

  const nextDay = await checkQuotaNotice({ info, today: '2026-11-22', readPref, writePref })
  ok('6d 第二天 → 又提一次', nextDay?.level === 'warn')

  const critical = await checkQuotaNotice({ info: { usage: 970, quota: 1000 }, today: '2026-11-22', readPref, writePref })
  ok('6e 升级到 critical → 当天仍提示新档位', critical?.level === 'critical', JSON.stringify(critical))

  ok('6f 配额未知（null）→ 不提示也不写记录',
    (await checkQuotaNotice({ info: null, today: '2026-11-23', readPref, writePref })) === null)
  ok('6g 0 配额的源 → 不提示', (await checkQuotaNotice({ info: { usage: 0, quota: 0 }, today: '2026-11-23', readPref, writePref })) === null)
  ok('6h 用了少量空间 → 不提示', (await checkQuotaNotice({ info: { usage: 10, quota: 1000 }, today: '2026-11-23', readPref, writePref })) === null)
}

console.log(`\nstorageQuota: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
