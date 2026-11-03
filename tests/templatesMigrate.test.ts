// ============ 3.2.0 · WT1-4：模板迁移执行、隔离与恢复 ============
//
// 钉五件事（全部来自方案 §3.6，逐条对应）：
//   ① 逐值类型转换**只做计划承诺过的组合**，失败不返回空串（不许静默删数据）；
//   ② 迁移前备份必须**读回校验**；值改写后失败要能按备份恢复；
//   ③ 计划/值的**基线**过期必须停手 —— 不拿旧计划改新定义；
//   ④ 「未解决前不能报告完整迁移成功」⇒ 有失败/待人工项时落 `done-partial`；
//   ⑤ 隔离：内存锁 + 持久阻断态；恢复未完成前禁止再迁移同一页签。
import * as db from '../src/lib/db'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { __resetMockStores } from './mock-memory'
import { TEMPLATE_DEF_VERSION, type TemplateDef } from '@/lib/templates/definition'
import { planTemplateChange, planIsNoop } from '@/lib/templates/plan'
import type { EffectiveField } from '@/lib/templates/types'
import { loadTemplateDef, saveTemplateDef, loadTemplateIndex } from '@/lib/templates/store'
import { MIGRATION_KEY_PREFIX } from '@/lib/templates/migrationLog'
import {
  loadMigrationLog, loadMigrationBackup, saveMigrationLog, saveMigrationBackup,
  clearMigrationArtifacts, MIGRATION_LOG_VERSION, migrationLogKeyOf,
} from '@/lib/templates/migrationLog'
import {
  applyTemplateMigration, convertValueForMigration, recoverTemplateMigration,
} from '@/lib/templates/migrate'
import {
  beginTabMigrationLock, guardTabWrite, isTabMigrationActive, migrationStateLabel,
} from '@/lib/templates/migrationGuard'
import { isSensitiveMetaKey, isLocalOnlyMetaKey } from '@/lib/storage/sensitiveMeta'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-mig'
const TAB = 'races'

function mkField(over: Partial<EffectiveField> = {}): EffectiveField {
  const id = over.id ?? 'cf_x'
  return {
    id,
    sourceKey: id,
    source: 'custom',
    label: over.label ?? `字段${id}`,
    type: 'text',
    groupId: 'g1',
    order: 0,
    appliesTo: '*',
    archived: false,
    permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
    ...over,
  }
}

function mkDef(fields: EffectiveField[], over: Partial<TemplateDef> = {}): TemplateDef {
  return {
    formatVersion: TEMPLATE_DEF_VERSION,
    templateId: 'builtin:races',
    name: '模板',
    tabId: TAB,
    origin: { kind: 'builtin' },
    groups: [{ id: 'g1', label: '扩展', order: 0 }],
    fields,
    nameFieldId: fields[0]?.id ?? '',
    semanticDigest: 'd1',
    revision: 0,
    updatedAt: 1,
    ...over,
  }
}

const seedForm = (data: Record<string, string>) => db.saveFormDataFor(PID, TAB, data)
const seedRow = (id: string, data: Record<string, string>, order = 0) =>
  db.saveTableRow({ id, projectId: PID, tabId: TAB, data, order })
const readForm = () => db.getFormDataFor(PID, TAB)
const readRow = async (id: string) => (await db.getTableRowsFor(PID, TAB)).find(r => r.id === id)

