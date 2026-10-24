// ============ 3.2.3 · R2：候选应用的进程终止与重启核对 ============
//
// 为什么单开这一条：`candidateApply.test.ts` 里的崩溃恢复全是**同进程内的内存异常**
// （persist 抛错、回读串了）。方案 §6.2 明确要求：
//   「对可确定阶段的进程终止安排少量独立进程测试，不能把内存异常测试写成真实崩溃恢复已验证」。
//
// 这里真的把子进程 SIGKILL 掉，用**真实文件**当存储，再在父进程里重新走一次 `applyCandidate`，
// 核对它到底停在哪一步、有没有重复写正文、有没有把可重试的失败误判成"放弃"。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { applyCandidate, failureReceipt, type CandidateApplyDeps } from '@/lib/revision/candidateApply'
import type { RevisionJob } from '@/lib/revision/jobTypes'
import type { RevisionCandidate } from '@/lib/revision/revisionCandidate'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const digest = (t: string) => `d:${t.length}:${t.slice(0, 8)}`
const BEFORE = '这是改前的正文，作者刚写完。'
const AFTER = '这是改后的正文，AI 改写完成并更紧凑。'

const job: RevisionJob = {
  id: 'job-1', projectId: 'pid-crash', kind: 'rewrite',
  scope: { chapterId: 'ch-1' },
  params: {}, status: 'running', stepCount: 0, currentStep: 0, steps: [],
  baseline: { bodyDigest: digest(BEFORE), at: 1 },
  createdAt: 1, updatedAt: 1,
} as unknown as RevisionJob

const candidate: RevisionCandidate = {
  id: 'cand-1', jobId: 'job-1', projectId: 'pid-crash', chapterId: 'ch-1', status: 'pending',
  text: AFTER, beforeText: BEFORE, summary: '改写', bytes: AFTER.length,
  createdAt: 1, updatedAt: 1, generation: 1,
}

/** 父进程侧的真实文件依赖（无注入，用于"重启后"核对） */
function fileDeps(dir: string, logWrites = true): CandidateApplyDeps {
  const at = (n: string) => path.join(dir, n)
  return {
    readBody: async () => fs.readFileSync(at('body.txt'), 'utf8'),
    writeBody: async text => {
      fs.writeFileSync(at('body.txt'), text)
      if (logWrites) fs.appendFileSync(at('writes.log'), 'write\n')
      return text
    },
    readBack: async () => fs.readFileSync(at('body.txt'), 'utf8'),
    persist: async c => { fs.writeFileSync(at('candidate.json'), JSON.stringify(c, null, 2)) },
    digest,
  }
}
const writesCount = (dir: string) =>
  fs.readFileSync(path.join(dir, 'writes.log'), 'utf8').split('\n').filter(l => l === 'write').length
const readCandidate = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'candidate.json'), 'utf8')) as RevisionCandidate

function prepare(): string {
  const parent = path.join(os.tmpdir(), 'yfe-crash-')
  const dir = fs.mkdtempSync(parent)
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2))
  fs.writeFileSync(path.join(dir, 'candidate.json'), JSON.stringify(candidate, null, 2))
  fs.writeFileSync(path.join(dir, 'body.txt'), BEFORE)
  fs.writeFileSync(path.join(dir, 'writes.log'), '')
  return dir
}

/** 在指定屏障上把子进程硬杀掉；返回子进程的退出信息 */
function crashAt(dir: string, stage: string): Promise<{ code: number | null; signal: string | null }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'build-test.mjs'), 'candidateCrashChild'], {
      cwd: ROOT,
      env: { ...process.env, YFE_TEST_QUIET: '1', YFE_CRASH_DIR: dir, YFE_CRASH_STAGE: stage },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { out += String(d) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, 60000)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (fs.existsSync(path.join(dir, 'result.json'))) {
        ok(`子进程在 ${stage} 确实被终止（没跑完）`, false, '子进程竟然正常跑完了：' + out.slice(-200))
      }
      resolve({ code, signal })
    })
  })
}

