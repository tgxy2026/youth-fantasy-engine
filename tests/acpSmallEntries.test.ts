// ============ 3.5.6 · 四个小入口接入 ACP ============
//
// 覆盖：本章变化清单 / 节奏与章末钩子 / 按章反推写作规范 / 正文与细纲对照。
// 判据一律不变：引文逐字定位、字段键白名单、计划项与状态校验、证据不足降级。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiChapterChangeList } from '../src/lib/aiTasks/changeList'
import { aiPaceAnalysis } from '../src/lib/aiTasks/pace'
import { aiInferStyle } from '../src/lib/aiTasks/styleInfer'
import { aiComparePlanWithBody } from '../src/lib/aiTasks/planCompareAi'
import { verifyChangeItems } from '../src/lib/audit/changeList'

let pass = 0
let fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 本章变化清单 ----------
const chgPrompts: string[] = []
const chg = await aiChapterChangeList({
  material: '陈渊蹲在雨里，忽然听见铃铛响了一声，他没有回头。',
  chapterTitle: '第二章 夜行',
  acpText: async prompt => {
    chgPrompts.push(prompt)
    return JSON.stringify({
      changes: [
        { type: '信息', before: '', after: '陈渊意识到铃铛在响', quote: '忽然听见铃铛响了一声' },
        { type: '信息', before: '', after: '编造的引文', quote: '正文里根本没有这句' },
      ],
    })
  },
})
ok('变化清单走 ACP', chg.text.includes('changes'))
ok('模型标签如实标为 ACP Agent', chg.modelTag === 'ACP Agent')
ok('提示词带章节与 JSON 约束', chgPrompts[0].includes('第二章 夜行') && /【输出格式】/.test(chgPrompts[0]))
const items = verifyChangeItems(chg.text, '陈渊蹲在雨里，忽然听见铃铛响了一声，他没有回头。')
ok('逐字命中的线索保留、编造引文被剔除', items.length === 1, JSON.stringify(items.map(i => i.quote)))

// ---------- 节奏与章末钩子 ----------
const pacePrompts: string[] = []
const pace = await aiPaceAnalysis('【设定】青石巷', '他抬头看雨，雨停了。远处传来钟声。', {
  acpText: async prompt => {
    pacePrompts.push(prompt)
    return JSON.stringify({
      hook: { present: true, kind: '悬念', evidence: '远处传来钟声', note: '留了未解释的声音' },
      beats: [{ kind: '逆转', quote: '雨停了', note: '停顿后转折' }],
      increments: ['雨停'],
      observations: ['爆点在后段'],
      summary: '收在悬念上',
    })
  },
})
ok('节奏走 ACP 并解析出钩子', pace.hookPresent === true && pace.hookKind === '悬念')
ok('爆点引文保留并被本地定位', pace.beats.length === 1 && pace.beats[0].quote === '雨停了')
ok('提示词带正文与结构约束', pacePrompts[0].includes('远处传来钟声') && pacePrompts[0].includes('"hook"'))

// ---------- 按章反推写作规范 ----------
const stylePrompts: string[] = []
const style = await aiInferStyle({
  material: '青石铺的巷子湿得发亮，他走得很慢。',
  fields: [{ key: '叙述视角::人称', label: '人称' }],
  acpText: async prompt => {
    stylePrompts.push(prompt)
    return JSON.stringify({
      suggestions: [
        { key: '叙述视角::人称', value: '第三人称限知', reason: '只写主角所见', quote: '他走得很慢' },
        { key: '不存在的::字段', value: '应被丢弃', reason: '', quote: '' },
      ],
    })
  },
})
ok('反推规范走 ACP', style.length === 1 && style[0].key === '叙述视角::人称')
ok('白名单外的字段键被丢弃', !style.some(s => s.key.includes('不存在的')))
ok('提示词带字段清单与原文材料', stylePrompts[0].includes('叙述视角::人称') && stylePrompts[0].includes('青石铺的巷子'))

// ---------- 正文与细纲对照 ----------
const planPrompts: string[] = []
const body = '他跪在雪里，腕上金纹发烫，忽然笑了一声。'
const plan = await aiComparePlanWithBody(
  [{ planFieldId: '核心事件', planQuote: '主角被羞辱后觉醒', templateVersion: 'chapter-outline' }],
  body,
  {
    acpText: async prompt => {
      planPrompts.push(prompt)
      return JSON.stringify([
        { planFieldId: '核心事件', status: 'completed', bodyQuotes: ['腕上金纹发烫'], note: '写成觉醒征兆' },
        { planFieldId: '不存在的计划', status: 'completed', bodyQuotes: [], note: '应被丢弃' },
      ])
    },
  },
)
ok('细纲对照走 ACP 并得出完成判定', plan.state === 'completed' && plan.review?.items[0].status === 'completed')
ok('不在本次计划里的行被丢弃', plan.review?.dropped === 1 && plan.review?.unknownFields.includes('不存在的计划'))
ok('提示词带计划原文与正文', planPrompts[0].includes('主角被羞辱后觉醒') && planPrompts[0].includes('腕上金纹发烫'))

// 引文对不上 ⇒ 强制降级（判据未放宽）
const softPlan = await aiComparePlanWithBody(
  [{ planFieldId: '核心事件', planQuote: '主角被羞辱后觉醒', templateVersion: 'chapter-outline' }],
  body,
  { acpText: async () => JSON.stringify([{ planFieldId: '核心事件', status: 'completed', bodyQuotes: ['正文里没有这句'], note: '' }]) },
)
ok('无逐字证据的「已完成」被降级为证据不足', softPlan.review?.items[0].status === 'insufficient', softPlan.review?.items[0].status)

// ---------- 界面接线（静态契约） ----------
const panelCases: Array<[string, string, string]> = [
  ['src/components/audit/ManuscriptCheckPanel.tsx', 'change-list', '本章变化清单'],
  ['src/components/outline/PaceAnalysisPanel.tsx', 'pace', '节奏与章末钩子'],
  ['src/components/sheets/StyleTools.tsx', 'style-infer', '按章反推写作规范'],
  ['src/components/editor/ChapterContextPanel.tsx', 'plan-compare', '正文与细纲对照'],
]
for (const [file, task, label] of panelCases) {
  const src = read(file)
  ok(`${label}：按写作就绪判断（API 或 ACP）`, /writingReady\s*=|useAcpWriting\(\)/.test(src))
  ok(`${label}：注入 ACP 闸门与任务标识 ${task}`, src.includes('acpGatedText') && src.includes(`'${task}'`))
  ok(`${label}：闸门带接收方名称（按 Agent 记账）`, src.includes('agentName:'))
}

const bridge = read('src/lib/agentHost/acpBridge.ts')
const main = read('electron/main.cjs')
for (const task of ['change-list', 'pace', 'style-infer', 'plan-compare']) {
  ok(`任务标识登记与放行：${task}`, bridge.includes(`'${task}'`) && main.includes(`'${task}'`))
}

console.log(`\n—— acpSmallEntries 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
