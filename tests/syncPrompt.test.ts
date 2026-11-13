// 3.5.3 · P0-4 同步结局 → 用户文案 · 单测
//
// 盯三件事：
//   ① 归类穷举：十种结局各归各类，五类「必须区分」的失败不能塌成一句"同步失败"；
//   ② 🔴 失败类文案必须含安抚（本机/保留/不受影响）——同步失败最忌讳让用户以为稿子丢了；
//   ③ 成功不挂告警（空串），网络类要说"会自动重试"而不是"同步失败"。
import { syncPrompt, syncPromptKind } from '@/lib/sync/syncPrompt'
import type { UploadOutcome } from '@/lib/sync/projectUploader'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const err = (code: string, message = '', retryable = false): UploadOutcome =>
  ({ ok: false, status: 'error', code, message, retryable })
const published = (revision = 1): UploadOutcome =>
  ({ ok: true, status: 'published', revision, snapshotId: `s${revision}` })
const conflict = (revision = 2): UploadOutcome => ({ ok: false, status: 'conflict', revision })
const quota = (): UploadOutcome => ({ ok: false, status: 'quota', usedBytes: 1, quotaBytes: 2 })

const DATA_ANOMALY = ['PROJECT_DATA_INVALID', 'PROJECT_DATA_READ_FAILED', 'PROJECT_DATA_MISSING', 'PROJECT_DATA_RECOVERY_REQUIRED']

function main() {
  // ---------- 1. 归类穷举 ----------
  {
    ok('1a 成功 → ok', syncPromptKind(published()) === 'ok')
    ok('1b 基线不符 → conflict', syncPromptKind(conflict()) === 'conflict')
    ok('1c 配额 → quota', syncPromptKind(quota()) === 'quota')
    for (const c of ['NETWORK', 'TIMEOUT', 'ECONNRESET']) {
      ok(`1d 网络类 ${c} → network`, syncPromptKind(err(c, '', true)) === 'network')
    }
    for (const c of DATA_ANOMALY) {
      ok(`1e 数据异常 ${c} → data-anomaly`, syncPromptKind(err(c)) === 'data-anomaly')
    }
    ok('1f 账号忙 → account-busy', syncPromptKind(err('PROJECT_ACCOUNT_BUSY', '', true)) === 'account-busy')
    ok('1g 世代失效 → epoch', syncPromptKind(err('EPOCH_STALE')) === 'epoch')
    ok('1h 旧服务器 → old-server', syncPromptKind(err('SERVER_TOO_OLD')) === 'old-server')
    ok('1i 旧写入停用 → legacy-blocked', syncPromptKind(err('LEGACY_WRITE_BLOCKED')) === 'legacy-blocked')
    ok('1j 其它 → error', syncPromptKind(err('WHATEVER')) === 'error')
  }

  // ---------- 2. 成功不挂告警 ----------
  ok('2a 成功文案为空（界面不为成功挂告警）', syncPrompt(published()) === '', JSON.stringify(syncPrompt(published())))

  // ---------- 3. 🔴 失败类必须含安抚 ----------
  {
    const failures: UploadOutcome[] = [
      conflict(), quota(),
      err('NETWORK', '', true), err('TIMEOUT', '', true),
      ...DATA_ANOMALY.map((c) => err(c)),
      err('PROJECT_ACCOUNT_BUSY', '', true), err('EPOCH_STALE'),
      err('SERVER_TOO_OLD'), err('LEGACY_WRITE_BLOCKED'), err('WHATEVER'),
    ]
    const silent = failures.filter((o) => !syncPrompt(o).trim())
    ok('3a 每条失败都有非空文案', silent.length === 0, String(silent.length))
    const noReassure = failures.filter((o) => !/(本机|保留|不受影响)/.test(syncPrompt(o)))
    ok('3b 🔴 每条失败都点明「本机稿件还在」（否则用户以为稿子丢了）', noReassure.length === 0,
      noReassure.map((o) => syncPrompt(o)).join(' ｜ '))
  }

  // ---------- 4. 🔴 五类必须区分（不能塌成一句"同步失败"）----------
  {
    const five = [
      syncPrompt(err('PROJECT_DATA_RECOVERY_REQUIRED')),
      syncPrompt(err('PROJECT_ACCOUNT_BUSY', '', true)),
      syncPrompt(err('EPOCH_STALE')),
      syncPrompt(err('SERVER_TOO_OLD')),
      syncPrompt(err('NETWORK', '', true)),
    ]
    ok('4a 数据异常/账号忙/世代/旧服务器/网络 五类文案互不相同', new Set(five).size === 5, JSON.stringify(five))
    const generic = syncPrompt(err('WHATEVER'))
    ok('4b 五类都不等于通用"同步失败"文案', five.every((t) => t !== generic), JSON.stringify(five))
    ok('4c 网络类说"会自动重试"（不是"同步失败"）', /自动重试/.test(syncPrompt(err('NETWORK', '', true))))
    ok('4d 数据异常默认提示联系管理员', /管理员/.test(syncPrompt(err('PROJECT_DATA_INVALID'))))
  }

  // ---------- 5. 服务端文案透传（error 变体带 message 时优先用它）----------
  {
    const custom = '云端索引校验失败（自定义说明）'
    ok('5a 数据异常透传服务端 message', syncPrompt(err('PROJECT_DATA_INVALID', custom)) === custom)
    ok('5b 账号忙透传 message', syncPrompt(err('PROJECT_ACCOUNT_BUSY', custom, true)) === custom)
    ok('5c 世代透传 message', syncPrompt(err('EPOCH_STALE', custom)) === custom)
    ok('5d 旧服务器透传 message', syncPrompt(err('SERVER_TOO_OLD', custom)) === custom)
    ok('5e 旧写入停用透传 message', syncPrompt(err('LEGACY_WRITE_BLOCKED', custom)) === custom)
    ok('5f 其它错误透传 message', syncPrompt(err('WHATEVER', custom)) === custom)
    // 负面对照：conflict/quota 没有 message 字段，文案是合成的（证明 5a 不是"一律透传"）
    ok('5g 冲突文案是合成的（不依赖 message）', /保留哪一份/.test(syncPrompt(conflict())))
  }

  console.log(`\nsyncPrompt: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()