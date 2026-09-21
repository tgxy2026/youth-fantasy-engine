// ============ 「全书级设定汇总」的字段清单与表单写入通道 ============
//
// 两件事必须钉死：
//   ① **覆盖范围**：老大 2026-09-18 口径是「不止点名的三张，针对所有表」——
//      所以这里是**动态**取 schema 全部 form 型页签，新增 form 页签要自动纳入（不能写死三张）。
//   ② **写入语义**：表单是整项目单份、没有"同名条目"，冲突策略要作用在**字段**上。
//      最容易错的是"keep-existing 也填空"这条 —— 按条目型那样"已存在就整条不动"的话，
//      汇总将永远写不进任何东西（而这是静默失效，界面上只是"好像没生效"）。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { TABS } from '../src/lib/schema'
import { commitDraftRows, previewCommit } from '../src/lib/flow/commit'
import { defaultPicked } from '../src/lib/flow/draft'
import { formDraftRows, formFieldSpecs, formFieldNames, formFieldsPrompt, summaryFormTabs } from '../src/lib/flow/formMap'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
const PID = 'flow-form-test'
db.setCurrentProject(PID)

const FORM_TABS = TABS.filter(t => t.type === 'form')

// ---------- ① 覆盖范围：动态取全部 form 型（不是写死三张） ----------
{
  const ids = summaryFormTabs()
  ok('覆盖 schema 里全部 form 型页签',
    ids.length === FORM_TABS.length && FORM_TABS.every(t => ids.includes(t.id)),
    `派生 ${ids.length} / schema ${FORM_TABS.length}`)
  ok('包含需求点名的三张（作品定位 / 世界设定 / 力量体系）',
    ['positioning', 'worldbase', 'power'].every(id => ids.includes(id)), ids.join(','))
  ok('🔴 也包含其余 form 型（老大口径：不止点名的三张）',
    ids.includes('master') && ids.includes('style'), ids.join(','))
  for (const t of FORM_TABS) {
    const n = (t.modules ?? []).reduce((acc, m) => acc + m.fields.length, 0)
    ok(`  · 「${t.name}」的 ${n} 个字段全部纳入清单`,
      formFieldSpecs().filter(s => s.tabId === t.id).length === n)
  }
  ok('字段总数与手工统计一致',
    formFieldSpecs().length === FORM_TABS.reduce((acc, t) => acc + (t.modules ?? []).reduce((a, m) => a + m.fields.length, 0), 0),
    String(formFieldSpecs().length))
  ok('提示词清单带页签名 / 模块名 / 字段名 / 说明',
    /〖世界设定〗/.test(formFieldsPrompt()) && /世界名称/.test(formFieldsPrompt()) && /例：/.test(formFieldsPrompt()))
  ok('字段白名单不含不存在的字段', !formFieldNames('worldbase').has('瞎写的字段名'))
}

// ---------- ② 模型产出 → 草稿行 ----------
{
  const rows = formDraftRows({
    世界设定: { 世界名称: '苍澜大陆', 一句话世界观: '神族封仙路收割人族灵气', 瞎写的字段: '应被挡掉' },
    worldbase_dup: {},
  })
  ok('顶层键认页签名', rows.length === 1 && rows[0].tabId === 'worldbase', JSON.stringify(rows.map(r => r.tabId)))
  const row = rows[0]
  ok('🔴 幽灵字段被挡掉（schema 里没有的一律不落）',
    !row.fields.some(f => f.label === '瞎写的字段'), JSON.stringify(row.fields.map(f => f.label)))
  ok('字段顺序＝schema 顺序（世界名称在前）', row.fields[0].label === '世界名称', row.fields[0].label)
  ok('落库键形如 `模块::字段`', row.fields[0].key === '一、世界总览::世界名称', row.fields[0].key)
  ok('空值字段不进草稿',
    formDraftRows({ 世界设定: { 世界名称: '甲', 一句话世界观: '   ' } })[0].fields.length === 1)
  ok('一个字段都没填的页签不产出空行', formDraftRows({ 世界设定: { 世界名称: '' } }).length === 0)
  ok('顶层键也认页签 id', formDraftRows({ worldbase: { 世界名称: '乙' } })[0]?.fields[0].value === '乙')
  ok('恒为 new（表单无同名判重）', row.status === 'new')
  ok('置信度达标 → 默认勾选（作者要的就是汇总）', defaultPicked(row))
  ok('非 form 页签的键被忽略（不会往卡片表乱写）',
    formDraftRows({ 主要角色: { 姓名: '陈渊' } }).length === 0)
}

