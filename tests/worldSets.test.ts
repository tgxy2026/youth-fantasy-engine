// ============ C10（2.4.2）世界观 · 力量体系「母子结构」============
//
// 这一层最要紧的两件事：
//   ① **母级永远喂、子级只有活跃的才喂** —— 少喂则 AI 不知道当前副本；多喂则几套设定互相打架
//      （这正是老大点名的风险）；
//   ② **单世界用户必须零变化** —— 没建子项的人，AI 上下文与本次改动前一字不差。
// 另外把「活跃列表与子项的一致性」也钉住（删了子项还在活跃列表里 ⇒ 上下文会冒出空标题）。
import { createDemoProject } from '../src/lib/seedData'
import { uid } from '../src/lib/id'
import * as db from '../src/lib/db'
import { buildProjectContext } from '../src/lib/aiContext'
import {
  activeKeyOf, composeSubSetsBlock, composeParallelSetBlock, isSubTabId, isWorldSetTab, isParallelSetTab, isMultiSetTab,
  pruneActiveIds, splitActive, subTabIdOf, toggleActiveId,
  WORLD_SET_TABS, PARALLEL_SET_TABS, MULTI_SET_TABS,
} from '../src/lib/worldSets'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ worldSets')

// ---------- 1. 判据（三个常量：母子 / 并列 / 合计） ----------
{
  // 2.7.2 主人定案：**只有「世界设定」「力量体系」是母子结构**（有母级 formData + 子项）；
  // 政治 / 经济 / 信仰 / 司法改成**并列结构**（没有母级，多份条目平铺）。
  // 这条断言是「四链路零改动生效」的第一道门 —— 结构判据错一处，AI 上下文 / 导出就会多喂一层。
  ok('母子结构只认这两张表', WORLD_SET_TABS.length === 2
    && ['worldbase', 'power'].every(isWorldSetTab))
  ok('并列结构认政治/经济/信仰/司法四张表', PARALLEL_SET_TABS.length === 4
    && ['politics', 'economy', 'belief', 'justice'].every(isParallelSetTab))
  ok('🔴 两类互斥（制度四页签不再是母子）',
    ['politics', 'economy', 'belief', 'justice'].every(id => !isWorldSetTab(id) && isParallelSetTab(id))
    && !isWorldSetTab('politics') && !isParallelSetTab('worldbase') && !isParallelSetTab('power'))
  ok('「有多套条目」判据 = 母子 ∪ 并列（六张全算）', MULTI_SET_TABS.length === 6
    && ['worldbase', 'power', 'politics', 'economy', 'belief', 'justice'].every(isMultiSetTab))
  ok('别的页签不算多套表',
    !isMultiSetTab('master') && !isMultiSetTab('char-main') && !isMultiSetTab('')
    && !isWorldSetTab('master') && !isParallelSetTab('master'))
  ok('子级 tabId 派生成 <tabId>-sub（两类共用同一后缀）',
    subTabIdOf('worldbase') === 'worldbase-sub' && subTabIdOf('politics') === 'politics-sub')
  ok('能反认出子级 tabId（用于遍历时跳过）',
    isSubTabId('worldbase-sub') && isSubTabId('justice-sub') && !isSubTabId('worldbase'))
  ok('活跃键带表名（settingsKV 会自动再加 pid 前缀）',
    activeKeyOf('worldbase') === 'worldSubActive::worldbase'
    && activeKeyOf('politics') === 'worldSubActive::politics')
}

// ---------- 2. splitActive：活跃 / 已完结切分 ----------
{
  const subs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const r1 = splitActive(subs, ['b'])
  ok('按活跃列表切分', r1.active.map(s => s.id).join() === 'b' && r1.closed.map(s => s.id).join() === 'a,c',
    `活跃=${r1.active.map(s => s.id)} 完结=${r1.closed.map(s => s.id)}`)

  const r2 = splitActive(subs, [])
  ok('没有活跃 ⇒ 全部算已完结', r2.active.length === 0 && r2.closed.length === 3)

  const r3 = splitActive(subs, ['a', 'b', 'c'])
  ok('全部活跃 ⇒ 已完结为空', r3.active.length === 3 && r3.closed.length === 0)

  // 🔴 防御 ①：活跃列表里的「幽灵 id」必须被忽略（跨设备删除 / 删除中途失败都会留下）
  const r4 = splitActive(subs, ['a', '不存在的id'])
  ok('🔴 活跃列表里的幽灵 id 被忽略（不产生 undefined 项）',
    r4.active.length === 1 && r4.active[0].id === 'a' && r4.active.every(s => !!s && !!s.id),
    `活跃=${r4.active.map(s => s?.id)}`)

  // 🔴 防御 ②：重复 id 只算一次
  const r5 = splitActive(subs, ['a', 'a', 'a'])
  ok('🔴 活跃列表重复 id 只出现一次', r5.active.length === 1 && r5.closed.length === 2)

  ok('保持传入顺序（排序是存储层的事）',
    splitActive(subs, ['c', 'a']).active.map(s => s.id).join() === 'a,c')
  ok('空子项列表不炸', splitActive([], ['a']).active.length === 0)
}

