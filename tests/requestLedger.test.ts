// 3.2.0 · WQ6 批次/步骤请求预算 · 单测
//
// 盯三件事（方案 §16.7 第 856 行）：
//   ① 预算只增不减、到上限判 exhausted（**暂停**而不是继续硬打）；
//   ② 补字/压缩循环**真的**在预算耗尽时一次都不发（不是"发了才发现超了"）；
//   ③ 不传预算 ⇒ 行为与改造前逐字一致（默认不改变任何老路径）。
import http from 'node:http'
import { readFileSync } from 'node:fs'
import {
  createAttemptBudget, AIRequestBudgetExhaustedError, isRequestBudgetExhausted,
  CHAPTER_ATTEMPT_BUDGET, MAX_REQUESTS_PER_LOGICAL_CALL,
  REWRITE_ATTEMPT_BUDGET, ONE_SHOT_ATTEMPT_BUDGET,
} from '@/lib/ai/requestLedger'
import { enforceWordRange } from '@/lib/editor/wordRange'
import { aiRewriteChapter } from '@/lib/ai/aiTasks'
import { extractAndCommitSettings } from '@/lib/outline/autoContinue'
import { saveActiveId, saveProviders, type AIProvider } from '../src/lib/ai'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

let hits = 0
/** 每次补写返回 40 个汉字的增量（≥30 才算有效增量，否则循环会立刻 break） */
const FILL = '他抬头看了一眼天色，把外袍的领口拢紧，继续往前走了几步。'.repeat(2)

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    hits++
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) } catch { /* 忽略 */ }
    if (body.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: FILL } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: FILL }, finish_reason: 'stop' }] }))
  })
})

/** 🔴 必须用**真 provider**：baseUrl 留空会连不上，`askSoft` 把它吞成空串 ——
//    测试就会"绿得毫无意义"（补写没生效 ≠ 预算生效）。 */
let CFG: () => never = () => { throw new Error('CFG 未初始化') }

