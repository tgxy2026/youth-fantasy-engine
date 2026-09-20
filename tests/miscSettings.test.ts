// ============ 世界构建·「其他设定」页签（misc-settings）============
//
// 2026-09-20 新增：世界构建的**兜底层** —— 名称 + 内容两列纯文本，装那些结构表塞不进的零散设定。
//
// 老大对这个页签有两条硬要求，正是本用例的重点：
//   ① **默认不勾选**（tier = optional，且不写进 DEFAULT_IDS）；
//   ② **不加任何依赖项** —— 不改 STRONG_DEPS / ANY_DEPS，也不许别人反过来依赖它。
//
// 另有一条项目红线：**新增资料型页签必须登记进 aiContext 的 PRIORITY**，
// 否则它虽然会被"兜底追加"进上下文（不丢数据），却排在最末、预算一紧就先被丢掉。
import fs from 'node:fs'
import path from 'node:path'
import {
  TABS, FEATURE_TIER, DEFAULT_IDS, STRONG_DEPS, ANY_DEPS, SETTING_SUBTABS, getTab, tierOf,
} from '../src/lib/schema'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
const MIS = 'misc-settings'
const tab = getTab(MIS)

// ---------- ① 页签本体 ----------
{
  ok('页签存在且能从 getTab 取到', !!tab)
  ok('挂在世界构建组、是表格类型', tab?.group === '世界构建' && tab?.type === 'table',
    `${tab?.group} / ${tab?.type}`)
  ok('名称就是「其他设定」', tab?.name === '其他设定', tab?.name ?? '(无)')

  const cols = (tab?.columns ?? []).map(c => c.name)
  ok('🔴 列＝编号 / 名称 / 内容（老大要的"起个名字 + 后面填具体内容"）',
    JSON.stringify(cols) === JSON.stringify(['编号', '名称', '内容']), cols.join(','))
  ok('内容列给了较宽默认宽度（纯文本要写得下）',
    (tab?.columns ?? []).some(c => c.name === '内容' && c.width === 'w-96'))
  ok('displayCol = 名称（列表 / 引用都取它）', tab?.displayCol === '名称')
  ok('没有加任何 select 枚举列（是纯文本兜底，不做结构校验）',
    !(tab?.columns ?? []).some(c => c.type === 'select'))

  ok('编号规则用 MISC 前缀', /编号规则：MISC \+ 4 位序号/.test(tab?.codeRule ?? ''), tab?.codeRule ?? '')
  ok('MISC 前缀不与任何现有表格冲突',
    [...read('src/lib/schema.ts').matchAll(/编号规则：([A-Z]+) \+/g)].filter(m => m[1] === 'MISC').length === 1)

  ok('页签说明不作绝对化的"不外发"承诺（文案闸红线）',
    !/全程本地|不外发|不上传|纯本地/.test(tab?.description ?? ''))
  ok('说明里点出它会进 AI 的设定资料（与 PRIORITY 登记一致，不是"记了也没用"）',
    /设定资料/.test(tab?.description ?? ''))
  ok('tips 提醒名称要起得具体（否则引用名高亮会在正文里到处亮）',
    (tab?.tips ?? []).some(t => t.includes('名称尽量起得具体')))
  ok('tips 提醒"能进专表的优先进专表"（本页是兜底不是首选）',
    (tab?.tips ?? []).some(t => t.includes('优先放进对应的专表')))
}

// ---------- ② 🔴 默认不勾选 ----------
{
  ok('🔴 FEATURE_TIER 里显式标 optional（写出来而不是省略，让读的人知道这是有意的）',
    FEATURE_TIER[MIS] === 'optional', String(FEATURE_TIER[MIS]))
  ok('🔴 tierOf 解析结果也是 optional（＝自定义项目里默认不勾选）', tierOf(MIS) === 'optional')
  ok('🔴 不在 DEFAULT_IDS 里（默认勾选清单）', !DEFAULT_IDS.includes(MIS))
}

// ---------- ③ 🔴 不加任何依赖项 ----------
{
  ok('🔴 不依赖任何别的页签（STRONG_DEPS 里没有它）', !(MIS in STRONG_DEPS))
  ok('🔴 不在 ANY_DEPS 里（"至少需要一个"会连带开启别的功能）',
    !(MIS in ANY_DEPS))
  ok('🔴 也没有任何页签反过来依赖它（依赖是双向的，反向加了同样违背"零依赖"）',
    !Object.values(STRONG_DEPS).some(l => l.includes(MIS))
    && !Object.values(ANY_DEPS).some(l => l.includes(MIS)))
}

// ---------- ④ 页签变化涉及的同步点 ----------
{
  ok('🔴 登记进 SETTING_SUBTABS 的「世界构建」（编辑器左侧设定检索栏的分组）',
    (SETTING_SUBTABS['世界构建'] ?? []).includes(MIS),
    (SETTING_SUBTABS['世界构建'] ?? []).join(','))
  ok('🔴 登记进 aiContext 的 PRIORITY（项目红线：新增资料型页签必须登记，否则进不了预算）',
    /^\s*'misc-settings',/m.test(read('src/lib/aiContext.ts')))
  ok('在 TABS 里只出现一次（重复定义会让侧栏出现两个同名页签）',
    TABS.filter(t => t.id === MIS).length === 1)

  // 侧栏 / 功能勾选弹窗 / 指南页 / 数据健康都从 TABS 派生，自动生效 —— 这里确认派生方式没被改掉
  ok('侧栏仍从 TABS 派生（新页签自动出现在世界构建组，无需手工登记）',
    /TABS\.filter\(t => t\.group === group/.test(read('src/components/Sidebar.tsx')))
  ok('功能勾选弹窗仍从 TABS 派生（新页签自动进入可选清单）',
    /for \(const t of TABS\)/.test(read('src/components/FeatureSelectModal.tsx')))
}

// ---------- ⑤ 示范项目里的示例数据 ----------
{
  const seed = read('src/lib/seedData.ts')
  ok('🔴 示范项目播种了示例行（种子闸 ④ 要求每个表格页签都不空；空表作者也不会用）',
    /'misc-settings', \{ '编号': 'MISC0001'/.test(seed))
  ok('示例行的键与 schema 列名完全一致（否则会写出一列谁也看不见的幽灵数据）',
    /'misc-settings', \{ '编号': 'MISC0001', '名称': '[^']+', '内容': '[^']+' \}/.test(seed))
}

console.log(`\n—— miscSettings 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
