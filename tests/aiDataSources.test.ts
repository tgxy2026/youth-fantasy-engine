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
  const where = componentSrc.find(c => c.text.includes(`feature="${id}"`))?.name
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

console.log(`\n—— aiDataSources 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
