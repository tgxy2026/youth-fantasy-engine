// 3.2.0 · T3 轻量字段定义（`fieldDefinition32:<tabId>`）：
// 历史别名迁移成「待确认改名」、作者确认后的名称 / 说明生效，且存储键一个字节不动。
//
// 验收要点（方案 §3.12.2 / §3.12.3）：
//   · 迁移幂等、不删旧别名、已采用模板的页签跳过；
//   · 轻量定义只在没有采用快照时生效（快照 label 优先）；
//   · 脏名称（撞名 / 超长 / 未知键）一律丢弃，与别名同一口径；
//   · 名称 / 说明 / 确认状态变化进入语义摘要（索引与 AI 候选据此失效）。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { TABS } from '@/lib/schema'
import type { TabDef } from '@/lib/types'
import * as db from '@/lib/db'
import { createDemoProject } from '@/lib/app/seedData'
import { __resetMockStores } from './mock-memory'
import { __resetTemplateCacheForTests, resolveTemplateCached, templateCacheStats } from '@/lib/templates/cache'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import {
  applyFieldDefinitions, fieldDefinitionKeyOf, isFieldDefinitionDoc,
  loadFieldDefinitions, migrateAliasesToFieldDefinitions, saveFieldDefinition,
  type FieldDefinitionDoc, type FieldDefinitionOverride,
} from '@/lib/templates/fieldDefinition'
import { loadFieldLabels } from '@/lib/templates/labels'
import { snapshotOfBuiltin } from '@/lib/templates/snapshot'
import { saveTemplateDef } from '@/lib/templates/store'
import { loadAliases, saveAliases } from '@/lib/settings/fieldAlias'
import { buildProjectContext } from '@/lib/ai/aiContext'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const tabOf = (id: string): TabDef => {
  const t = TABS.find(x => x.id === id)
  if (!t) throw new Error('找不到页签 ' + id)
  return t
}

const MASTER = tabOf('master')
const RACES = tabOf('races')
const POS = tabOf('positioning')
const KEY = '一、故事内核::主线一句话'
const SIBLING = '一、故事内核::主角弧光'
const POS_KEY = '一、基本信息::书名'

function keysOf(tab: TabDef): string[] {
  const keys = (tab.columns ?? []).map(c => c.name)
  for (const m of tab.modules ?? []) for (const f of m.fields) keys.push(`${m.name}::${f.name}`)
  return keys
}

function docOf(fields: Record<string, FieldDefinitionOverride>): FieldDefinitionDoc {
  return { formatVersion: 1, tabId: MASTER.id, revision: 1, updatedAt: 1, fields }
}

function fieldOf(tpl: ReturnType<typeof resolveTemplateForTab>, key: string) {
  return tpl.fields.find(f => f.sourceKey === key)
}

