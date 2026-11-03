/**
 * 角色卡跨页签移动（3.1.3）—— `lib/world/cardMove.ts`。
 *
 * 盯的是**内容去哪了**，不是函数返回值好不好看：
 *   ① 同名字段必须落到目标页签**自己的模块路径**上（`一、基础信息::姓名` ≠ `NPC档案::姓名`）；
 *   ② 同义字段（身份定位/身份、功法·技能/实力与功法、核心性格/一句话性格…）必须跟过去；
 *   ③ 目标没有的栏位 ⇒ 进 `lost`（非空才进；空值不算"丢失"，否则警告会吓人）；
 *   ④ NPC 的合并栏「年龄/性别/外貌特征」：降级时整段进「年龄/性别」不拆词，升级时两栏拼回去；
 *   ⑤ 目标页签多出来的栏位进 `blank`（"多余的页签为空白状态"）。
 *
 * 🔴 后半段用**真实 schema** 做一次全量预演：那是契约闸 —— 谁把「核心性格」改名、
 *    或给三张卡加字段却不更新语义表，这里会立刻红。
 */
import { TABS } from '@/lib/schema'
import type { CardRecord, TabDef } from '@/lib/types'
import {
  CHARACTER_CARD_TAB_IDS, characterCardTargets, flattenCardFields, isCharacterCardTab,
  planCardMove, semanticOfField,
} from '@/lib/world/cardMove'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function tab(id: string): TabDef {
  const t = TABS.find(x => x.id === id)
  if (!t) throw new Error(`schema 里没有 ${id}`)
  return t
}
const MAIN = tab('char-main')
const SECONDARY = tab('char-secondary')
const NPC = tab('char-npc')

function rec(tabId: string, data: Record<string, string>): CardRecord {
  return { id: 'c1', projectId: 'p1', tabId, name: data[Object.keys(data)[0] ?? ''] ?? '测试卡', data, order: 0 }
}

/** 取某个字段在页签里的存储路径（`模块::字段`） */
function pathOf(t: TabDef, name: string): string {
  const f = flattenCardFields(t).find(x => x.name === name)
  if (!f) throw new Error(`${t.id} 没有字段 ${name}`)
  return f.path
}

// ---------- ① 页签集合与目标列表 ----------
{
  ok('① 三张角色卡都认得', CHARACTER_CARD_TAB_IDS.every(isCharacterCardTab))
  ok('① 「其他设定」不是角色卡', !isCharacterCardTab('misc-settings'))
  const fromMain = characterCardTargets('char-main').map(t => t.id)
  ok('① 主要角色可去往次要/NPC', fromMain.join(',') === 'char-secondary,char-npc', fromMain.join(','))
  const fromNpc = characterCardTargets('char-npc').map(t => t.id)
  ok('① NPC 可去往主要/次要', fromNpc.join(',') === 'char-main,char-secondary', fromNpc.join(','))
  ok('① 目标列表不含自己', !characterCardTargets('char-secondary').some(t => t.id === 'char-secondary'))
}

// ---------- ② 降级：主要 → 次要（同名字段带走、深层设定丢失） ----------
{
  const r = rec('char-main', {
    [pathOf(MAIN, '姓名')]: '陈渊',
    [pathOf(MAIN, '核心性格')]: '坚韧、护短',
    [pathOf(MAIN, '功法/技能')]: '混沌吞天诀',
    [pathOf(MAIN, '价值观与底线')]: '不伤无辜',
    [pathOf(MAIN, '角色弧光')]: '弃子→破局者',
    [pathOf(MAIN, '种族')]: '人族',
    [pathOf(MAIN, '人物状态')]: '已登场',
  })
  const p = planCardMove(MAIN, SECONDARY, r)
  ok('② 姓名落到次要卡自己的模块路径', p.data[pathOf(SECONDARY, '姓名')] === '陈渊', JSON.stringify(p.data))
  ok('② 同名性格字段映射', p.data[pathOf(SECONDARY, '核心性格')] === '坚韧、护短')
  ok('② 功法/技能 → 实力与功法（同义映射）', p.data[pathOf(SECONDARY, '实力与功法')] === '混沌吞天诀', JSON.stringify(p.data))
  ok('② 人物状态保留', p.data[pathOf(SECONDARY, '人物状态')] === '已登场')
  const lostFields = p.lost.map(l => l.field)
  ok('② 价值观与底线进丢失清单', lostFields.includes('价值观与底线'), lostFields.join(','))
  ok('② 角色弧光进丢失清单', lostFields.includes('角色弧光'))
  ok('② 种族在三张卡都有 ⇒ 跟着走，不算丢失', p.data[pathOf(SECONDARY, '种族')] === '人族', JSON.stringify(p.data))
  ok('② 能映射的字段不进丢失清单', !lostFields.includes('核心性格') && !lostFields.includes('功法/技能') && !lostFields.includes('种族'))
  ok('② 目标字段更多/相等才算 richer（次要 28 < 主要 30）', p.richer === false, `${p.fromFieldCount}->${p.toFieldCount}`)
  ok('② 目标多出来的栏位进 blank', p.blank.includes('核心动机') && p.blank.includes('与主角的关系'), p.blank.join(','))
  ok('② 已填项计数', p.filledCount === 7, String(p.filledCount))
}

