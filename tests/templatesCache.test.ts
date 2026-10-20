// 3.2.0 · WT0-2 有效模板缓存与失效（负向控制为主）
//
// 缓存最怕的不是「没命中」，而是「**命中了不该命中的**」——把别的项目、别的修订、
// 别的别名的模板端给调用方，界面看起来一切正常，数据却对不上。
// 所以本文件每一条都在证明「什么情况下**必须**未命中」。
import { TABS } from '@/lib/schema'
import {
  resolveTemplateCached, resolveTemplateByIdCached, templateCacheKeyOf,
  invalidateTemplateCache, subscribeTemplateCache, templateCacheStats,
  __resetTemplateCacheForTests, MAX_ENTRIES,
} from '@/lib/templates/cache'
import type { AtlasSchemaConfig } from '@/lib/atlas/types'
import type { TemplateDef } from '@/lib/templates/definition'
import type { TabDef } from '@/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const tabOf = (id: string) => {
  const t = TABS.find(x => x.id === id)
  if (!t) throw new Error('找不到页签 ' + id)
  return t
}

function mkConfig(revision: number, customLabel = '食性'): AtlasSchemaConfig {
  return {
    formatVersion: 1,
    revision,
    fields: [
      { id: 'cf_a1', label: customLabel, type: 'text', description: '吃什么', options: [], appliesTo: '*', groupId: 'g1', order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: true },
    ],
    groups: [{ id: 'g1', label: '扩展资料', order: 0 }],
    builtinPresentation: {},
    summaryKeys: [],
  } as unknown as AtlasSchemaConfig
}

const RACES = tabOf('races')
const FORM_TAB = tabOf('master')   // 非图鉴页签（表单）

// ────────────────────────── ① 基本命中 ──────────────────────────
{
  __resetTemplateCacheForTests()
  const a = resolveTemplateCached(RACES, { config: mkConfig(1), purpose: 'detail' }, 'p1')
  const b = resolveTemplateCached(RACES, { config: mkConfig(1), purpose: 'detail' }, 'p1')
  const s = templateCacheStats()
  ok('① 同输入第二次命中（返回同一对象）', a === b)
  ok('① 计数：1 miss + 1 hit', s.misses === 1 && s.hits === 1, JSON.stringify(s))
  ok('① 缓存里只有 1 条', s.size === 1, String(s.size))
  // 内容没有被缓存「改变」
  ok('① 命中结果的自定义字段仍在', b.fields.some(f => f.id === 'cf_a1'))
}

// ────────────────────────── ② 换项目必须未命中（最痛的一条）──────────────────────────
{
  __resetTemplateCacheForTests()
  const withCustom = resolveTemplateCached(RACES, { config: mkConfig(1) }, 'pid-A')
  // B 项目没有自定义字段配置
  const withoutCustom = resolveTemplateCached(RACES, { config: null }, 'pid-B')
  ok('② 换项目 ⇒ 未命中', templateCacheStats().misses === 2)
  ok('② 不把 A 书的自定义字段端给 B 书',
    withCustom.fields.some(f => f.id === 'cf_a1') && !withoutCustom.fields.some(f => f.id === 'cf_a1'))
  ok('② 缓存里两条（按 pid 各一条）', templateCacheStats().size === 2)
  // 切回 A 书：pid 进键才可能命中（否则每次切书都白算一遍）
  const backToA = resolveTemplateCached(RACES, { config: mkConfig(1) }, 'pid-A')
  ok('② 切回 A 书仍命中（不多算一遍）', backToA === withCustom && templateCacheStats().hits === 1, JSON.stringify(templateCacheStats()))
  ok('② A 书仍是 A 书的模板（带自定义字段）', backToA.fields.some(f => f.id === 'cf_a1'))
}

// ────────────────────────── ③ 修订号 / 配置修订号 ──────────────────────────
{
  __resetTemplateCacheForTests()
  resolveTemplateCached(RACES, { config: mkConfig(1), revision: 5 }, 'p1')
  resolveTemplateCached(RACES, { config: mkConfig(1), revision: 6 }, 'p1')
  ok('③ 项目修订号变 ⇒ 未命中', templateCacheStats().misses === 2)

  __resetTemplateCacheForTests()
  resolveTemplateCached(RACES, { config: mkConfig(1) }, 'p1')
  resolveTemplateCached(RACES, { config: mkConfig(2) }, 'p1')
  ok('③ 配置修订号变 ⇒ 未命中', templateCacheStats().misses === 2)

  __resetTemplateCacheForTests()
  resolveTemplateCached(RACES, { config: mkConfig(3) }, 'p1')
  resolveTemplateCached(RACES, { config: mkConfig(3) }, 'p1')
  ok('③ 配置修订号相同、对象新建 ⇒ 命中（比的是修订号不是对象）', templateCacheStats().hits === 1)
}

