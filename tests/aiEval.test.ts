// ============ AI 评估断言 · 单测（3.6.2 · W5）============
//
// 本文件最重要的部分不是"好响应能过"，而是**坏响应必须被抓**。
// 一条永远返回 ok 的断言，会让"评估全过"变成自欺 —— 这里逐个场景配一条坏响应做对照。
import fs from 'node:fs'
import path from 'node:path'
import {
  countSentences,
  runCheck,
  runScenarioChecks,
  stripFences,
  tryParseJson,
  type EvalCheck,
} from '../scripts/verify/ai-eval-checks.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const root = [process.cwd(), path.join(process.cwd(), '..')]
  .find(c => fs.existsSync(path.join(c, 'package.json'))) ?? ''
const fixturePath = path.join(root, 'tests/fixtures/ai-eval/scenarios.json')
const doc = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  scenarios: Array<{ id: string; checks: EvalCheck[]; recorded?: { status: string; response: string; model?: string } }>
}

// ---------- 1. 夹具自身完整 ----------
{
  ok('1a 夹具至少有 3 个场景', doc.scenarios.length >= 3, String(doc.scenarios.length))
  ok('1b 每个场景都有 id / checks / recorded',
    doc.scenarios.every(s => s.id && Array.isArray(s.checks) && s.checks.length > 0 && s.recorded))
  ok('1c 每个场景都带了录制响应（不是空壳）',
    doc.scenarios.every(s => (s.recorded?.response?.length ?? 0) > 10),
    doc.scenarios.map(s => `${s.id}:${s.recorded?.response?.length ?? 0}`).join(' '))
  ok('1d 录制里记了模型名（换模型对比时要知道基线是谁）',
    doc.scenarios.every(s => (s.recorded?.model ?? '').length > 0),
    doc.scenarios.map(s => s.recorded?.model).join(','))
}

// ---------- 2. 好响应全过（离线可复现） ----------
{
  for (const s of doc.scenarios) {
    const { failed } = runScenarioChecks(s.checks, s.recorded?.response ?? '')
    ok(`2·${s.id} 录制响应通过全部断言`, failed.length === 0,
      failed.map(f => `${f.check.kind}: ${f.detail}`).join('；'))
  }
}

// ---------- 3. 🔴 坏响应必须被抓（断言不能空转） ----------
{
  // 场景一：JSON 格式坏了（多一句寒暄 + 缺字段）
  const bad1 = '好的，这是摘要：\n{"summary":"林昭去追人了"}'
  const r1 = runScenarioChecks(doc.scenarios[0].checks, bad1)
  ok('🔴 3a JSON 缺字段会被抓（has-fields）',
    r1.failed.some(f => f.check.kind === 'has-fields'),
    r1.failed.map(f => f.check.kind).join(','))
  ok('3b 前后有寒暄仍能抠出 JSON（宽容解析，不算失败）',
    runCheck({ kind: 'json-valid' }, bad1).ok === true)

  // 场景二：越界 + 引用不存在的章号 + 超句数
  // 4 句：要求两句、容忍三句，第四句才真的越界（3 句正好卡在上限，不算失败）
  const bad2 = '纵观全书，这一章埋下了重要伏笔。第 7 章会揭示船夫的真实身份。沈砚最终抵达对岸。他回头望去，渡口已空无一人。'
  const r2 = runScenarioChecks(doc.scenarios[1].checks, bad2)
  ok('🔴 3c 把单章说成「全书」会被抓', r2.failed.some(f => f.check.kind === 'not-contains'),
    r2.failed.map(f => f.check.kind).join(','))
  ok('🔴 3d 引用材料里没有的第 7 章会被抓', r2.failed.some(f => f.check.kind === 'no-unknown-chapter'),
    r2.failed.map(f => f.check.kind + ':' + f.detail).join('；'))
  ok('3e 四句话超过「两句（容忍三句）」上限会被抓', r2.failed.some(f => f.check.kind === 'max-sentences'),
    r2.failed.map(f => f.check.kind).join(','))

  // 场景三：编造人名
  const bad3 = '他的母亲名叫柳氏，后来投河自尽了。'
  const r3 = runScenarioChecks(doc.scenarios[2].checks, bad3)
  ok('🔴 3f 没承认不确定就编名字会被抓', r3.failed.some(f => f.check.kind === 'no-fabricated-name'),
    r3.failed.map(f => `${f.check.kind}:${f.detail}`).join('；'))
  ok('🔴 3g 编造时也不会「承认不确定」', r3.failed.some(f => f.check.kind === 'admits-uncertainty'))
}

// ---------- 4. 单条断言的边界 ----------
{
  ok('4a stripFences 去掉 ```json 围栏',
    stripFences('```json\n{"a":1}\n```') === '{"a":1}', stripFences('```json\n{"a":1}\n```'))
  ok('4b 纯文本原样返回', stripFences('就是一句话') === '就是一句话')
  ok('4c 截断的 JSON → tryParseJson 返回 null',
    tryParseJson('{"a": [1,2') === null)

  ok('4d 句子数：中文句末', countSentences('一。二！三？') === 3)
  ok('4e 句子数：空串为 0', countSentences('') === 0)
  ok('4f 句子数：连续标点不产生空句', countSentences('一。。。二') === 2)

  ok('4g 章号边界：等于已给章号不算越界',
    runCheck({ kind: 'no-unknown-chapter', knownChapter: 3 }, '第 3 章写了…').ok === true)
  ok('4h 章号边界：大于已给章号算越界',
    runCheck({ kind: 'no-unknown-chapter', knownChapter: 3 }, '第 4 章写了…').ok === false)
  ok('4i 中文数字章号不误判为越界（只判阿拉伯数字）',
    runCheck({ kind: 'no-unknown-chapter', knownChapter: 3 }, '第三章写了…').ok === true)

  ok('4j 未知断言类型 → 判失败而不是静默通过',
    runCheck({ kind: 'no-such-check' }, '任意文本').ok === false)

  ok('4k max-chars 对非字符串字段判失败',
    runCheck({ kind: 'max-chars', field: 'summary', limit: 10 }, '{"summary":123}').ok === false)
  ok('4l array-not-empty 对空数组判失败',
    runCheck({ kind: 'array-not-empty', field: 'keyEvents' }, '{"keyEvents":[]}').ok === false)
}

// ---------- 5. 分数统计不会把「没跑」当「通过」 ----------
{
  const empty = runScenarioChecks([], '任意文本')
  ok('5a 没有断言时 failed 为空（上层据此报 SKIP 而不是 PASS）', empty.failed.length === 0 && empty.results.length === 0)
}

console.log(`\naiEval: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
