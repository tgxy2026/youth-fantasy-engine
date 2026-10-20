// 3.2.0 · W3 种子：候选引用生产者 · 单测
//
// 背景：`AiRun.candidates` 从 3.0 就存在，但**一直没有生产者** —— 「创作轨迹」里的
// 候选条数恒为 0，这块界面从来没说过真话。本测试钉住新生产者的口径：
//   ① 同一落点 + 同一指纹重复上报 ⇒ 只更新状态，不重复计数（否则界面会虚报"N 条候选"）；
//   ② 同一落点但指纹变了 ⇒ 视为新一稿，追加（作者看得出改过几稿）；
//   ③ 任务已收尾 / 没有 taskId ⇒ 静默忽略，绝不打断创作；
//   ④ 只存引用（落点/条数/指纹/状态），**不存正文**。
import { __resetMockStores } from './mock-memory'
import { createRun, finishRun, noteCandidate } from '../src/lib/ai/aiRunLedger'
import { getAiRun } from '../src/lib/db'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'w3-seed'

async function main() {
  // ---------- 一、基本口径 ----------
  __resetMockStores()
  {
    const run = await createRun({ projectId: PID, kind: 'continue', title: '续写', basis: { at: 1 } })
    noteCandidate(run.id, { target: 'chapter:c1', fingerprint: 'fp-a', state: 'pending' })
    noteCandidate(run.id, { target: 'chapter:c1', fingerprint: 'fp-a', state: 'adopted' })
    await finishRun(run.id, { status: 'done' })

    const r = await getAiRun(run.id)
    ok('① 同一落点同一指纹只算一条（状态被更新）',
      r?.candidates.length === 1 && r.candidates[0].state === 'adopted',
      JSON.stringify(r?.candidates))
    ok('① 引用里没有正文字段（只有落点/条数/指纹/状态）',
      Object.keys(r?.candidates[0] ?? {}).sort().join(',') === 'count,fingerprint,state,target',
      Object.keys(r?.candidates[0] ?? {}).join(','))
  }

  // ---------- 二、改稿 ⇒ 新一稿 ----------
  __resetMockStores()
  {
    const run = await createRun({ projectId: PID, kind: 'continue', title: '续写', basis: { at: 1 } })
    noteCandidate(run.id, { target: 'chapter:new', fingerprint: 'fp-1', state: 'discarded' })
    noteCandidate(run.id, { target: 'chapter:new', fingerprint: 'fp-2', state: 'discarded' })
    noteCandidate(run.id, { target: 'chapter:c9', fingerprint: 'fp-3', state: 'adopted' })
    await finishRun(run.id, { status: 'done' })

    const r = await getAiRun(run.id)
    ok('② 同一落点两稿 ⇒ 两条（看得出改过几次）',
      r?.candidates.filter(c => c.target === 'chapter:new').length === 2,
      JSON.stringify(r?.candidates))
    ok('② 不同落点各自独立', Boolean(r?.candidates.some(c => c.target === 'chapter:c9' && c.state === 'adopted')))
  }

  // ---------- 三、旁路安全 ----------
  __resetMockStores()
  {
    let threw = false
    try {
      noteCandidate(undefined, { target: 'chapter:x', fingerprint: 'f', state: 'adopted' })
      noteCandidate('run-不存在', { target: 'chapter:x', fingerprint: 'f', state: 'adopted' })
    } catch { threw = true }
    ok('③ 没有 taskId / 任务已收尾 ⇒ 静默忽略（不抛、不写脏数据）', !threw)

    const run = await createRun({ projectId: PID, kind: 'continue', title: 'x', basis: { at: 1 } })
    await finishRun(run.id, { status: 'done' })
    // 收尾之后再上报：应被忽略（槽位已摘）
    noteCandidate(run.id, { target: 'chapter:late', fingerprint: 'f', state: 'adopted' })
    const r = await getAiRun(run.id)
    ok('③ 收尾后的迟到上报不会写进账本', r?.candidates.length === 0, JSON.stringify(r?.candidates))
  }

  // ---------- 四、没有候选时不写空数组（老记录形态不变） ----------
  __resetMockStores()
  {
    const run = await createRun({ projectId: PID, kind: 'creative', title: 'y', basis: { at: 1 } })
    await finishRun(run.id, { status: 'done' })
    const r = await getAiRun(run.id)
    ok('④ 没有候选 ⇒ 不写 candidates 字段（与 3.1.x 记录一致）', r?.candidates.length === 0)
  }

  // ---------- 五、接线闸 ----------
  {
    const ac = readFileSync('src/lib/outline/autoContinue.ts', 'utf8')
    ok('⑤ 正文链在落库时上报「已采纳」', /noteCandidate\(cb\.request\?\.taskId, \{[\s\S]{0,120}state: 'adopted'/.test(ac))
    ok('⑤ 异常稿被丢弃时也留痕（作者能看出"生成了几稿"）',
      /state: 'discarded'/.test(ac))
    const cs = readFileSync('src/lib/creative/creativeSession.ts', 'utf8')
    ok('⑤ 设定闸门：勾选即采纳、一条没勾即丢弃',
      /target: 'settings:bible'/.test(cs) && /picked && picked\.length > 0 \? 'adopted' : 'discarded'/.test(cs))
    ok('⑤ 大纲闸门：采纳/否掉都留痕',
      /target: 'outline'/.test(cs) && /ok \? 'adopted' : 'discarded'/.test(cs))
    const rg = readFileSync('src/lib/ai/aiRunLedger.ts', 'utf8')
    ok('⑤ 账本提供唯一生产者入口（不再各处手搓 candidates 数组）',
      /export function noteCandidate\(/.test(rg))
  }

  console.log(`\n———— candidateRef：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
