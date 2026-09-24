// ============ AI 功能「会读哪些项目数据」声明表的守卫 ============
//
// 这份声明表（src/lib/aiDataSources.ts）是**界面文案的唯一数据源**：各 AI 功能的问号气泡里
// 那段「本次会读」就是它渲染出来的。它有三个容易腐烂的方向，本用例逐个盯住：
//   ① 表里写了没人挂 —— 作者看不到、维护者以为已经做了（最危险）；
//   ② 界面挂了但 id 拼错 —— 组件静默返回 null，气泡里什么都不显示，肉眼极难发现；
//   ③ 条目内容空壳 —— 只写了分组名，没写具体读了什么或边界。
//
// 另外锁住 summarizeSources 的输出格式（概括行是直接给作者看的那一行）。
import fs from 'node:fs'
import path from 'node:path'
import { AI_DATA_SOURCES, sourcesOf, summarizeSources } from '../src/lib/aiDataSources'
import { TABS } from '../src/lib/schema'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① 条目内容非空壳 ----------
for (const [id, f] of Object.entries(AI_DATA_SOURCES)) {
  ok(`${id}：有展示名`, f.label.trim().length > 0)
  ok(`${id}：sources 非空`, f.sources.length > 0)
  // 分组名本身可以承载全部信息（如 { group: '本章正文', items: [] }），所以不要求每组都带 items，
  // 但**整个功能**至少要有一处写出"具体读了什么"或"边界在哪" —— 否则就是空壳条目。
  ok(`${id}：每个分组都有名字`, f.sources.every(s => s.group.trim().length > 0),
    f.sources.filter(s => !s.group.trim()).map(s => JSON.stringify(s)).join('/'))
  ok(`${id}：至少一处写了明细或边界（不是空壳）`,
    f.sources.some(s => s.items.length > 0 || !!s.note),
    f.sources.map(s => s.group).join(' / '))
  ok(`${id}：excludes 若存在则不留空串`,
    !f.excludes || f.excludes.every(x => x.trim().length > 0))
}

// ---------- ② 表里每条都真的被界面引用了 ----------
const componentsDir = path.join(process.cwd(), 'src', 'components')
const componentSrc = fs.readdirSync(componentsDir)
  .filter(f => f.endsWith('.tsx'))
  .map(f => ({ name: f, text: fs.readFileSync(path.join(componentsDir, f), 'utf8') }))

const allComponentText = componentSrc.map(c => c.text).join('\n')

/**
 * 文案已就绪、**但界面尚未挂载**的功能 id —— 即当前进度待办。
 * 挂完后把它从下面这个集合里删掉，这条断言就会开始守它。
 *
 * 当前只剩这两条：它们在酒馆里是**工具条上的按钮**（「整理记忆」「结束本轮对话」），
 * 旁边没有说明位、按钮 title 也塞不进组件 —— 要挂得先给它们设计展示位（如加一个说明气泡）。
 */
const NOT_YET_MOUNTED = new Set([
  'tavern-memory',       // 本场记忆整理
  'tavern-round-end',    // 结束本轮对话
])

/**
 * 由 `jiewenji-panel` 一条汇总覆盖、无需再单独挂载的细分条目。
 * ⚠️ 它们的 sources 仍各自独立维护（粒度更细），只是界面上不再单独展示。
 */
const COVERED_BY_PANEL = new Set([
  'jiewenji-proofread', 'jiewenji-diagnosis', 'jiewenji-rewrite', 'jiewenji-review',
  'jiewenji-ooc', 'jiewenji-advice', 'jiewenji-pleasure', 'jiewenji-opening',
  'jiewenji-brief', 'jiewenji-ledger',
])

for (const [id] of Object.entries(AI_DATA_SOURCES)) {
  if (NOT_YET_MOUNTED.has(id) || COVERED_BY_PANEL.has(id)) continue
  // 2.4.4 六维审计：worldbase / power 由 WorldSetSheet 以 feature={tab.id} **动态**传入
  // （tab.id 限定在 WORLD_SET_TABS 内），源码里没有 feature="worldbase" 字面量 —— 特例放行，
  // 判据改为「页签组件存在且其 feature 取值落在 worldSet 页签里」。
  const dynamicWorldSet = (id === 'worldbase' || id === 'power')
    && componentSrc.some(c => c.name === 'WorldSetSheet.tsx' && c.text.includes('AIDataSourceNote feature={tab.id}'))
  const where = componentSrc.find(c => c.text.includes(`feature="${id}"`))?.name
    ?? (dynamicWorldSet ? 'WorldSetSheet.tsx（feature={tab.id} 动态）' : undefined)
  ok(`🔴 ${id}：已被界面引用（否则作者根本看不到）`, !!where, where ?? '未被任何组件引用')
}

