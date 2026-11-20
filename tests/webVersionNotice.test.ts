// ============ 网页版「有新版本，刷新以应用」 · 纯函数与免打扰单测（3.6.2 W1）============
//
// 钉住四条口径（也是本模块存在的理由）：
//   ① 只有**确实换版**才提示；
//   ② 任一侧 id 为空就**静默**（断网 / 清单没部署 / 字段缺失 —— 绝不把空值当"有新版本"）；
//   ③ 同一天点过"今天不再提示"就不再提示，且按**本地日期**算（UTC 会在东八区晚上算错一天）；
//   ④ 取线上 id 永不抛。
import {
  localDateKey,
  shouldPrompt,
  readDismissedOn,
  dismissForToday,
  fetchLatestWebBuildId,
} from '../src/lib/app/webVersionNotice'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// uiPrefs 走 localStorage；Node 里没有 → 垫一个内存版，只为验「写进去能读回来」
const mem = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size },
} as Storage

// ---------- 本地日期键 ----------
{
  ok('本地日期键按本地时区（23:30 仍算当天）', localDateKey(new Date(2026, 0, 5, 23, 30)) === '2026-01-05',
    localDateKey(new Date(2026, 0, 5, 23, 30)))
  ok('本地日期键补零', localDateKey(new Date(2026, 8, 9, 0, 5)) === '2026-09-09',
    localDateKey(new Date(2026, 8, 9, 0, 5)))
  ok('🔴 与 UTC 切片不同：东八区 07:00 用 toISOString 会得到前一天',
    new Date(2026, 0, 5, 7, 0).toISOString().slice(0, 10) !== localDateKey(new Date(2026, 0, 5, 7, 0))
    || new Date().getTimezoneOffset() === 0,
    `tz=${new Date().getTimezoneOffset()}`)
}

// ---------- shouldPrompt 基本判定 ----------
{
  const today = '2026-11-21'
  ok('id 相同 → 不提示', shouldPrompt('b1', 'b1', null, today) === false)
  ok('id 不同 → 提示', shouldPrompt('b1', 'b2', null, today) === true)
  ok('🔴 本页面 id 为空 → 静默', shouldPrompt('', 'b2', null, today) === false)
  ok('🔴 线上 id 为空 → 静默（清单没 webBuildId 时不许误报）', shouldPrompt('b1', '', null, today) === false)
  ok('🔴 两侧都空 → 静默', shouldPrompt('', '', null, today) === false)
  ok('两侧只有空白 → 静默', shouldPrompt('   ', '  ', null, today) === false)
  ok('首尾空白不影响比较（b1 vs " b1 " → 相同）', shouldPrompt('b1', ' b1 ', null, today) === false)
  ok('今天已经点过"不再提示" → 不弹', shouldPrompt('b1', 'b2', today, today) === false)
  ok('昨天点过 → 今天照常提示', shouldPrompt('b1', 'b2', '2026-11-20', today) === true)
  ok('记录值格式怪（含时间）也算"今天"？→ 不，按严格相等，仍提示',
    shouldPrompt('b1', 'b2', '2026-11-21T10:00:00', today) === true)
}

// ---------- 免打扰读写 ----------
{
  ok('未点过 → 读到 null', readDismissedOn() === null)
  dismissForToday('2026-11-21')
  ok('点过之后能读回当天日期', readDismissedOn() === '2026-11-21', String(readDismissedOn()))
  ok('点过之后再判断 → 不提示', shouldPrompt('b1', 'b2', readDismissedOn(), '2026-11-21') === false)
  ok('跨到第二天 → 又能提示', shouldPrompt('b1', 'b2', readDismissedOn(), '2026-11-22') === true)
}

// ---------- 取线上 webBuildId：永不抛 ----------
const realFetch = globalThis.fetch
async function withFetch(fn: () => Promise<unknown>) {
  globalThis.fetch = fn as typeof fetch
  try { return await fetchLatestWebBuildId() } finally { globalThis.fetch = realFetch }
}

{
  const got = await withFetch(async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ schema: 1, version: '3.6.2', webBuildId: 'b20261205', assets: [] }),
  }))
  ok('清单里有 webBuildId → 原样取回', got === 'b20261205', got)
}

{
  const got = await withFetch(async () => ({ ok: false, status: 404, text: async () => '<html>404</html>' }))
  ok('清单 404 → 空串（静默）', got === '', JSON.stringify(got))
}

{
  const got = await withFetch(async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ schema: 1, version: '3.6.2', assets: [] }),
  }))
  ok('清单没写 webBuildId → 空串', got === '', JSON.stringify(got))
}

{
  const got = await withFetch(async () => { throw new Error('offline') })
  ok('网络抛错 → 空串且不冒泡', got === '', JSON.stringify(got))
}

{
  // 端到端：拿到的 id 与页面启动时记的不同 ⇒ 应提示
  const got = await withFetch(async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ schema: 1, version: '3.6.2', webBuildId: 'new-one', assets: [] }),
  }))
  ok('取到新 id + 页面是旧 id → 提示', shouldPrompt('old-one', got, null, '2026-11-21') === true)
}

console.log(`\nwebVersionNotice: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