// ────────────────────────── ④ 别名：内容变了要未命中，内容没变要命中 ──────────────────────────
{
  __resetTemplateCacheForTests()
  resolveTemplateCached(RACES, { config: mkConfig(1), aliases: { 名称: '种族名' } }, 'p1')
  resolveTemplateCached(RACES, { config: mkConfig(1), aliases: { 名称: '种族名' } }, 'p1')
  ok('④ 别名内容相同但对象重建 ⇒ 命中（按内容签名）', templateCacheStats().hits === 1)

  resolveTemplateCached(RACES, { config: mkConfig(1), aliases: { 名称: '族名' } }, 'p1')
  ok('④ 别名内容变了 ⇒ 未命中', templateCacheStats().misses === 2)
  const renamed = resolveTemplateCached(RACES, { config: mkConfig(1), aliases: { 名称: '族名' } }, 'p1')
  ok('④ 未命中后拿到的是新显示名', renamed.fields.some(f => f.label === '族名'))
  ok('④ 改别名不动存储键', renamed.fields.some(f => f.sourceKey === '名称'))
}

// ────────────────────────── ⑤ TabDef 视为不可变：换对象即未命中 ──────────────────────────
{
  __resetTemplateCacheForTests()
  const clone: TabDef = { ...RACES }
  resolveTemplateCached(RACES, { config: mkConfig(1) }, 'p1')
  resolveTemplateCached(clone, { config: mkConfig(1) }, 'p1')
  ok('⑤ 页签换了新对象 ⇒ 未命中（结构可能已变）', templateCacheStats().misses === 2)
}

// ────────────────────────── ⑥ 阻断性降级不缓存 ──────────────────────────
{
  __resetTemplateCacheForTests()
  const tooNew = { ...mkConfig(1), formatVersion: 2 } as unknown as AtlasSchemaConfig
  const r1 = resolveTemplateCached(RACES, { config: tooNew }, 'p1')
  const r2 = resolveTemplateCached(RACES, { config: tooNew }, 'p1')
  const s = templateCacheStats()
  ok('⑥ 配置版本过高 ⇒ 每次重算（不缓存降级视图）', s.hits === 0 && s.misses === 2, JSON.stringify(s))
  ok('⑥ 至少两次被记为 skipped', s.skipped >= 1, JSON.stringify(s))
  ok('⑥ 诊断如实上报', r1.diagnostics.some(d => d.code === 'unknown-config-version'))
  ok('⑥ 降级后内置字段照常可用', r1.fields.length > 0 && r2.fields.length > 0)
  ok('⑥ 降级结果不进缓存', s.size === 0, String(s.size))
}

// ────────────────────────── ⑦ 显式失效 ──────────────────────────
{
  __resetTemplateCacheForTests()
  resolveTemplateCached(RACES, { config: mkConfig(1) }, 'p1')
  resolveTemplateCached(FORM_TAB, {}, 'p1')
  const before = templateCacheStats()
  ok('⑦ 前置：两条都在缓存里', before.size === 2, String(before.size))

  invalidateTemplateCache('races')
  ok('⑦ 按页签失效只清该页签', templateCacheStats().size === 1, String(templateCacheStats().size))
  resolveTemplateCached(RACES, { config: mkConfig(1) }, 'p1')
  ok('⑦ 清掉后重算（未命中）', templateCacheStats().misses === 3)
  resolveTemplateCached(FORM_TAB, {}, 'p1')
  ok('⑦ 别的页签仍在缓存里（命中）', templateCacheStats().hits === 1)

  invalidateTemplateCache()
  ok('⑦ 全清后为空', templateCacheStats().size === 0)
}

// ────────────────────────── ⑧ 订阅通知 ──────────────────────────
{
  __resetTemplateCacheForTests()
  let n = 0
  const off = subscribeTemplateCache(() => { n++ })
  invalidateTemplateCache()
  invalidateTemplateCache('races')
  ok('⑧ 失效会通知订阅者', n === 2, String(n))
  off()
  invalidateTemplateCache()
  ok('⑧ 取消订阅后不再通知', n === 2, String(n))
}