// 进度可见：跑测试时能看到还差多少没挂
if (NOT_YET_MOUNTED.size > 0) {
  console.log(`\n[进度] 文案已就绪、待挂到界面：${NOT_YET_MOUNTED.size} 条 → ${[...NOT_YET_MOUNTED].join(', ')}\n`)
}

// ---------- ③ 界面引用的 id 必须在表里登记（拼错会静默不显示） ----------
const usedIds = new Set<string>()
for (const m of allComponentText.matchAll(/feature="([A-Za-z0-9_-]+)"/g)) usedIds.add(m[1])
for (const id of usedIds) {
  ok(`🔴 界面引用的「${id}」已在声明表登记`, sourcesOf(id) !== null)
}
ok('界面至少引用了 8 处（防止注入被回滚后测试仍绿）', usedIds.size >= 8, `当前 ${usedIds.size} 处：${[...usedIds].join(', ')}`)

// ---------- ④ 未登记 id 的行为 ----------
ok('未登记 id → null（组件据此静默不渲染，而不是崩）', sourcesOf('not-registered-xxx') === null)

// ---------- ⑤ 概括行格式（作者看到的那一行） ----------
ok('概括行：多项的分组带数量',
  summarizeSources({ label: 'x', sources: [{ group: '项目设定资料', items: ['a', 'b', 'c'] }] }) === '项目设定资料（3 项）')
ok('概括行：单个条目的分组不带数量',
  summarizeSources({ label: 'x', sources: [{ group: '本章正文', items: [] }] }) === '本章正文')
ok('概括行：多组用 + 连接',
  summarizeSources({
    label: 'x',
    sources: [{ group: '本章正文', items: [] }, { group: '项目设定资料', items: ['a', 'b'] }],
  }) === '本章正文 + 项目设定资料（2 项）')

// ---------- ⑥ 内容口径抽查：几条最容易写错/最要紧的 ----------
const plot = AI_DATA_SOURCES['tavern-plot']
ok('剧情推演：明确写了防剧透（沉浸档排除作者侧页签）',
  !!plot.excludes?.some(x => x.includes('作者侧页签')), JSON.stringify(plot.excludes))
ok('剧情推演：写清了「背景设定关键词命中才注入」这条边界',
  plot.sources.some(s => s.group.includes('背景设定') && !!s.note?.includes('关键词命中')), '')

const free = AI_DATA_SOURCES['tavern-free']
ok('自由对话：明确写了「不读小说项目设定表」',
  !!free.excludes?.some(x => x.includes('不读小说项目的设定表')), JSON.stringify(free.excludes))

const fill = AI_DATA_SOURCES['fill-template']
ok('AI 补全：点明了世界观上下文只来自 3 张表（不是全部设定）',
  fill.sources.some(s => s.group.includes('3 张表') && !!s.note?.includes('仅此三表')), '')

const inline = AI_DATA_SOURCES['inline-suggest']
ok('AI 伴写：点明了精选设定只有 4 类且不含章节目录',
  inline.sources.some(s => s.group.includes('4 类') && !!s.note?.includes('不含章节目录')), '')

// ---------- ⑦ 别向作者承诺"不外发" ----------
// 拆书与创意写作都支持云端模型（作者选了云端，内容就会离开本机）。
// 笼统一句「全程本地模型，不外发」是**误导性声明**：作者据此决定要不要用它拆自己没发表的稿子时，
// 会得到一个错误的安心。这里锁住"发给当前选定的模型"这个诚实口径，防止将来又被写回去。
for (const id of ['bookbreak', 'creative-writing', 'chapter-rewrite']) {
  const f = AI_DATA_SOURCES[id]
  const says = (f.excludes ?? []).join(' ／ ')
  ok(`🔴 ${id}：说明的是「发给当前选定的模型」，不是笼统的"不外发"`,
    says.includes('当前选定') && !says.includes('全程本地模型'),
    says || '(excludes 为空)')
}

ok('创意写作：写清了「只做大纲规划」不写正文这条边界',
  !!AI_DATA_SOURCES['creative-writing'].excludes?.some(x => x.includes('只做大纲规划')),
  JSON.stringify(AI_DATA_SOURCES['creative-writing'].excludes))

const cr = AI_DATA_SOURCES['chapter-rewrite']
ok('整章改写：点明送进模型的是「整章正文」（区别于选区改稿的一段）',
  !!cr?.sources.some(s => s.group.includes('整章')), JSON.stringify(cr?.sources.map(s => s.group)))
ok('整章改写：写清了「改动前不写库、写前留快照」这条安全边界',
  !!cr?.excludes?.some(x => x.includes('快照')), JSON.stringify(cr?.excludes))

