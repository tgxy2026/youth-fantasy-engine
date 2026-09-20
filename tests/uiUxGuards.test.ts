// ============ 界面 UX 护栏（2026-09-20 六维审计 F1 + 文案一致性） ============
//
// 这两类问题都**不是**功能 bug：
//   · F1 的「缺就绪守卫」—— 点了确实有 catch → toast 兜底，只是"点了才知道不行"；
//   · 文案类 —— 只是措辞／与实现略有出入。
// 但都属于"用户能直接感到别扭"的一类，且**极容易在后续改动里悄悄回退**
// （回退后不会有任何报错，界面照常工作）。静态断言成本极低，所以钉住。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const read = (rel: string) => {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— uiUxGuards 用例开始 ——')

// ---------- ① AI 入口的就绪守卫（F1，只给「判据一致」的三处加） ----------
//
// 🔴 加守卫的前提是**判据与真实调用链一致**，否则会误禁（比不加更糟：用户以为功能坏了）。
//    这三处都只走 `requireActiveProvider()`（全局活动模型），与 `useAIReady` 的判据相同：
//      · AIOrganize      → aiTasks/organize.ts
//      · AITemplateFill  → ai.ts aiCompleteTemplate
//      · BookBreakPanel  → aiTasks/extract.ts + formSummary.ts
{
  const cases: [string, string][] = [
    ['src/components/AIOrganize.tsx', '开始整理'],
    ['src/components/AITemplateFill.tsx', '生成补全'],
    ['src/components/BookBreakPanel.tsx', '开始抽取'],
  ]
  for (const [file, label] of cases) {
    const s = read(file)
    ok(`🔴 ${label}：未配置模型时预先禁用（useAIReady）`,
      /const \{ ready: aiReady \} = useAIReady\(\)/.test(s), file)
    ok(`  · ${label}：禁用条件里带 !aiReady`,
      /disabled=\{[^}]*!aiReady[^}]*\}/.test(s), file)
    ok(`  · ${label}：禁用时给出统一提示（AI_DISABLED_HINT）`,
      /AI_DISABLED_HINT/.test(s), file)
  }
}

// ---------- ② 不该加守卫的两处 —— 防"顺手补上"造成误禁 ----------
//
// 🔴 这两处的模型来源**不是全局活动模型**，用 useAIReady 守卫会把「配置有效」的场景禁掉：
//    · InterviewChat：实际发请求的是调用方给的 `callChat`（酒馆用会话指定的模型）；
//    · TavernFree：酒馆可指定自己的面板默认模型（defaultProviderId）而全局活动模型为空。
{
  ok('🔴 InterviewChat 不加全局就绪守卫（模型由调用方 callChat 决定，加会误禁酒馆场景）',
    !/useAIReady/.test(read('src/components/InterviewChat.tsx')))
  ok('🔴 TavernFree 不加全局就绪守卫（酒馆可指定自身 provider，加会误禁）',
    !/useAIReady/.test(read('src/components/TavernFree.tsx')))
}

// ---------- ③ 文案一致性 ----------
{
  ok('🔴 界面不再出现已下线的「便携版」字样',
    !/便携版/.test(read('src/components/SearchSettingsPanel.tsx')))

  const saveTitles = ['CharacterSheet', 'FormSheet', 'OutlineSheet', 'TableSheet']
    .map(f => read(`src/components/${f}.tsx`))
  ok('🔴 保存按钮空态提示统一为「无未保存的改动」（原先两种口径混用）',
    saveTitles.every(s => !/无未保存修改/.test(s)) && saveTitles.every(s => /无未保存的改动/.test(s)))

  ok('🔴 「本章写作简报」口径统一（PlotCanvas 不再叫「灵感简报」）',
    !/灵感简报/.test(read('src/components/PlotCanvas.tsx')))

  ok('🔴 用户可见处不再出现「占位 / 待替换」这类开发期字样',
    !/占位|待替换/.test(read('src/lib/schema.ts'))
    && !/占位内容/.test(read('src/components/AboutPage.tsx'))
    && !/待作者替换/.test(read('src/components/AboutPage.tsx'))
    && !/示例占位（/.test(read('src/components/AboutPage.tsx')))

  ok('🔴 ProjectHub 的必选说明与 FEATURE_TIER 一致（拆书 / 创意写作可取消）',
    /拆书与创意写作默认不勾选/.test(read('src/components/ProjectHub.tsx')))
}

console.log(`\n—— uiUxGuards 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
