// ============ 投稿广场 · 安全与数据回归（3.5.0 · P0） ============
//
// 三条「静默出错也不会报」的路径，必须用纯函数钉住：
//   ① 审核建议的模型目标——远程模型绝不允许收到待审正文；
//   ② 提交回执——账号切换/继续输入时不得清空或覆盖；
//   ③ 排行批次——积压旧日期不能永远传不上去；账本负数与 seq 不能算错。
//
// ?? 只测纯函数与源码接线，不起服务、不联网；真实模型与部署仍属未验收。

import {
  classifyAdviceTarget,
} from '../src/lib/community/advice'
import { decideAfterSubmit } from '../src/lib/community/publishOutcome'
import { buildRankEntries, shiftDateKey } from '../src/lib/community/rankUpload'
import { applyLedgerDelta, netDeltaOfTexts } from '../src/lib/community/rankLedger'
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function read(rel: string): string {
  try { return fs.readFileSync(path.join(process.cwd(), rel), 'utf8') } catch { return '' }
}

console.log('\n—— communitySafety 用例开始 ——')

// ---- ① 审核建议目标 ----
const provider = (over: Partial<{ type: string; protocol: string; local: boolean; baseUrl: string }>) => ({
  type: 'openai', protocol: 'openai', local: false, baseUrl: '', ...over,
}) as never