// ---------- 3. toggleActiveId / pruneActiveIds ----------
{
  ok('开：加进去', toggleActiveId(['a'], 'b', true).join() === 'a,b')
  ok('关：拿出来', toggleActiveId(['a', 'b'], 'a', false).join() === 'b')
  ok('🔴 幂等：重复开不会变两项', toggleActiveId(toggleActiveId(['a'], 'b', true), 'b', true).length === 2)
  ok('关一个本来就不在的 id 不出错', toggleActiveId(['a'], 'zz', false).join() === 'a')
  ok('净化：剔掉已不存在的 id', pruneActiveIds(['a', 'b'], ['b', 'c']).join() === 'b')
  ok('净化：全都不存在 ⇒ 空数组', pruneActiveIds(['x'], ['a']).length === 0)
}

// ---------- 4. composeSubSetsBlock：进 AI 的骨架与诚实口径 ----------
{
  const two = composeSubSetsBlock([{ name: '主神空间', body: '世界名称：主神空间' }], 2)
  ok('标题写明「活跃 N / 共 M」', two.includes('〖子世界（活跃 1 / 共 2）〗'), two.split('\n')[0])
  ok('活跃子项带名字与正文', two.includes('▸ 主神空间') && two.includes('世界名称：主神空间'))
  ok('🔴 尾部必须写「另有 N 个已完结，未发送」（作者靠它判断 AI 读到了什么）',
    two.includes('另有 1 个已完结的子世界，未发送'), two.split('\n').pop())

  const none = composeSubSetsBlock([], 2)
  ok('🔴 一个活跃都没有 ⇒ 只给一行说明，不把已完结的发出去',
    none.includes('当前没有活跃的子世界') && !none.includes('▸'), none.replace(/\n/g, ' | '))

  const all = composeSubSetsBlock([{ name: 'A', body: '' }], 1)
  ok('全活跃时没有「另有」这句', !all.includes('另有'), all.replace(/\n/g, ' | '))

  const unnamed = composeSubSetsBlock([{ name: '', body: '' }], 1)
  ok('子项没名字也不出空标题', unnamed.includes('▸ 未命名子世界'), unnamed.replace(/\n/g, ' | '))

}

// ---------- 4b. composeParallelSetBlock：并列结构（2.7.2 制度四页签专用） ----------
{
  const two = composeParallelSetBlock([{ name: '大燕', body: '政体：君主立宪' }], 2, '政权')
  // 🔴 负面对照的核心：标题**不能**出现「子世界」—— 母级已取消，称子世界会误导作者与模型
  ok('标题用条目总称，且不出现「子世界」',
    two.includes('〖政权（活跃 1 / 共 2）〗') && !two.includes('子世界'), two.split('\n')[0])
  ok('🔴 也没有「全书统一」那一层（并列结构没有母级）', !two.includes('全书统一'), two.replace(/\n/g, ' | '))
  ok('活跃条目带名字与正文', two.includes('▸ 大燕') && two.includes('政体：君主立宪'))
  ok('尾部诚实口径同样写「另有 N 个已完结」',
    two.includes('另有 1 个已完结的政权，未发送'), two.split('\n').pop())

  const none = composeParallelSetBlock([], 2, '行业')
  ok('一个活跃都没有 ⇒ 只给一行说明，不发已完结的',
    none.includes('当前没有活跃的行业') && !none.includes('▸'), none.replace(/\n/g, ' | '))

  const unnamed = composeParallelSetBlock([{ name: '', body: '' }], 1, '教团')
  ok('条目没名字也不出空标题', unnamed.includes('▸ 未命名教团'), unnamed.replace(/\n/g, ' | '))

  // 与母子版并存：两者标题必须不同（否则改结构等于没改）
  ok('🔴 母子版与并列版标题口径不同（并列不叫「子世界」）',
    composeSubSetsBlock([{ name: 'X', body: '' }], 1).includes('〖子世界（活跃 1 / 共 1）〗')
    && composeParallelSetBlock([{ name: 'X', body: '' }], 1, '政权').includes('〖政权（活跃 1 / 共 1）〗'))
}

