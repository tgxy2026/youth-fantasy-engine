// ============ 3.5.6 · 一键拆书接入 ACP ============
//
// 覆盖：章节边界识别、全书设定汇总的 ACP 通道；解析与过滤判据不变；
// 整条链路（四处调用）确实把同一个发送器传下去；界面与两处白名单同步。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiBookBreakSplitChapters } from '../src/lib/aiTasks/bookBreakSplit'
import { aiSummarizeFormSettings } from '../src/lib/aiTasks/formSummary'

let pass = 0
let fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 章节边界识别 ----------
const splitPrompts: string[] = []
const lines = await aiBookBreakSplitChapters({
  sampleText: '01|风起\n雨声打在青石上。\n02|夜行\n铃铛响了一下。',
  samples: ['01|风起'],
  acpText: async prompt => {
    splitPrompts.push(prompt)
    return JSON.stringify({ lines: ['01|风起', '  ', '02|夜行'] })
  },
})
ok('章节识别走 ACP 并解析出行', lines.join('|') === '01|风起|02|夜行')
ok('提示词带标题示例与原文节选', splitPrompts[0].includes('01|风起') && splitPrompts[0].includes('雨声打在青石上'))
ok('提示词带 JSON 约束（不靠服务端 json 模式）', /【输出格式】/.test(splitPrompts[0]) && splitPrompts[0].includes('"lines"'))

// 中文键容错（parseChapterLines 既有能力，换通道后必须保留）
const cn = await aiBookBreakSplitChapters({
  sampleText: '第一章 风起',
  samples: ['第一章 风起'],
  acpText: async () => JSON.stringify({ 章节行: ['第一章 风起'] }),
})
ok('中文键仍能解析', cn.join('') === '第一章 风起')

// ---------- 全书设定汇总 ----------
const formPrompts: string[] = []
const values = await aiSummarizeFormSettings('【材料】陈渊，青石巷少年，持青铜铃。', {
  acpText: async prompt => {
    formPrompts.push(prompt)
    return JSON.stringify({
      世界设定: { 地理: { 主城: '青石巷' } },
      作品信息: { 题材: '仙侠' },
      坏的页签: ['不是对象，应被丢掉'],
      空页签: {},
    })
  },
})
ok('设定汇总走 ACP', Object.keys(values).length === 2 && !!values['世界设定'])
ok('嵌套模块结构原样保留（不摊平）', (values['世界设定'] as Record<string, Record<string, string>>).地理.主城 === '青石巷')
ok('非对象与空页签被丢掉', !values['坏的页签'] && !values['空页签'])
ok('提示词带字段清单与 JSON 约束', formPrompts[0].includes('〖要填的字段〗') && /【输出格式】/.test(formPrompts[0]))

// 空结果触发收紧重试（同 API 路径）
const retryPrompts: string[] = []
await aiSummarizeFormSettings('【材料】只有一句话。', {
  acpText: async prompt => {
    retryPrompts.push(prompt)
    return '{}'
  },
})
ok('空结果重试一次', retryPrompts.length === 2)
ok('第二次点明上次被截断', /上一次输出被截断了/.test(retryPrompts[1]) && !/上一次输出被截断了/.test(retryPrompts[0]))

// ---------- 链路接线（静态契约） ----------
const run = read('src/lib/bookbreak/run.ts')
ok('运行层接受 acpText 选项', /acpText\?:\s*\(prompt: string/.test(run))
for (const [label, pattern] of [
  ['章节识别', /aiBookBreakSplitChapters\(\{[\s\S]{0,400}acpText: opts\.acpText/],
  ['逐章抽取', /aiExtractSettingEntitiesWithStatus\([\s\S]{0,300}acpText: opts\.acpText/],
  ['设定汇总', /aiSummarizeFormSettings\([\s\S]{0,300}acpText: opts\.acpText/],
  ['关系整理', /buildRelationDrafts\(\{[\s\S]{0,500}acpText: opts\.acpText/],
] as const) ok(`${label}透传 acpText`, pattern.test(run))

const relations = read('src/lib/bookbreak/relations.ts')
ok('关系整理把 acpText 交给 organizeRows', /organizeRows\(tab, \{[\s\S]{0,900}acpText: opts\.acpText/.test(relations))
ok('关系整理选项声明 acpText', /acpText\?: \(prompt: string\) => Promise<string>/.test(relations))

const panel = read('src/components/bookbreak/BookBreakPanel.tsx')
ok('面板按写作就绪判断（API 或 ACP）', panel.includes('writingReady') && /writingReady\s*=\s*aiReady \|\| !!acpWriting\?\.ready/.test(panel))
ok('面板注入 ACP 闸门', panel.includes('acpGatedText') && panel.includes("task: 'bookbreak'"))
ok('整本只确认一次', /askOnce:\s*true/.test(panel))
ok('取消沿用任务中心信号', /acpGatedText\(\{[\s\S]{0,500}signal: ctx\.signal/.test(panel))

const bridge = read('src/lib/agentHost/acpBridge.ts')
ok('任务标识登记 bookbreak', /'bookbreak'/.test(bridge))
const main = read('electron/main.cjs')
ok('主进程白名单放行 bookbreak', main.includes("'bookbreak'"))

// 承接：不得为了让 ACP 通过而放宽本地核对
const aiSplit = read('src/lib/bookbreak/aiSplit.ts')
ok('行定位核对逻辑未被改动（仍逐字回原文）', aiSplit.includes('buildChaptersFromMarks') && aiSplit.includes('stripEmphasis'))

console.log(`\n—— acpBookbreak 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