ok('本机 Ollama 允许', classifyAdviceTarget(provider({ type: 'ollama', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434' })).ok)
ok('Ollama 留空按官方默认本机处理', classifyAdviceTarget(provider({ type: 'ollama', protocol: 'ollama', baseUrl: '' })).ok)
ok('局域网 LM Studio 允许（192.168.x）', classifyAdviceTarget(provider({ baseUrl: 'http://192.168.1.20:1234/v1' })).ok)
ok('公网 OpenAI 被拒', !classifyAdviceTarget(provider({ baseUrl: 'https://api.openai.com/v1' })).ok)
ok('公网 DeepSeek 被拒', !classifyAdviceTarget(provider({ baseUrl: 'https://api.deepseek.com/v1' })).ok)
ok('域名即使勾了 local 也拒绝（地址才是证据）', !classifyAdviceTarget(provider({ local: true, baseUrl: 'https://example.com/v1' })).ok)
ok('无地址的 OpenAI 兼容配置拒绝', !classifyAdviceTarget(provider({ baseUrl: '' })).ok)
ok('拒绝理由可展示且不含密钥', (() => {
  const r = classifyAdviceTarget(provider({ baseUrl: 'https://api.openai.com/v1', local: true }))
  return !r.ok && r.reason.length > 4 && !/sk-|secret|token/i.test(r.reason)
})())
ok('建议结果记录实际端点（源码接线）', /endpoint: target\.host/.test(read('src/lib/community/advice.ts')))
ok('建议记录写入 endpoint / coverage（服务端）', /endpoint: String\(body\?\.endpoint/.test(read('server/lib/communityApi.mjs')))

// ---- ② 提交回执 ----
const snap = { accountKey: 'acc-a', title: '标题', body: '正文一' }
ok('内容未变 → 清空', decideAfterSubmit(snap, { accountKey: 'acc-a', title: '标题', body: '正文一' }) === 'clear')
ok('继续输入 → 保留新内容', decideAfterSubmit(snap, { accountKey: 'acc-a', title: '标题', body: '正文一，又写了一段' }) === 'keep')
ok('账号已切换 → 忽略整条回执', decideAfterSubmit(snap, { accountKey: 'acc-b', title: '', body: '' }) === 'ignore')
ok('账号切换且内容相同也必须忽略', decideAfterSubmit(snap, { accountKey: 'acc-b', title: '标题', body: '正文一' }) === 'ignore')

// ---- ③ 排行批次与账本 ----
ok('日期偏移跨月正确', shiftDateKey('2026-03-01', -1) === '2026-02-28' && shiftDateKey('2026-12-31', 1) === '2027-01-01')
ok('批次按日期升序（旧积压先传）', await (async () => {
  const ledger = async () => [
    { date: '2026-11-03', net: 10, seq: 1, updatedAt: 1 },
    { date: '2026-11-01', net: 20, seq: 1, updatedAt: 2 },
    { date: '2026-11-02', net: 30, seq: 1, updatedAt: 3 },
  ]
  const rows = await buildRankEntries({ projects: ['p1'], ledgerOf: ledger, fromDate: '2026-11-01' })
  return rows.map((r) => r.date).join(',') === '2026-11-01,2026-11-02,2026-11-03'
})())
ok('积压不再被 400 条截断（450 条全部进入批次）', await (async () => {
  const many = Array.from({ length: 450 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000)
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    return { date, net: i + 1, seq: 1, updatedAt: i }
  })
  const rows = await buildRankEntries({ projects: ['p1'], ledgerOf: async () => many, fromDate: '2025-01-01' })
  return rows.length === 450
})())
ok('早于授权日的记录不上传', await (async () => {
  const rows = await buildRankEntries({
    projects: ['p1'],
    ledgerOf: async () => [
      { date: '2026-10-01', net: 999, seq: 1, updatedAt: 1 },
      { date: '2026-11-10', net: 10, seq: 2, updatedAt: 2 },
    ],
    fromDate: '2026-11-10',
  })
  return rows.length === 1 && rows[0].date === '2026-11-10'
})())
ok('账本同日增减相抵且 seq 递增', (() => {
  const a = applyLedgerDelta(null, 10000, '2026-11-10', 1)
  const b = applyLedgerDelta(a, -5000, '2026-11-10', 2)
  return a.net === 10000 && b.net === 5000 && b.seq === 2
})())
ok('账本保留负数（供周月抵扣）', applyLedgerDelta(null, -3000, '2026-11-10').net === -3000)
ok('授权当天只上传开启后的有符号增量', await (async () => {
  const start = Date.parse('2026-11-10T12:00:00+08:00')
  const a = applyLedgerDelta(null, 10000, '2026-11-10', start - 1000)
  const sameTime = applyLedgerDelta(a, 800, '2026-11-10', start)
  const b = applyLedgerDelta(sameTime, 3000, '2026-11-10', start + 1000)
  const c = applyLedgerDelta(b, -500, '2026-11-10', start + 2000)
  const rows = await buildRankEntries({ projects: ['p1'], ledgerOf: async () => [c], fromDate: '2026-11-10', optInAt: start })
  return rows.length === 1 && rows[0].netDelta === 2500
})())
ok('撤回后重开只统计新授权后的写作', await (async () => {
  const start = Date.parse('2026-11-10T12:00:00+08:00')
  const a = applyLedgerDelta(null, 400, '2026-11-10', start - 1000)
  const b = applyLedgerDelta(a, 200, '2026-11-10', start + 1000)
  const rows = await buildRankEntries({ projects: ['p1'], ledgerOf: async () => [b], fromDate: '2026-11-10', optInAt: start })
  return rows.length === 1 && rows[0].netDelta === 200
})())
ok('历史账本缺少开启当天细节时不猜测上报', await (async () => {
  const start = Date.parse('2026-11-10T12:00:00+08:00')
  let incomplete = false
  const rows = await buildRankEntries({ projects: ['p1'], ledgerOf: async () => [{ date: '2026-11-10', net: 900, seq: 1, updatedAt: start + 1 }], fromDate: '2026-11-10', optInAt: start, onIncomplete: () => { incomplete = true } })
  return incomplete && rows.length === 0
})())
ok('延迟补记保留原始发生时间', (() => {
  const start = Date.parse('2026-11-10T12:00:00+08:00')
  const newer = applyLedgerDelta(null, 30, '2026-11-10', start + 2000)
  const delayed = applyLedgerDelta(newer, 20, '2026-11-10', start - 1000)
  return delayed.updatedAt === start + 2000 && !!delayed.events?.some((e) => e.at === start - 1000 && e.delta === 20)
})())
ok('含标点净增量复用既有口径', netDeltaOfTexts('字'.repeat(5000), '字'.repeat(10000) + '，') === 5001)
ok('批次上限与服务器一致（400）', /const BATCH_SIZE = 400/.test(read('src/lib/community/rankUpload.ts'))
  && /entries.slice\(0, 400\)/.test(read('server/lib/communityApi.mjs')))
ok('上报前先补记失败增量', /flushPendingRankDeltas\(\)/.test(read('src/lib/community/rankUpload.ts')))

// ---- 账本覆盖：新增章节、删除、恢复、导入排除 ----
const chapters = read('src/lib/db/chapters.ts')
ok('新建即带正文也记账', /!old && next\.content/.test(chapters) && /countWordsWithPunct\(next\.content\)/.test(chapters))
ok('删除章节记负', /recordChapterDeleted/.test(chapters))
ok('回收站恢复记正（对冲）', /countWordsWithPunct\(restored\.content/.test(chapters))
ok('导入与备份恢复不经过保存函数', !/saveChapter/.test(read('src/lib/db/projects.ts')) && !/saveChapter/.test(read('src/lib/db/backups.ts')))

// ---- 无码找回与资格盘点 ----
ok('一次性找回码只存哈希且 24h 有效', (() => {
  const src = read('server/lib/users.mjs')
  return /createHash\('sha256'\)/.test(src) && /RECOVERY_TTL_MS = 24 \* 3600 \* 1000/.test(src)
})())
ok('找回码路径与邀请码错误文案一致（防枚举）', (() => {
  const src = read('server/lib/users.mjs')
  const bad = (src.match(/用户名或找回码不正确/g) || []).length
  return bad >= 1 && /resetPasswordByInvite/.test(src)
})())
ok('运维提供资格盘点与找回码签发', (() => {
  const src = read('server/admin.mjs')
  return /cmdSyncAudit/.test(src) && /cmdRecovery/.test(src) && /sync-audit/.test(src)
})())
ok('已发布投稿可单独改为匿名（服务端）', /sub === '\/display'/.test(read('server/lib/communityApi.mjs')))
ok('昵称禁止官方/管理身份字样', /NICKNAME_IMPERSONATION/.test(read('server/lib/communityRules.mjs')))
ok('申诉绑定版本并可重新进入待审', /kind: 'appeal'/.test(read('server/lib/communityApi.mjs')) && /action === 'reopen'/.test(read('server/lib/communityApi.mjs')))

console.log(`communitySafety: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
