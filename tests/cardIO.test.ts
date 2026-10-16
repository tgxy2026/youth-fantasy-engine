// ============ 角色卡批量导入导出（3.1.x）============
//
// 锁七件事：
//   ① 拍平：`tab.modules` → 字段列表，列名 = **纯字段名**（这就是 CSV 列头契约）；
//   ② 重名防御：同页签内字段名重复时列名退化为 `模块::字段`（绝不静默串位）；
//   ③ 虚拟表格页签：字段类型按取值来源推断（tableRef / select / text），主列 = 姓名；
//   ④ 映射与往返：CardRecord → 表格行 → CSV → 行对象 → CardRecord，键位与值逐字对上；
//   ⑤ 落库构造：卡名取「姓名」，data 的键是存储键（`模块::字段`），空值不写入；
//   ⑥ 多值引用列（所属势力）的悬空校验**逐个拆开**验 —— 整串比对会每一行都误报；
//   ⑦ 说明文档与多选转义：中文逗号的多选值不被 CSV 拆列，立绘不参与。
//
// 🔴 这里刻意用**真实 schema 的 char-main**，而不是自造 TabDef ——
//    「同页签内字段名不重复」是本适配层的前提，用真表测才能在将来有人加了重名字段时立刻炸出来。
import { getTab } from '../src/lib/schema'
import {
  CARD_NAME_FIELD, cardFieldsOf, cardFieldPathMap, cardNamePath, cardTabToTableTab,
  cardRecordsToTableRows, buildCardRecords, exportCardTemplateCsv, exportCardsCsv,
  buildCardImportGuide,
} from '../src/lib/storage/cardIO'
import {
  parseImportText, validateImport, buildImportPrepared, splitCsvLine,
  type ImportContext, type ImportRowResult,
} from '../src/lib/storage/tableIO'
import type { CardRecord, TabDef } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const charMain = getTab('char-main') as TabDef
const charNpc = getTab('char-npc') as TabDef
const vtab = cardTabToTableTab(charMain)
const PID = 'p1'

function card(id: string, name: string, data: Record<string, string>, order = 0): CardRecord {
  return { id, projectId: PID, tabId: 'char-main', name, data, order }
}
function picked(data: Record<string, string>, index = 1): ImportRowResult {
  return { data, index, dupExisting: false, dupInBatch: false, missing: [], dangling: [], codeConflict: false }
}
function emptyCtx(existing: CardRecord[] = []): ImportContext {
  return { existing: cardRecordsToTableRows(charMain, existing), refValues: new Map(), refLabels: new Map() }
}

// ---------- 1. 拍平：字段列表与列名契约 ----------
{
  ok('char-main 拿到真实页签', !!charMain && charMain.type === 'card', charMain?.type)

  const fields = cardFieldsOf(charMain)
  ok('字段数与 schema 一致（30）', fields.length === 30, String(fields.length))
  ok('保持模块顺序：首个字段是「姓名」', fields[0].name === CARD_NAME_FIELD && fields[0].module === '一、基础信息')
  ok('存储键格式 = 模块::字段', fields[0].path === '一、基础信息::姓名', fields[0].path)
  ok('列名不含模块前缀（短名口径）', fields.every(f => !f.name.includes('::')))

  // 前提断言：真表内字段名不重复 —— 一旦有人加了重名字段，这条会先炸，提示去处理退化分支
  const names = fields.map(f => f.name)
  ok('char-main 内字段名互不重复（适配层前提）', new Set(names).size === names.length)

  const npc = cardFieldsOf(charNpc)
  ok('char-npc 单模块 12 字段', npc.length === 12 && npc[0].name === '姓名', String(npc.length))

  // 自证：下面各节硬编码的存储键必须真实存在于 schema —— 将来谁改了模块名，这条会先炸，
  // 免得测试继续「自说自话地通过」（本次就是靠它才没把写错的路径蒙混过去）。
  const pathSet = new Set(fields.map(f => f.path))
  const used = [
    '一、基础信息::姓名', '一、基础信息::别称', '一、基础信息::人物状态', '一、基础信息::保密等级',
    '二、性格与内心::核心性格', '四、背景与关系::所属势力',
  ]
  ok('测试用到的存储键均真实存在于 schema', used.every(p => pathSet.has(p)),
    used.filter(p => !pathSet.has(p)).join('|'))
  ok('「所属势力」确实在「四、背景与关系」模块下', pathSet.has('四、背景与关系::所属势力'))
}