async function main() {
  // ---------- 一、纯函数口径 ----------
  {
    const b = createAttemptBudget({ label: '第 3 章', max: 10, estimatedRange: [4, 8] })
    ok('① 初始未耗尽', !b.exhausted && b.used === 0 && b.remaining === 10)
    ok('① 消费一次仍有余量', b.consume(1) === true && b.used === 1 && b.remaining === 9)
    ok('① 一次消费 9 次正好用满 ⇒ 返回 true（未超）', b.consume(9) === true && b.used === 10)
    ok('① 用满即判耗尽（>= 而不是 >）', b.exhausted === true && b.remaining === 0)
    ok('① 超预算仍如实累计（不截断、不掩盖）', b.consume(3) === false && b.used === 13)

    const d = b.describe()
    ok('① 人话里同时给出「预计范围」与「实际上限」',
      /第 3 章/.test(d) && /预计 4~8/.test(d) && /已用 13/.test(d) && /上限 10/.test(d), d)
    const fresh = createAttemptBudget({ label: '第 1 章', max: CHAPTER_ATTEMPT_BUDGET }).describe()
    ok('① 未耗尽时也报上限（作者事前能看到量级）', /上限/.test(fresh) && /40/.test(fresh), fresh)
    ok('① 实际请求上限＝逻辑调用上限 × 每次调用上限',
      fresh.includes(String(CHAPTER_ATTEMPT_BUDGET * MAX_REQUESTS_PER_LOGICAL_CALL)), fresh)

    ok('① max 非正数被夹到 1（不许出现"零预算"把一切掐死）',
      createAttemptBudget({ label: 'x', max: 0 }).max === 1)
    ok('① consume(0) 不改变状态', (() => {
      const c = createAttemptBudget({ label: 'x', max: 5 })
      c.consume(0)
      return c.used === 0
    })())
    ok('① 改写步骤预算＝6（主改写 1 + 补写 2 + 压缩 2 + 设定整理 1）',
      REWRITE_ATTEMPT_BUDGET === 6, String(REWRITE_ATTEMPT_BUDGET))
    ok('① 一次性入口预算＝3（抽取 1 + 变化检测 1 + 降级余量）',
      ONE_SHOT_ATTEMPT_BUDGET === 3, String(ONE_SHOT_ATTEMPT_BUDGET))
  }

  // ---------- 二、并行任务各记各的（绝不能是单例） ----------
  {
    const a = createAttemptBudget({ label: 'A', max: 5 })
    const b = createAttemptBudget({ label: 'B', max: 5 })
    a.consume(5)
    ok('② 一个任务耗尽不影响另一个（并行不互相掐停）', a.exhausted && !b.exhausted)
    ok('② 快照是值拷贝（后续消费不改已取出的快照）', (() => {
      const snap = b.snapshot()
      b.consume(1)
      return snap.used === 0 && b.used === 1
    })())
  }

  // ---------- 三、错误类型可区分 ----------
  {
    const b = createAttemptBudget({ label: '第 9 章', max: 2 })
    b.consume(2)
    const e = new AIRequestBudgetExhaustedError(b.snapshot())
    ok('③ 耗尽错误自带快照、名字可判', e.name === 'AIRequestBudgetExhaustedError'
      && e.snapshot.used === 2 && e.snapshot.label === '第 9 章')
    ok('③ 与普通错误区分得开（重试策略不同）',
      isRequestBudgetExhausted(e) && !isRequestBudgetExhausted(new Error('boom')))
    ok('③ 提示里说清"已暂停"与手动再试', /暂停/.test(e.message) && /手动/.test(e.message), e.message)
  }

  // ---------- 四、补字循环真的被拦住 ----------
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const provider: AIProvider = {
    id: 'p1', name: '假端点', type: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'fake-model', local: false,
  }
  await saveProviders([provider])
  await saveActiveId('p1')
  CFG = () => provider as never

  const BODY = '他站在城门口，看着远处的烽火。'.repeat(10) // 约 160 汉字，远短于目标
  const runOnce = async (budget?: ReturnType<typeof createAttemptBudget>) => {
    hits = 0
    const logs: string[] = []
    await enforceWordRange({
      cfg: CFG(), body: BODY, target: 4000,
      maxExpand: 2, maxShrink: 0,
      ...(budget ? { budget } : {}),
      onLog: m => logs.push(m),
    })
    return { hits, logs }
  }

  {
    const adequate = createAttemptBudget({ label: '第 1 章', max: 10 })
    const r1 = await runOnce(adequate)
    ok('④ 预算充足：补写两轮照常发出（行为与改造前一致）', r1.hits === 2, String(r1.hits))
    ok('④ 消费数与实际调用数一致（不漏记）', adequate.used === 2, String(adequate.used))
  }

  {
    const exhausted = createAttemptBudget({ label: '第 2 章', max: 1 })
    exhausted.consume(1)
    const r2 = await runOnce(exhausted)
    ok('🔴 ④ 预算已耗尽 ⇒ 一轮都不发（不是发完才发现超了）', r2.hits === 0, String(r2.hits))
    ok('④ 如实说明为什么停（含已用/上限/当前字数）',
      r2.logs.some(m => /上限/.test(m) && /1\/1/.test(m)), r2.logs.join(' | '))
  }

  {
    const tight = createAttemptBudget({ label: '第 3 章', max: 1 })
    const r3 = await runOnce(tight)
    ok('④ 只剩一次预算 ⇒ 只发一轮就停（不嵌套追加）', r3.hits === 1, String(r3.hits))
    ok('④ 停下时说明已达上限', r3.logs.some(m => /已达上限/.test(m)), r3.logs.join(' | '))
  }

  {
    const r4 = await runOnce()
    ok('🔴 ④ 不传预算 ⇒ 行为逐字不变（老调用零影响）', r4.hits === 2, String(r4.hits))
  }

  // ---------- 五、整章改写：预算耗尽时一个请求都不发 ----------
  {
    const exhausted = createAttemptBudget({ label: '第 5 章改写', max: 1 })
    exhausted.consume(1)
    hits = 0
    let caught: unknown
    try {
      await aiRewriteChapter({
        title: '第五章', body: BODY, action: 'polish', requirement: '', isLatest: false,
        budget: exhausted,
      })
    } catch (e) { caught = e }
    ok('🔴 ⑤ 改写预算已耗尽 ⇒ 直接暂停，不发请求',
      isRequestBudgetExhausted(caught) && hits === 0, `hits=${hits} err=${String(caught)}`)
  }

  {
    const b = createAttemptBudget({ label: '第 6 章改写', max: REWRITE_ATTEMPT_BUDGET })
    hits = 0
    const out = await aiRewriteChapter({
      title: '第六章', body: BODY, action: 'polish', requirement: '', isLatest: false, budget: b,
    })
    ok('⑤ 主改写计入预算（一次逻辑调用 = 1）', b.used === 1 && hits === 1, `used=${b.used} hits=${hits}`)
    ok('⑤ 不传 targetWords 时不跑字数校准（只花这一次）', out.length > 0 && b.used === 1)
  }

  // ---------- 六、一次性入口（设定整理）到上限就跳过 ----------
  {
    const b = createAttemptBudget({ label: '设定同步', max: ONE_SHOT_ATTEMPT_BUDGET })
    b.consume(ONE_SHOT_ATTEMPT_BUDGET)
    hits = 0
    const r = await extractAndCommitSettings('他推门走了出去。', '第七章', 'add-only', undefined, undefined, undefined, b)
    ok('🔴 ⑥ 设定整理预算耗尽 ⇒ 一条请求都不发、如实说明已跳过',
      hits === 0 && r.created === 0 && /已达上限/.test(r.errors?.join('') ?? ''),
      `hits=${hits} errors=${r.errors?.join('|') ?? ''}`)
  }

  // ---------- 七、接线（真源里确实建了各自的预算） ----------
  {
    const rewriteSrc = readFileSync('src/lib/aiTasks/rewrite.ts', 'utf8')
    const ticketSrc = readFileSync('src/lib/app/optimizeTicket.ts', 'utf8')
    const creativeSrc = readFileSync('src/lib/creative/creativeSession.ts', 'utf8')
    const autoSrc = readFileSync('src/lib/outline/autoContinue.ts', 'utf8')
    const panelSrc = readFileSync('src/components/tools/OptimizeTicketPanel.tsx', 'utf8')

    ok('⑦ 改写入口：预算耗尽先抛（发请求之前）',
      /if \(o\.budget\?\.exhausted\) throw new AIRequestBudgetExhaustedError/.test(rewriteSrc))
    ok('⑦ 改写入口：字数校准（补写/压缩）共用同一份预算',
      (rewriteSrc.match(/\.\.\.\(o\.budget \? \{ budget: o\.budget \} : \{\}\)/g) ?? []).length === 2)

    ok('⑦ 工单改写：每章一份预算（不是全局单例）',
      /createAttemptBudget\(\{ label: `第 \$\{hit\.no\} 章改写`, max: REWRITE_ATTEMPT_BUDGET \}\)/.test(ticketSrc))
    ok('⑦ 工单改写：预算快照回传界面', /budget: budget\.snapshot\(\)/.test(ticketSrc))
    ok('⑦ 工单改写：设定整理从本章预算扣',
      /extractAndCommitSettings\(text, hit\.chapter\.title, 'add-only', undefined, opts\.signal, request, budget\)/.test(ticketSrc))
    ok('⑦ 工单面板：显示已用/上限（不是只报一个模糊数）',
      /调用 \{b\.used\}\/\{b\.max\}/.test(panelSrc) && /MAX_REQUESTS_PER_LOGICAL_CALL/.test(panelSrc))

    ok('⑦ 手动改写入口：各自一份改写预算 + 一次性设定同步预算',
      /max: REWRITE_ATTEMPT_BUDGET/.test(creativeSrc)
      && /label: '设定同步', max: ONE_SHOT_ATTEMPT_BUDGET/.test(creativeSrc))
    ok('⑦ 连写侧：设定整理改为按实际调用逐次记账',
      /cb\.signal, cb\.request, budget\)/.test(autoSrc)
      && /budget\?\.consume\(1\)[\s\S]{0,120}aiExtractSettingEntitiesWithStatus/.test(autoSrc))
  }

  console.log(`\n———— requestLedger：${pass} 通过 / ${fail} 失败 ————`)
  server.close()
  if (fail > 0) process.exit(1)
}

main()