// ---------- 4c. 边界 ----------
{
  // 名字里有换行也别把结构撑坏（作者可能在卡名里敲了空格/换行）
  ok('total 小于 entries 时不出负数', !composeSubSetsBlock([{ name: 'a', body: '' }], 0).includes('-'))
  ok('并列版同样不出负数', !composeParallelSetBlock([{ name: 'a', body: '' }], 0, '政权').includes('-'))
}

// ---------- 5. 存储层：子项增删改 + 活跃状态 ----------
__resetMockStores()
await createDemoProject()
{
  const before = await db.getSubSets('worldbase')
  ok('新建项目没有任何子项', before.length === 0)

  await db.saveSubSet('worldbase', {
    id: uid(), projectId: '', tabId: '', name: '主神空间', data: { '一、世界总览::世界名称': '主神空间' }, order: 0,
  } as never)
  await db.saveSubSet('worldbase', {
    id: uid(), projectId: '', tabId: '', name: '三国乱世', data: { '一、世界总览::世界名称': '三国乱世' }, order: 1,
  } as never)
  const subs = await db.getSubSets('worldbase')
  ok('子项写入后能读回（按 order 排）', subs.length === 2 && subs[0].name === '主神空间', subs.map(s => s.name).join())
  ok('🔴 子项落在 <tabId>-sub 下（不污染页签卡片）', subs.every(s => s.tabId === 'worldbase-sub'),
    subs.map(s => s.tabId).join())
  ok('别的表读不到这些子项（tabId 隔离）', (await db.getSubSets('power')).length === 0)

  const a = subs[0].id
  const b = subs[1].id
  await db.setSubActive('worldbase', a, true)
  await db.setSubActive('worldbase', a, true)   // 幂等
  await db.setSubActive('worldbase', b, true)
  ok('开关写入 + 幂等', (await db.getActiveSubIds('worldbase')).length === 2)
  await db.setSubActive('worldbase', b, false)
  ok('关掉一个', (await db.getActiveSubIds('worldbase')).join() === a)

  // 🔴 删子项必须同步清活跃列表
  await db.deleteSubSet('worldbase', a)
  const rest = await db.getSubSets('worldbase')
  const act = await db.getActiveSubIds('worldbase')
  ok('删除后子项没了', rest.length === 1 && rest[0].id === b)
  ok('🔴 删除后活跃列表里也不再有它（否则 AI 段落会冒空标题）', !act.includes(a), act.join() || '（空）')
}

