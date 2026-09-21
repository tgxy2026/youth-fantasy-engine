// ============ 世界构建·「其他设定」页签（misc-settings）============
//
// 2026-09-20 新增（最初是表格型）→ 当晚按老大要求**改成卡片型**。
// 用途：世界构建的**兜底层** —— 装那些有结构的表（国家势力 / 地理风物 / 种族生物 /
// 物品资源 / 历史事件 / 名词术语）塞不进的零散设定。卡名＝这条设定的名字，卡内「内容」写正文。
//
// 老大对这个页签有两条硬要求，正是本用例的重点：
//   ① **默认不勾选**（tier = optional，且不写进 DEFAULT_IDS）；
//   ② **不加任何依赖项** —— 不改 STRONG_DEPS / ANY_DEPS，也不许别人反过来依赖它。
//
// 另有一条项目红线：**新增资料型页签必须登记进 aiContext 的 PRIORITY**，
// 否则它虽然会被"兜底追加"进上下文（不丢数据），却排在最末、预算一紧就先被丢掉。
//
// 🔴 改形态顺带要断的三件事（都属于"改了不报错、但会静默出错"）：
//   · 卡名＝名称 ⇒ **不能再有「名称」字段**，否则 AI 上下文里会重复一遍
//     （renderCards 以 card.name 作标题渲染成「〖灵力潮汐周期〗」+ 各字段行）；
//   · 卡片表不编号 ⇒ `CODE_PREFIX` 里那条 MISC 必须撤掉，`codeRule` 也该消失；
//   · 表格行与卡片**存在不同的 store**（tableRows / cardRecords）⇒ 必须有迁移，
//     否则作者先前填好的条目会在界面上「凭空消失」（数据还在库里，只是没人读）。
import fs from 'node:fs'
import path from 'node:path'
import {
  TABS, FEATURE_TIER, DEFAULT_IDS, STRONG_DEPS, ANY_DEPS, SETTING_SUBTABS, getTab, tierOf,
} from '../src/lib/schema'
import { resolveSlot } from '../src/lib/flow/fieldMap'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
const MIS = 'misc-settings'
const tab = getTab(MIS)

