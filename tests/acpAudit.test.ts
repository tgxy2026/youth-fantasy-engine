// ============ 3.5.6 · 检查工具与读者审问接入 ACP ============
//
// 覆盖：六件套（连续性 / 读者反馈 / 健康诊断 / 伏笔 / 术语去重 / 文风）与读者视角审问
// 通过根组件注册的发送器走 Agent；无通道时不假装通过；界面就绪条件与任务标识同步。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aiAnalyzeFeedback, aiContinuityAuditWithStatus, aiDedupTerms, aiDiagnoseProject,
  aiForeshadowReviewWithStatus, aiStyleCheck,
} from '../src/lib/aiTasks/audit'
import { aiReaderProbe } from '../src/lib/aiTasks/readerProbe'
import { aiReviewSensitive } from '../src/lib/aiTasks/suggest'
import { setAcpTextFactory } from '../src/lib/agentHost/acpRegistry'

let pass = 0
let fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const tasks: string[] = []
const prompts: string[] = []
let payload = '[]'
setAcpTextFactory(task => async prompt => {
  tasks.push(task)
  prompts.push(prompt)
  return payload
})

// ---------- 连续性 ----------
payload = JSON.stringify([{ level: '提示', title: '时间线矛盾', detail: '同一晚出现两次', where: '第 2 段' }])
const continuity = await aiContinuityAuditWithStatus('设定资料', '本章正文')
ok('连续性走注册表', tasks.at(-1) === 'audit' && continuity.state === 'completed')
ok('连续性结果被解析', (continuity.result?.data.length ?? 0) === 1 && continuity.result?.data[0].title === '时间线矛盾')
ok('检查提示词带 JSON 约束', /【输出格式】/.test(prompts.at(-1) ?? ''))

// ---------- 读者反馈 ----------
payload = JSON.stringify({ summary: '追读在下降', churnAttribution: '第 12 章节奏拖', suggestions: '压缩过渡段' })
const feedback = await aiAnalyzeFeedback([{ period: '第 3 周', metrics: '追读 1200', complaints: '水', churnChapter: '12', churnReason: '拖' }])
ok('读者反馈走注册表', feedback.summary === '追读在下降' && feedback.churnAttribution.includes('第 12 章'))

// ---------- 健康诊断 ----------
payload = JSON.stringify([{ score: 82, summary: '整体健康', risks: [{ level: '提示', title: '伏笔偏多', detail: '', where: '' }], nextSteps: ['回收两条'] }])
const diagnosis = await aiDiagnoseProject('设定', { chapters: 30, words: 90000, volumes: 3, unf: 5, unusedIdeas: 2 })
ok('健康诊断走注册表', diagnosis.score === 82 && diagnosis.risks.length === 1 && diagnosis.nextSteps[0] === '回收两条', JSON.stringify(diagnosis))

// ---------- 伏笔 ----------
payload = JSON.stringify([{ level: '严重', title: '青铜铃伏笔悬空', detail: '埋了未回收', where: '第 3 章' }])
const foreshadow = await aiForeshadowReviewWithStatus('伏笔追踪资料')
ok('伏笔审查走注册表', foreshadow.state === 'completed' && (foreshadow.result?.data.length ?? 0) === 1)

// ---------- 术语去重 ----------
payload = JSON.stringify([{ groups: [{ terms: ['青铜铃', '青铜古铃'], reason: '同物异名', suggestion: '统一为青铜铃' }] }])
const dedup = await aiDedupTerms([{ term: '青铜铃', category: '物品', definition: '' }, { term: '青铜古铃', category: '物品', definition: '' }])
ok('术语去重走注册表', dedup.groups.length === 1 && dedup.groups[0].terms.length === 2, JSON.stringify(dedup))

// ---------- 文风体检 ----------
payload = JSON.stringify([{ type: '标点', quote: '...', issue: '用三个点代替省略号', suggestion: '改为……', level: '提示' }])
const style = await aiStyleCheck('本章正文', '写作规范')
ok('文风体检走注册表', style.length === 1 && style[0].type === '标点')

// ---------- 读者视角审问 ----------
tasks.length = 0
payload = JSON.stringify({ answers: [{ q: 'hook', text: '章末钩子还不错', where: '最后一段' }], summary: '会追' })
const probe = await aiReaderProbe('设定', '本章正文', 'newbie')
ok('读者审问走 reader-probe 标识', tasks.at(-1) === 'reader-probe' && probe.summary === '会追')

// ---------- 敏感词复核 ----------
payload = JSON.stringify([{ word: '血光', risk: '低', reason: '普通描写', suggestion: '' }])
const review = await aiReviewSensitive([{ word: '血光', snippet: '一道血光掠过' }])
ok('敏感词复核走 sensitive-review', tasks.at(-1) === 'sensitive-review' && review.length === 1)

// ---------- 无通道时不假装通过 ----------
setAcpTextFactory(null)
const failed = await aiContinuityAuditWithStatus('设定资料', '本章正文')
ok('🔴 无 API 也无 ACP 时如实 failed（不冒充没有问题）', failed.state === 'failed')

// ---------- 静态契约 ----------
const app = read('src/App.tsx')
ok('根组件注册检查类发送器', app.includes('setAcpTextFactory') && app.includes("acpGatedText("))
const check = read('src/components/audit/CheckTools.tsx')
ok('检查工具按写作就绪判断', check.includes('writingReady') && check.includes('useAcpWriting'))
const modals = read('src/components/audit/AuditModals.tsx')
ok('检查弹窗按写作就绪判断', modals.includes('writingReady'))
const reader = read('src/components/audit/ReaderProbePanel.tsx')
ok('读者审问按写作就绪判断', reader.includes('writingReady'))
const bridge = read('src/lib/agentHost/acpBridge.ts')
ok('任务标识登记 audit', bridge.includes("'audit'"))
ok('任务标识登记 reader-probe', bridge.includes("'reader-probe'"))
const main = read('electron/main.cjs')
ok('主进程放行 audit', main.includes("'audit'"))
ok('主进程放行 reader-probe', main.includes("'reader-probe'"))

console.log(`\nACP_AUDIT ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