// ---------- 2. 重名防御：列名退化为全路径 ----------
{
  const dupTab: TabDef = {
    id: 'dup-card', name: '重名测试', group: '角色管理', type: 'card', description: '',
    modules: [
      { name: '一、甲', fields: [{ name: '名称', desc: '', example: '' }, { name: '独有A', desc: '', example: '' }] },
      { name: '二、乙', fields: [{ name: '名称', desc: '', example: '' }, { name: '独有B', desc: '', example: '' }] },
    ],
  }
  const f = cardFieldsOf(dupTab)
  ok('重名字段退化为全路径列名', f[0].name === '一、甲::名称' && f[2].name === '二、乙::名称', f.map(x => x.name).join('|'))
  ok('不重名的字段仍用短名', f[1].name === '独有A' && f[3].name === '独有B')
  // 退化后 path 与 name 一致 ⇒ 映射仍然自洽，不会把两列并到一处
  const m = cardFieldPathMap(dupTab)
  ok('退化后列名→存储键仍一一对应', m.get('一、甲::名称') === '一、甲::名称' && m.size === 4, String(m.size))
}

// ---------- 3. 虚拟表格页签：类型推断与主列 ----------
{
  ok('虚拟页签类型改为 table', vtab.type === 'table' && vtab.id === 'char-main')
  ok('主列 = 姓名', vtab.displayCol === CARD_NAME_FIELD, vtab.displayCol)

  const byName = new Map((vtab.columns ?? []).map(c => [c.name, c]))
  ok('「所属势力」→ tableRef + multiValue', byName.get('所属势力')?.type === 'tableRef'
    && byName.get('所属势力')?.refTab === 'nations' && byName.get('所属势力')?.multiValue === true)
  ok('「种族」→ tableRef（单选，不带 multiValue）', byName.get('种族')?.type === 'tableRef'
    && byName.get('种族')?.refTab === 'races' && !byName.get('种族')?.multiValue)
  ok('「地理位置」→ tableRef(geography)', byName.get('地理位置')?.refTab === 'geography')
  ok('「人物状态」→ select 且选项来自单一源', byName.get('人物状态')?.type === 'select'
    && byName.get('人物状态')?.options?.join(',') === '未登场,已登场,已退场')
  ok('「保密等级」→ select（S/A/B/C/D）', byName.get('保密等级')?.options?.join(',') === 'S,A,B,C,D')
  ok('普通字段 → text 且带上说明', byName.get('核心性格')?.type === 'text' && !!byName.get('核心性格')?.tip)
  ok('立绘不进列（不是 data 字段）', !byName.has('立绘') && !byName.has('portrait'))

  // char-npc 没有「所属势力」以外的引用列，同样应正确推断
  const npcCols = new Map((cardTabToTableTab(charNpc).columns ?? []).map(c => [c.name, c]))
  ok('char-npc 的主列也是姓名', cardTabToTableTab(charNpc).displayCol === CARD_NAME_FIELD)
  ok('char-npc「所属势力」同样标 multiValue', npcCols.get('所属势力')?.multiValue === true)
}

