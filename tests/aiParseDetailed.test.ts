// WQ1（3.2.0 · MQ0 契约）：aiParse 详细解析接口的负向控制测试
//
// 覆盖方案 §16.2 验收口径：合法空数组、无效 JSON、修复部分成功、缺字段、
// 截断分别有正确状态；`[]` 与解析失败必须可区分。
//
// 🔴 负向控制原则：每条断言都按「能红的坏样本」写 —— 若把 detailed 版改回
//    「一律返回 data」的老形状，本文件必须失败。
import { parseObjectArray, parseObjectArrayDetailed, parsePlainObjectDetailed, parseLooseObject } from '../src/lib/ai/aiParse'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 合法空结果（valid）----------
{
  const r = parseObjectArrayDetailed('[]')
  ok('模型明确返回 [] ⇒ valid', r.outcome === 'valid')
  ok('合法空结果数据为空', r.data.length === 0)
  ok('合法空结果无诊断', r.diagnostics.length === 0)
  ok('合法空结果非截断', r.truncated === false)

  const r2 = parseObjectArrayDetailed('{"list":[]}')
  ok('{list:[]} ⇒ valid 空数据（明确给了空清单）', r2.outcome === 'valid' && r2.data.length === 0)

  const r3 = parseObjectArrayDetailed('```json\n[]\n```')
  ok('围栏里的空数组 ⇒ valid', r3.outcome === 'valid' && r3.data.length === 0)
}

// ---------- 正常解析（valid）----------
{
  const r = parseObjectArrayDetailed('[{"a":1},{"a":2}]')
  ok('标准数组 ⇒ valid', r.outcome === 'valid' && r.data.length === 2)

  const s = parseObjectArrayDetailed('{"a":1}')
  ok('单对象归一化 ⇒ valid（兼容行为不算修复）', s.outcome === 'valid' && s.data.length === 1)

  const l = parseObjectArrayDetailed('{"list":[{"a":1},{"a":2}]}')
  ok('{list:[…]} 取内部数组 ⇒ valid', l.outcome === 'valid' && l.data.length === 2)
}

// ---------- 修复（repaired）----------
{
  // 顿号场景：原 parseObjectArray 靠截断回退救回前 1 条 —— detailed 必须同路径，
  // 只把「走了截断兜底、丢了尾部」显式化（不新增更宽松路径，见实现注释）
  const p = parseObjectArrayDetailed('[{"a":1}、{"a":2}]')
  ok('顿号场景 ⇒ repaired（截断回退路径）', p.outcome === 'repaired')
  ok('顿号场景救回前 1 条（与原函数一致）', p.data.length === 1)
  ok('顿号场景带 truncated 诊断', p.diagnostics.some(d => d.code === 'truncated'))
  ok('顿号场景标记 truncated', p.truncated === true)

  const t = parseObjectArrayDetailed('[{"a":1},{"a":2},{"a":3')
  ok('截断 JSON ⇒ repaired', t.outcome === 'repaired')
  ok('截断保住前 N-1 条', t.data.length >= 2)
  ok('截断标记 truncated', t.truncated === true)
  const td = t.diagnostics.find(d => d.code === 'truncated')
  ok('截断诊断带 droppedIndex', !!td && td.droppedIndex === t.data.length)

  const all = parseObjectArrayDetailed('["a","b"]')
  ok('元素全非对象 ⇒ repaired 空结果', all.outcome === 'repaired' && all.data.length === 0)
  ok('元素全非对象带 type-error', all.diagnostics.some(d => d.code === 'type-error'))

  const mixed = parseObjectArrayDetailed('[{"a":1},"x",{"a":2}]')
  ok('混入非对象 ⇒ repaired', mixed.outcome === 'repaired')
  ok('混入非对象只保留对象条目', mixed.data.length === 2)
  ok('混入非对象带 type-error 诊断', mixed.diagnostics.some(d => d.code === 'type-error'))
}

