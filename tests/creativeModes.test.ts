/**
 * 「创意写作」两种起点 + 融合后约束的防回滚闸。
 *
 * 这些断言的价值不在"测逻辑"（逻辑靠实机验），而在**钉住结构**：
 * 融合是把两个功能并成一个，最容易出的问题不是写错，而是**某天被人悄悄改回去**
 * （比如又把续写挂回灵感启发页、又把拆书/创意写作设成默认勾选、又在界面文案里写 markdown 星号）。
 * 本文件跑在 CI 基线里（`tests/run-all.mjs`），改了这些地方就会红。
 */
import { CONTINUE_DRAFT_STAGES, CONTINUE_PLAN_STAGES, CREATIVE_STAGES } from '../src/lib/aiWorkflow'
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

// ============ ① 阶段表：两阶段各自跑什么（2026-09-20 长篇分批改造后） ============
{
  const plan = CONTINUE_PLAN_STAGES.map(s => s.id)
  const draft = CONTINUE_DRAFT_STAGES.map(s => s.id)
  const scr = CREATIVE_STAGES.map(s => s.id)
  ok('「从零创作」三步齐（设定奠基 → 分卷大纲 → 逐章连写）',
    scr.join(',') === 'bible,outline,draft', scr.join(','))
  ok('🔴 接着写 +「只做大纲规划」只跑续排大纲（不写正文）',
    plan.length === 1 && plan[0] === 'outline', plan.join(','))
  ok('🔴 接着写 +「只生成正文」只跑连写（不重排大纲）',
    draft.length === 1 && draft[0] === 'draft', draft.join(','))
  ok('两条路线的连写阶段 id 相同（共用同一执行体，融合的关键）',
    scr.includes('draft') && draft.includes('draft'))
  ok('每个阶段都有中文显示名（节点时间线要用）',
    [...CONTINUE_PLAN_STAGES, ...CONTINUE_DRAFT_STAGES, ...CREATIVE_STAGES].every(s => !!s.label.trim()))
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

  // ---------- 产出目标（2026-09-19 起：开口就分清"只要规划"还是"连正文一起写"）----------
  const panel = read('src/components/CreativeWritingPanel.tsx')
  ok('🔴 先选篇幅、再选「这一次要产出什么」',
    /LENGTH_META/.test(panel) && /TARGETS_BY_LENGTH/.test(panel) && /updateInputs\(\{ target: k \}\)/.test(panel))
  // ---------- 长篇分批（2026-09-20 老大要求）----------
  ok('🔴 面板不再有「起点」按钮组（起点按项目现状自动判定，作者不必选）',
    !/MODE_META/.test(panel) && !/MODES\.map/.test(panel))
  ok('🔴 中长篇不提供「大纲 + 正文」一次跑完（必须分两阶段做）',
    /short: \['outline', 'full'\]/.test(panel) && /long: \['outline', 'draft'\]/.test(panel))
  ok('🔴 面板读项目现状探针（状态行与输入框显隐都靠它）', /probeCreativeProject/.test(panel))
  ok('🔴 旧的「先续排细纲」开关已删除（细纲必须先排好，正文只管写）',
    !/extendOutline/.test(panel) && !/extendOutline/.test(read('src/lib/creativeSession.ts')) && !/extendOutlineFirst/.test(read('src/lib/aiWorkflow.ts')))
  ok('🔴 分卷大纲卡带「本卷章号范围」字段（正文切卷的唯一依据）',
    /f\('本卷章号范围'/.test(read('src/lib/schema.ts')))
  ok('🔴 章号范围由系统算（fillChapterRanges 是纯函数，可测）',
    /export function fillChapterRanges/.test(read('src/lib/outlineCard.ts')))
  ok('🔴 切篇幅时把产出目标一起映射（否则会留下"当前篇幅下不存在的档"：按钮不亮、提示却在讲它）',
    /onPickLength/.test(panel) && /TARGETS_BY_LENGTH\[l\]/.test(panel))
  ok('🔴 「只生成正文」需要有已排好的大纲（如实报错，不静默改成"先排大纲"）',
    /target === 'draft' && !probe\.hasOutline/.test(read('src/lib/aiWorkflow.ts')))
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
  // 2026-09-20 长篇分批改造：以下五条钉住新的口径，防的是"某天被改回旧实现"
  // ⚠️ 2026-09-20 二次改造：起点多了一支「缺口优先」（先把没排满的卷补完，再谈新卷）。
  //    断言从"恒等于 maxOutlineNo + 1"改成"两支都对"—— 这是**口径变更**，不是放宽判据。
  ok('🔴 续排起点看「已排到哪」（＝已有细纲最大章号 + 1；有缺口时＝缺口起点）—— 旧口径看正文，纯排大纲时必卡死',
    /const fromNo = sealing \? sealing\.gapFrom : probe\.maxOutlineNo \+ 1/.test(wf))
  ok('🔴 起点由项目现状自动判定（不再让作者手选"从一句话创作 / 接着写"）',
    /probeCreativeProject\(\)/.test(wf) && /probe\.hasOutline \? 'continue' : 'scratch'/.test(wf))
  ok('🔴 每卷章号范围由系统算（fillChapterRanges），且带**实际章数**防"幽灵卷范围"',
    /fillChapterRanges\(raw\.volumes, fromNo, perVolume, raw\.chapters\.length\)/.test(wf))
  ok('🔴 产出不足要重试并把差额告知模型（它有时写一半就收尾，而 JSON 是闭合的）',
    /askOnce\(true, first\.chapters\.length\)/.test(read('src/lib/aiTasks/creative.ts')))
  ok('🔴 接续提示词点明「这是长篇连载的其中一段，不是全书结局」（防模型写成大结局）',
    /不是全书结局/.test(read('src/lib/aiTasks/creative.ts')))
  ok('🔴 正文按大纲切卷（volumeIdFor 交给 runAutoContinue，否则第 21 章留在卷一）',
    /volumeIdFor: await buildChapterVolumeIndex\(\)/.test(wf))
  ok('🔴 从零排与接续排共用同一个入口（aiPlanOutline），旧的成对实现不许回来',
    /aiPlanOutline\(material/.test(wf) && !/aiExtendOutline/.test(wf) && !/aiGenerateOutline/.test(wf))
  ok('大纲落库复用 commitOutline（同名卡跳过，已有章不会被覆盖）', /commitOutline\(outline/.test(wf))
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

  // ---------- 缺口优先 + 卷大纲补全 + 正文补齐（2026-09-20 二次改造，老大要求）----------
  // 钉住的是三件事的**实现接线**（纯函数行为在 tests/volumeGap.test.ts 里逐条验）：
  //   ① 有卷没排满 → 本批只补缺口、不另开新卷；
  //   ② 该卷卷大纲只有骨架 → 一并补全，但只填空 / 占位；
  //   ③ 正文最后一章没写完 → 开写新章前先补齐（只补最后一章）。
  const ol = read('src/lib/outlineCard.ts')
  const cont = read('src/lib/autoContinue.ts')
  ok('🔴 缺口检测纯函数（找第一个没排满的卷）', /export function detectVolumeGap/.test(ol))
  ok('🔴 卷边界三级取用：本卷章号范围 → 本卷章数预估 → 单章式文本靠「每卷章数」推定',
    /VOLUME_BOUND_SLOTS = \['本卷章号范围', '本卷章数预估'\]/.test(ol)
    && /r\.to > r\.from \? r : \{ from: r\.from, to: r\.from \+ m - 1 \}/.test(ol))
  ok('🔴 有缺口时本批章数由缺口定（卷数 × 每卷章数不参与）',
    /sealing \? sealing\.gapTo - sealing\.gapFrom \+ 1 : planTotalChapters/.test(wf))
  ok('🔴 缺口补齐默认不新建卷；只有该卷卷大纲仅剩骨架时才顺带产出一条（volLimit 0/1）',
    /const volLimit = sealing \? \(sealing\.needVolumeOutline \? 1 : 0\) : volCount/.test(cr))
  // ⚠️ 2026-09-20 实机抓到的真 bug：system 分支说"顺带补全卷大纲、volumes 只放这一卷"，
  //    而 user 消息**末尾**（权重最高）写死"volumes 为空数组"⇒ 模型照末尾执行，卷大纲永远补不上。
  //    这条断言就是钉住"四处措辞必须同源"，别再出现两处约束打架。
  ok('🔴 缺口模式「要不要产出卷」的措辞四处同源（system 规则 / JSON 结构 / 任务陈述 / 末尾硬约束）',
    (cr.match(/needVolumeOutline/g) ?? []).length >= 4
    && /并顺带把\*\*这一卷\*\*的卷大纲补全/.test(cr)
    && /只放\*\*这一卷\*\*/.test(cr),
    String((cr.match(/needVolumeOutline/g) ?? []).length) + ' 处')
  ok('🔴 卷大纲「完整性」只看四个卷级走向字段（伏笔 / 角色那类不算"没规划好"）',
    /VOLUME_CORE_SLOTS = \['第一大高潮', '卷中转折', '卷末高潮', '本卷结尾（卷末状态）'\]/.test(ol))
  ok('🔴 卷级字段补全只写空 / 占位（作者已写实的内容一个字不动）',
    /isPlaceholderText\(card\.data\[key\] \?\? ''\)/.test(wf))
  ok('🔴 章号范围回填只在原本为空时写（作者手填的范围不能被覆盖）',
    /isPlaceholderText\(card\.data\[rangeKey\] \?\? ''\)/.test(wf))
  ok('🔴 正文缺口优先：只补最后一章，只动 content / wordCount / updatedAt',
    /opts\.topUpLast && last/.test(cont) && /last\.wordCount = w1/.test(cont))
  ok('🔴 正文补齐绝不压缩（原文若已够长就保持原样，作者可能有意写短章）', /maxShrink: 0/.test(cont))
  ok('🔴 正文里的 markdown 标记会被剥掉，且**接进了逐章连写链路**（原先只有整章改写在调它）',
    /export function stripInlineMarkdown/.test(rw) && (cont.match(/cleanChapterOutput\(/g) ?? []).length >= 3)
  ok('🔴 面板状态行写明「哪一卷还差几章、本次补哪几段」',
    /还差 \$\{gap\.gapTo - gap\.gapFrom \+ 1\} 章/.test(cwp))
  ok('🔴 面板与编排器共用同一个 detectVolumeGap（口径只留一个来源，防两处漂移）',
    /detectVolumeGap\(probe\.volumeBounds, probe\.maxOutlineNo, inp\.chaptersPerVolume\)/.test(cwp))
}

// ============ ⑥ 界面文案纪律：不许再承诺"开发中"的幽灵功能 ============
{
  const schema = read('src/lib/schema.ts')
  const cwDesc = (schema.match(/id: 'creative-writing'[\s\S]{0,200}?description: '([^']+)'/) || [])[1] ?? ''
  ok('创意写作页签说明已更新为「两阶段分批」',
    /只做大纲规划/.test(cwDesc) && /只生成正文/.test(cwDesc), cwDesc.slice(0, 60))
  ok('🔴 页签说明里不再有「（开发中）」这类幽灵功能承诺', !/开发中/.test(cwDesc))
}

console.log(`\n—— creativeModes 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