async function main() {

// ────────────────────────── ① 逐值转换 ──────────────────────────
{
  const c = (f: Parameters<typeof convertValueForMigration>[0], t: Parameters<typeof convertValueForMigration>[1], v: string, o?: { options?: string[] }) =>
    convertValueForMigration(f, t, v, o)

  ok('① 空值恒合法（不管什么类型）', c('text', 'number', '') .ok === true)
  ok('① 类型未变原样保留', (() => { const r = c('number', 'number', '3.50'); return r.ok && r.value === '3.50' })())
  ok('① 文本→数字：合法值原样保留写法', (() => { const r = c('text', 'number', '3.50'); return r.ok && r.value === '3.50' })())
  ok('① 文本→数字：非法值失败', c('text', 'number', '很多').ok === false)
  ok('① 文本→数字：带单位失败（不猜）', c('text', 'number', '18 级').ok === false)
  ok('① 文本→单选：命中选项通过', (() => { const r = c('text', 'select', '天级', { options: ['天级', '地级'] }); return r.ok && r.value === '天级' })())
  ok('① 文本→单选：未命中失败', c('text', 'select', '玄级', { options: ['天级', '地级'] }).ok === false)
  ok('① 文本→布尔：是/否', (() => { const a = c('text', 'boolean', '是'); const b = c('text', 'boolean', '否'); return a.ok && a.value === 'true' && b.ok && b.value === 'false' })())
  ok('① 文本→布尔：1/0', (() => { const a = c('text', 'boolean', '1'); const b = c('text', 'boolean', '0'); return a.ok && a.value === 'true' && b.ok && b.value === 'false' })())
  ok('① 文本→布尔：其它值失败（不默认成否）', c('text', 'boolean', '大概吧').ok === false)
  ok('① 长文本→短文本：200 字内通过', c('textarea', 'text', '短').ok === true)
  ok('① 长文本→短文本：超 200 字失败', c('textarea', 'text', '长'.repeat(201)).ok === false)
  ok('① 多选→单选：一律人工（结构不同）', c('multiSelect', 'select', 'a,b').ok === false)
  ok('① 未承诺的组合一律失败（不发明转换）', c('date', 'text', '1001-01-01').ok === false)
}

// ────────────────────────── ② 正常迁移：同 ID 改型 ──────────────────────────
{
  __resetMockStores()
  const from = mkDef([
    mkField({ id: 'cf_name', label: '名称' }),
    mkField({ id: 'cf_power', label: '战力' }),
  ], { templateId: 'builtin:races', revision: 0, semanticDigest: 'd1' })
  const to = mkDef([
    mkField({ id: 'cf_name', label: '名称' }),
    mkField({ id: 'cf_power', label: '战力', type: 'number' }),
  ], { templateId: 'builtin:races', revision: 1, semanticDigest: 'd2' })

  await saveTemplateDef(PID, from)
  await seedForm({ cf_name: '赤焰', cf_power: '18' })
  await seedRow('r1', { cf_name: '冰魄', cf_power: '7' })

  const plan = planTemplateChange(from, to)
  const res = await applyTemplateMigration({ pid: PID, tabId: TAB, plan, to, expectedFrom: from })
  ok('② 迁移成功 = done', res.ok && res.state === 'done', JSON.stringify(res).slice(0, 200))

  const form = await readForm()
  const row = await readRow('r1')
  ok('② 表单值保留（数字原样）', form.cf_power === '18')
  ok('② 表格行值也参与迁移', row?.data?.cf_power === '7')

  const cur = await loadTemplateDef(PID, TAB)
  ok('② 定义已切到新版本', cur?.revision === 1 && cur?.semanticDigest === 'd2')
  const idx = await loadTemplateIndex(PID)
  ok('② 目录索引同步更新', idx.entries.find(e => e.tabId === TAB)?.revision === 1)

  const log = await loadMigrationLog(PID, TAB)
  ok('② 日志记录完成态', log?.state === 'done')
  ok('② 备份读回校验通过（严格持久化证据）', log?.backupVerified === true)
  const ids = (log?.steps ?? []).map(s => s.id)
  ok('② 逐步记录齐六个环节',
    ['verify', 'backup', 'values', 'template', 'index', 'invalidate'].every(x => ids.includes(x as never)),
    ids.join(','))
  const backup = await loadMigrationBackup(PID, TAB)
  ok('② 备份只存被改写的槽位（2 条：表单 + 一行）', backup?.values.length === 2, JSON.stringify(backup?.values))
  ok('② 备份里是**原值**而不是迁移后的值',
    (backup?.values ?? []).length > 0 && (backup?.values ?? []).every(v => v.value === '18' || v.value === '7'))

  // 幂等：同一份目标再跑一次
  const again = planTemplateChange(to, to)
  ok('② 同目标重算计划 = no-op', planIsNoop(again))
  const res2 = await applyTemplateMigration({ pid: PID, tabId: TAB, plan: again, to, expectedFrom: to })
  ok('② 重复执行识别为 noop（不反复改义）', res2.ok && res2.state === 'noop')
}

// ────────────────────────── ③ 转换失败 ⇒ done-partial，原值保留 ──────────────────────────
{
  __resetMockStores()
  const from = mkDef([mkField({ id: 'cf_power', label: '战力' })], { revision: 0, semanticDigest: 'd1' })
  const to = mkDef([mkField({ id: 'cf_power', label: '战力', type: 'number' })], { revision: 1, semanticDigest: 'd2' })
  await saveTemplateDef(PID, from)
  await seedForm({ cf_power: '很多' })

  const plan = planTemplateChange(from, to)
  const res = await applyTemplateMigration({ pid: PID, tabId: TAB, plan, to, expectedFrom: from })
  ok('③ 有失败条目 ⇒ done-partial（不装成功）', res.ok && res.state === 'done-partial')

  const form = await readForm()
  ok('③ 转换失败保留原值（没变空白）', form.cf_power === '很多')
  const log = await loadMigrationLog(PID, TAB)
  ok('③ 失败条目带原值，作者能据此判断', log?.failures.length === 1 && log.failures[0].value === '很多')
  ok('③ 失败条目指向具体槽位', log?.failures[0].target === 'form')
  ok('③ 结构仍然切过去了（值的问题不阻塞结构）', (await loadTemplateDef(PID, TAB))?.revision === 1)
}

// ────────────────────────── ④ 基线过期必须停手 ──────────────────────────
{
  __resetMockStores()
  const from = mkDef([mkField({ id: 'cf_a' })], { revision: 0, semanticDigest: 'd1' })
  const to = mkDef([mkField({ id: 'cf_a' }), mkField({ id: 'cf_b' })], { revision: 1, semanticDigest: 'd2' })
  await saveTemplateDef(PID, from)
  await seedForm({ cf_a: '保留' })
  const plan = planTemplateChange(from, to)

  // 计划算完之后，作者又在别处改了一版模板
  await saveTemplateDef(PID, { ...from, revision: 3, semanticDigest: 'd3' })
  const res = await applyTemplateMigration({ pid: PID, tabId: TAB, plan, to, expectedFrom: from })
  ok('④ 配置基线变了 ⇒ 停手', !res.ok && res.code === 'baseline-config-changed', JSON.stringify(res).slice(0, 160))
  ok('④ 停手时不动任何值', (await readForm()).cf_a === '保留')
  ok('④ 停手时不写日志（没有半个中间态）', (await loadMigrationLog(PID, TAB)) === null)
  ok('④ 定义仍是作者刚改的那版', (await loadTemplateDef(PID, TAB))?.revision === 3)

  // 计划与旧定义不配套
  const badPlan = planTemplateChange(mkDef([], { templateId: 'other:races' }), to)
  const res2 = await applyTemplateMigration({ pid: PID, tabId: TAB, plan: badPlan, to, expectedFrom: from })
  ok('④ 计划起点与传入旧定义不一致 ⇒ 拒绝', !res2.ok && res2.code === 'plan-baseline-mismatch')

  // 值基线变化
  __resetMockStores()
  await saveTemplateDef(PID, from)
  await seedForm({ cf_a: '一' })
  const plan2 = planTemplateChange(from, to, { valueCounts: { cf_a: 1 } })
  await seedRow('r2', { cf_a: '二' })
  const res3 = await applyTemplateMigration({ pid: PID, tabId: TAB, plan: plan2, to, expectedFrom: from })
  ok('④ 值规模变了 ⇒ 要求重新推演', !res3.ok && res3.code === 'baseline-values-changed', JSON.stringify(res3).slice(0, 160))
}

// ────────────────────────── ⑤ 回滚：目标模板非法 ⇒ 值回到原样 ──────────────────────────
{
  __resetMockStores()
  const from = mkDef([mkField({ id: 'cf_power', label: '战力' })], { revision: 0, semanticDigest: 'd1' })
  const to = mkDef(
    // 字段名 21 字 ⇒ 超「名称 1–20 字」限额 ⇒ `saveTemplateDef` 整体拒绝（不截断）
    [mkField({ id: 'cf_power', label: '战'.repeat(21), type: 'number' })],
    { revision: 1, semanticDigest: 'd2' },
  )
  await saveTemplateDef(PID, from)
  await seedForm({ cf_power: ' 18 ' })

  const plan = planTemplateChange(from, to)
  const res = await applyTemplateMigration({ pid: PID, tabId: TAB, plan, to, expectedFrom: from })
  ok('⑤ 模板被拒 ⇒ 迁移失败', !res.ok && res.code === 'template-rejected', JSON.stringify(res).slice(0, 200))
  ok('⑤ 失败后已恢复', !res.ok && res.recovered === true)
  const form = await readForm()
  ok('⑤ 值恢复为原文（含空格的原写法）', form.cf_power === ' 18 ', JSON.stringify(form))
  ok('⑤ 定义仍是旧版', (await loadTemplateDef(PID, TAB))?.revision === 0)
  const log = await loadMigrationLog(PID, TAB)
  ok('⑤ 日志落 rolled-back（可追溯）', log?.state === 'rolled-back')
  ok('⑤ 备份里存的是原文，恢复才有依据', log?.backupVerified === true)
}

// ────────────────────────── ⑥ 同名映射：未确认不动值，确认才复制 ──────────────────────────
{
  __resetMockStores()
  const from = mkDef([mkField({ id: 'cf_old', label: '别名' })], { revision: 0, semanticDigest: 'd1' })
  const to = mkDef([mkField({ id: 'cf_new', label: '别名' })], { revision: 1, semanticDigest: 'd2' })
  await saveTemplateDef(PID, from)
  await seedForm({ cf_old: '旧值' })

  const plan = planTemplateChange(from, to)
  ok('⑥ 计划只给建议、不自动合并', plan.items.some(i => i.disposition === 'suggested-map' && i.suggestedTargetId === 'cf_new'))

  const res = await applyTemplateMigration({ pid: PID, tabId: TAB, plan, to, expectedFrom: from })
  const form = await readForm()
  ok('⑥ 未确认 ⇒ 不写新键', form.cf_new === undefined, JSON.stringify(form))
  ok('⑥ 未确认 ⇒ 旧值原地保留', form.cf_old === '旧值')
  ok('⑥ 未确认 ⇒ 该字段进人工作业清单', res.ok && res.state === 'done-partial'
    && (res.log.manualFields.some(m => m.fieldId === 'cf_old')))

  // 非法确认：目标不是计划建议的那个
  __resetMockStores()
  await saveTemplateDef(PID, from)
  await seedForm({ cf_old: '旧值' })
  const bad = await applyTemplateMigration({
    pid: PID, tabId: TAB, plan, to, expectedFrom: from, approvedMaps: { cf_old: 'cf_zzz' },
  })
  ok('⑥ 确认的目标与建议不符 ⇒ 拒绝', !bad.ok && bad.code === 'invalid-approved-map')

  const good = await applyTemplateMigration({
    pid: PID, tabId: TAB, plan, to, expectedFrom: from, approvedMaps: { cf_old: 'cf_new' },
  })
  const form2 = await readForm()
  ok('⑥ 确认后复制到新字段', good.ok && form2.cf_new === '旧值', JSON.stringify(form2))
  ok('⑥ 旧键值保留（迁移默认不删值）', form2.cf_old === '旧值')
}

// ────────────────────────── ⑦ 隔离：内存锁 + 持久阻断态 ──────────────────────────
{
  __resetMockStores()
  const release = beginTabMigrationLock(PID, TAB)
  ok('⑦ 占锁期间：自动保存被拦', (await guardTabWrite(PID, TAB, 'autosave'))?.code === 'tab-in-migration')
  const draft = await guardTabWrite(PID, TAB, 'draft')
  ok('⑦ 冲突带明确说明与下一步', draft?.blocked === true && (draft?.hint ?? '').length > 0)
  ok('⑦ 同一页签的 AI 回填也被拦（不串字段）', (await guardTabWrite(PID, TAB, 'ai-writeback'))?.blocked === true)
  ok('⑦ 不相关页签不受影响', (await guardTabWrite(PID, 'items', 'autosave')) === null)
  release()
  release() // 重复释放不该出错
  ok('⑦ 释放后恢复可写', (await guardTabWrite(PID, TAB, 'autosave')) === null)
  ok('⑦ 锁状态可查询', isTabMigrationActive(PID, TAB) === false)

  // 持久阻断态：进程重启后内存锁没了，日志还在
  await saveMigrationLog({
    formatVersion: MIGRATION_LOG_VERSION, pid: PID, tabId: TAB, state: 'writing',
    startedAt: 1, updatedAt: 1, fromTemplateId: 'a', toTemplateId: 'b',
    fromRevision: 0, toRevision: 1, steps: [], failures: [], manualFields: [],
    backupVerified: true, writtenValues: 0,
  })
  const persisted = await guardTabWrite(PID, TAB, 'autosave')
  ok('⑦ 崩溃后的阻断态同样拦住写入', persisted?.state === 'writing', JSON.stringify(persisted))

  const from = mkDef([mkField({ id: 'cf_a' })], { revision: 0, semanticDigest: 'd1' })
  const to = mkDef([mkField({ id: 'cf_a' }), mkField({ id: 'cf_b' })], { revision: 1, semanticDigest: 'd2' })
  await saveTemplateDef(PID, from)
  const res = await applyTemplateMigration({ pid: PID, tabId: TAB, plan: planTemplateChange(from, to), to, expectedFrom: from })
  ok('⑦ 恢复未完成前禁止再迁同一页签', !res.ok && res.code === 'pending-migration')
  ok('⑦ 阻断态不允许清痕迹', await (async () => {
    try { await clearMigrationArtifacts(PID, TAB); return false } catch { return true }
  })())
  ok('⑦ 状态文案统一（界面不各写一套）', migrationStateLabel('rollback-failed').includes('人工'))
}

// ────────────────────────── ⑧ 恢复：中断的迁移能回到迁移前 ──────────────────────────
{
  __resetMockStores()
  const oldDef = mkDef([mkField({ id: 'cf_power', label: '战力' })], { revision: 0, semanticDigest: 'd1' })
  const newDef = mkDef([mkField({ id: 'cf_power', label: '战力', type: 'number' })], { revision: 1, semanticDigest: 'd2' })
  await saveTemplateDef(PID, oldDef)
  await seedForm({ cf_power: '18' })

  // 模拟"备份写了、值写了一半就断电"
  await saveMigrationBackup({
    formatVersion: MIGRATION_LOG_VERSION, pid: PID, tabId: TAB, at: 1, def: oldDef,
    values: [{ target: 'form', fieldId: 'cf_power', value: '18' }],
  })
  await saveMigrationLog({
    formatVersion: MIGRATION_LOG_VERSION, pid: PID, tabId: TAB, state: 'writing',
    startedAt: 1, updatedAt: 1, fromTemplateId: 'builtin:races', toTemplateId: 'builtin:races',
    fromRevision: 0, toRevision: 1, steps: [], failures: [], manualFields: [],
    backupVerified: true, writtenValues: 1,
  })
  // 半新半旧：定义已切、值被写成空
  await saveTemplateDef(PID, newDef)
  await db.saveFormDataFor(PID, TAB, { cf_power: '' })

  const rec = await recoverTemplateMigration(PID, TAB)
  ok('⑧ 恢复成功', rec.ok && rec.state === 'recovered', JSON.stringify(rec))
  ok('⑧ 值回到迁移前', (await readForm()).cf_power === '18')
  ok('⑧ 定义回到迁移前', (await loadTemplateDef(PID, TAB))?.revision === 0)
  ok('⑧ 日志落 rolled-back，作者看得见', (await loadMigrationLog(PID, TAB))?.state === 'rolled-back')

  const again = await recoverTemplateMigration(PID, TAB)
  ok('⑧ 已恢复过 ⇒ nothing-to-do（幂等）', again.ok && again.state === 'nothing-to-do')

  // 恢复后可以清痕迹，也可以重新迁移
  await clearMigrationArtifacts(PID, TAB)
  ok('⑧ 恢复完成后可清痕迹', (await loadMigrationLog(PID, TAB)) === null)
  const res = await applyTemplateMigration({
    pid: PID, tabId: TAB, plan: planTemplateChange(oldDef, newDef), to: newDef, expectedFrom: oldDef,
  })
  ok('⑧ 恢复后允许重新迁移', res.ok && res.state === 'done', JSON.stringify(res).slice(0, 160))

  // 没有备份的阻断日志 ⇒ 明确说"无法自动恢复"，且落到 rollback-failed
  __resetMockStores()
  await saveMigrationLog({
    formatVersion: MIGRATION_LOG_VERSION, pid: PID, tabId: TAB, state: 'prepared',
    startedAt: 1, updatedAt: 1, fromTemplateId: 'a', toTemplateId: 'b',
    fromRevision: 0, toRevision: 1, steps: [], failures: [], manualFields: [],
    backupVerified: false, writtenValues: 0,
  })
  const noBackup = await recoverTemplateMigration(PID, TAB)
  ok('⑧ 无备份 ⇒ 不假装能恢复', !noBackup.ok && noBackup.code === 'no-backup')
  ok('⑧ 无备份 ⇒ 状态置 rollback-failed（继续禁止迁移）',
    (await loadMigrationLog(PID, TAB))?.state === 'rollback-failed')
  const none = await recoverTemplateMigration('p-none', TAB)
  ok('⑧ 没有日志 ⇒ 明确报 no-log', !none.ok && none.code === 'no-log')
}

// ────────────────────────── ⑨ 同步排除：迁移痕迹不上云 ──────────────────────────
{
  ok('⑨ 迁移键前缀与日志模块同一口径', MIGRATION_KEY_PREFIX === 'templateMigration32:')
  ok('⑨ 日志键落在本机专属前缀', isLocalOnlyMetaKey(migrationLogKeyOf('p1', 'races')))
  ok('⑨ 敏感判据同样命中（导出/同步两处共用一份）', isSensitiveMetaKey(migrationLogKeyOf('p1', 'races')))
  ok('⑨ 备份键也命中', isSensitiveMetaKey('templateMigration32:backup:p1:races'))
  ok('⑨ 普通 meta 不受影响', !isSensitiveMetaKey('someOtherKey'))
}

// ────────────────────────── ⑩ 源码闸：顺序与依赖不许回退 ──────────────────────────
//
// 只会"跑通一次"的用例守不住后人重排顺序：把写值挪到备份之前，功能测试照样绿
// （毕竟本地写盘几乎不会失败），但线上断电一次就再也恢复不回来。
// 按老规矩断言**调用了什么函数 + 谁在前谁在后**，不认字面参数。
{
  const src = readFileSync(path.join(process.cwd(), 'src/lib/templates/migrate.ts'), 'utf8')
  const guardSrc = readFileSync(path.join(process.cwd(), 'src/lib/templates/migrationGuard.ts'), 'utf8')
  const sensitiveSrc = readFileSync(path.join(process.cwd(), 'src/lib/storage/sensitiveMeta.ts'), 'utf8')

  ok('🔴 源码：备份必须读回校验', src.includes('verifyMigrationBackup('))
  ok('🔴 源码：备份在写值之前',
    src.indexOf('await saveMigrationBackup(') > 0
    && src.indexOf('await saveMigrationBackup(') < src.indexOf('await flushWrites('),
    `${src.indexOf('await saveMigrationBackup(')} vs ${src.indexOf('await flushWrites(')}`)
  ok('🔴 源码：锁在 finally 释放（失败路径不漏解）',
    /finally\s*\{\s*release\(\)/.test(src))
  ok('🔴 源码：存在 done-partial，不把未解决报成成功', src.includes("'done-partial'"))
  ok('🔴 源码：执行层只用显式 pid（不碰 currentProjectId）',
    !src.includes('currentProjectId'))
  ok('🔴 源码：隔离层不依赖执行层（防运行期环）',
    !guardSrc.includes("from './migrate'"), guardSrc.slice(0, 120))
  ok('🔴 源码：同步排除判据与本模块同一前缀',
    sensitiveSrc.includes(`'${MIGRATION_KEY_PREFIX}'`))
}
}

main().then(() => {
  console.log(`\ntemplatesMigrate: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})
