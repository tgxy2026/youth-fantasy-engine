// ============ 3.5.6 · 批量摘要接入 ACP ============
//
// 覆盖：批量摘要整批走 Agent、整批只确认一次、逐章计账不变、界面就绪条件与文案同步。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiChapterSummary } from '../src/lib/aiTasks/jieWenJi'

let pass = 0
let fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 任务层：acpText 分支 ----------
const prompts: string[] = []
const summary = await aiChapterSummary('陈渊借雷劫破境，青铜小塔吞噬雷池。', {
  acpText: async prompt => {
    prompts.push(prompt)
    return '陈渊借雷劫破境，小塔吞噬雷池。'
  },
})
ok('ACP 通道能生成摘要', summary.includes('陈渊') && summary.length > 0)
ok('提示词包含本章正文', prompts.length === 1 && prompts[0].includes('青铜小塔'))
ok('不要求 API 模型配置（acpText 分支先于 requireProviderFor）',
  read('src/lib/aiTasks/jieWenJi.ts').indexOf('if (opts?.acpText)') < read('src/lib/aiTasks/jieWenJi.ts').indexOf("requireProviderFor('review')"))

let emptyError = ''
try {
  await aiChapterSummary('正文', { acpText: async () => '   ' })
} catch (error) {
  emptyError = error instanceof Error ? error.message : String(error)
}
ok('ACP 空输出明确报错', /没有返回可用章节摘要/.test(emptyError))

// ---------- 接线静态契约 ----------
const model = read('src/components/editor/useNovelEditorModel.ts')
const regenAcp = read('src/components/editor/regenAcp.ts')
ok('批量摘要走 ACP 闸门', regenAcp.includes('task: \'batch-summary\'') && regenAcp.includes('acpGatedText'))
ok('整批只确认一次', /askOnce:\s*true/.test(regenAcp))
ok('取消信号沿用任务中心', model.includes('createRegenAcpSend(acpWriting, ctx.signal)'))
ok('只有 ACP 就绪才注入（否则保持 API 路径）', /acpWriting\?\.ready \? createRegenAcpSend/.test(model))
ok('逐章计账执行体未被改写（仍用 runRegenSummaries）', model.includes('runRegenSummaries(all'))
const editor = read('src/components/editor/NovelEditor.tsx')
ok('按钮按写作就绪判断', /disabled=\{!writingReady \|\| !active\}/.test(editor))
ok('未连接时提示 ACP 未连接', editor.includes("acpWriting ? 'ACP 未连接'"))
ok('文案不再写「批量重生成使用 API 模式」', !editor.includes('批量重生成使用 API 模式'))
const bridge = read('src/lib/agentHost/acpBridge.ts')
ok('任务标识登记 batch-summary', bridge.includes("'batch-summary'"))
ok('主进程白名单放行 batch-summary', read('electron/main.cjs').includes("'batch-summary'"))

console.log(`\nACP_BATCH_SUMMARY ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
