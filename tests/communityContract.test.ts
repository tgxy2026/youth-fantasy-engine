// ============ 投稿广场 · 双端口径与接线契约（3.5.0） ============
//
// 守三件容易「各写各的」的事：
//   ① 客户端计数/标签/上限必须与服务端规则层逐项一致（否则界面说能发、服务端说超长）；
//   ② 「含标点」统计必须复用既有 `countWords(...,'cjk-punct')`，不能另造一套；
//   ③ 排行账本的接入点必须覆盖保存 / 删章 / 删卷 / 恢复，且导入与备份恢复**不得**计入。
//
// ?? 这是静态契约 + 纯函数等价，不是界面验收；真实双端联调仍需部署环境。

import fs from 'node:fs'
import path from 'node:path'
import {
  COMMUNITY_LIMITS as CLIENT_LIMITS, COMMUNITY_TAGS as CLIENT_TAGS,
  charCount as clientCharCount, countWordsWithPunct,
} from '../src/lib/community/limits'
import { countWords } from '../src/lib/editor/textStats'
import {
  COMMUNITY_LIMITS as SERVER_LIMITS, COMMUNITY_TAGS as SERVER_TAGS,
  charCount as serverCharCount, todayKeyCn, periodRange,
} from '../server/lib/communityRules.mjs'
import { cnDateKey } from '../src/lib/community/rankLedger'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function read(rel: string): string {
  try { return fs.readFileSync(path.join(process.cwd(), rel), 'utf8') } catch { return '' }
}

console.log('\n—— communityContract 用例开始 ——')

// ---- 常量一致 ----
const limitKeys = ['titleMax', 'bodyMax', 'commentMax', 'tagMax', 'tagLenMax', 'nicknameMin', 'nicknameMax', 'pageSize', 'pageSizeMax', 'postDailyMax', 'commentDailyMax', 'reportDailyMax']
const mismatched = limitKeys.filter((k) => (CLIENT_LIMITS as Record<string, number>)[k] !== (SERVER_LIMITS as Record<string, number>)[k])
ok('字数/频率上限双端一致', mismatched.length === 0, mismatched.join(','))
ok('预设标签双端一致', JSON.stringify(CLIENT_TAGS) === JSON.stringify(SERVER_TAGS))

// ---- 计数等价 ----
const samples = [
  '', '你好，世界。', '🙂🙂🙂', 'a1 中文 mixed 123', '雨落在旧城墙的\u3000青砖上……',
  '第一行\n第二行\r\n第三行', '\u200b零宽\ufeffBOM', '——破折号…省略号·间隔号',
]
const charDiff = samples.filter((s) => clientCharCount(s) !== serverCharCount(s))
ok('字符计数双端逐样例相等（Unicode 码点口径）', charDiff.length === 0, charDiff.join(' | '))

const punctDiff = samples.filter((s) => countWordsWithPunct(s) !== countWords(s, 'cjk-punct'))
ok('含标点字数复用既有 countWords(cjk-punct)，无第二套口径', punctDiff.length === 0, punctDiff.join(' | '))
ok('排行榜口径示例：新增 10000 删除 5000 → 净增 5000', (() => {
  const before = '字'.repeat(5000)
  const after = '字'.repeat(10000)
  return countWordsWithPunct(after) - countWordsWithPunct(before) === 5000
})())

// ---- 北京时间日期一致 ----
ok('客户端与服务端“今天”同为北京时间', cnDateKey(Date.now()) === todayKeyCn())
ok('周范围跨月正确（2026-11-01 周日 → 10-26..11-01）', (() => {
  const r = periodRange('week', '2026-11-01')
  return !!r && r.start === '2026-10-26' && r.end === '2026-11-01'
})())

// ---- 接入点静态契约 ----
const chapters = read('src/lib/db/chapters.ts')
ok('保存路径接入排行账本（afterChapterWrite）', /recordRankDelta/.test(chapters) && /content !== next\.content/.test(chapters))
ok('删章路径记负增量', /recordChapterDeleted/.test(chapters))
ok('回收站恢复与删除对冲（记回正增量）', /restoreFromTrash[\s\S]*countWordsWithPunct[\s\S]*recordRankDelta/.test(chapters))
const volumes = read('src/lib/db/volumes.ts')
ok('删卷连带删章记负增量', /removedWords/.test(volumes) && /recordRankDelta/.test(volumes))
const agentOps = read('src/lib/agentHost/contentOps.ts')
ok('Agent 删章与手动删章同口径', /recordChapterDeleted/.test(agentOps))

// 导入 / 备份恢复 / 云应用：都必须**不经过** afterChapterWrite 的保存函数
const projects = read('src/lib/db/projects.ts')
ok('项目导入直接写表（不当作日常写作）', /put\('chapters'/.test(projects) && !/saveChapter/.test(projects))
const backups = read('src/lib/db/backups.ts')
ok('备份恢复直接写表（不当作日常写作）', /put\('chapters'/.test(backups) && !/saveChapter/.test(backups))

// ---- 审核绑定版本的服务端契约 ----
const api = read('server/lib/communityApi.mjs')
ok('审批必须携带并校验 versionId', /validateDecision\(post, versionId, action\)/.test(api))
ok('AI 建议只登记、不改变状态', /admin\/advice[\s\S]{0,2000}p\.advice = advice/.test(api))
ok('云同步资格与社区接口分离（社区路由在 v2 闸之前）', (() => {
  const index = read('server/index.mjs')
  const communityAt = index.indexOf("startsWith('/api/community/')")
  const v2At = index.indexOf("startsWith('/api/v2/')")
  return communityAt > 0 && v2At > 0 && communityAt < v2At
})())

// ---- 页签落位 ----
const schema = read('src/lib/schema.ts')
ok('投稿广场是正文写作组的独立页签（与正文编辑同级）', /COMMUNITY_TAB: TabDef = \{\s*id: 'community'[^}]*group: '正文写作'/.test(schema))
ok('投稿广场页签锁定可见（自定义项目也不隐藏）', /community: 'locked'/.test(schema))

console.log(`communityContract: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1