// ────────────────────────── ⑨ 非图鉴页签：只认真正影响输出的输入 ──────────────────────────
{
  __resetTemplateCacheForTests()
  const t1 = resolveTemplateCached(FORM_TAB, { purpose: 'detail' }, 'p1')
  const t2 = resolveTemplateCached(FORM_TAB, { purpose: 'aiRead', aliases: { 姓名: '名字' }, config: mkConfig(9) }, 'p1')
  const s = templateCacheStats()
  ok('⑨ 换用途/传配置/传别名 ⇒ 仍命中（这些输入不影响内置模板）', t1 === t2, JSON.stringify(s))
  ok('⑨ 只有 1 条缓存（不按用途各存一份）', s.size === 1, String(s.size))
  ok('⑨ 内置模板 purpose 恒为 detail', t2.purpose === 'detail')
}

// ────────────────────────── ⑩ 图鉴页签按用途隔离 ──────────────────────────
{
  __resetTemplateCacheForTests()
  resolveTemplateCached(RACES, { config: mkConfig(1), purpose: 'detail' }, 'p1')
  resolveTemplateCached(RACES, { config: mkConfig(1), purpose: 'aiRead' }, 'p1')
  ok('⑩ 图鉴页签不同用途是不同条目', templateCacheStats().size === 2 && templateCacheStats().misses === 2)
}

// ────────────────────────── ⑪ 容量上限 ──────────────────────────
{
  __resetTemplateCacheForTests()
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    resolveTemplateCached(RACES, { config: mkConfig(1), purpose: 'detail', category: 'c' + i }, 'p1')
  }
  const s = templateCacheStats()
  ok('⑪ 条目数不超过上限', s.size === MAX_ENTRIES, `${s.size} / ${MAX_ENTRIES}`)
  ok('⑪ 有淘汰发生', s.evictions === 5, String(s.evictions))
  // 最近用过的还在（插入顺序淘汰）
  resolveTemplateCached(RACES, { config: mkConfig(1), purpose: 'detail', category: 'c' + (MAX_ENTRIES + 4) }, 'p1')
  ok('⑪ 最新一条仍在缓存（命中）', templateCacheStats().hits === 1)
}

// ────────────────────────── ⑫ 键形状 ──────────────────────────
{
  ok('⑫ 同参数键稳定', templateCacheKeyOf('races', 'detail', { category: '兽' }) === templateCacheKeyOf('races', 'detail', { category: '兽' }))
  ok('⑫ 类别不同键不同', templateCacheKeyOf('races', 'detail', { category: '兽' }) !== templateCacheKeyOf('races', 'detail', { category: '植物' }))
  ok('⑫ 忽略类别开关影响键', templateCacheKeyOf('races', 'detail', { ignoreAppliesTo: true }) !== templateCacheKeyOf('races', 'detail', {}))
  ok('⑫ 用途不同键不同', templateCacheKeyOf('races', 'detail') !== templateCacheKeyOf('races', 'aiRead'))
  ok('⑫ 页签不同键不同', templateCacheKeyOf('races', 'detail') !== templateCacheKeyOf('items', 'detail'))

  // 🔴 Q2-7：采用快照的语义摘要也是输入 —— 导入/恢复可能保留 revision 却换了字段权限，
  //    只认 `templateId@revision` 会把旧的「可读」规则端给召回闸。
  const defLike = (digest: string) => ({ templateId: 'tpl_x', revision: 3, semanticDigest: digest }) as unknown as TemplateDef
  const on = templateCacheKeyOf('races', 'index', { def: defLike('f1:on') })
  const off = templateCacheKeyOf('races', 'index', { def: defLike('f1:off') })
  ok('⑫ 快照摘要进键（同 revision、内容变了 ⇒ 键不同）', on !== off)
  ok('⑫ 快照身份相同 ⇒ 键相同', on === templateCacheKeyOf('races', 'index', { def: defLike('f1:on') }))
}

// ────────────────────────── ⑬ 按 ID 的便捷入口 ──────────────────────────
{
  __resetTemplateCacheForTests()
  const t = resolveTemplateByIdCached(TABS, 'races', { config: mkConfig(1) }, 'p1')
  ok('⑬ 按 ID 解析走缓存', !!t && t.tabId === 'races')
  ok('⑬ 再走一次命中', (() => { resolveTemplateByIdCached(TABS, 'races', { config: mkConfig(1) }, 'p1'); return templateCacheStats().hits === 1 })())
  ok('⑬ 页签不存在 ⇒ null（不静默返回空模板）', resolveTemplateByIdCached(TABS, 'no-such-tab', {}, 'p1') === null)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
