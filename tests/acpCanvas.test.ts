// ============ 3.5.6 · 情节推演画布 AI 生成接入 ACP ============
//
// 覆盖：画布「生成推演」在 ACP 就绪时不再要求 API 模型；复用 briefing 同一条管线；
// 简报解析与卡片布局判据不变；空报告不得当成可用结果。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiBriefing } from '../src/lib/aiTasks/jieWenJi'

let pass = 0
let fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 任务层：简报 ACP 分支 ----------
const prompts: string[] = []
const report = await aiBriefing('【设定】青石巷、青铜剑宗', '章节：第一章\n事件：陈渊捡到青铜铃', {
  acpText: async prompt => {
    prompts.push(prompt)
    return '## 待办伏笔\n- 青铜铃的来历\n## 钩子爽点\n- 铃中剑鸣'
  },
})
ok('简报走 ACP 并原样带回正文', report.report.includes('青铜铃的来历'))
ok('提示词带设定资料与本章要素', prompts[0].includes('青石巷') && prompts[0].includes('陈渊捡到青铜铃'))
ok('提示词带简报系统说明（复用同一套提示词）', /简报/.test(prompts[0]))

let emptyRejected = false
try {
  await aiBriefing('设定', '章节', { acpText: async () => '   ' })
} catch { emptyRejected = true }
ok('空报告直接报错，不冒充可用简报', emptyRejected)

// ---------- 画布组件接线（静态契约） ----------
const canvas = read('src/components/outline/PlotCanvas.tsx')
ok('画布按写作就绪判断（API 或 ACP）', /writingReady\s*=\s*ai\.ready \|\| !!acpWriting\?\.ready/.test(canvas))
ok('生成入口用 writingReady 拦截', /if \(!writingReady \|\| generating\) return/.test(canvas))
ok('按钮禁用条件同步为 writingReady', /disabled=\{!writingReady \|\| generating != null\}/.test(canvas))
ok('ACP 闸门任务标识复用 briefing（同一条管线）', canvas.includes('acpGatedText') && canvas.includes("task: 'briefing'"))
ok('闸门文案如实写明只发章节要素/摘要与设定资料', /所选各章的章节要素（或压缩摘要）与设定资料/.test(canvas))
ok('整批只确认一次', /askOnce:\s*true/.test(canvas))
ok('简报调用透传 acpText', /aiBriefing\(projCtx, ctx, acpText \? \{ acpText \} : undefined\)/.test(canvas))
ok('卡片解析与布局判据未变（parseBriefing + 每章一列）', canvas.includes('parseBriefing(res.report') && canvas.includes('colX = baseX + i * 360'))
ok('生成期仍有「30–90 秒」耐心提示（不冒充卡死）', canvas.includes('30–90 秒'))
ok('画布仍复用同一 AI 管线（不另起孤岛）', canvas.includes("from '@/lib/ai/aiTasks'") && !canvas.includes('requireProviderFor'))

console.log(`\n—— acpCanvas 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
