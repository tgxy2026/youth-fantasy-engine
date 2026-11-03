/**
 * 「作者自定义系统提示词」注入 · 单测（2026-10-06 新增）
 *
 * 钉住两件事：
 *   1. `composeSystemPrompt` 的**既有语义**——作者没填时行为完全不变（老库升级上来不能有任何差异）；
 *   2. `injectUserSystemPrompt`（`chat()` 的兜底）四条分支，尤其**不重复注入**那条：
 *      显式拼过的链路若被拼第二遍，同一段话在 system 里出现两次 —— 既白烧额度，
 *      又会让模型误以为「作者在特别强调这条」，把作者的一句提醒放大成硬约束。
 *
 * 另有一条「标记必须真的写在输出里」的断言：兜底靠 `USER_SYSTEM_MARK` 判断「拼过没有」，
 * 哪天有人改了拼接文案却忘了同步常量，去重判断就会**静默失效**（后果就是上面那种重复注入）。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  composeSystemPrompt, injectUserSystemPrompt, USER_SYSTEM_MARK,
  type AIProvider, type ChatMessage,
} from '../src/lib/aiCore/core'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 造一个只关心 systemPrompt 的 provider */
const prov = (systemPrompt?: string): AIProvider => ({
  id: 'p1', name: '测试模型', type: 'ollama',
  baseUrl: 'http://localhost:11434', apiKey: '', model: 'test:latest',
  ...(systemPrompt === undefined ? {} : { systemPrompt }),
})

const sys = (content: string): ChatMessage => ({ role: 'system', content })
const usr = (content: string): ChatMessage => ({ role: 'user', content })

function main() {
  // ================= 一、composeSystemPrompt =================
  {
    ok('1a 没给 provider → 原样返回功能提示词', composeSystemPrompt('功能提示') === '功能提示')
    ok('1b provider 没填自定义 → 原样返回', composeSystemPrompt('功能提示', prov()) === '功能提示')
    ok('1c 自定义只有空白 → 视同没填（trim 后为空）', composeSystemPrompt('功能提示', prov('   \n  ')) === '功能提示')
    ok('1d 功能提示为空字符串 → 也返回空', composeSystemPrompt('', prov()) === '')

    const out = composeSystemPrompt('功能提示', prov('用第一人称'))
    ok('1e 两者都有 → 功能提示在前、自定义在后', out.startsWith('功能提示') && out.endsWith('用第一人称'))
    ok('1f 自定义内容带前后空白 → 被 trim 掉', composeSystemPrompt('F', prov('  用第一人称  ')).endsWith('用第一人称'))

    // 🔴 兜底去重完全依赖这个标记出现在输出里
    ok('1g 🔴 输出里必须含注入标记（去重判断靠它）', out.includes(USER_SYSTEM_MARK))
    // base 为空时不该留下前导空白块（会变成 system 开头的两个空行）
    const onlyCustom = composeSystemPrompt('', prov('用第一人称'))
    ok('1h 功能提示为空时 → 不产生前导空行', onlyCustom.startsWith(USER_SYSTEM_MARK), JSON.stringify(onlyCustom.slice(0, 6)))
  }

  // ================= 二、injectUserSystemPrompt =================
  {
    const original: ChatMessage[] = [sys('功能提示'), usr('干活')]

    // 2a 没填 → 连数组都不复制（零开销：这条路径是最热的）
    const untouched: ChatMessage[] = [sys('功能提示'), usr('干活')]
    ok('2a provider 没填 → 原样返回同一个数组引用（零复制）',
      injectUserSystemPrompt(untouched, prov()) === untouched)
    ok('2a-2 连 provider 都没有 → 同样原样返回',
      injectUserSystemPrompt(untouched, null) === untouched)

    // 2b 有 system 但没拼过 → 追加到该条尾部
    const r2 = injectUserSystemPrompt(original, prov('用第一人称'))
    ok('2b 有 system 且未拼过 → 追加到它后面', r2.length === 2 && r2[0].content.includes('用第一人称'))
    ok('2b-2 追加后功能提示仍在前、自定义在后',
      r2[0].content.indexOf('功能提示') < r2[0].content.indexOf('用第一人称'))
    ok('2b-3 🔴 不修改入参数组（调用方可能复用）',
      original[0].content === '功能提示' && original.length === 2)
    ok('2b-4 user 消息原样保留', r2[1].role === 'user' && r2[1].content === '干活')

    // 2c 已经拼过（带标记）→ 绝不拼第二遍
    const already: ChatMessage[] = [sys(composeSystemPrompt('功能提示', prov('用第一人称'))), usr('干活')]
    const r3 = injectUserSystemPrompt(already, prov('用第一人称'))
    ok('2c 🔴 已拼过的链路 → 原样返回，不重复注入', r3 === already)
    ok('2c-2 重复调用也稳定（幂等）', injectUserSystemPrompt(r3, prov('用第一人称')) === r3)

    // 2d 一条 system 都没有 → 在最前面补一条（不能被降级成 user）
    const noSys: ChatMessage[] = [usr('干活')]
    const r4 = injectUserSystemPrompt(noSys, prov('用第一人称'))
    ok('2d 没有 system → 在最前面补一条', r4.length === 2 && r4[0].role === 'system')
    ok('2d-2 补进去的带标记与内容', r4[0].content.includes(USER_SYSTEM_MARK) && r4[0].content.includes('用第一人称'))
    ok('2d-3 🔴 作者提示词仍处于最高指令层（system），没被降级成 user', r4[0].role === 'system')
    ok('2d-4 原 user 消息顺序不变', r4[1] === noSys[0])

    // 2e 多条 system → 只拼第一条（功能主提示词通常在最前）
    const twoSys: ChatMessage[] = [sys('主提示'), sys('副提示'), usr('干活')]
    const r5 = injectUserSystemPrompt(twoSys, prov('用第一人称'))
    ok('2e 多条 system → 只拼第一条', r5[0].content.includes('用第一人称') && r5[1].content === '副提示')
    ok('2e-2 数组长度不变（不新增消息）', r5.length === 3)
  }

  // ================= 三、与「覆盖面」相关的契约 =================
  {
    // 这两条是「所有 AI 功能都接上」这个承诺的**文本支点**：
    // 兜底必须真的在 chat() 里被调用，光实现函数不接线等于没有（详见 structureGates ⑩）。
    const p = path.join(process.cwd(), 'src', 'lib', 'aiCore', 'chat.ts')
    const src = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
    ok('3a 🔴 chat() 里真的调用了兜底注入（函数存在 ≠ 接线）',
      src.includes('injectUserSystemPrompt(messages'), src ? '' : '（读不到 chat.ts）')
    ok('3b chat() 提供了 skipUserSystem 逃生口',
      src.includes('skipUserSystem'))
  }

  console.log(`\nuserSystemPrompt: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