// ---------- ⑧ 页签说明里同样不许承诺"不外发" ----------
// 上一节只锁住了 `AI_DATA_SOURCES[id].excludes`，而**功能说明（schema 的 description）一样会显示给作者**
// （功能选择弹窗 / 页签说明里都能读到）。2026-09-19 六维审计实测：`bookbreak` 的 description
// 写着「全程本地模型，原文不外发」—— 而它明明支持云端模型。误导只差一层没被闸住，这里补上。
//
// 口径（与 aiDataSources 一致）：**发给「当前选定的那个模型」** ——
// 本地不出本机，云端上传到该服务商。绝对化的「不外发 / 不上传 / 全程本地」一律不许写。
// ⚠️ 只禁绝对承诺：正确口径里也会出现「本地模型不出本机」，所以不能用"不出本机"当判据。
//
// 🔴 2026-09-21（A4）修掉一处**闸自己的盲区**：原先只查 `description`，而 `tips`
//    同样显示给作者（页签说明区）。写「创作轨迹」文案时实测 —— "也不上传任何数据"
//    写在 tips 里，闸**一句都没报**。工具的结构假设会静默失明：它认 description，不认 tips。
//    现在两者一起查。
const ABSOLUTE_PROMISE = /全程本地|不外发|不上传|绝不外发|纯本地/
for (const t of TABS) {
  const d = t.description ?? ''
  if (d.trim()) {
    ok(`🔴 页签说明 ${t.id}：不向作者作绝对化的"不外发"承诺`,
      !ABSOLUTE_PROMISE.test(d), d.slice(0, 80))
  }
  const tipsText = (t.tips ?? []).join('\n')
  if (tipsText.trim()) {
    ok(`🔴 页签说明 tips ${t.id}：同样不作绝对化的"不外发"承诺`,
      !ABSOLUTE_PROMISE.test(tipsText), tipsText.slice(0, 80))
  }
}

// ============ ⑨ items 里的「表名」必须真的是 schema 的真名 ============
//
// 为什么必须闸：aiDataSources.ts 第 50 行就给维护者写了这条规矩
//（「这里的名字必须是 schema 的**真名**（`TABS[].name`）」），但**规矩本身没人守** ——
// 2026-09-19 六维审计 P1-8 命中过一次（「世界观设定 / NPC 角色 / 术语表」三个别名），
// 2026-09-22 六维审计又在同一个文件的 `jiewenji-ooc` 里命中 `'NPC 角色'`（真名 `NPC角色`，
// 多一个空格）—— 修 P1-8 时漏了这一处，而当时**没有任何测试能发现它**。
//
// 判据：`items` 里凡"看起来像表名"的条目（不以「的/状态/清单」等词结尾的短名词短语），
//       必须 ∈ TABS 的 name 集合。
//
// ⚠️ 刻意**不做全量强校验**：有些 items 是合法的**派生数据概念**（如「未回收伏笔」
//    「出场角色状态」——它们是程序汇总出来的，不是某张表的 name）。全量强校验会把这些
//    正确写法误判成错误。折中方案：用「与真名的编辑距离 ≤1 且长度接近」来抓**拼写近似**
//    的别名（`NPC 角色` vs `NPC角色` 正好是 1 个空格差），既能抓真 bug、又不误伤派生概念。
const TAB_NAMES: string[] = TABS.map(t => t.name)
const TAB_NAME_SET = new Set(TAB_NAMES)

/** 去掉空格/空白后比较（`NPC 角色` → `NPC角色`） */
const squash = (s: string) => s.replace(/\s+/g, '')

for (const [id, f] of Object.entries(AI_DATA_SOURCES)) {
  for (const s of f.sources) {
    for (const item of s.items) {
      // 真名直接通过
      if (TAB_NAME_SET.has(item)) continue
      // 允许带序号/修饰的真名写法（如「角色卡 · 主要角色」）—— 逐段拆开看是否含真名
      if (TAB_NAMES.some(n => item.includes(n))) continue
      // 剩下的：只揪「去掉空白后与某个真名完全相同」的 —— 那是纯拼写/空格别名，一定是笔误
      const hit = TAB_NAMES.find(n => squash(n) === squash(item))
      ok(`🔴 ${id}：items「${item}」不是 schema 真名的别名写法（真名「${hit ?? '?'}」）`,
        !hit,
        hit ? `应写「${hit}」（当前「${item}」多了空格等差异）` : '')
    }
  }
}

// ============ 全局排除项（保密等级 D 级）必须真的渲染出来 ============
// 只写在文档里没用 —— 作者是看界面气泡的。这里静态确认「不读」清单里追加了 AI_PRUNE_NOTE，
// 防的正是"哪天有人重构 AIDataSourceNote 时把这一行删了、没人发现"。
{
  const note = componentSrc.find(c => c.name === 'AIDataSourceNote.tsx')
  ok('🔴 D 级排除项被渲染进「不读」清单（不是只写在文档里）',
    !!note && note.text.includes('AI_PRUNE_NOTE') && note.text.includes('f.excludes'),
    note ? '' : 'AIDataSourceNote.tsx 未在组件目录中找到')
}

console.log(`\n—— aiDataSources 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
