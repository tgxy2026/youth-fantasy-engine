/**
 * 运行期错误留痕 · 单测（2026-10-06 补）
 *
 * 两个重点：
 *   ① **隐私**：错误消息会被复制进诊断信息贴到群里 ⇒ 必须截断；来源必须只留文件名（不能带目录/用户名）；
 *   ② **环形语义**：上限到了丢最旧、`recentErrors()` 新在前 —— 诊断文本按序读，顺序错了会误导定位。
 */
import {
  recordError, recentErrors, clearErrors, messageOf, shortSource,
  installGlobalErrorHooks, type ErrorRecord,
} from '../src/lib/errorLog'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  clearErrors()

  // ---------- 1) messageOf：各种 throw 出来的东西都要能读 ----------
  {
    ok('1a Error → 取 message', messageOf(new Error('读盘失败')) === '读盘失败')
    ok('1b 无 message 的 Error → 退回 name', messageOf(new TypeError('')) === 'TypeError', messageOf(new TypeError('')))
    ok('1c 字符串原样', messageOf('炸了') === '炸了')
    ok('1d 对象 → JSON 化', messageOf({ code: 1 }) === '{"code":1}', messageOf({ code: 1 }))
    ok('1e null / undefined 不抛', typeof messageOf(null) === 'string' && typeof messageOf(undefined) === 'string')
    ok('1f 换行被压成空格（单行展示）', messageOf(new Error('第一行\n第二行')) === '第一行 第二行')
  }

  // ---------- 2) 🔴 隐私：消息必须截断 ----------
  {
    const long = 'A'.repeat(5000)
    const got = messageOf(new Error(long))
    ok('2a 超长消息被截断到 200 字 + 省略号', got.length === 201 && got.endsWith('…'), String(got.length))
    // 负面对照：短消息不该被加省略号（证明截断确实按长度触发，不是无脑加）
    ok('2b 短消息不截断、不加省略号', messageOf(new Error('短路')) === '短路')
    // 🔴 正文式污染：错误消息里夹带一整段正文，也不能原样进留痕
    const leak = 'JSON.parse 失败：' + '这是很长的正文内容'.repeat(60)
    ok('2c 夹带长文本的消息被截断（不会把正文整段带出去）', messageOf(new Error(leak)).length <= 201)
  }

  // ---------- 3) 🔴 隐私：来源只留文件名 ----------
  {
    ok('3a Windows 绝对路径 → 只剩文件名', shortSource('C:\\Users\\18223\\AppData\\x\\main.js') === 'main.js',
      shortSource('C:\\Users\\18223\\AppData\\x\\main.js'))
    ok('3b 带行号', shortSource('C:\\a\\b\\app.ts', 42) === 'app.ts:42', shortSource('C:\\a\\b\\app.ts', 42))
    ok('3c URL 带查询串 → 去查询串只留文件名', shortSource('http://localhost:5199/src/App.tsx?t=123', 7) === 'App.tsx:7',
      shortSource('http://localhost:5199/src/App.tsx?t=123', 7))
    ok('3d 相对路径', shortSource('src/lib/db.ts', 10) === 'db.ts:10', shortSource('src/lib/db.ts', 10))
    ok('3e 空值 → 空串（不抛）', shortSource(null) === '' && shortSource('') === '' && shortSource(undefined) === '')
    ok('3f 行号为 0/负数时不拼行号', shortSource('a/b.ts', 0) === 'b.ts', shortSource('a/b.ts', 0))
    // 🔴 关键：任何形态都不许把用户名带出来
    ok('3g 结果里绝不含用户名片段',
      !shortSource('C:\\Users\\18223\\x\\y.js', 3).includes('18223'))
  }

  // ---------- 4) 环形缓冲语义 ----------
  {
    clearErrors()
    recordError('window', new Error('第一条'), 'a.ts:1')
    recordError('unhandled', new Error('第二条'))
    recordError('render', new Error('第三条'), 'App.tsx:9')
    const list = recentErrors()
    ok('4a 新的在前（诊断文本按序读）', list[0].message === '第三条' && list[2].message === '第一条',
      list.map(r => r.message).join('|'))
    ok('4b kind 如实记录', list[0].kind === 'render' && list[1].kind === 'unhandled' && list[2].kind === 'window')
    ok('4c source 有就带上、没有就是空串', list[0].source === 'App.tsx:9' && list[1].source === '')
    ok('4d 带时间戳（可排序、可展示）', list.every((r: ErrorRecord) => typeof r.at === 'number' && r.at > 0))
  }
  {
    clearErrors()
    for (let i = 0; i < 25; i++) recordError('window', new Error(`e${i}`))
    const list = recentErrors()
    ok('4e 超过上限只留 10 条（不无限增长）', list.length === 10, String(list.length))
    ok('4f 丢的是最旧的（留下 e24…e15）', list[0].message === 'e24' && list[9].message === 'e15',
      `${list[0].message} … ${list[9].message}`)
  }
  {
    clearErrors()
    recordError('window', new Error('x'))
    clearErrors()
    ok('4g clearErrors 清空', recentErrors().length === 0)
  }

  // ---------- 5) 全局钩子 ----------
  {
    // Node 环境没有 window：必须安全 no-op（不能抛），否则测试与 SSR 都会挂
    let threw = false
    try { installGlobalErrorHooks(); installGlobalErrorHooks() } catch { threw = true }
    ok('5a 非浏览器环境调用安全 no-op（且可重复调用）', !threw)
    // 有 window 时：装钩子后能在不抛异常的前提下被调用（用最小桩）
    const g = globalThis as { window?: unknown }
    const handlers: Record<string, ((ev: unknown) => void)[]> = {}
    const fakeWin = {
      addEventListener: (t: string, fn: (ev: unknown) => void) => { (handlers[t] ||= []).push(fn) },
    }
    const saved = g.window
    g.window = fakeWin
    clearErrors()
    try {
      // 重新 import 拿一份「未装过」的实例不好做 ⇒ 直接验证桩侧行为：装钩子不抛、且只登记一次
      installGlobalErrorHooks()
      const n1 = (handlers['error'] || []).length
      installGlobalErrorHooks()
      ok('5b 重复调用不会重复登记监听', (handlers['error'] || []).length === n1)
      handlers['error']?.forEach(fn => fn({ error: new Error('脚本炸了'), filename: 'C:\\u\\a\\x.js', lineno: 3 }))
      const rec = recentErrors()
      ok('5c 触发 error 事件后留痕（消息 + 只留文件名的来源）',
        rec.length === 1 && rec[0].message === '脚本炸了' && rec[0].source === 'x.js:3',
        JSON.stringify(rec[0] ?? null))
    } finally {
      if (saved === undefined) delete g.window; else g.window = saved
      // 让后续用例不受影响（installed 标记已置位，这里保持——真实运行也只装一次）
      clearErrors()
    }
  }

  console.log(`\nerrorLog: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error('errorLog 测试自身异常:', e); process.exit(1) })