// ---------- ②b 🔴 模型按「页签 → 模块 → 字段」三层输出（实机就是这个形态） ----------
// 2026-09-18 实机抓到：提示词里的字段清单按「页签〖〗→ 模块 → 字段」给，模型于是照着这个层级输出，
// 而原实现只认两层（页签 → 字段）→ **5 张表全部被静默丢弃**，界面只显示"没汇总出可用的全书级设定"。
// 产出本身完全正确，错的是我们读它的方式。
{
  const real = {
    作品定位: { '一、基本信息': { 类型赛道: '东方玄幻' } },
    世界设定: { '一、世界总览': { 世界名称: '苍澜大陆', 世界体量与格局: '东洲·云州' } },
    力量体系: { '一、体系总览': { 体系类型: '修炼流' }, '二、修炼路径与资源': { 修炼资源体系: '青玉丹' } },
  }
  const rows = formDraftRows(real)
  ok('🔴 三层结构也能读出草稿行', rows.length === 3, `${rows.length}：${rows.map(r => r.tabId).join(',')}`)
  const world = rows.find(r => r.tabId === 'worldbase')
  ok('  字段值正确取出', world?.fields.map(f => f.label).join(',') === '世界名称,世界体量与格局',
    JSON.stringify(world?.fields.map(f => f.label)))
  ok('  落库键仍按 `模块::字段` 组装', world?.fields[0].key === '一、世界总览::世界名称', world?.fields[0].key)
  ok('  同一张表跨模块的字段都收齐（力量体系 2 个模块 2 字段）',
    rows.find(r => r.tabId === 'power')?.fields.length === 2,
    JSON.stringify(rows.find(r => r.tabId === 'power')?.fields.map(f => f.label)))
  ok('两层与三层混用也不出错（模型两种都可能给）',
    formDraftRows({ 世界设定: { 世界名称: '甲' }, 力量体系: { '一、体系总览': { 体系名称: '乙' } } }).length === 2)
  ok('三层里的幽灵字段照样被挡',
    formDraftRows({ 世界设定: { '一、世界总览': { 世界名称: '甲', 瞎写: 'x' } } })[0].fields.length === 1,
    JSON.stringify(formDraftRows({ 世界设定: { '一、世界总览': { 世界名称: '甲', 瞎写: 'x' } } })[0].fields.map(f => f.label)))
}

// ---------- ③ 表单写入通道 ----------
{
  const rows = () => formDraftRows({ 世界设定: { 世界名称: '苍澜大陆', 一句话世界观: '神族封仙路' } })

  // 全新（form 原本为空）
  const out1 = await commitDraftRows(rows(), { conflict: 'keep-existing' })
  const d1 = await db.getFormData('worldbase')
  ok('🔴 原本为空 → keep-existing 也要填上（否则汇总永远写不进，功能静默失效）',
    d1['一、世界总览::世界名称'] === '苍澜大陆', JSON.stringify(d1))
  ok('  算作新建', out1.created === 1 && out1.updated === 0, JSON.stringify(out1))

  // 作者手改过 → 不覆盖，但空字段继续补
  await db.saveFormData('worldbase', { '一、世界总览::世界名称': '作者手写：九霄界' })
  const out2 = await commitDraftRows(rows(), { conflict: 'keep-existing' })
  const d2 = await db.getFormData('worldbase')
  ok('🔴 作者已填的字段不被覆盖', d2['一、世界总览::世界名称'] === '作者手写：九霄界', JSON.stringify(d2))
  ok('  空字段仍被补上（累积合并）', d2['一、世界总览::一句话世界观'] === '神族封仙路', JSON.stringify(d2))
  ok('  算作更新', out2.updated === 1 && out2.created === 0, JSON.stringify(out2))

  // 再跑一次 → 无可写内容，一个字都不动
  const out3 = await commitDraftRows(rows(), { conflict: 'keep-existing' })
  ok('幂等：全部已填时不再写库（created/updated 都为 0）',
    out3.created === 0 && out3.updated === 0, JSON.stringify(out3))

  // use-incoming 才覆盖
  await commitDraftRows(rows(), { conflict: 'use-incoming' })
  ok('只有 use-incoming 会覆盖手改内容',
    (await db.getFormData('worldbase'))['一、世界总览::世界名称'] === '苍澜大陆')
}

// ---------- ④ 落库预览与实际一致 ----------
{
  __resetMockStores()
  db.setCurrentProject('flow-form-test-preview')
  const rows = formDraftRows({ 世界设定: { 世界名称: '苍澜大陆' } })

  const p1 = await previewCommit(rows, 'keep-existing')
  ok('预览：空表 → create', p1.create === 1 && p1.items[0].action === 'create', JSON.stringify(p1.items))

  // 表里已有别的字段内容、但目标字段（世界名称）还空着 → 会写，算 update
  await db.saveFormData('worldbase', { '一、世界总览::一句话世界观': '已有内容' })
  const p2 = await previewCommit(rows, 'keep-existing')
  ok('预览：表里已有内容但目标字段为空 → update', p2.update === 1 && p2.items[0].action === 'update', JSON.stringify(p2.items))

  await db.saveFormData('worldbase', { '一、世界总览::世界名称': '已有内容' })
  const p3 = await previewCommit(rows, 'keep-existing')
  ok('预览：目标字段已填 → skip（与实际落库一致）', p3.skip === 1 && p3.items[0].action === 'skip', JSON.stringify(p3.items))

  // 预览说 skip，实际也得真的不写（"看到的与将要发生的对得上"）
  const before = JSON.stringify(await db.getFormData('worldbase'))
  await commitDraftRows(rows, { conflict: 'keep-existing' })
  ok('🔴 预览为 skip 时，实际落库确实没动',
    JSON.stringify(await db.getFormData('worldbase')) === before)
}

console.log(`\n—— flowFormMap 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
