// 3.2.0 · WQ7 酒馆归属 · 单测
//
// 盯两件事：
//   ① 酒馆的模型调用**如实标 `scope:'independent'`** —— 它没有父任务，
//      不该被算到「当时恰好唯一在跑的任务」账上（统计与重试次数都会虚高）；
//   ② 包装**只动 `request`**：signal / onToken / 温度 / 输出协议一律原样透传 ——
//      酒馆红线（`docs/归档/酒馆模式/酒馆模式-工程红线.md` §18.4 / §18.10）对
//      注入层序、预算、输出协议另有硬约束，改归属不能顺手改别的。
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { withIndependentAttribution, TAVERN_INDEPENDENT_REQUEST } from '@/lib/tavern/attribution'
import type { ChatFn } from '@/lib/tavern/provider'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  // ---------- 一、注入行为 ----------
  {
    const calls: unknown[][] = []
    const fake = (async (...args: unknown[]) => {
      calls.push(args)
      return '回复正文'
    }) as unknown as ChatFn
    const wrapped = withIndependentAttribution(fake)

    const out = await wrapped({ id: 'p' } as never, [{ role: 'user', content: 'hi' }] as never, {
      temperature: 0.9,
      signal: undefined,
      onToken: () => {},
    } as never)

    ok('① 返回值原样透传（包装不吞内容）', out === '回复正文', String(out))
    ok('① 只调用了一次（没有偷偷重试）', calls.length === 1, String(calls.length))
    const opts = calls[0][2] as Record<string, unknown>
    ok('🔴 ① 没有 request 时补 scope=independent', (opts.request as { scope?: string })?.scope === 'independent',
      JSON.stringify(opts.request))
    ok('① 其他选项一个不丢（温度 / onToken）',
      opts.temperature === 0.9 && typeof opts.onToken === 'function', JSON.stringify(Object.keys(opts)))
    ok('① 没给 opts 也能安全补（调用点有省略第三参的写法）', await (async () => {
      const c2: unknown[][] = []
      const f2 = (async (...a: unknown[]) => { c2.push(a); return 'x' }) as unknown as ChatFn
      const r = await withIndependentAttribution(f2)({} as never, [] as never)
      return r === 'x' && (c2[0][2] as { request?: { scope?: string } })?.request?.scope === 'independent'
    })())
  }

  {
    const calls: unknown[][] = []
    const fake = (async (...args: unknown[]) => { calls.push(args); return 'ok' }) as unknown as ChatFn
    await withIndependentAttribution(fake)({} as never, [] as never, {
      request: { scope: 'project', taskId: 'job-9' },
    } as never)
    const req = (calls[0][2] as { request?: { taskId?: string } }).request
    ok('① 调用方显式给了归属 ⇒ 原样尊重（不硬改成 independent）', req?.taskId === 'job-9', JSON.stringify(req))
  }

  // ---------- 二、覆盖度：所有酒馆注入点都套上 ----------
  {
    const dir = 'src/lib/tavern'
    const files = readdirSync(path.resolve(dir)).filter(f => f.endsWith('.ts'))
    const unwrapped: string[] = []
    let sites = 0
    for (const f of files) {
      const src = readFileSync(path.resolve(dir, f), 'utf8')
      for (const line of src.split('\n')) {
        if (!/^\s*const runChat = /.test(line)) continue
        sites++
        if (!line.includes('withIndependentAttribution(')) unwrapped.push(`${f}: ${line.trim()}`)
      }
    }
    ok('🔴 ② 每个注入点都套了归属包装（漏一个就有一整条链串账）',
      unwrapped.length === 0, unwrapped.join(' | '))
    ok(`② 覆盖 16 处注入点（实测 ${sites}）`, sites === 16, String(sites))
    ok('② 包装只有一个真源（各文件都从 attribution 导入）',
      files.filter(f => f !== 'attribution.ts'
        && readFileSync(path.resolve(dir, f), 'utf8').includes('const runChat = '))
        .every(f => readFileSync(path.resolve(dir, f), 'utf8').includes("from '@/lib/tavern/attribution'")))
  }

  // ---------- 三、只动 request（红线：不许顺手改别的） ----------
  {
    const src = readFileSync('src/lib/tavern/attribution.ts', 'utf8')
    // 只有  这一行是**赋值**（其余 \ 都在注释里）
    ok('③ 包装里只有一处 request 赋值（其余选项原样透传）', (src.match(/request:/g) ?? []).length === 1,
      String((src.match(/request:/g) ?? []).length))
    ok('🔴 ③ 不碰提示词 / 预算 / 层序（那三样在红线里另有约束）',
      !/systemPrompt|inject|historyBudget|contextBudget|numCtx/.test(src))
    ok('③ 常量是 readonly（不会被调用方改掉）', /as const/.test(src) && TAVERN_INDEPENDENT_REQUEST.scope === 'independent')
  }

  console.log(`\n———— tavernAttribution：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
