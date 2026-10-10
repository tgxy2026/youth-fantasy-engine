// 3.0 · W0-2 数据迁移 · remap 纯函数护栏
//
// 这是整条迁移链里**唯一可纯函数单测**的部分（探测 / 文件 IO 在主进程，IDB 转库需真浏览器）。
// 所以这里把 remap 的每条分支都钉死 —— 它是「旧值 → 新值」的唯一权威改写点，错了就是数据静默错。
import { remapLegacyJsonText, LEGACY_KIND_MAP, LEGACY_APP, NEW_APP } from '../src/lib/storage/legacyMigration'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— legacyMigration 用例开始 ——')

// ① 顶层 app：旧 → 新（本机实测整库 JSON 里唯一会出现旧值的地方）
{
  const src = JSON.stringify({ app: LEGACY_APP, kind: 'portable-data', fileVersion: 1, savedAt: 0, stores: {} })
  const r = remapLegacyJsonText(src)
  ok('合法整库 → remap 成功', r.ok === true)
  if (r.ok) {
    const out = JSON.parse(r.text) as Record<string, unknown>
    ok('app 已改为新值', out.app === NEW_APP, String(out.app))
    ok('kind 保持不变（portable-data 不是品牌串）', out.kind === 'portable-data')
    ok('统计 app=1', r.stats.app === 1, String(r.stats.app))
    ok('统计 kinds=0', r.stats.kinds === 0, String(r.stats.kinds))
  }
}

// ② 🔴 中文显示串 `generator.app = '青春幻想引擎'` 绝不能动（§3.3 注）
{
  const src = JSON.stringify({ app: LEGACY_APP, generator: { app: '青春幻想引擎' }, stores: {} })
  const r = remapLegacyJsonText(src)
  ok('中文显示串 generator.app 不改',
    r.ok === true && (JSON.parse(r.text) as { generator: { app: string } }).generator.app === '青春幻想引擎')
}

// ③ 递归兜底：深处记录里的旧 kind 也要 remap
{
  const src = JSON.stringify({ app: LEGACY_APP, stores: { x: { a: { kind: 'novel-studio-trajectory' } } } })
  const r = remapLegacyJsonText(src)
  ok('嵌套 kind 已 remap 成功', r.ok === true)
  if (r.ok) {
    const out = JSON.parse(r.text) as { stores: { x: { a: { kind: string } } } }
    ok('嵌套 kind 值正确', out.stores.x.a.kind === 'youth-fantasy-engine-trajectory', out.stores.x.a.kind)
    ok('统计 kinds=1', r.stats.kinds === 1, String(r.stats.kinds))
  }
}

// ④ 三种已知 kind 全覆盖（数组里的 kind 也要命中）
{
  for (const [oldK, newK] of Object.entries(LEGACY_KIND_MAP)) {
    const src = JSON.stringify({ app: LEGACY_APP, list: [{ kind: oldK }] })
    const r = remapLegacyJsonText(src)
    const got = r.ok ? (JSON.parse(r.text) as { list: { kind: string }[] }).list[0].kind : ''
    ok(`kind 映射（数组内）${oldK} → ${newK}`, got === newK, got)
  }
}

// ⑤ 异常输入：一律失败、不抛
{
  ok('非 JSON 文本 → 失败', remapLegacyJsonText('{ not json ').ok === false)
  ok('数组根 → 失败', remapLegacyJsonText('[]').ok === false)
  ok('字符串根 → 失败', remapLegacyJsonText('"x"').ok === false)
  ok('null 根 → 失败', remapLegacyJsonText('null').ok === false)
}

// ⑥ 幂等：已是新值的整库再 remap，改动数为 0
{
  const src = JSON.stringify({ app: NEW_APP, kind: 'portable-data', stores: {} })
  const r = remapLegacyJsonText(src)
  ok('已是新值 → 幂等（app 统计为 0）', r.ok === true && r.stats.app === 0 && r.stats.kinds === 0)
  ok('已是新值 → app 仍为新值', r.ok === true && (JSON.parse(r.text) as { app: string }).app === NEW_APP)
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
