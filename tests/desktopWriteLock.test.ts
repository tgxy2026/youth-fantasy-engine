// 3.0 · W3-3 · §11.1 L4 —— 桌面版「数据文件读不出来就锁写盘」六分支判定
//
// 为什么补这条（§11.1 L4 原文）：`DesktopWriteLockBanner` 是**数据安全组件**，却是零覆盖 ——
// 而它背后那条红线（读不出数据文件就别写盘，否则内存里的空库会覆盖磁盘上的真实数据）**从来没被测试守过**，
// 原因很实在：判定内联在 `initDesktopStore`，而它依赖 `DESKTOP`（模块级 const，读 preload 注入）与 IPC 桥，
// 测试环境注入不了。
//
// 修法不是引入 React 测试工具，而是把**判定**抽成纯函数 `decideDataFileLoad` ——
// 组件与 main 逻辑各自保留原样，六条分支逐条可断言。
import fs from 'node:fs'
import { decideDataFileLoad } from '../src/lib/desktop'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 一份**本软件写出的**合法数据文件文本 */
const VALID = JSON.stringify({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 1, savedAt: 123, stores: { projects: { p1: { id: 'p1' } } } })

console.log('\n—— desktopWriteLock 用例开始 ——')

// ---------- ① 读取报错 —— 必须锁 ----------
{
  const o = decideDataFileLoad({ text: null, error: 'EACCES: 权限被拒', missing: false })
  ok('① 读取报错 ⇒ lock（不是 empty）', o.kind === 'lock', o.kind)
  ok('① reason 带出主进程原话（作者能看懂）', o.kind === 'lock' && o.reason.includes('EACCES'), o.kind === 'lock' ? o.reason : '')
  ok('① error 文案写明「已暂停写入」', o.kind === 'lock' && /已暂停写入/.test(o.error))
}

// ---------- ② 文件确实不存在（missing === true） ⇒ 首次使用，可写 ----------
{
  const o = decideDataFileLoad({ text: null, error: null, missing: true })
  ok('② missing===true ⇒ empty（首次使用放行）', o.kind === 'empty', o.kind)
}

// ---------- ③ 旧 preload（无 missing 字段）+ 无文本 ⇒ 同样按首次使用 ----------
{
  const o = decideDataFileLoad({ text: null, error: null })
  ok('③ missing 未知 + 无文本 ⇒ empty', o.kind === 'empty', o.kind)
  const o2 = decideDataFileLoad({ text: '   ', error: null })
  ok('③ missing 未知 + 纯空白文本 ⇒ empty（空白 ≠ 有内容）', o2.kind === 'empty', o2.kind)
}

// ---------- ④ 文件存在但内容为空 ⇒ 锁（可能正在同步 / 上次写被中断） ----------
{
  const o = decideDataFileLoad({ text: '', error: null, missing: false })
  ok('④ 文件存在但空 ⇒ lock', o.kind === 'lock', o.kind)
  ok('④ reason 提到「内容为空」', o.kind === 'lock' && o.reason.includes('内容为空'))
  const o2 = decideDataFileLoad({ text: '  \n ', error: null, missing: false })
  ok('④ 纯空白同样锁（trim 后为空）', o2.kind === 'lock', o2.kind)
}

// ---------- ⑤ JSON 损坏 ⇒ 锁 ----------
{
  const o = decideDataFileLoad({ text: '{ 这不是合法 JSON', error: null, missing: false })
  ok('⑤ JSON 损坏 ⇒ lock', o.kind === 'lock', o.kind)
  ok('⑤ reason 提到「不是有效的 JSON」', o.kind === 'lock' && o.reason.includes('有效的 JSON'))
}

// ---------- ⑥ 合法 JSON 但不是本软件写出的 ⇒ 锁（P1-2：漏这步是**静默覆盖**） ----------
{
  const o = decideDataFileLoad({ text: JSON.stringify({ hello: 'world' }), error: null, missing: false })
  ok('⑥ 缺 kind 标识 ⇒ lock（否则会被当空库放行、静默覆盖）', o.kind === 'lock', o.kind)
  ok('⑥ reason 提到「格式标识」', o.kind === 'lock' && o.reason.includes('格式标识'))

  const old = decideDataFileLoad({ text: JSON.stringify({ app: 'novel-studio', kind: 'portable-data' }), error: null, missing: false })
  ok('⑥ 旧品牌 app 也算「不是本软件写出的」⇒ lock', old.kind === 'lock', old.kind)

  const noApp = decideDataFileLoad({ text: JSON.stringify({ kind: 'portable-data', stores: {} }), error: null, missing: false })
  ok('⑥ app 缺省（老备份）但 kind 正确 ⇒ 放行（向后兼容）', noApp.kind === 'ready', noApp.kind)
}

// ---------- ⑦ 正常文件 ⇒ ready 且经 normalizePortableData 归一 ----------
{
  const o = decideDataFileLoad({ text: VALID, error: null, missing: false })
  ok('⑦ 合法文件 ⇒ ready', o.kind === 'ready', o.kind)
  ok('⑦ 数据被归一化（stores 成形）', o.kind === 'ready' && !!o.data.stores && !!o.data.stores.projects)
  ok('⑦ savedAt 保留', o.kind === 'ready' && o.data.savedAt === 123, o.kind === 'ready' ? String(o.data.savedAt) : '')
}

// ---------- ⑧ 🔴 P2-11 核心：missing **未知** + 有内容 ⇒ 绝不能当「首次使用」放行 ----------
//
// 场景：旧 preload（没有 missing 字段）配新渲染层，而数据文件其实存在。
// 若按「不存在」放行，内存里的空库会在几百毫秒后覆盖真实文件（磁盘级不可逆）。
{
  const good = decideDataFileLoad({ text: VALID, error: null })
  ok('🔴 missing 未知 + 合法内容 ⇒ ready（走解析，不是 empty）', good.kind === 'ready', good.kind)

  const bad = decideDataFileLoad({ text: '{ 坏了', error: null })
  ok('🔴 missing 未知 + 损坏内容 ⇒ lock（更不能当 empty 放行）', bad.kind === 'lock', bad.kind)

  const notOurs = decideDataFileLoad({ text: JSON.stringify({ a: 1 }), error: null })
  ok('🔴 missing 未知 + 非本软件文件 ⇒ lock', notOurs.kind === 'lock', notOurs.kind)
}

// ---------- ⑨ 源码闸：判定只在纯函数一处，initDesktopStore 不再内联 ----------
{
  let src = ''
  try { src = fs.readFileSync('src/lib/desktop.ts', 'utf8') } catch { /* 读不到就留给下面的断言报错 */ }
  ok('⑨ initDesktopStore 已改走 decideDataFileLoad（防回退成内联判定）',
    /const outcome = decideDataFileLoad\(r\)/.test(src))
  ok('⑨ 六条分支文案仍都在（抽函数时没丢文案）',
    src.includes('数据文件读取失败：') && src.includes('数据文件存在但内容为空')
    && src.includes('数据文件内容不是有效的 JSON') && src.includes('数据文件缺少本软件的格式标识'))
  ok('⑨ 三条经验教训的注释随判定一起搬进了纯函数（后人看得到为什么）',
    /missing 未知时不能当「首次使用」放行/.test(src) && /解析成功 ≠ 是本软件的数据文件/.test(src))
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
