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

// ---------- ② 不该加全局守卫的两处 —— 防"顺手补上"造成误禁 ----------
//
// 🔴 这两处的模型来源**不是全局活动模型**，用 useAIReady 守卫会把「配置有效」的场景禁掉：
//    · InterviewChat：实际发请求的是调用方给的 `callChat`（酒馆用会话指定的模型）；
//    · TavernFree：酒馆可指定自己的面板默认模型（defaultProviderId）而全局活动模型为空。
//
// ⚠️ 但「不许用全局判据」不等于「干脆别加守卫」—— 那会退回 F1 原意（点了才知道不行）。
//    所以这里同时要求：酒馆这条链**必须有一个同源的替身判据**（`useTavernReady`），
//    并有自己的单测（tests/tavernReady.test.ts，含负面对照）证明它读的是酒馆那条链。
{
  ok('🔴 InterviewChat 不加全局就绪守卫（模型由调用方 callChat 决定，加会误禁酒馆场景）',
    !/useAIReady/.test(read('src/components/InterviewChat.tsx')))
  ok('🔴 TavernFree 不加全局就绪守卫（酒馆可指定自身 provider，加会误禁）',
    !/useAIReady/.test(read('src/components/TavernFree.tsx')))
  // ⚠️ 只查 `useTavernReady.ts` 里**有没有 import** 全局 hook（而不是全文出现该词）——
  //    它的文件头注释**必须**能解释"为什么不要用那个"，写成全文禁词会把说明本身判违规。
  const readyHook = read('src/components/useTavernReady.ts')
  ok('🔴 酒馆就绪守卫走的是**自己的** provider 链（useTavernReady），而非删掉守卫了事',
    /useTavernReady/.test(read('src/components/useTavernFreeModel.tsx'))
    && /export function useTavernReady/.test(readyHook)
    && !/from '[^']*useAIReady'/.test(readyHook))
  ok('🔴 就绪判据与真实发请求同源（都经 resolveTavernProvider 的三层兜底链）',
    /resolveTavernProvider/.test(read('src/lib/tavern/provider.ts'))
    && /export async function checkTavernReady/.test(read('src/lib/tavern/provider.ts')))
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

// ---------- 2026-09-20 晚间：列宽拖拽崩溃（老大报障）+ 卡片文案参数化 ----------
{
  // 报障原文：TypeError: Cannot read properties of null (reading 'col') @ 打开表格页签调列宽。
  // 根因：setColWidths 的 updater 是**延迟执行**的（React 在渲染阶段才调用），
  // 到那时 mouseup 早已把 dragRef.current 置空，而 updater 里还写 [dragRef.current!.col]。
  // ⚠️ `!` 只是 TS 断言、编译后没有运行时保护 ——「上一步 if 判过非空」救不了下一步。
  const tsModel = read('src/components/useTableSheetModel.ts')
  // ⚠️ 判据要精确到 **updater 那一行**：文件注释里刻意保留了反例写法（`[dragRef.current!.col]`）
  // 来解释历史 bug，宽泛正则会把注释本身也算成违规（第一版就这么假 FAIL 了一次）。
  ok('🔴 列宽 updater 用的是同步捕获的局部量（而非延迟读取的 dragRef.current）',
    /setColWidths\(prev => \(\{ \.\.\.prev, \[d\.col\]: w \}\)\)/.test(tsModel)
    && !/setColWidths\(prev => \(\{ \.\.\.prev, \[dragRef\.current!?\.col\]/.test(tsModel))
  ok('🔴 拖拽上下文在回调开头就同步捕获（范式同 useSvgPanZoom / PlotCanvas）',
    /const d = dragRef\.current[\s\S]{0,40}if \(!d\) return/.test(tsModel))

  // 起因：CharacterSheet 从 1.x 起只服务角色卡、文案里写死了「角色」；
  // 2.3.0 新增「其他设定」（世界构建组，卡片型）后同一组件也服务非角色卡片表，
  // 于是「新建角色 / 请输入角色姓名」全成了错话（老大实测：功能没问题，文案全是新建角色）。
  const cs = read('src/components/CharacterSheet.tsx')
  ok('🔴 CharacterSheet 的卡片文案按页签参数化（照 OutlineSheet 的 noun 范式）',
    /const isCharTab = tab\.group === '角色管理'/.test(cs) && /const noun = isCharTab/.test(cs))
  // ⚠️ 同样要精确：注释里举例提到过「新建角色」（用的是中文引号），那不算违规
  ok('🔴 新建按钮 / 改名弹窗不再写死「新建角色」',
    !/<Plus size=\{14\} \/> 新建角色/.test(cs) && !/'新建角色'/.test(cs) && !/'修改角色姓名'/.test(cs))
  ok('🔴 改名弹窗不再写死「请输入角色姓名」', !/请输入角色姓名/.test(cs))
  ok('🔴 删除确认不再写死「删除角色卡」', !/title: '删除角色卡'/.test(cs))
  ok('🔴 「隐藏已退场」只对角色卡渲染（非角色卡片表没有「人物状态」字段，开关点了也没用）',
    /\{isCharTab && \(/.test(cs))
}

console.log(`\n—— uiUxGuards 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