// ---------- ③ 升级：次要 → 主要（不丢内容，因为主要字段是超集） ----------
{
  const r = rec('char-secondary', {
    [pathOf(SECONDARY, '姓名')]: '萧景行',
    [pathOf(SECONDARY, '核心性格')]: '自尊极高',
    [pathOf(SECONDARY, '核心动机')]: '证明自己是天命之子',
    [pathOf(SECONDARY, '剧情功能')]: '天才对照组',
    [pathOf(SECONDARY, '结局归宿')]: '兵解',
  })
  const p = planCardMove(SECONDARY, MAIN, r)
  const lostFields = p.lost.map(l => l.field)
  ok('③ 核心动机在主要卡无对应 ⇒ 丢失（不硬塞进人际关系）', lostFields.includes('核心动机'), lostFields.join(','))
  ok('③ 剧情功能在主要卡无对应 ⇒ 丢失', lostFields.includes('剧情功能'))
  ok('③ 结局归宿映射成功', p.data[pathOf(MAIN, '结局归宿')] === '兵解')
  ok('③ 主要卡字段更多 ⇒ richer=true', p.richer === true)
  ok('③ 主要卡独有栏位留空', p.blank.includes('价值观与底线') && p.blank.includes('角色弧光'))
  ok('③ 没有重名丢失', lostFields.length === 2, String(lostFields.length))
}

// ---------- ④ 升级：NPC → 主要（合并栏拆不开，整段进「年龄/性别」） ----------
{
  const merged = pathOf(NPC, '年龄/性别/外貌特征')
  const r = rec('char-npc', {
    [pathOf(NPC, '姓名')]: '王铁柱',
    [merged]: '20岁/男，身材魁梧、剑眉星目',
    [pathOf(NPC, '身份')]: '杂役院伙伴',
    [pathOf(NPC, '一句话性格')]: '莽直忠厚',
    [pathOf(NPC, '口癖/记忆点')]: '"渊哥，俺跟你干！"',
    [pathOf(NPC, '关键出场')]: '第2章起',
    [pathOf(NPC, '功能定位')]: '氛围组',
  })
  const p = planCardMove(NPC, MAIN, r)
  ok('④ 合并栏整段写入「年龄/性别」', p.data[pathOf(MAIN, '年龄/性别')] === '20岁/男，身材魁梧、剑眉星目', JSON.stringify(p.data))
  ok('④ 外貌特征不硬拆', !p.data[pathOf(MAIN, '外貌特征')])
  ok('④ 外貌特征在 blank（确实空着）', p.blank.includes('外貌特征'))
  ok('④ 有拆词说明', p.notes.some(n => n.includes('年龄/性别') && n.includes('外貌特征')), p.notes.join('|'))
  ok('④ 身份 → 身份定位', p.data[pathOf(MAIN, '身份定位')] === '杂役院伙伴')
  ok('④ 一句话性格 → 核心性格', p.data[pathOf(MAIN, '核心性格')] === '莽直忠厚')
  ok('④ 口癖/记忆点 → 说话风格', p.data[pathOf(MAIN, '说话风格')] === '"渊哥，俺跟你干！"')
  ok('④ 关键出场 → 首次出场', p.data[pathOf(MAIN, '首次出场')] === '第2章起')
  ok('④ 功能定位在主要卡无对应 ⇒ 丢失', p.lost.map(l => l.field).includes('功能定位'))
}

