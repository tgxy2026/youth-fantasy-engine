// 手动脚本（不叫 *.test.ts，run-all 不会自动跑）：把全部**已登记** AI 提示词连同正文导出，
// 供「AI 功能梳理 / 提示词审计」建台账（字数 / 估算 token / markdown 星号数）。
//
// 用法：  YFE_TEST_QUIET=1 node tests/build-test.mjs live-promptdump
// 默认输出：.workbuddy/tmp/prompts-dump.json（可用环境变量 PROMPTDUMP_OUT 覆盖）
//
// ⚠️ 输出路径**不能走 process.argv** —— build-test 会把入口名当 argv[2] 传进来，
//    读 argv 会把 dump 写成一个名叫 live-promptdump 的文件。
//
// 🔴 必须 import **4 个注册点**：ai.ts / aiTasks.ts / autoContinue.ts / AIAssist.tsx。
//    `fill-template`、`setting-update-detect`、`assist-planner` 不在 aiTasks 门面里 ——
//    少 import 一个就会静默漏条（见 skill novel-studio-audit-fix 第五轮）。
import '../src/lib/ai'
import '../src/lib/aiTasks'
import '../src/lib/autoContinue'
import '../src/components/AIAssist'
import { listPrompts } from '../src/lib/promptSettings'
import fs from 'node:fs'
import path from 'node:path'

const out = process.env.PROMPTDUMP_OUT || '.workbuddy/tmp/prompts-dump.json'

const rows = listPrompts()
const dump = rows.map(r => ({
  id: r.id,
  group: r.group,
  name: r.name,
  chars: r.text.length,
  tokens: Math.round(r.text.length / 1.6),
  stars: (r.text.match(/\*\*/g) || []).length,
  lines: r.text.split('\n').length,
  text: r.text,
}))

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(dump, null, 2), 'utf8')

const byGroup = new Map<string, typeof dump>()
for (const d of dump) {
  const a = byGroup.get(d.group) ?? []
  a.push(d)
  byGroup.set(d.group, a)
}
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length))
let totalTokens = 0
let totalStars = 0
console.log(`\n共 ${dump.length} 条已登记提示词（导出 → ${out}）\n`)
for (const [g, arr] of byGroup) {
  console.log(`── ${g} ──`)
  for (const d of arr) {
    totalTokens += d.tokens
    totalStars += d.stars
    console.log(`  ${pad(d.id, 26)} ${pad(String(d.chars), 6)}字 ~${pad(String(d.tokens), 5)}tok  **×${d.stars}  ${d.name}`)
  }
}
console.log(`\n合计 ~${totalTokens} tokens · ** 共 ${totalStars} 处`)