// ---------- 4. 导出：模板表头与数据列序 ----------
{
  const tpl = exportCardTemplateCsv(charMain)
  ok('模板只有一行表头', tpl.split('\n').length === 1, String(tpl.split('\n').length))
  ok('模板表头 = 纯字段名（首列姓名）', tpl.startsWith('姓名,别称,保密等级'), tpl.slice(0, 40))
  ok('模板表头列数 = 字段数', splitCsvLine(tpl).length === 30, String(splitCsvLine(tpl).length))

  const recs = [
    card('c1', '陈渊', { '一、基础信息::姓名': '陈渊', '二、性格与内心::核心性格': '坚韧、护短', '四、背景与关系::所属势力': '青岚宗，天机阁' }),
    card('c2', '萧景行', { '一、基础信息::姓名': '萧景行' }, 1),
  ]
  const csv = exportCardsCsv(charMain, recs)
  const lines = csv.split('\n')
  ok('导出：1 行表头 + 2 行数据', lines.length === 3, String(lines.length))
  const head = splitCsvLine(lines[0])
  const r1 = splitCsvLine(lines[1])
  ok('导出：按列名定位到「核心性格」', r1[head.indexOf('核心性格')] === '坚韧、护短', r1[head.indexOf('核心性格')])
  ok('导出：中文逗号的多选值仍在一格内', r1[head.indexOf('所属势力')] === '青岚宗，天机阁', r1[head.indexOf('所属势力')])
  ok('导出：空字段导出为空串', splitCsvLine(lines[2])[head.indexOf('核心性格')] === '')
}

// ---------- 5. 往返：导出 → 解析 → 校验 → 落库 ----------
{
  const src = [card('c1', '陈渊', {
    '一、基础信息::姓名': '陈渊',
    '一、基础信息::别称': '小渊、渊哥',
    '二、性格与内心::核心性格': '坚韧、护短、藏拙',
    '四、背景与关系::所属势力': '青岚宗，天机阁',
    '一、基础信息::人物状态': '已登场',
    '一、基础信息::保密等级': 'A',
  })]
  const csv = exportCardsCsv(charMain, src)
  const parsed = parseImportText(csv)
  const prepared = buildImportPrepared(parsed, vtab)
  ok('往返：识别为表格', !!parsed.table && prepared.rows.length === 1, parsed.note)

  const ctx: ImportContext = {
    existing: [],   // 空库 ⇒ 不判重
    refValues: new Map([['nations', new Set(['青岚宗', '天机阁'])]]),
    refLabels: new Map([['nations', '国家势力']]),
  }
  const results = validateImport(prepared.rows, vtab, ctx)
  ok('往返：不判重、不缺必填、无悬空', !results[0].dupExisting && results[0].missing.length === 0 && results[0].dangling.length === 0)

  let n = 0
  const back = buildCardRecords(results, charMain, [], PID, () => `new${++n}`)
  ok('往返：卡名 = 姓名', back[0].name === '陈渊', back[0].name)
  ok('往返：data 键是存储键', back[0].data['二、性格与内心::核心性格'] === '坚韧、护短、藏拙')
  ok('往返：多选值原样保留', back[0].data['四、背景与关系::所属势力'] === '青岚宗，天机阁')
  ok('往返：枚举值原样保留', back[0].data['一、基础信息::人物状态'] === '已登场' && back[0].data['一、基础信息::保密等级'] === 'A')
  ok('往返：order 从已有条数续号', back[0].order === 0 && back[0].projectId === PID && back[0].tabId === 'char-main')
  ok('往返：未填字段不写入 data（不留空串）', Object.keys(back[0].data).length === 6, String(Object.keys(back[0].data).length))
}

// ---------- 6. 多值引用列的悬空校验：逐个拆开 ----------
{
  const ctx: ImportContext = {
    existing: [],
    refValues: new Map([['nations', new Set(['青岚宗', '天机阁'])]]),
    refLabels: new Map([['nations', '国家势力']]),
  }
  const good = validateImport([{ 姓名: '陈渊', 所属势力: '青岚宗，天机阁' }], vtab, ctx)
  ok('多选值全命中 → 不报悬空', good[0].dangling.length === 0, JSON.stringify(good[0].dangling))

  const half = validateImport([{ 姓名: '陈渊', 所属势力: '青岚宗，不存在的宗' }], vtab, ctx)
  ok('多选值部分不命中 → 只报那一个子项', half[0].dangling.length === 1 && half[0].dangling[0].value === '不存在的宗',
    JSON.stringify(half[0].dangling))
  ok('悬空提示带上目标表显示名', half[0].dangling[0].refLabel === '国家势力', half[0].dangling[0].refLabel)

  const eng = validateImport([{ 姓名: '陈渊', 所属势力: '青岚宗,天机阁' }], vtab, ctx)
  ok('英文逗号分隔同样被拆开识别', eng[0].dangling.length === 0, JSON.stringify(eng[0].dangling))

  // 回归对照：单选引用列（种族）行为与改动前一致 —— 整串比对
  const single = validateImport([{ 姓名: '陈渊', 种族: '人族' }], vtab, { ...ctx, refValues: new Map([['races', new Set(['人族', '妖族'])]]) })
  ok('单选引用列命中 → 不报悬空', single[0].dangling.length === 0)
  const singleBad = validateImport([{ 姓名: '陈渊', 种族: '精灵' }], vtab, { ...ctx, refValues: new Map([['races', new Set(['人族', '妖族'])]]) })
  ok('单选引用列不命中 → 报悬空', singleBad[0].dangling.length === 1 && singleBad[0].dangling[0].value === '精灵')
}