// ---------- ① 页签本体：卡片型 ----------
{
  ok('页签存在且能从 getTab 取到', !!tab)
  ok('挂在世界构建组、是**卡片**类型（2026-09-20 晚间形态改定）',
    tab?.group === '世界构建' && tab?.type === 'card', `${tab?.group} / ${tab?.type}`)
  ok('名称就是「其他设定」', tab?.name === '其他设定', tab?.name ?? '(无)')

  const mods = tab?.modules ?? []
  const allFields = mods.flatMap(m => m.fields.map(f => f.name))
  ok('🔴 卡内只有「内容」一个字段（老大要的"起个名字 + 后面填具体内容"）',
    JSON.stringify(allFields) === JSON.stringify(['内容']), allFields.join(','))
  ok('🔴 没有「名称」字段 —— 卡名就是设定名，再放一个字段会在 AI 上下文里重复',
    !allFields.includes('名称'))
  ok('🔴 没有「编号」字段（卡片表一律不编号）', !allFields.includes('编号'))
  ok('🔴 表格形态的痕迹已清干净：无 columns（留着会被读成表格）', !tab?.columns)
  ok('🔴 无 codeRule（不编号就没有编号规则可讲）', !tab?.codeRule)
  ok('🔴 无 displayCol / subtitleCol（卡片表靠 CardRecord.name，不靠列名）',
    !tab?.displayCol && !tab?.subtitleCol)
  ok('字段示例值非空（作者点新建时能看到"该怎么写"）',
    mods.length > 0 && mods.every(m => m.fields.every(f => !!f.example.trim())))

  ok('页签说明不作绝对化的"不外发"承诺（文案闸红线）',
    !/全程本地|不外发|不上传|纯本地/.test(tab?.description ?? ''))
  ok('说明里点出它会进 AI 的设定资料（与 PRIORITY 登记一致，不是"记了也没用"）',
    /设定资料/.test(tab?.description ?? ''))
  ok('说明里讲清"卡名就是这条设定的名字"（改成卡片后必须讲清在哪儿起名）',
    /卡名/.test(tab?.description ?? ''), tab?.description ?? '')
  ok('tips 提醒名字要起得具体（否则引用名高亮会在正文里到处亮）',
    (tab?.tips ?? []).some(t => t.includes('名字尽量起得具体')))
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

  ok('🔴 CODE_PREFIX 里**已无** misc-settings（改卡片后不编号，留着就是一条死配置）',
    !/'misc-settings':/.test(read('src/lib/autoCode.ts')))
  ok('schema 里也不再承诺 MISC 编号（codeRule 已删）',
    !/编号规则：MISC/.test(read('src/lib/schema.ts')))

  // 侧栏 / 功能勾选弹窗 / 指南页 / 数据健康都从 TABS 派生，自动生效 —— 这里确认派生方式没被改掉
  ok('侧栏仍从 TABS 派生（新页签自动出现在世界构建组，无需手工登记）',
    /TABS\.filter\(t => t\.group === group/.test(read('src/components/Sidebar.tsx')))
  ok('功能勾选弹窗仍从 TABS 派生（新页签自动进入可选清单）',
    /for \(const t of TABS\)/.test(read('src/components/FeatureSelectModal.tsx')))
  ok('设定检索会收录世界构建组的卡片表（rec.name 作条目标题，所以卡名就是引用名）',
    /tab\.type === 'card' && \(tab\.group === '角色管理' \|\| tab\.group === '世界构建'/.test(read('src/components/SettingSearch.tsx')))
}

// ---------- ⑤ 🔴 存储键与「表格 → 卡片」迁移 ----------
{
  ok('🔴 存储键 = `设定内容::内容`（迁移与 formByExamples 都按它写）',
    resolveSlot(MIS, '内容') === '设定内容::内容', String(resolveSlot(MIS, '内容')))
  ok('🔴 取不到「名称」这个键了（字段已删，硬写它就是幽灵数据）',
    resolveSlot(MIS, '名称') === null, String(resolveSlot(MIS, '名称')))

  const mig = read('src/lib/db/migrations.ts')
  ok('🔴 存在「表格行 → 卡片」迁移（不迁的话老数据凭空消失：两者是不同的 store）',
    /export async function migrateMiscSettingsToCards/.test(mig))
  ok('迁移挂在 runMigrations 里（否则永远不会跑）',
    /await migrateMiscSettingsToCards\(\)/.test(mig))
  ok('迁移写入的键与 resolveSlot 一致（不一致＝数据看得见却填不进去）',
    /'设定内容::内容'/.test(mig))
  ok('迁移幂等：该表已无表格行时直接返回',
    /if \(rows\.length === 0\) return 0/.test(mig))
  ok('迁移先写卡、再删原行（中途失败下次还能再来一遍）',
    /await ops\.put\('cardRecords'[\s\S]{0,240}?await ops\.del\('tableRows'/.test(mig))
}

// ---------- ⑥ 示范项目里的示例数据 ----------
{
  const seed = read('src/lib/seedData.ts')
  ok('🔴 示范项目把示例播种成**卡片**（表格播种已经不产这个页签的数据了）',
    /card\('misc-settings'/.test(seed))
  ok('表格播种里已无 misc-settings（残留会播出一批谁也读不到的行）',
    !/^\s*\['misc-settings',/m.test(seed))
  ok('三条示例都在（种子闸要求页签不为空，空表作者也不会用）',
    ['玄脉品级划分', '灵石兑换比率', '望剑城收剑之制'].every(n => seed.includes(n)))
}

console.log(`\n—— miscSettings 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
