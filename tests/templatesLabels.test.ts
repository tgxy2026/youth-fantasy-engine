// 3.2.0 · T3 字段改名：从「界面看的名字」贯通到「模型看到的名字」，存储键一个字节不动。
//
// 验收要点（方案 §3.12）：
//   · 一对一改名（含义不变）⇒ AI 使用**当前名称**理解与回填；
//   · 采用模板的 label 优先于老别名；两者都只影响显示；
//   · 渲染 / 上下文 / 世界观摘要三条链路取同一份名字。
import { TABS } from '@/lib/schema'
import type { TabDef } from '@/lib/types'
import * as db from '@/lib/db'
import { createDemoProject } from '@/lib/app/seedData'
import { __resetMockStores } from './mock-memory'
import { adaptBuiltinTab } from '@/lib/templates/legacyAdapter'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import { __resetTemplateCacheForTests } from '@/lib/templates/cache'
import { loadFieldLabels } from '@/lib/templates/labels'
import { snapshotOfBuiltin } from '@/lib/templates/snapshot'
import { saveTemplateDef } from '@/lib/templates/store'
import { saveAliases } from '@/lib/settings/fieldAlias'
import { renderTable } from '@/lib/ai/tableRender'
import { buildProjectContext } from '@/lib/ai/aiContext'
import { buildWorldContext } from '@/lib/aiCore/template'

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
const POS = tabOf('positioning')
const KEY = '一、故事内核::主线一句话'   // 表单存储键：模块名::字段名

function keysOf(tab: TabDef): string[] {
  const keys = (tab.columns ?? []).map(c => c.name)
  for (const m of tab.modules ?? []) for (const f of m.fields) keys.push(`${m.name}::${f.name}`)
  return keys
}