// ---------- 7. 判重与缺必填（走 tableIO 同一套） ----------
{
  const exist = [card('c1', '陈渊', { '一、基础信息::姓名': '陈渊' })]
  const ctx = emptyCtx(exist)
  const dup = validateImport([{ 姓名: '陈渊' }, { 姓名: '叶昭' }], vtab, ctx)
  ok('与已有卡同姓名 → 判重', dup[0].dupExisting && !dup[1].dupExisting)
  const batch = validateImport([{ 姓名: '叶昭' }, { 姓名: '叶昭' }], vtab, emptyCtx())
  ok('批内同姓名 → 判重', !batch[0].dupInBatch && batch[1].dupInBatch)
  const miss = validateImport([{ 姓名: '', 别称: 'x' }], vtab, emptyCtx())
  ok('缺姓名 → 缺必填并点名「姓名」', miss[0].missing.join(',') === '姓名', miss[0].missing.join(','))
  const noCode = validateImport([{ 姓名: '叶昭' }], vtab, emptyCtx())
  ok('角色卡无编号列 ⇒ 永不报编号冲突', noCode[0].codeConflict === false)
}

// ---------- 8. 落库构造的边界 ----------
{
  let n = 0
  const uid = () => `n${++n}`
  const two = buildCardRecords([picked({ 姓名: '叶昭' }, 1), picked({ 姓名: '苏瑶' }, 2)], charMain,
    [card('c1', '陈渊', {}, 0), card('c2', '萧景行', {}, 1)], PID, uid)
  ok('多行落库：order 从已有条数续号', two[0].order === 2 && two[1].order === 3, `${two[0].order},${two[1].order}`)
  ok('多行落库：id 逐个生成', two[0].id === 'n1' && two[1].id === 'n2')

  const blank = buildCardRecords([picked({ 姓名: '' })], charMain, [], PID, uid)
  ok('姓名为空（兜底路径）→ 用「未命名角色」', blank[0].name === '未命名角色', blank[0].name)

  const npc = buildCardRecords([picked({ 姓名: '王铁柱', 功能定位: '氛围组' })], charNpc, [], PID, uid)
  ok('char-npc 落库键位正确', npc[0].data['NPC档案::功能定位'] === '氛围组', JSON.stringify(npc[0].data))
  ok('char-npc 卡名取姓名', npc[0].name === '王铁柱' && npc[0].tabId === 'char-npc')
}

// ---------- 9. 说明文档 ----------
{
  const guide = buildCardImportGuide(charMain)
  ok('说明含页签名', guide.includes('《主要角色》'), guide.slice(0, 40))
  ok('说明点出角色卡特有事项（立绘）', guide.includes('人物立绘不在 CSV 里'))
  ok('说明点出多选分隔符口径', guide.includes('中文逗号'))
  ok('说明含可复制的表头行', guide.includes('姓名,别称,保密等级'))
  ok('说明含 AI 提示词段', guide.includes('交给其他 AI 整理用的提示词'))
  ok('说明含「姓名」必填提示', guide.includes('**必填**') && guide.includes('「姓名」这一列是必填'))
}

