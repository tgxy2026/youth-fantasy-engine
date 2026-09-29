// ============ 网络代理偏好（netPrefs · 2026-09-28）============
//
// 钉住的行为：
// ① normalizeProxyInput 是主进程 Chromium 代理解析器的入参防线：只放行
//    http/https/socks5 + host[:port]，其余一律 ''（调用方按「无效」处理）；
// ② sanitizeBypassList：分号 / 全角逗号 / 空白都能当分隔符（容错），非法段丢弃，
//    `<local>` 标记合法（Chromium bypass 语法）；
// ③ getStoredNetPrefs 脏数据收窄：非法 rules → 该字段清空且 enabled 强制 false
//    （🔴 有 rules 但不合法时绝不能以 enabled 状态推给主进程）；
// ④ 无 document / 无桥环境静默跳过（node 单测不抛）。
import {
  normalizeProxyInput, sanitizeBypassList, getStoredNetProxy,
  applyNetProxy, applyStoredNetProxy, storeNetProxy, DEFAULT_BYPASS,
} from '../src/lib/netPrefs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① normalizeProxyInput ----------
{
  ok('裸 host:port 合法', normalizeProxyInput('127.0.0.1:7890') === '127.0.0.1:7890')
  ok('http://host:port 合法', normalizeProxyInput('http://127.0.0.1:7890') === 'http://127.0.0.1:7890')
  ok('socks5:// 合法', normalizeProxyInput('socks5://192.168.1.10:1080') === 'socks5://192.168.1.10:1080')
  ok('大写 scheme 也认（SOCKS5://）', normalizeProxyInput('SOCKS5://10.0.0.1:1080') === 'SOCKS5://10.0.0.1:1080')
  ok('域名 host 合法', normalizeProxyInput('gateway.corp.internal:8080') === 'gateway.corp.internal:8080')
  ok('🔴 空 → 非法', normalizeProxyInput('') === '' && normalizeProxyInput('   ') === '')
  ok('🔴 注入字符（分号/空格/引号）→ 非法', normalizeProxyInput('127.0.0.1:7890; rm -rf') === '')
  ok('🔴 裸 port 溢出 → 非法', normalizeProxyInput('127.0.0.1:99999') === '' && normalizeProxyInput('127.0.0.1:0') === '')
  ok('🔴 未知 scheme → 非法', normalizeProxyInput('ftp://127.0.0.1:21') === '')
  ok('🔴 纯 scheme 无 host → 非法', normalizeProxyInput('http://') === '')
  ok('🔴 含路径 → 非法（规则串不需要路径）', normalizeProxyInput('http://127.0.0.1:7890/path') === '')
}

// ---------- ② sanitizeBypassList ----------
{
  ok('逗号名单原样保留', sanitizeBypassList('localhost,127.0.0.1') === 'localhost,127.0.0.1')
  ok('分号 / 全角逗号 / 空白容错成逗号', sanitizeBypassList('localhost；127.0.0.1，<local>') === 'localhost,127.0.0.1,<local>')
  ok('<local> 标记合法（Chromium bypass 语法）', sanitizeBypassList('<local>') === '<local>')
  ok('非法段丢弃', sanitizeBypassList('localhost, a;b, 192.168.*') === 'localhost,192.168.*')
  ok('全非法 → 空串（调用方回默认名单）', sanitizeBypassList(';;') === '')
}

// ---------- ③ getStoredNetProxy 脏数据收窄（mock localStorage） ----------
{
  const g = globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }
  const withStore = (v: string | null) => {
    g.localStorage = { getItem: () => v, setItem: () => {}, removeItem: () => {} }
  }
  try {
    withStore(null)
    ok('无存储 → 默认（关闭 + 默认直连名单）',
      JSON.stringify(getStoredNetProxy()) === JSON.stringify({ enabled: false, rules: '', bypass: DEFAULT_BYPASS }))
    withStore('not json {')
    ok('脏 JSON → 默认', getStoredNetProxy().enabled === false)
    withStore(JSON.stringify({ enabled: true, rules: 'bad rules;;', bypass: 'localhost' }))
    const dirty = getStoredNetProxy()
    ok('🔴 rules 非法 → enabled 强制 false（绝不能把无效配置推给主进程）',
      dirty.enabled === false && dirty.rules === '' && dirty.bypass === 'localhost')
    withStore(JSON.stringify({ enabled: true, rules: 'http://127.0.0.1:7890', bypass: 42 }))
    ok('合法 rules 保留、bypass 非字符串回默认名单',
      getStoredNetProxy().rules === 'http://127.0.0.1:7890' && getStoredNetProxy().bypass === DEFAULT_BYPASS)
  } finally {
    delete g.localStorage
  }
}

// ---------- ④ node 环境（无 document / 无桥）静默跳过 ----------
{
  applyNetProxy({ enabled: true, rules: '127.0.0.1:7890', bypass: '' })   // 不抛即过（无桥 ok:false）
  applyStoredNetProxy()
  storeNetProxy({ enabled: false, rules: '', bypass: '' })
  ok('apply / store 系列在 node 环境下不抛', true)
}

console.log(`\nnetPrefs: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
