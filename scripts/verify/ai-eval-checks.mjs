/**
 * AI 评估断言库（3.6.2 · W5）—— 纯函数，无 IO、无网络。
 *
 * 【为什么单独成文件】它要同时被两处用：
 *   ① `scripts/verify/ai-eval.mjs`（跑夹具）；
 *   ② `tests/aiEval.test.ts`（用**坏响应**验证"断言真的会失败"）。
 * 第 ② 点是关键：如果断言永远返回 ok，那"评估全过"只是自欺。
 * 所以这里必须能被单测直接喂假数据。
 *
 * 判据只针对**可判定的东西**（格式 / 范围 / 诚实），不碰文笔。
 */

/** 去掉 ```json 围栏与前后寒暄，尽量把 JSON 抠出来（宽容解析，不等于纵容） */
export function stripFences(text) {
  let s = String(text ?? '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first >= 0 && last > first) s = s.slice(first, last + 1)
  return s
}

export function tryParseJson(text) {
  try { return JSON.parse(stripFences(text)) } catch { return null }
}

/** 句子数：按中英文句末标点切 */
export function countSentences(text) {
  return String(text ?? '')
    .split(/[。！？!?]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .length
}

/** 模型"承认不确定"的常见说法（判"没编"用） */
export const UNCERTAINTY_MARKS = ['没有提到', '无法判断', '信息不足', '未提及', '不知道', '无法确定']

/**
 * 执行一条断言。返回 `{ ok, detail }`。
 * 🔴 失败必须给**人能读懂的理由**：这张表的用途是"改完提示词后知道改坏了什么"。
 */
export function runCheck(check, text) {
  const raw = String(text ?? '')
  switch (check.kind) {
    case 'json-valid': {
      const parsed = tryParseJson(raw)
      return parsed && typeof parsed === 'object'
        ? { ok: true, detail: '可解析' }
        : { ok: false, detail: '不是合法 JSON（下游会 parse 失败）' }
    }
    case 'has-fields': {
      const parsed = tryParseJson(raw)
      if (!parsed || typeof parsed !== 'object') return { ok: false, detail: '无法解析，字段无从检查' }
      const missing = check.fields.filter(f => !(f in parsed))
      return missing.length === 0
        ? { ok: true, detail: `字段齐（${check.fields.join('/')}）` }
        : { ok: false, detail: `缺字段：${missing.join('、')}` }
    }
    case 'array-not-empty': {
      const parsed = tryParseJson(raw)
      const v = parsed && typeof parsed === 'object' ? parsed[check.field] : null
      return Array.isArray(v) && v.length > 0
        ? { ok: true, detail: `${check.field} 有 ${v.length} 项` }
        : { ok: false, detail: `${check.field} 不是非空数组` }
    }
    case 'max-chars': {
      const parsed = tryParseJson(raw)
      const v = parsed && typeof parsed === 'object' ? parsed[check.field] : null
      const n = typeof v === 'string' ? v.length : null
      if (n === null) return { ok: false, detail: `${check.field} 不是字符串` }
      return n <= check.limit
        ? { ok: true, detail: `${n} 字（上限 ${check.limit}）` }
        : { ok: false, detail: `${n} 字，超过上限 ${check.limit}` }
    }
    case 'not-contains': {
      const hit = check.any.filter(w => raw.includes(w))
      return hit.length === 0
        ? { ok: true, detail: '没有越界表述' }
        : { ok: false, detail: `出现越界表述：${hit.join('、')}` }
    }
    case 'no-unknown-chapter': {
      const nums = [...raw.matchAll(/第\s*(\d+)\s*章/g)].map(m => Number(m[1]))
      const bad = nums.filter(n => n > (check.knownChapter ?? 0))
      return bad.length === 0
        ? { ok: true, detail: nums.length ? `引用章号 ${[...new Set(nums)].join('、')}` : '未引用章号' }
        : { ok: false, detail: `引用了材料里没有的章号：${[...new Set(bad)].join('、')}` }
    }
    case 'max-sentences': {
      const n = countSentences(raw)
      return n <= check.limit
        ? { ok: true, detail: `${n} 句（上限 ${check.limit}）` }
        : { ok: false, detail: `${n} 句，超过上限 ${check.limit}` }
    }
    case 'admits-uncertainty': {
      const hit = (check.any ?? UNCERTAINTY_MARKS).filter(w => raw.includes(w))
      return hit.length > 0
        ? { ok: true, detail: `承认了不确定（「${hit[0]}」）` }
        : { ok: false, detail: '没有承认信息不足 —— 很可能在编' }
    }
    case 'no-fabricated-name': {
      // 承认了不确定就不能因为出现人名判失败（那可能是在解释规则）
      const admitted = UNCERTAINTY_MARKS.some(w => raw.includes(w))
      if (admitted) return { ok: true, detail: '已承认不确定，未判编造' }
      const m = raw.match(/(?:名叫|叫做|叫)\s*[「“"']?([\u4e00-\u9fa5]{1,4})[」”"']?/)
      return m
        ? { ok: false, detail: `未承认不确定却给出了名字：${m[1]}` }
        : { ok: false, detail: '未承认不确定（且未给出名字，仍属答非所问）' }
    }
    default:
      return { ok: false, detail: `未知断言类型：${check.kind}` }
  }
}

/** 跑一个场景的全部断言；返回逐项结果与"是否有失败" */
export function runScenarioChecks(checks, text) {
  const results = (checks ?? []).map(c => ({ check: c, ...runCheck(c, text) }))
  return { results, failed: results.filter(r => !r.ok) }
}