// ---------- 6. AI 上下文：母级恒在 / 只喂活跃 / 单世界零变化 ----------
{
  // 🔴 上一节刻意留了子项（验删除逻辑），这里必须先清干净：
  //    否则「共 N」的计数会把残留算进来（写这版时踩过，3 条断言假红）
  __resetMockStores()
  await createDemoProject()
  const base = await buildProjectContext({ budget: 400000, onlyTabIds: ['worldbase'], includeChapterList: false })
  ok('母级照旧进上下文（没建子项时）', base.text.includes('世界名称'), base.text.slice(0, 40).replace(/\n/g, ' | '))
  ok('🔴 单世界用户零变化：没建子项时**不出现**母／子两层标题',
    !base.text.includes('〖子世界') && !base.text.includes('〖全书统一〗'),
    `子世界=${base.text.includes('〖子世界')} 全书统一=${base.text.includes('〖全书统一〗')}`)

  // 建两个子项：一个活跃、一个已完结
  await db.saveSubSet('worldbase', {
    id: uid(), projectId: '', tabId: '', name: '主神空间', order: 0,
    data: { '一、世界总览::世界名称': '主神空间专属名', '二、底层法则（定了不改）::世界核心规则': '轮回者以积分解锁血脉' },
  } as never)
  await db.saveSubSet('worldbase', {
    id: uid(), projectId: '', tabId: '', name: '三国乱世', order: 1,
    data: { '一、世界总览::世界名称': '三国乱世专属名' },
  } as never)
  const subs = await db.getSubSets('worldbase')
  await db.setSubActive('worldbase', subs[0].id, true)   // 主神空间活跃；三国乱世完结

  const withSubs = await buildProjectContext({ budget: 400000, onlyTabIds: ['worldbase'], includeChapterList: false })
  const t = withSubs.text
  ok('🔴 建过子项后出现两层标题',
    t.includes('〖全书统一〗') && t.includes('〖子世界（活跃 1 / 共 2）〗'), t.match(/〖[^〗]*〗/g)?.join(' '))
  ok('🔴 活跃子项的正文进上下文', t.includes('主神空间专属名') && t.includes('轮回者以积分解锁血脉'))
  ok('🔴 已完结子项**不进**上下文', !t.includes('三国乱世专属名'), t.includes('三国乱世专属名') ? '不该出现' : '已正确省略')
  ok('🔴 尾部写明「另有 1 个已完结，未发送」', t.includes('另有 1 个已完结的子世界，未发送'), t.split('\n').pop())

  // 全部关掉 ⇒ 只剩母级 + 一行说明
  await db.setSubActive('worldbase', subs[0].id, false)
  const closedAll = await buildProjectContext({ budget: 400000, onlyTabIds: ['worldbase'], includeChapterList: false })
  ok('🔴 全部已完结 ⇒ 子世界正文一条都不发，只留说明',
    closedAll.text.includes('当前没有活跃的子世界')
    && !closedAll.text.includes('主神空间专属名')
    && !closedAll.text.includes('三国乱世专属名'))

  // 母级仍在（子项没把母级挤掉）
  ok('🔴 子项存在时母级照旧在上下文里（母级永远喂）',
    closedAll.text.includes('〖全书统一〗') && closedAll.text.includes('世界名称'))
}

// ---------- 7. AI 上下文：并列结构页签（2.7.2 · 政治页实测） ----------
{
  __resetMockStores()
  await createDemoProject()

  // 一个条目都没建 ⇒ 整段不带（回归保护：没建过的用户上下文与改动前一字不差）
  const empty = await buildProjectContext({ budget: 400000, onlyTabIds: ['politics'], includeChapterList: false })
  ok('🔴 并列页签没建条目 ⇒ 整段不带，也不出现「全书统一」',
    !empty.text.includes('〖全书统一〗') && !empty.text.includes('〖政权'),
    empty.text.match(/〖[^〗]*〗/g)?.join(' ') || '（无小节）')

  // 建两条：一条活跃、一条已完结
  await db.saveSubSet('politics', {
    id: uid(), projectId: '', tabId: '', name: '大燕', order: 0,
    data: { '一、政体与权力结构::政体': '君主立宪，内外朝分立' },
  } as never)
  await db.saveSubSet('politics', {
    id: uid(), projectId: '', tabId: '', name: '南楚', order: 1,
    data: { '一、政体与权力结构::政体': '贵族议会制' },
  } as never)
  const psubs = await db.getSubSets('politics')
  await db.setSubActive('politics', psubs[0].id, true)

  const t2 = (await buildProjectContext({ budget: 400000, onlyTabIds: ['politics'], includeChapterList: false })).text
  ok('🔴 并列页签出的是「政权」段，且**没有**「全书统一」与「子世界」',
    t2.includes('〖政权（活跃 1 / 共 2）〗')
    && !t2.includes('〖全书统一〗') && !t2.includes('子世界'),
    t2.match(/〖[^〗]*〗/g)?.join(' ') || '（无小节）')
  ok('🔴 活跃条目的正文进上下文', t2.includes('君主立宪，内外朝分立'))
  ok('🔴 已完结条目不进上下文', !t2.includes('贵族议会制'), t2.includes('贵族议会制') ? '不该出现' : '已正确省略')
  ok('🔴 尾部诚实口径写「另有 1 个已完结的政权」',
    t2.includes('另有 1 个已完结的政权，未发送'), t2.split('\n').pop())

  // 🔴 负面对照：删掉 sectionOf 里的 isParallelSetTab 分支 ⇒ 上面那条「没有『全书统一』」必红
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
