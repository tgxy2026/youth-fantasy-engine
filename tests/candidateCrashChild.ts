// ============ 候选应用的「进程被终止」夹具（不是回归用例，不被分批清单收录） ============
//
// 3.2.3 · R2 §6.2 明确要求：**可确定阶段的进程终止要单独做**，
// 不能把内存里的异常包装成"真实崩溃恢复已验证"。
//
// 做法：本文件由 `tests/candidateCrash.test.ts` 通过 build-test 拉起，按 `YFE_CRASH_STAGE`
// 在某个确定屏障上直接 SIGKILL 自己（不是 throw、不是 exit(0)）——
// 父进程随后用同一份文件存储重新走 `applyCandidate`，核对"到底写到哪了"。
import fs from 'node:fs'
import path from 'node:path'
import { applyCandidate, type CandidateApplyDeps } from '@/lib/revision/candidateApply'
import type { RevisionJob } from '@/lib/revision/jobTypes'
import type { RevisionCandidate } from '@/lib/revision/revisionCandidate'

const dir = process.env.YFE_CRASH_DIR
const stage = process.env.YFE_CRASH_STAGE
if (!dir || !stage) {
  console.error('YFE_CRASH_DIR / YFE_CRASH_STAGE 必填')
  process.exit(2)
}
const at = (name: string) => path.join(dir, name)
const digest = (t: string) => `d:${t.length}:${t.slice(0, 8)}`

const job = JSON.parse(fs.readFileSync(at('job.json'), 'utf8')) as RevisionJob
const candidate = JSON.parse(fs.readFileSync(at('candidate.json'), 'utf8')) as RevisionCandidate

/** 硬终止：模拟进程被强杀（留痕文件供父进程确认停在哪个屏障） */
function die(why: string): never {
  fs.writeFileSync(at('crash.txt'), `${stage}:${why}`)
  fs.writeFileSync(at('writes.log'), `${fs.readFileSync(at('writes.log'), 'utf8')}crash:${stage}\n`)
  process.kill(process.pid, 'SIGKILL')
  // 兜底：SIGKILL 不生效时也不许继续往下跑（否则测试会变成"其实没崩"）
  process.exit(99)
}

const deps: CandidateApplyDeps = {
  readBody: async () => fs.readFileSync(at('body.txt'), 'utf8'),
  writeBody: async text => {
    if (stage === 'before-write') die('before-write')
    fs.writeFileSync(at('body.txt'), text)
    fs.appendFileSync(at('writes.log'), 'write\n')
    if (stage === 'after-write') die('after-write')
    return text
  },
  readBack: async () => fs.readFileSync(at('body.txt'), 'utf8'),
  persist: async c => {
    if (stage === 'before-intent') die('before-intent')
    if (stage === 'before-receipt' && c.status === 'applied') die('before-receipt')
    fs.writeFileSync(at('candidate.json'), JSON.stringify(c, null, 2))
    if (stage === 'after-intent') die('after-intent')
  },
  digest,
}

const out = await applyCandidate(job, candidate, deps)
fs.writeFileSync(at('result.json'), JSON.stringify({ ok: out.ok, code: out.ok ? 'ok' : out.code, resumed: out.ok ? out.resumed : null }, null, 2))