// ---------- ⑤ 降级：主要 → NPC（两栏拼回合并栏，深层设定进警告） ----------
{
  const r = rec('char-main', {
    [pathOf(MAIN, '姓名')]: '陈渊',
    [pathOf(MAIN, '年龄/性别')]: '16岁/男',
    [pathOf(MAIN, '外貌特征')]: '瘦削但筋骨匀称',
    [pathOf(MAIN, '核心性格')]: '坚韧',
    [pathOf(MAIN, '所属势力')]: '青岚宗',
    [pathOf(MAIN, '价值观与底线')]: '不伤无辜',
    [pathOf(MAIN, '隐藏设定')]: '混沌神体',
  })
  const p = planCardMove(MAIN, NPC, r)
  const merged = pathOf(NPC, '年龄/性别/外貌特征')
  ok('⑤ 两栏拼进合并栏', p.data[merged] === '16岁/男，瘦削但筋骨匀称', p.data[merged])
  ok('⑤ 拼接不是覆盖（两段都在）', p.data[merged].includes('16岁') && p.data[merged].includes('瘦削'))
  ok('⑤ 深层设定按项进丢失清单', p.lost.map(l => l.field).includes('价值观与底线') && p.lost.map(l => l.field).includes('隐藏设定'))
  ok('⑤ NPC 没有的栏位一律丢失', p.lost.length === 2, String(p.lost.length))
  ok('⑤ NPC 独有的功能定位留空', p.blank.includes('功能定位'))
}

// ---------- ⑥ 空值不算丢失、不写进 data ----------
{
  const r = rec('char-main', {
    [pathOf(MAIN, '姓名')]: '陈渊',
    [pathOf(MAIN, '价值观与底线')]: '   ',
    [pathOf(MAIN, '种族')]: '',
  })
  const p = planCardMove(MAIN, SECONDARY, r)
  ok('⑥ 空白值不进丢失清单', p.lost.length === 0, JSON.stringify(p.lost))
  ok('⑥ 空白值不写进 data', !p.data[pathOf(SECONDARY, '种族')])
  ok('⑥ 只有姓名算已填', p.filledCount === 1, String(p.filledCount))
}

// ---------- ⑦ 值两端空白被裁掉 ----------
{
  const r = rec('char-main', { [pathOf(MAIN, '姓名')]: '  陈渊  ' })
  const p = planCardMove(MAIN, NPC, r)
  ok('⑦ 落库值已 trim', p.data[pathOf(NPC, '姓名')] === '陈渊', JSON.stringify(p.data))
}

// ---------- ⑧ 语义表自检 ----------
{
  ok('⑧ 身份与身份定位同义', semanticOfField('身份') === semanticOfField('身份定位'))
  ok('⑧ 功法/技能与实力与功法同义', semanticOfField('功法/技能') === semanticOfField('实力与功法'))
  ok('⑧ 未登记字段按名字自成一组', semanticOfField('姓名') === '姓名' && semanticOfField('姓名') !== semanticOfField('别称'))
  ok('⑧ 合并栏与拆分栏语义不同', semanticOfField('年龄/性别/外貌特征') !== semanticOfField('年龄/性别'))
}

// ---------- ⑨ 真实 schema 全量预演：三张卡两两移动都不该"无声蒸发" ----------
{
  const filled = (t: TabDef) => Object.fromEntries(flattenCardFields(t).map(f => [f.path, `${f.name}的值`]))
  const pairs: [TabDef, TabDef][] = [[MAIN, SECONDARY], [SECONDARY, MAIN], [MAIN, NPC], [NPC, MAIN], [SECONDARY, NPC], [NPC, SECONDARY]]
  for (const [a, b] of pairs) {
    const src = rec(a.id, filled(a))
    const p = planCardMove(a, b, src)
    const covered = new Set<string>()
    for (const c of p.carried) covered.add(c.from)
    // 每一个源字段：要么带走了，要么（非空时）在丢失清单里 —— 不允许"既不带走也不报丢"
    const silent = flattenCardFields(a).filter(f => !covered.has(f.name) && !p.lost.some(l => l.field === f.name))
    ok(`⑨ ${a.id}→${b.id} 没有无声蒸发的字段`, silent.length === 0, silent.map(f => f.name).join(','))
    // 写入的键必须是目标页签真实存在的路径（否则就是把值写进了没人读的地方）
    const dstPaths = new Set(flattenCardFields(b).map(f => f.path))
    const ghost = Object.keys(p.data).filter(k => !dstPaths.has(k))
    ok(`⑨ ${a.id}→${b.id} 写入路径都在目标页签`, ghost.length === 0, ghost.join(','))
    // 每个目标字段最多出现一次，不重复
    ok(`⑨ ${a.id}→${b.id} carried 无重复`, new Set(p.carried.map(c => `${c.from}->${c.to}`)).size === p.carried.length)
    // 源已填 N 项 ⇒ 带走 + 丢失 应覆盖全部（含合并栏一对二的情况）
    ok(`⑨ ${a.id}→${b.id} 已填项都有去处`, p.filledCount === flattenCardFields(a).length, `${p.filledCount}`)
  }
}

console.log(`\n========== cardMove：${pass} 通过 / ${fail} 失败 ==========`)
if (fail > 0) process.exit(1)
