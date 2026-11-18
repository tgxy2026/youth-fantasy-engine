// ============ 图鉴「按语义看」只读投影（3.6.1 · B5）============
//
// `templates/semanticView` 在 3.6.0 记账时是 `gap`：AI 侧的字段提示已由 `consumers.ts` 承担，
// 模块本身面向**界面投影**。3.6.1 把它接进图鉴详情，边界写死：
//   · 只读：不写回、不提供"按语义改"；
//   · 不落第二份事实库：投影只在渲染时算；
//   · 分组与槽位**全部来自 `slotsForTab`**（语义映射的唯一真源），界面不自己列字段名。
//
// 这里钉：分组归属、出处标注、空值不占位、非语义页签整块不渲染、以及「不改原记录」。
import { resolveTemplateForTab } from '../src/lib/templates/resolve'
import { getTab } from '../src/lib/schema'
import { buildSemanticPreview, SEMANTIC_GROUPS } from '../src/lib/atlas/semanticPreview'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const tab = getTab('char-main')
if (!tab) throw new Error('人物页签不存在，夹具失效')
const template = resolveTemplateForTab(tab, { purpose: 'detail', ignoreAppliesTo: true })

/**
 * 按**显示名**取存储键：人物卡的存储键是 `模块::字段`（如 `一、基础信息::身份定位`）。
 * 🔴 测试不写死存储键 —— 键随模板结构走，写死会让"改一下分组标题"就红成假失败。
 */
const keyOf = (label: string): string => {
  const field = template.fields.find(f => f.label === label)
  if (!field) throw new Error(`模板里没有字段「${label}」，夹具失效`)
  return field.sourceKey
}
const recordOf = (data: Record<string, string>) => ({
  id: 'row-1',
  data: Object.fromEntries(Object.entries(data).map(([label, value]) => [keyOf(label), value])),
})

function main() {
  // ① 分组来自槽位目录，不是界面自己列的字段名
  {
    ok('三组固定且顺序稳定', SEMANTIC_GROUPS.map(g => g.id).join(',') === 'identity,motivation,state')
    ok('中文名是身份 / 动机 / 状态', SEMANTIC_GROUPS.map(g => g.label).join(',') === '身份,动机,状态')
  }

  // ② 正常投影：值、槽位名、出处都对得上
  {
    const groups = buildSemanticPreview(template, recordOf({
      姓名: '林砚',
      身份定位: '青云宗掌门',
      '核心矛盾/内在挣扎': '守旧与护短',
      实力境界: '元婴初期',
      所属势力: '青云宗',
    }), 'char-main')
    const byId = Object.fromEntries(groups.map(g => [g.id, g]))
    ok('三组都产出（页签属于语义实体）', groups.length === 3, String(groups.length))
    const identity = byId.identity.items.map(i => i.value)
    ok('身份组含身份定位', identity.includes('青云宗掌门'), JSON.stringify(identity))
    ok('身份组含所属势力（同组多槽位）', identity.includes('青云宗'), JSON.stringify(identity))
    ok('动机组含核心矛盾', byId.motivation.items.some(i => i.value === '守旧与护短'), JSON.stringify(byId.motivation.items))
    ok('状态组含实力境界', byId.state.items.some(i => i.value === '元婴初期'), JSON.stringify(byId.state.items))
    ok('姓名不属于这三组（不硬塞）', groups.every(g => g.items.every(i => i.value !== '林砚')), JSON.stringify(groups))
    const item = byId.identity.items.find(i => i.value === '青云宗掌门')
    ok('逐项标注出处字段（可回表格核对）', item?.sourceLabels.includes('身份定位') === true, JSON.stringify(item?.sourceLabels))
    ok('槽位名用目录里的中文名', item?.label === '身份定位', String(item?.label))
  }

  // ③ 空值不占位，但组仍标记为「有对应字段」
  {
    const groups = buildSemanticPreview(template, recordOf({ 身份定位: '散修' }), 'char-main')
    const motivation = groups.find(g => g.id === 'motivation')
    ok('没填的组不给空条目（速查视图不占位）', motivation?.items.length === 0, JSON.stringify(motivation?.items))
    ok('仍标记该组有对应字段（≠ 资料缺失）', motivation?.mapped === true)
  }

  // ④ 页签不参与语义映射 ⇒ 整块不渲染
  {
    const groups = buildSemanticPreview(template, recordOf({ 身份定位: '散修' }), 'not-a-real-tab')
    ok('非语义页签返回空数组（界面据此整块不渲染）', groups.length === 0, String(groups.length))
  }

  // ⑤ 只读：不改原记录、不改模板
  {
    const rec = recordOf({ 身份定位: '散修' })
    const before = JSON.stringify(rec.data)
    buildSemanticPreview(template, rec, 'char-main')
    ok('投影不修改原记录', JSON.stringify(rec.data) === before)
    ok('投影不往记录里塞字段', Object.keys(rec.data).length === 1, JSON.stringify(rec.data))
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} semanticPreview ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
