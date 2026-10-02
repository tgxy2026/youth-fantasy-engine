// 全量测试聚合器：node tests/run-all.mjs  （或 npm test）
//
// 为什么要这一层：
//   1. 测试用例散在多个 *.test.ts，逐个手敲 `node tests/build-test.mjs <名>` 既繁琐又容易漏跑；
//   2. roundtrip.test.ts 与 adversarial.test.ts 结尾是 process.exit()——它会**直接掐死当前进程**，
//      所以绝不能让它们同进程串跑，必须每个入口单开一个子进程，靠子进程退出码判断成败；
//   3. seed-schema-check.mjs 是独立回归闸（种子键 ↔ schema 列名对账），一并纳管。
//
// 约定：任一子进程非 0 退出 → 本脚本最终退出码为 1，可直接接进 CI / 提交前钩子。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const quiet = { ...process.env, YFE_TEST_QUIET: '1' }

/** 用 *.test.ts 的基名构建执行计划（build-test.mjs 需要不带扩展名的入口名） */
const entries = fs.readdirSync(here)
  .filter(f => f.endsWith('.test.ts'))
  .map(f => f.slice(0, -'.test.ts'.length))
  .sort()

/** 独立回归脚本（各自自带进程与退出码，不经 build-test.mjs） */
const standalone = ['seed-schema-check.mjs', 'feature-deps-check.mjs']
  .filter(f => fs.existsSync(path.join(here, f)))

const jobs = [
  ...entries.map(name => ({ label: name, file: 'build-test.mjs', args: [name] })),
  ...standalone.map(f => ({ label: f.replace(/\.mjs$/, ''), file: f, args: [] })),
]

if (jobs.length === 0) {
  console.error('未发现任何测试入口（tests/*.test.ts 或 tests/seed-schema-check.mjs）')
  process.exit(1)
}

const results = []
const t0 = Date.now()

for (const job of jobs) {
  process.stdout.write(`\n${'─'.repeat(64)}\n▶ ${job.label}\n${'─'.repeat(64)}\n`)
  const r = spawnSync(
    process.execPath,
    [path.join(here, job.file), ...job.args],
    { cwd: path.resolve(here, '..'), env: quiet, encoding: 'utf8' },
  )
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // esbuild 的打包横幅（"tests\.xxx.mjs  4.7kb" / "Done in 83ms"）在批量跑时纯属噪音，过滤掉。
  // 但只在「已知是横幅」时才过滤，避免吞掉真实报错。
  const lines = out.split(/\r?\n/).filter(l =>
    !/^\s*tests[\\/]\.[\w.-]+\.mjs\s+[\d.]+kb\s*$/.test(l) && !/^Done in \d+ms\s*$/.test(l),
  )
  const body = lines.join('\n').trim()
  if (body) console.log(body)

  /**
   * 🔴🔴 退出码判据（2026-10-02 修）：`r.status` 为 null 有两种原因 ——
   *   ① 被信号杀掉（`r.signal` 有值）⇒ 失败；
   *   ② **本机环境的 EBUSY 拦截**（`r.error.code === 'EBUSY'`）⇒ 子进程压根没起来，
   *      此时 `status` 与 `signal` **都是 null**，旧写法 `r.status ?? (r.signal ? 1 : 0)`
   *      会把它判成 **0 = 通过** —— 实测踩过：`worldSets` 明明 FAIL，汇总却报「132 通过、0 失败」。
   * ⇒ 现在只要 `status === null` 一律算失败，并打印原因，别让「没跑起来」冒充「跑过了」。
   */
  if (r.status === null) {
    const why = r.error?.code === 'EBUSY'
      ? 'EBUSY（子进程被本机拦截，没真跑起来）'
      : r.signal ? `被信号 ${r.signal} 终止` : `未知原因：${r.error?.message ?? '无 status 无 signal'}`
    console.log(`  ❌ 该入口没跑成功 —— ${why}`)
    results.push({ label: job.label, code: 1, signal: r.signal })
    continue
  }
  results.push({ label: job.label, code: r.status, signal: r.signal })
}

const failed = results.filter(r => r.code !== 0)
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

console.log(`\n${'═'.repeat(64)}`)
console.log(`测试汇总（${elapsed}s）`)
for (const r of results) {
  const mark = r.code === 0 ? 'PASS' : 'FAIL'
  const extra = r.signal ? ` (signal ${r.signal})` : ''
  console.log(`  ${mark}  ${r.label}${extra}`)
}
console.log(`  —— 共 ${results.length} 个入口，通过 ${results.length - failed.length}，失败 ${failed.length}`)
console.log('═'.repeat(64))

if (failed.length > 0) {
  console.error(`\n失败入口：${failed.map(r => r.label).join('、')}`)
  process.exit(1)
}
