/**
 * 「创意写作」两种起点 + 融合后约束的防回滚闸。
 *
 * 这些断言的价值不在"测逻辑"（逻辑靠实机验），而在**钉住结构**：
 * 融合是把两个功能并成一个，最容易出的问题不是写错，而是**某天被人悄悄改回去**
 * （比如又把续写挂回灵感启发页、又把拆书/创意写作设成默认勾选、又在界面文案里写 markdown 星号）。
 * 本文件跑在 CI 基线里（`tests/run-all.mjs`），改了这些地方就会红。
 */
import { CONTINUE_STAGES, CREATIVE_STAGES } from '../src/lib/aiWorkflow'
import { DEAI_TEMPLATES } from '../src/lib/autoContinue'
import { FEATURE_TIER, DEFAULT_IDS } from '../src/lib/schema'
import { AI_DATA_SOURCES } from '../src/lib/aiDataSources'
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const ROOT = process.cwd()
const read = (rel: string) => {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

console.log('\n—— creativeModes 用例开始 ——')

// ============ ① 阶段表：两种起点各跑什么 ============
{
  const cont = CONTINUE_STAGES.map(s => s.id)
  const scr = CREATIVE_STAGES.map(s => s.id)
  ok('🔴「接着已有内容写」只跑连写一步（不重跑设定奠基与分卷大纲）',
    cont.length === 1 && cont[0] === 'draft', cont.join(','))
  ok('「从一句话创作」三步齐（设定奠基 → 分卷大纲 → 逐章连写）',
    scr.join(',') === 'bible,outline,draft', scr.join(','))
  ok('两条路线的连写阶段 id 相同（共用同一执行体，融合的关键）',
    scr.includes('draft') && cont.includes('draft'))
  ok('每个阶段都有中文显示名（节点时间线要用）',
    [...CONTINUE_STAGES, ...CREATIVE_STAGES].every(s => !!s.label.trim()))
}

// ============ ② 去 AI 味儿模板：自定义那一条必须是空提示词 ============
{
  const ids = DEAI_TEMPLATES.map(t => t.id)
  ok('内置 3 套 + 自定义 1 条', ids.length === 4 && ids.includes('custom'), ids.join(','))
  const custom = DEAI_TEMPLATES.find(t => t.id === 'custom')
  ok('自定义项本身不带提示词（运行时取输入框内容）', custom?.prompt === '')
  ok('其余模板都有实质提示词（≥ 50 字）',
    DEAI_TEMPLATES.filter(t => t.id !== 'custom').every(t => t.prompt.length >= 50))
}

// ============ ③ 功能档位：两者都不再默认勾选（老大 2026-09-19 要求） ============
{
  ok('🔴「一键拆书」不默认勾选（optional）', FEATURE_TIER['bookbreak'] === 'optional', String(FEATURE_TIER['bookbreak']))
  ok('🔴「创意写作」不默认勾选（optional）', FEATURE_TIER['creative-writing'] === 'optional', String(FEATURE_TIER['creative-writing']))
  ok('DEFAULT_IDS 里确实没有它们',
    !DEFAULT_IDS.includes('bookbreak') && !DEFAULT_IDS.includes('creative-writing'),
    DEFAULT_IDS.join(','))
}

// ============ ④ 数据源：auto-continue 已并入 creative-writing ============
{
  ok('🔴 数据源声明里不再有独立的 auto-continue（已并入创意写作）',
    !('auto-continue' in AI_DATA_SOURCES), Object.keys(AI_DATA_SOURCES).join(',') === '' ? '' : 'creative-writing 等')
  const cw = AI_DATA_SOURCES['creative-writing']
  ok('创意写作的数据源含「上一章结尾」（接着写的锚）',
    !!cw?.sources.some(s => s.group.includes('上一章结尾')))
  ok('创意写作的数据源含「最近 3 章摘要」（把握走向）',
    !!cw?.sources.some(s => s.group.includes('最近 3 章摘要')))
  ok('创意写作的「不读」里写明：其它章节原文走摘要',
    !!cw?.excludes?.some(x => x.includes('走摘要')))
}

// ============ ⑤ 防回滚：删掉的东西不许回来 ============
{
  ok('🔴 AutoContinue 组件已删除（能力已并入创意写作）',
    !fs.existsSync(path.join(ROOT, 'src/components/AutoContinue.tsx')))
  const inspire = read('src/components/InspireTools.tsx')
  ok('🔴 灵感启发页不再引用续写组件', !inspire.includes('AutoContinue'))
  ok('灵感启发页副标题已去掉「AI 一键续写」',
    inspire.includes('随机取名生成器 · AI 辅助规划'))
  ok('🔴 灵感启发帮助文案不再提示「功能迁移到哪了」（界面/提示不留迁移指南）',
    !/已并入|已移到|已迁到|搬到「/.test(inspire))

  const session = read('src/lib/creativeSession.ts')
  ok('会话层存在（切页签不丢状态的根）', session.length > 0)

  // ---------- 产出目标在起点（2026-09-19：开口就分清大纲规划 / 正文创作）----------
  const panel = read('src/components/CreativeWritingPanel.tsx')
  ok('🔴 起点处可选「产出目标」（只做大纲规划 / 大纲 + 正文）',
    /TARGET_META/.test(panel) && /updateInputs\(\{ target: k \}\)/.test(panel))
  ok('🔴 闸门②不再问「只保存大纲」（目标已在起点定，闸门只做确认/放弃）',
    !/outline-only/.test(panel) && !/outline-only/.test(read('src/lib/aiWorkflow.ts')))
  ok('CreativeInputs 带 target 字段', /target: CreativeTarget/.test(session))
  ok('aiWorkflow 按 target 决定是否跑正文阶段', /opts\.target \?\? 'full'/.test(read('src/lib/aiWorkflow.ts')))

  // ---------- 整章改写（2026-09-19）----------
  // ⚠️ 2026-09-19 D1：整章改写的实体（含提示词）已从 aiTasks.ts 拆到 aiTasks/rewrite.ts。
  //    登记形态也从「registerPrompt({...}) 调用」变成「PROMPTS 数组里的 meta」——
  //    故这里同时断言「域里有 meta」+「门面 PROMPT_ORDER 里有它」，强度不降。
  const rw = read('src/lib/aiTasks/rewrite.ts')
  ok('🔴 整章改写的提示词已登记（可在「模型设置 → AI 提示词」里改）',
    /meta: \{ id: 'chapter-rewrite'/.test(rw) && /'chapter-rewrite'/.test(read('src/lib/aiTasks.ts')))
  ok('🔴 整章改写走纯文本输出（不塞 JSON —— 长文塞 JSON 会被转义搞坏）',
    /aiRewriteChapter/.test(rw) && !/aiRewriteChapter[\s\S]{0,900}json: true/.test(rw))
  const rwLib = read('src/lib/chapterRewrite.ts')
  ok('🔴 写库前必存快照（旧稿可恢复）', /createSnapshot/.test(rwLib))
  ok('🔴 只改 content/wordCount/updatedAt，不动标题与卷属',
    /content: body, wordCount: words, updatedAt: Date.now\(\)/.test(rwLib))
  ok('改字数后同步章节台账', /syncChapterMaster/.test(rwLib))
  const sess = read('src/lib/creativeSession.ts')
  ok('🔴 写入后的提示指向「时光机 · 本章版本历史」（旧稿可恢复要告诉作者）',
    /时光机/.test(sess))
  ok('🔴 上一章衔接样本取尾部（不是开头）', /slice\(-1200\)/.test(rw))
  // ---------- 续排细纲（方案 B）+ 历史章/最新章分治（2026-09-19 老大要求）----------
  const wf = read('src/lib/aiWorkflow.ts')
  ok('🔴 接着写可续排细纲：阶段表有「续排细纲」',
    /CONTINUE_OUTLINE_STAGES/.test(wf) && /label: '续排细纲'/.test(wf))
  ok('🔴 续排起点看正文写到哪（不是细纲最大章号）', /const fromNo = writtenNo \+ 1/.test(wf))
  ok('🔴 细纲已覆盖下一章时跳过续排（不重复排）', /outlines\.has\(fromNo\)/.test(wf))
  ok('续排产物复用 commitOutline（同名卡跳过，已有章不会被覆盖）', /commitOutline\(result/.test(wf))
  ok('🔴 整章改写按最新章 / 历史章分治',
    /CHAPTER_REWRITE_HISTORY_RULE/.test(rw) && /CHAPTER_REWRITE_LATEST_RULE/.test(rw) && /o\.isLatest \?/.test(rw))
  ok('🔴 历史章纪律写明「不得改动设定类内容」',
    /HISTORY_RULE = `[\s\S]{0,900}设定类内容/.test(rw) || /绝对不能做的/.test(rw))
  ok('🔴 最新章落库后补跑设定同步（历史章不跑）',
    /if \(r\.isLatest\)/.test(sess) && /extractAndCommitSettings/.test(sess))
  ok('🔴 最新章判定＝候选列表最后一章', /idx === cands\.length - 1/.test(sess))
  // ⚠️ 2026-09-19 D1：`extend-outline` 随「续排细纲」落 aiTasks/creative.ts，不在 rewrite.ts。
  //    这里三层都查：域里有 meta → 门面 PROMPT_ORDER 有 id（= 真的会出现在设置页）。
  const cr = read('src/lib/aiTasks/creative.ts')
  const facade = read('src/lib/aiTasks.ts')
  ok('三条新提示词都登记了（可在模型设置里改）',
    /'chapter-rewrite-history'/.test(rw) && /'chapter-rewrite-latest'/.test(rw) && /'extend-outline'/.test(cr) &&
    ['chapter-rewrite-history', 'chapter-rewrite-latest', 'extend-outline'].every((id) => facade.includes(`'${id}'`)))

  // 2026-09-19 第二轮：判定基准由「原文的固定占比」改为「期望字数」——
  // 旧口径对**精简**是结构性误判（压到目标字数必然远低于原文 → 必被锁住替换），
  // 对**扩写**方向的严重缩水又漏判。判定逻辑已抽成 chapterRewrite 里的两个纯函数（见 chapterRewrite 用例 ⑦）。
  ok('🔴 异常结果判定以「期望字数」为基准（润色＝原文 / 扩写·精简·改写＝目标字数）',
    /isSuspectRewrite\(fromWords, outWords, expectWords\)/.test(sess)
    && /export function expectedRewriteWords/.test(rwLib)
    && /export function isSuspectRewrite/.test(rwLib))
  ok('🔴 会话层不 import 组件（lib → components 是反向依赖，会被 importCycles 拦）',
    !/from '\.\.\/components\//.test(session))
  ok('会话层用 useSyncExternalStore 订阅（React 18 标准姿势）',
    session.includes('useSyncExternalStore'))

  const deal = read('src/components/NewProjectAdvice.tsx')
  ok('新建项目提示条存在', deal.length > 0)
  // 只检查**渲染用的文案块**：文件头注释里出现「**」是给读代码的人看的，不影响界面
  const dealText = deal.slice(deal.indexOf('const CONTENT'), deal.indexOf('export default'))
  ok('🔴 提示条文案不含 markdown 星号（界面是纯文本渲染，星号会原样露出）',
    !/\*\*/.test(dealText), (dealText.match(/\*\*[^*]{0,20}/) || [''])[0])
  const bb = read('src/components/BookBreakPanel.tsx')
  const cwp = read('src/components/CreativeWritingPanel.tsx')
  ok('🔴 拆书页挂了提示条', bb.includes('<NewProjectAdvice kind="bookbreak" />'))
  ok('🔴 创意写作页挂了提示条', cwp.includes('<NewProjectAdvice kind="creative-writing" />'))
  ok('两个提示条都点名了「完整项目」（老大要求的"开启全部功能"的准确说法）',
    deal.includes('完整项目'))
}

// ============ ⑥ 界面文案纪律：不许再承诺"开发中"的幽灵功能 ============
{
  const schema = read('src/lib/schema.ts')
  const cwDesc = (schema.match(/id: 'creative-writing'[\s\S]{0,200}?description: '([^']+)'/) || [])[1] ?? ''
  ok('创意写作页签说明已更新为「两种起点」', /接着项目已有内容往下续写/.test(cwDesc), cwDesc.slice(0, 40))
  ok('🔴 页签说明里不再有「（开发中）」这类幽灵功能承诺', !/开发中/.test(cwDesc))
}

console.log(`\n—— creativeModes 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