async function main() {
  __resetMockStores()
  __resetTemplateCacheForTests()
  const pid = await createDemoProject()
  db.setCurrentProject(pid)

  // ────────────────────────── ① 写读往返与形状校验 ──────────────────────────
  {
    const saved = await saveFieldDefinition(pid, MASTER.id, KEY, {
      label: '故事主线',
      description: '全书主线的一句话概括',
      meaningStatus: 'confirmed',
    })
    ok('① 写入成功（修订号从 1 起）', saved?.revision === 1, JSON.stringify(saved?.revision))
    const ov = saved?.fields[KEY]
    ok('① 名称 / 说明 / 确认状态落盘', ov?.label === '故事主线' && ov?.description === '全书主线的一句话概括' && ov?.meaningStatus === 'confirmed')
    ok('① 固化改名前名称', ov?.defaultLabel === '主线一句话' && ov?.source === 'author', JSON.stringify(ov))

    const loaded = await loadFieldDefinitions(pid, MASTER.id)
    ok('① 读回同一份文档', isFieldDefinitionDoc(loaded) && loaded?.fields[KEY]?.label === '故事主线')
    ok('① 文档按页签独立存放', fieldDefinitionKeyOf(MASTER.id) === 'fieldDefinition32:master')

    ok('① 版本不符的坏包不被当成定义',
      !isFieldDefinitionDoc({ formatVersion: 99, tabId: MASTER.id, revision: 1, updatedAt: 1, fields: {} }))
    ok('① 字段表是数组的坏包不被当成定义',
      !isFieldDefinitionDoc({ formatVersion: 1, tabId: MASTER.id, revision: 1, updatedAt: 1, fields: [] }))
    ok('① 本表不存在的存储键拒绝写入',
      await saveFieldDefinition(pid, MASTER.id, '不存在的字段', { label: '幽灵' }) === null)

    // 名称改回默认 ⇒ 改名与确认状态都应消失（说明是独立事实，仍可保留）
    const reverted = await saveFieldDefinition(pid, MASTER.id, KEY, { label: null })
    ok('① 改回原名 ⇒ 名称与确认状态被清除',
      !reverted?.fields[KEY]?.label && !reverted?.fields[KEY]?.meaningStatus, JSON.stringify(reverted?.fields[KEY]))
    const cleared = await saveFieldDefinition(pid, MASTER.id, KEY, { description: null })
    ok('① 说明也清空 ⇒ 整条覆盖移除', !cleared?.fields[KEY], JSON.stringify(cleared?.fields[KEY]))
  }

  // ────────────────────────── ② 叠到有效模板：只改 label / 说明 / 状态 ──────────────────────────
  {
    const doc = await saveFieldDefinition(pid, MASTER.id, KEY, {
      label: '故事主线',
      description: 'ZZ说明',
      meaningStatus: 'pending',
    })
    const plain = resolveTemplateForTab(MASTER)
    const tpl = resolveTemplateForTab(MASTER, { fieldDefinitions: doc })
    const f = fieldOf(tpl, KEY)
    ok('② 名称生效', f?.label === '故事主线', JSON.stringify(f?.label))
    ok('② 说明与确认状态生效', f?.description === 'ZZ说明' && f?.meaningStatus === 'pending')
    ok('② 存储键 / 稳定身份 / 类型原样', f?.sourceKey === KEY && f?.id === KEY && f?.type === 'textarea')
    ok('② 未覆盖的字段保持原样', fieldOf(tpl, SIBLING)?.label === '主角弧光'
      && fieldOf(tpl, SIBLING)?.meaningStatus === undefined)
    ok('② 改名改变语义摘要', tpl.semanticDigest !== plain.semanticDigest)
    ok('② 没有覆盖 ⇒ 返回同一个对象（缓存不必处理等价新对象）',
      applyFieldDefinitions(plain, null) === plain)
    ok('② defaultLabel 只在改名时出现',
      f?.defaultLabel === '主线一句话' && fieldOf(tpl, SIBLING)?.defaultLabel === undefined)
  }

  // ────────────────────────── ③ 脏覆盖：与别名同一份清洗口径 ──────────────────────────
  {
    const plain = resolveTemplateForTab(MASTER)
    const dirty = docOf({
      '不存在的字段': { label: '幽灵', source: 'author', updatedAt: 1 },
      [KEY]: { label: '主线一句话', source: 'author', updatedAt: 1 }, // 与默认名相同 ⇒ 视为未改
      [SIBLING]: { label: '一二三四五六七八九十一二三四五六七八九十一', source: 'author', updatedAt: 1 },
    })
    const tpl = applyFieldDefinitions(plain, dirty)
    ok('③ 未知存储键被忽略', !tpl.fields.some(x => x.label === '幽灵'))
    ok('③ 与默认名相同 ⇒ 不覆盖', fieldOf(tpl, KEY)?.label === '主线一句话')
    ok('③ 超长名称被丢弃', fieldOf(tpl, SIBLING)?.label === '主角弧光')

    const clash = docOf({
      [KEY]: { label: '同名', source: 'author', updatedAt: 1 },
      [SIBLING]: { label: '同名', source: 'author', updatedAt: 1 },
    })
    const clashTpl = applyFieldDefinitions(plain, clash)
    const labels = [fieldOf(clashTpl, KEY)?.label, fieldOf(clashTpl, SIBLING)?.label]
    ok('③ 两个字段撞名 ⇒ 只保留一个', labels.filter(l => l === '同名').length === 1, JSON.stringify(labels))

    const collideDefault = docOf({ [KEY]: { label: '主角弧光', source: 'author', updatedAt: 1 } })
    ok('③ 与别的字段原名撞名 ⇒ 丢弃', fieldOf(applyFieldDefinitions(plain, collideDefault), KEY)?.label === '主线一句话')

    // 说明变化同样改变 AI 依据，但不动名称
    const descOnly = docOf({ [KEY]: { description: '只看说明', source: 'author', updatedAt: 1 } })
    const descTpl = applyFieldDefinitions(plain, descOnly)
    ok('③ 只改说明：名称不变、说明生效', fieldOf(descTpl, KEY)?.label === '主线一句话'
      && fieldOf(descTpl, KEY)?.description === '只看说明')
    ok('③ 只改说明也改变语义摘要', descTpl.semanticDigest !== plain.semanticDigest)
  }

  // ────────────────────────── ④ 缓存：同一份定义命中，换成新定义必未命中 ──────────────────────────
  {
    __resetTemplateCacheForTests()
    const first = await loadFieldDefinitions(pid, MASTER.id)
    resolveTemplateCached(MASTER, { fieldDefinitions: first }, pid)
    resolveTemplateCached(MASTER, { fieldDefinitions: first }, pid)
    const s1 = templateCacheStats()
    ok('④ 同一份定义重复解析命中缓存', s1.hits === 1 && s1.misses === 1, JSON.stringify(s1))

    const second = await saveFieldDefinition(pid, MASTER.id, KEY, { label: '主线新名' })
    const tpl = resolveTemplateCached(MASTER, { fieldDefinitions: second }, pid)
    const s2 = templateCacheStats()
    ok('④ 定义变化 ⇒ 未命中并换用新名称', s2.misses === 2 && fieldOf(tpl, KEY)?.label === '主线新名',
      JSON.stringify({ s2, label: fieldOf(tpl, KEY)?.label }))
  }

  // ────────────────────────── ⑤ 显示名：轻量定义 > 别名；快照 > 轻量定义 ──────────────────────────
  {
    await saveAliases(MASTER.id, keysOf(MASTER), { [KEY]: '别名主线' })
    const labels = await loadFieldLabels(MASTER)
    ok('⑤ 轻量定义的名称优先于别名', labels[KEY] === '主线新名', JSON.stringify(labels[KEY]))

    await saveAliases(RACES.id, keysOf(RACES), { 名称: '种族称谓' })
    const racesLabels = await loadFieldLabels(RACES)
    ok('⑤ 没有轻量定义的页签照常走别名', racesLabels['名称'] === '种族称谓', JSON.stringify(racesLabels['名称']))

    // 采用快照后，快照 label 是当前结构；即使误传轻量定义也不得反向覆盖
    const posDoc = await saveFieldDefinition(pid, POS.id, POS_KEY, { label: '轻量书名', meaningStatus: 'confirmed' })
    const def = snapshotOfBuiltin(POS)
    def.revision = 1
    for (const f of def.fields) if (f.sourceKey === POS_KEY) f.label = '模板书名'
    const saved = await saveTemplateDef(pid, def)
    ok('⑤ 前置：模板保存成功', saved.ok, JSON.stringify((saved as { violations?: unknown }).violations))
    __resetTemplateCacheForTests()
    const posLabels = await loadFieldLabels(POS)
    ok('⑤ 采用快照后以模板 label 为准', posLabels[POS_KEY] === '模板书名', JSON.stringify(posLabels[POS_KEY]))
    ok('⑤ 显式传轻量定义也压不过快照',
      fieldOf(resolveTemplateForTab(POS, { def, fieldDefinitions: posDoc }), POS_KEY)?.label === '模板书名')
  }

  // ────────────────────────── ⑥ 历史别名迁移：待确认、幂等、不删别名、跳过已采用 ──────────────────────────
  {
    const posDefBefore = await loadFieldDefinitions(pid, POS.id)
    const r1 = await migrateAliasesToFieldDefinitions(pid)
    ok('⑥ 迁移至少写入一条待确认字段', r1.added >= 1 && r1.tabs >= 1, JSON.stringify(r1))
    ok('⑥ 已采用模板的页签跳过', r1.skippedAdopted.includes(POS.id), JSON.stringify(r1.skippedAdopted))

    const racesDoc = await loadFieldDefinitions(pid, RACES.id)
    const ov = racesDoc?.fields['名称']
    ok('⑥ 迁移结果默认待确认', ov?.meaningStatus === 'pending', JSON.stringify(ov))
    ok('⑥ 迁移保留旧名作为来源', ov?.defaultLabel === '名称' && ov?.label === '种族称谓')
    ok('⑥ 迁移来源可辨认', ov?.source === 'alias-migrated')
    ok('⑥ 旧别名仍保留（恢复来源 / 未迁移字段仍可用）',
      (await loadAliases(RACES.id))['名称'] === '种族称谓')
    ok('⑥ 已采用模板的页签不被迁移改写',
      (await loadFieldDefinitions(pid, POS.id))?.revision === posDefBefore?.revision)

    const r2 = await migrateAliasesToFieldDefinitions(pid)
    ok('⑥ 重复迁移幂等', r2.added === 0 && r2.tabs === 0, JSON.stringify(r2))
    const racesDoc2 = await loadFieldDefinitions(pid, RACES.id)
    ok('⑥ 重复迁移不重复计数、不覆盖已确认内容', racesDoc2?.revision === racesDoc?.revision
      && racesDoc2?.fields['名称']?.meaningStatus === 'pending')
  }

  // ────────────────────────── ⑦ 端到端：AI 上下文使用确认后的当前名称 ──────────────────────────
  {
    const cur = await db.getFormData(MASTER.id)
    await db.saveFormData(MASTER.id, { ...cur, [KEY]: 'ZZ主线值' })
    const ctx = await buildProjectContext({ budget: 200000, onlyTabIds: [MASTER.id] })
    ok('⑦ 提示词里出现轻量定义的当前名称', ctx.text.includes('主线新名：ZZ主线值'), ctx.text.slice(0, 300))
    ok('⑦ 不再出现旧名与别名', !ctx.text.includes('主线一句话：ZZ主线值') && !ctx.text.includes('别名主线：ZZ主线值'))
  }

  // ────────────────────────── ⑧ 轻量定义接管后，旧别名不再把名字顶回来 ──────────────────────────
  {
    await saveFieldDefinition(pid, MASTER.id, KEY, { label: null }) // 说明还在 ⇒ 覆盖仍然有效
    const labels = await loadFieldLabels(MASTER)
    ok('⑧ 恢复原名后不被旧别名顶回来', !labels[KEY], JSON.stringify(labels[KEY]))
    const doc = await loadFieldDefinitions(pid, MASTER.id)
    const tpl = resolveTemplateForTab(MASTER, {
      aliases: { [KEY]: '别名主线' },
      fieldDefinitions: doc,
    })
    ok('⑧ 解析层同样以轻量定义为准（名字回原名）', fieldOf(tpl, KEY)?.label === '主线一句话')
  }

  // ────────────────────────── ⑨ 接线闸：弹窗确认 + 按钮写轻量定义 + 打开项目迁移 ──────────────────────────
  {
    const srcOf = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8')
    const dialog = srcOf('src/components/sheets/FieldAliasDialog.tsx')
    ok('🔴 源码：改名弹窗承载含义确认', dialog.includes('含义已改变') && dialog.includes('MeaningDecision'))
    ok('🔴 源码：弹窗不再声称 AI 按旧名理解', !dialog.includes('AI 仍按「'))
    ok('🔴 源码：字段名按钮改走轻量定义', srcOf('src/components/sheets/FieldAliasButton.tsx').includes('useFieldRenames'))
    ok('🔴 源码：打开项目时幂等迁移历史别名',
      srcOf('src/App.tsx').includes('migrateAliasesToFieldDefinitions'))
  }

  // ────────────────────────── ⑩ 界面显示名与 AI 同口径（定义 > 别名） ──────────────────────────
  {
    const srcOf = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8')
    ok('🔴 源码：显示名 hook 与 AI 合并解析共用一份',
      srcOf('src/lib/templates/useFieldRenames.ts').includes('export function useFieldDisplayLabels'))
    // 保存后旧别名会被收走：这些界面若仍只读别名，名字会当场「变回原名」
    for (const p of [
      'src/components/sheets/TableSheet.tsx',
      'src/components/sheets/TableRelationGroups.tsx',
      'src/components/outline/OutlineSheet.tsx',
      'src/components/world/CharacterSheet.tsx',
      'src/components/common/SchemaFieldGrid.tsx',
      'src/components/templates/TemplateManagerDialog.tsx',
    ]) {
      ok(`🔴 源码：${p} 使用合并后的显示名`, srcOf(p).includes('useFieldDisplay') || srcOf(p).includes('useFieldRenames'))
    }
    ok('🔴 源码：设定检索按同一口径读显示名（含轻量定义）',
      srcOf('src/components/settings/SettingSearch.tsx').includes('loadFieldLabels'))
  }

  console.log(`\ntemplatesFieldDefinition: ${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.stack ? e.stack : e}`)
  process.exitCode = 1
})
