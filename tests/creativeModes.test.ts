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
  ok('灵感启发帮助文案交代了续写去了哪里（不能只删不说）',
    /已并入「创意写作」/.test(inspire))

  const session = read('src/lib/creativeSession.ts')
  ok('会话层存在（切页签不丢状态的根）', session.length > 0)
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