/** 一个屏障的完整核对流程 */
async function scenario(stage: string, expect: {
  bodyAfterCrash: string
  candidateStatus: string
  hasIntent: boolean
  hasReceipt: boolean
  resumed: boolean
}) {
  const dir = prepare()
  try {
    await crashAt(dir, stage)

    const bodyAfter = fs.readFileSync(path.join(dir, 'body.txt'), 'utf8')
    const candAfter = readCandidate(dir)
    ok(`[${stage}] 崩溃点如预期：正文${expect.bodyAfterCrash === BEFORE ? '未被改动' : '已写入'}`,
      bodyAfter === expect.bodyAfterCrash, bodyAfter.slice(0, 40))
    ok(`[${stage}] 崩溃点如预期：候选状态 ${expect.candidateStatus}`,
      candAfter.status === expect.candidateStatus, candAfter.status)
    ok(`[${stage}] 意图${expect.hasIntent ? '已' : '未'}落盘`, Boolean(candAfter.intent) === expect.hasIntent)
    ok(`[${stage}] 回执${expect.hasReceipt ? '已' : '未'}落盘`, Boolean(candAfter.receipt) === expect.hasReceipt)
    ok(`[${stage}] 🔴 崩溃后候选没有被判成"放弃"（可重试的失败不能丢候选）`,
      candAfter.status !== 'discarded' && candAfter.status !== 'stale')

    // ── 重启：用同一份文件重新走一次 ──
    const r = await applyCandidate(job, readCandidate(dir), fileDeps(dir))
    ok(`[${stage}] 重启后能收敛到"已应用"`, r.ok === true, JSON.stringify(r).slice(0, 200))
    if (r.ok) {
      ok(`[${stage}] ${expect.resumed ? '走补回执（没有重写正文）' : '走正常写入'}`,
        r.resumed === expect.resumed, String(r.resumed))
      ok(`[${stage}] 回执与意图配对`, r.receipt.operationId === r.candidate.intent?.operationId)
      ok(`[${stage}] 最终候选为 applied`, r.candidate.status === 'applied')
    }
    ok(`[${stage}] 🔴 正文只被写过一次（不重复覆盖作者后续编辑）`, writesCount(dir) === 1, String(writesCount(dir)))
    ok(`[${stage}] 最终正文就是候选内容`, fs.readFileSync(path.join(dir, 'body.txt'), 'utf8') === AFTER)
  } finally {
    const target = fs.realpathSync(dir)
    if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('yfe-crash-')) {
      throw new Error('拒绝清理不安全的临时目录')
    }
    fs.rmSync(target, { recursive: true })
  }
}

async function main() {
  // ① 意图落盘前被杀：正文必须一个字都没动，重试后正常写入一次
  await scenario('before-intent', {
    bodyAfterCrash: BEFORE, candidateStatus: 'pending', hasIntent: false, hasReceipt: false, resumed: false,
  })
  // ② 意图已落盘、正文没写：这是最容易误判的一段 —— 有 intent 但磁盘还是改前
  await scenario('after-intent', {
    bodyAfterCrash: BEFORE, candidateStatus: 'applying', hasIntent: true, hasReceipt: false, resumed: false,
  })
  // ③ 正要写正文时被杀：与 ② 同形，验证"写之前"这个屏障
  await scenario('before-write', {
    bodyAfterCrash: BEFORE, candidateStatus: 'applying', hasIntent: true, hasReceipt: false, resumed: false,
  })
  // ④ 正文写完立刻被杀：磁盘已是改后 ⇒ 重启只补回执，绝不再写一次
  await scenario('after-write', {
    bodyAfterCrash: AFTER, candidateStatus: 'applying', hasIntent: true, hasReceipt: false, resumed: true,
  })
  // ⑤ 回执持久化前被杀：同上，但屏障在 persist 内部（回执构造已完成）
  await scenario('before-receipt', {
    bodyAfterCrash: AFTER, candidateStatus: 'applying', hasIntent: true, hasReceipt: false, resumed: true,
  })

  // ⑥ 失败回执不能挂在候选上：没有 intent 就无从配对，必须返回 null 而不是伪造一条
  ok('⑥ 没有意图时不伪造失败回执', failureReceipt({ ...candidate, intent: undefined }, '写盘失败') === null)
  const withIntent: RevisionCandidate = {
    ...candidate,
    intent: { operationId: 'op-9', jobId: 'job-1', submittedAt: 1, beforeBodyDigest: digest(BEFORE), candidateId: candidate.id },
  }
  const fr = failureReceipt(withIntent, '写盘失败')
  ok('⑥ 失败回执是独立记录（带失败原因，不写进 candidate）',
    Boolean(fr) && fr?.ok === false && String(fr?.error ?? '').includes('写盘失败'))
  ok('⑥ 失败回执不改变候选状态', withIntent.status === 'pending' && !withIntent.receipt)

  console.log(`\n———— candidateCrash：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