async function main() {
  __resetMockStores()
  __resetTemplateCacheForTests()
  const pid = await createDemoProject()
  db.setCurrentProject(pid)

  // ────────────────────────── ① 适配器：别名只改 label ──────────────────────────
  {
    const plain = adaptBuiltinTab(MASTER)
    const renamed = adaptBuiltinTab(MASTER, { aliases: { [KEY]: '故事主线' } })
    const a = renamed.fields.find(f => f.sourceKey === KEY)
    ok('① 别名进入有效模板的 label', a?.label === '故事主线', JSON.stringify(a?.label))
    ok('① 存储键不动（回填 / 检索不受影响）', a?.sourceKey === KEY && a?.id === KEY)
    ok('① 未改名的字段保持原名', renamed.fields.filter(f => f.sourceKey !== KEY)
      .every(f => f.label === plain.fields.find(p => p.sourceKey === f.sourceKey)?.label))
    // 语义摘要会变：改名改变了「模型看到的依据」，索引 / 候选应判失效（T3 验收）。
    ok('① 改名改变语义摘要', renamed.semanticDigest !== plain.semanticDigest)
  }

  // ────────────────────────── ② 脏别名与解析入口 ──────────────────────────
  {
    const tpl = resolveTemplateForTab(MASTER, { aliases: { [KEY]: '故事主线' } })
    ok('② resolveTemplateForTab 透传别名', tpl.fields.some(f => f.sourceKey === KEY && f.label === '故事主线'))

    const same = adaptBuiltinTab(MASTER, { aliases: { [KEY]: '主线一句话' } })
    ok('② 与默认显示名相同 ⇒ 视为未改', same.fields.find(f => f.sourceKey === KEY)?.label === '主线一句话')

    const ghost = adaptBuiltinTab(MASTER, { aliases: { '不存在的字段': '幽灵' } })
    ok('② 本表不存在的键被丢弃', !ghost.fields.some(f => f.label === '幽灵'))

    const tooLong = adaptBuiltinTab(MASTER, { aliases: { [KEY]: '一二三四五六七八九十一二三四五六七八九十一' } })
    ok('② 超长别名被丢弃', tooLong.fields.find(f => f.sourceKey === KEY)?.label === '主线一句话')
  }

  // ────────────────────────── ③ 表格渲染：表头用当前名，取值仍按存储键 ──────────────────────────
  {
    const races = tabOf('races')
    const rows = [{ data: { 名称: '龙族', 与主线关系: 'ZZ关系' } }]
    const out = renderTable(races, rows, { labels: { 名称: '种族称谓' } })
    ok('③ 表头使用当前显示名', out.includes('种族称谓'), out)
    ok('③ 值仍按存储键取出', out.includes('龙族') && out.includes('ZZ关系'))
    ok('③ 不出现旧表头', !out.includes('名称'), out.slice(0, 80))

    // 图鉴字段投影自带的 label 优先（它已经包含图鉴别名，不能被内置别名覆盖）
    const atlasOut = renderTable(races, rows, { labels: { 名称: '内置别名' } },
      [{ key: '名称', label: '图鉴别名', kind: 'text' }])
    ok('③ 图鉴 label 优先于通用 labels', atlasOut.includes('图鉴别名') && !atlasOut.includes('内置别名'))
  }

  // ────────────────────────── ④ loadFieldLabels：别名路径 ──────────────────────────
  {
    await saveAliases(MASTER.id, keysOf(MASTER), { [KEY]: '故事主线' })
    const labels = await loadFieldLabels(MASTER)
    ok('④ 别名进入显示名表', labels[KEY] === '故事主线', JSON.stringify(labels[KEY]))
    ok('④ 没改名的字段不出现在表里（渲染时回退原名）', !Object.values(labels).includes('核心冲突'))
  }

  // ────────────────────────── ⑤ 上下文端到端：AI 看到当前名称 ──────────────────────────
  {
    const cur = await db.getFormData(MASTER.id)
    await db.saveFormData(MASTER.id, { ...cur, [KEY]: 'ZZ主线值' })

    const ctx = await buildProjectContext({ budget: 200000, onlyTabIds: [MASTER.id] })
    ok('⑤ 提示词里出现当前显示名', ctx.text.includes('故事主线：ZZ主线值'), ctx.text.slice(0, 300))
    ok('⑤ 提示词里不再出现旧名', !ctx.text.includes('主线一句话：ZZ主线值'))
  }

  // ────────────────────────── ⑥ 世界观上下文同样用当前名 ──────────────────────────
  {
    const posKey = '一、基本信息::书名'
    await saveAliases(POS.id, keysOf(POS), { [posKey]: '作品名' })
    const world = await buildWorldContext(['positioning'])
    ok('⑥ 世界观上下文用当前名', world.includes('作品名：'), world)
    ok('⑥ 世界观上下文不用旧名', !world.includes('书名：'), world)
  }

  // ────────────────────────── ⑦ 采用模板的 label 优先于别名 ──────────────────────────
  {
    const posKey = '一、基本信息::书名'
    await saveAliases(POS.id, keysOf(POS), { [posKey]: '作品名' })
    const def = snapshotOfBuiltin(POS)
    def.revision = 1
    for (const f of def.fields) if (f.sourceKey === posKey) f.label = '模板书名'
    const res = await saveTemplateDef(pid, def)
    ok('⑦ 前置：模板保存成功', res.ok, JSON.stringify((res as { violations?: unknown }).violations))

    __resetTemplateCacheForTests()
    const labels = await loadFieldLabels(POS)
    ok('⑦ 采用模板后以模板 label 为准', labels[posKey] === '模板书名', JSON.stringify(labels[posKey]))

    const tpl = resolveTemplateForTab(POS, { def })
    ok('⑦ 模板快照里别名没有反向覆盖结构', tpl.fields.find(f => f.sourceKey === posKey)?.label === '模板书名')
  }

  console.log(`\ntemplatesLabels: ${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.stack ? e.stack : e}`)
  process.exitCode = 1
})