// ---------- 失败（invalid）----------
{
  const n = parseObjectArrayDetailed('模型不想回答，随便写了点话')
  ok('纯文本 ⇒ invalid', n.outcome === 'invalid')
  ok('invalid 数据为空', n.data.length === 0)
  ok('invalid 带 unrecoverable 诊断', n.diagnostics.some(d => d.code === 'unrecoverable'))

  const broken = parseObjectArrayDetailed('[{"a":')
  ok('残缺且救不回来 ⇒ invalid', broken.outcome === 'invalid')

  const empty = parseObjectArrayDetailed('[]')
  const failed = parseObjectArrayDetailed('不是 JSON')
  ok('负向控制：合法空与失败的 outcome 必须不同', empty.outcome !== failed.outcome)
  ok('负向控制：两者 data 都为空但语义不同', empty.data.length === 0 && failed.data.length === 0)
}

// ---------- parsePlainObjectDetailed ----------
{
  const v = parsePlainObjectDetailed('{"a":1}')
  ok('对象正常 ⇒ valid', v.outcome === 'valid' && (v.data as { a?: number }).a === 1)

  const wrapped = parsePlainObjectDetailed('[{"a":1}]')
  ok('数组包裹首元素 ⇒ valid', wrapped.outcome === 'valid')

  const t = parsePlainObjectDetailed('{"a":1,"b":')
  ok('截断对象 ⇒ repaired', t.outcome === 'repaired' && t.truncated === true)

  const bad = parsePlainObjectDetailed('没有 JSON')
  ok('纯文本 ⇒ invalid 空对象', bad.outcome === 'invalid' && Object.keys(bad.data).length === 0)
}

// ---------- 兼容包装行为不变（回归防线）----------
{
  // parseObjectArrayDetailed 与 parseObjectArray 必须逐字一致（同容错边界）
  const cases = [
    '[]', '[{"a":1},{"a":2}]', '{"a":1}', '{"list":[]}',
    '[{"a":1}、{"a":2}]', '[{"a":1},{"a":2},{"a":3', '["a","b"]', '不是 JSON',
    '```json\n[{"a":1}]\n```', '[{"a":1},"x",{"a":2}]',
  ]
  let allSame = true
  for (const raw of cases) {
    const legacy = JSON.stringify(parseObjectArray(raw))
    const detailed = JSON.stringify(parseObjectArrayDetailed(raw).data)
    if (legacy !== detailed) { allSame = false; console.log(`  MISMATCH: ${raw.slice(0, 30)} legacy=${legacy} detailed=${detailed}`) }
  }
  ok('parseObjectArray 与 detailed.data 十个用例逐字一致', allSame)

  // parsePlainObjectDetailed 对齐 parseLooseObject（生成型入口的宽松口径）。
  // 注意 null ⇔ invalid 的语义对齐：loose 用 null 表示失败，TaskResult 类型上
  // 不能给 null（会破坏 T），故 invalid 时 data={} 且 outcome='invalid' 为主判据。
  const objCases = ['{"a":1}', '[{"a":1}]', '{"a":1,"b":', '没有 JSON', '{"a":1}、{"b":2}', '{"list":[{"x":1}]}']
  let objSame = true
  for (const raw of objCases) {
    const loose = parseLooseObject(raw)
    const d = parsePlainObjectDetailed(raw)
    if (loose === null) {
      if (d.outcome !== 'invalid') { objSame = false; console.log(`  MISMATCH: ${raw.slice(0, 30)} loose=null but outcome=${d.outcome}`) }
    } else if (JSON.stringify(loose) !== JSON.stringify(d.data)) {
      objSame = false; console.log(`  MISMATCH: ${raw.slice(0, 30)} loose=${JSON.stringify(loose)} detailed=${JSON.stringify(d.data)}`)
    }
  }
  ok('parsePlainObjectDetailed 与 parseLooseObject 语义对齐（null ⇔ invalid）', objSame)
}

console.log(`\naiParseDetailed: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