// ---------- 10. R9：卡片标题与「姓名」字段的口径（2026-10-16 独立复核） ----------
//
// 背景：手工新建卡走 submitNamePrompt 的 add 分支，产出的是 `{ name: '手工新建角色', data: {} }`
// —— **标题有值、data 里姓名为空**。历史数据里也有重命名后标题与字段不一致的。
// 若适配层只读 data，导出 CSV 的「姓名」为空 ⇒ 往返丢名字 + 判重失效（同名可重复建卡）。
{
  ok('cardNamePath 指向姓名字段的存储键', cardNamePath(charMain) === '一、基础信息::姓名', String(cardNamePath(charMain)))

  const manual = card('m1', '手工新建角色', {})   // ← 手工新建的真实形态
  const rows = cardRecordsToTableRows(charMain, [manual])
  ok('R9：姓名为空时用卡片标题兜底', rows[0].data['姓名'] === '手工新建角色', String(rows[0].data['姓名']))

  const csv = exportCardsCsv(charMain, [manual])
  const head = splitCsvLine(csv.split('\n')[0])
  ok('R9：手工卡的导出 CSV「姓名」不为空',
    splitCsvLine(csv.split('\n')[1])[head.indexOf('姓名')] === '手工新建角色',
    splitCsvLine(csv.split('\n')[1])[head.indexOf('姓名')])

  const dup = validateImport([{ 姓名: '手工新建角色' }], vtab,
    { existing: rows, refValues: new Map(), refLabels: new Map() })
  ok('R9：与「仅有标题」的已有卡能判重（此前漏判）', dup[0].dupExisting === true)

  // 往返：导出 → 解析 → 校验 → 落库，名字与姓名字段都保住
  const prepared2 = buildImportPrepared(parseImportText(csv), vtab)
  const results2 = validateImport(prepared2.rows, vtab, emptyCtx())
  let n2 = 0
  const back2 = buildCardRecords(results2, charMain, [], PID, () => `m${++n2}`)
  ok('R9：手工卡导出→导入往返保住卡名', back2[0].name === '手工新建角色', back2[0].name)
  ok('R9：往返后姓名字段也被补齐', back2[0].data['一、基础信息::姓名'] === '手工新建角色',
    String(back2[0].data['一、基础信息::姓名']))

  // 姓名字段**有值时不覆盖** —— 作者可能故意让标题与姓名不同
  const both = card('m2', '陈渊（主角）', { '一、基础信息::姓名': '陈渊' })
  const rows2 = cardRecordsToTableRows(charMain, [both])
  ok('R9：姓名字段有值时不被标题覆盖', rows2[0].data['姓名'] === '陈渊', String(rows2[0].data['姓名']))

  // 标题为空（异常数据）时不该把空串写进去顶掉「缺必填」判定
  const blank = cardRecordsToTableRows(charMain, [card('m3', '', {})])
  ok('R9：标题也空时保持空（仍会被判缺必填）', blank[0].data['姓名'] === '', JSON.stringify(blank[0].data['姓名']))
}

// ---------- 11. 说明生成器对「虚拟表格页签」幂等（R10 接线的隐性依赖） ----------
//
// 🔴 为什么值得钉：导入弹窗拿到的是 `cardTabToTableTab(tab)` 的结果（虚拟页签），
//    而 `guideBuilder`（= buildCardImportGuide）内部会**再拍平一次**。这目前只因为
//    `cardTabToTableTab` 用 `...tab` 顺带保留了 `modules` 才成立 —— 一旦日后把 modules
//    从虚拟页签上剥离，说明文档会**静默退化**成通用版（作者下载到的说明悄悄少了几段）。
{
  const fromVirtual = buildCardImportGuide(vtab)
  ok('R10：对虚拟表格页签调用仍产出卡片特有段落',
    fromVirtual.includes('人物立绘不在 CSV 里') && fromVirtual.includes('《主要角色》'),
    fromVirtual.slice(0, 60))
  ok('R10：两种入参（原页签 / 虚拟页签）产出完全一致',
    fromVirtual === buildCardImportGuide(charMain))
}

console.log(`\n=== cardIO: ${pass} passed, ${fail} failed ===`)
if (fail > 0) process.exit(1)
