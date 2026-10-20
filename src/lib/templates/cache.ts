/**
 * 3.2.0 · WT0-2：有效模板的**缓存与失效**
 *
 * 为什么要缓存：`resolveTemplateForTab` 每次都会把列/模块/图鉴配置重新翻译成字段表，
 * 表格一行行渲染、AI 装配上下文、搜索、导出各自都会反复要同一份模板 —— 不缓存就是
 * 每个消费面各跑一遍翻译（图鉴页签还要跑 `resolveAtlasFields` 的别名/类别/权限过滤）。
 *
 * 🔴 为什么不能只按 `tabId` 缓存（本项目已经踩过一次的坑）：
 *    tabId 在**所有项目里都叫同一个名字**（`races` 永远是 `races`）。只按 tabId 命中，
 *    换项目后就会把**上一本书的字段配置**端给新书（A 书删掉了「血统」自定义字段，
 *    B 书照样显示）。所以每条缓存都带 `pid`，取用前先比 —— 不一致即当未命中。
 *    （与 `settings/fieldAlias.ts` 的 `peekAliases`、`styleFingerprint` 同一手法。）
 *
 * 🔴 缓存键**不含解析结果的** `semanticDigest`：摘要是**输出**，不是输入。把输出塞进键会变成
 *    「摘要变了才算新键」，而摘要正是我们要用来判断「AI 候选是否过期」的东西 —— 循环。
 *    但**采用快照自带的** `def.semanticDigest` 是输入（导入 / 恢复可能保留 revision 却换了内容），
 *    必须进键（Q2-7）：否则同一 revision 下关掉字段权限，缓存仍会把旧的「可读」规则端给召回闸。
 *
 * 🔴 `TabDef` 一律视为**不可变**：动态分卷台账（`setVolumeTabs`）也是整批重建新对象。
 *    将来若有人原地改 TabDef，必须同时调 `invalidateTemplateCache()`，否则会读到旧结构。
 *
 * 🔴 **阻断性降级不缓存**：`unknown-config-version`（配置来自更新版本）这类结果只是
 *    「当前这次读不到」，一旦配置被修好就该立刻恢复 —— 缓存它等于把降级视图钉死在内存里。
 *    字段级的 `unknown-field-type` 是稳定事实，照常缓存。
 */
import { getCurrentProjectId } from '@/lib/db'
import type { TabDef } from '@/lib/types'
import { canAdaptAsAtlas } from './legacyAdapter'
import { fieldDefinitionSig } from './fieldDefinition'
import { resolveTemplateForTab, type ResolveTemplateOptions } from './resolve'
import type { EffectiveTemplate } from './types'

/**
 * 分隔符用**转义写法**而不是字面控制字符 —— 等价运行时值，但源码里没有控制字符，
 * 否则 grep / ripgrep 会把整个文件判成 binary（本项目扫描器会静默失明）。
 */
const SEP = '\u0001'

/** 条目上限：每个页签 × 用途 × 类别都会占一条，太多说明有调用方在瞎传类别 */
const MAX_ENTRIES = 256

interface CacheEntry {
  /** 项目 id —— 缺失/不符一律视为未命中 */
  pid: string
  /** TabDef 对象身份（见文件头：视为不可变） */
  tab: TabDef
  /** 项目修订号（纯布局变化） */
  revision: number
  /** 图鉴配置修订号（`saveAtlasSchema` 每次 +1）；非图鉴页签恒为 -1 */
  configRevision: number
  /** 别名映射的内容签名（别名的保存会换新对象，但签名更稳） */
  aliasesSig: string
  /** 项目采用快照的身份（`templateId@revision`）；未采用模板时为空串 */
  defSig: string
  /** 轻量字段定义的签名（`revision@updatedAt`）；未传 / 未采用快照时为空串 */
  defDocSig: string
  template: EffectiveTemplate
}

const cache = new Map<string, CacheEntry>()
const subs = new Set<() => void>()

const stats = { hits: 0, misses: 0, evictions: 0, skipped: 0 }

/** 别名内容签名：键排序后拼串（每张表的别名只有几到几十条，代价可忽略） */
function aliasesSignature(aliases: Record<string, string> | undefined): string {
  if (!aliases) return ''
  const keys = Object.keys(aliases)
  if (!keys.length) return ''
  keys.sort()
  let out = ''
  for (const k of keys) out += k + '=' + aliases[k] + SEP
  return out
}

/** 缓存键：同一个项目下「这个页签用这种方式看」才算同一份（**不含 pid**，pid 由内部前缀加） */
export function templateCacheKeyOf(
  tabId: string,
  purpose: string,
  opts: Pick<ResolveTemplateOptions, 'category' | 'ignoreAppliesTo' | 'def'> = {},
): string {
  // 🔴 快照身份也要进键：作者把《种族生物》从「预设 v1」换成「我的模板」之后，
  //    若键里没有 templateId/revision，会命中换模板前那一份缓存。
  const defSig = opts.def ? `${opts.def.templateId}@${opts.def.revision}#${opts.def.semanticDigest}` : ''
  return [tabId, purpose, opts.category ?? '', opts.ignoreAppliesTo ? '1' : '0', defSig].join(SEP)
}

/**
 * 实际存进 Map 的键 = `pid + 逻辑键`。
 *
 * 🔴 pid **必须进键**，不能只存在条目里比对：
 *    多本书之间来回切换是这个软件的常规用法（项目中心就是干这个的）。
 *    只存条目里比对的话，A/B 两本书会抢同一个槽位 —— 每次切书都未命中重算，
 *    缓存等于白做。进了键则各留一份，切回来仍命中。
 */
function entryKeyOf(pid: string, logicalKey: string): string {
  return pid + SEP + logicalKey
}

/** 不缓存的诊断（阻断性降级，见文件头） */
const UNCACHEABLE_DIAGNOSTICS = new Set(['unknown-config-version', 'config-read-failed'])

function uncacheable(t: EffectiveTemplate): boolean {
  return t.diagnostics.some(d => UNCACHEABLE_DIAGNOSTICS.has(d.code))
}

/**
 * 缓存版解析入口。
 *
 * `pid` 缺省取当前项目（浏览器/桌面都走 `getCurrentProjectId()`）；测试可显式传入。
 * 命中条件：pid、TabDef 身份、修订号、配置修订号、别名签名**全部**一致。
 *
 * 🔴 键只收**真正影响输出**的输入：非图鉴页签的 `adaptBuiltinTab` 只吃 `revision` 与 `aliases`，
 *    配置 / 用途 / 类别一律忽略（`purpose` 恒为 `detail`）⇒ 后三者折成常量，
 *    否则同一份模板会按用途各存一条（表格页签 6 份重复），纯属浪费。
 *    🔴 别名**必须**单独比（T3）：它现在会改动模板的 `label` 与语义摘要，
 *    不进比对就会在作者改名后继续把旧名字端给 AI 与界面。
 */
export function resolveTemplateCached(
  tab: TabDef,
  opts: ResolveTemplateOptions = {},
  pid: string = getCurrentProjectId(),
): EffectiveTemplate {
  const isAtlas = canAdaptAsAtlas(tab)
  const purpose = opts.purpose ?? 'detail'
  // 🔴 有快照 ⇒ 一切按快照走（purpose/category/ignoreAppliesTo 都进键）
  const logicalKey = opts.def
    ? templateCacheKeyOf(tab.id, purpose, opts)
    : isAtlas
      ? templateCacheKeyOf(tab.id, purpose, opts)
      : templateCacheKeyOf(tab.id, '', {})
  const defSig = opts.def ? `${opts.def.templateId}@${opts.def.revision}#${opts.def.semanticDigest}` : ''
  const configRevision = !opts.def && isAtlas && opts.config ? (opts.config.revision ?? 0) : -1
  // 别名两边都吃：图鉴走 `resolveAtlasFields`，内置走 `adaptBuiltinTab`（T3）。
  const aliasesSig = !opts.def ? aliasesSignature(opts.aliases) : ''
  // 轻量定义同理：它改 label / 说明 / 确认状态，不进比对就会在作者确认后继续端出旧结果。
  const defDocSig = !opts.def ? fieldDefinitionSig(opts.fieldDefinitions) : ''
  const key = entryKeyOf(pid, logicalKey)
  const revision = opts.revision ?? 0

  const hit = cache.get(key)
  if (
    hit
    && hit.pid === pid
    && hit.tab === tab
    && hit.revision === revision
    && hit.configRevision === configRevision
    && hit.aliasesSig === aliasesSig
    && hit.defSig === defSig
    && hit.defDocSig === defDocSig
  ) {
    stats.hits++
    // 保持「最近使用在末尾」，淘汰时从最旧开始
    cache.delete(key)
    cache.set(key, hit)
    return hit.template
  }

  stats.misses++
  const template = resolveTemplateForTab(tab, opts)
  if (uncacheable(template)) {
    stats.skipped++
    cache.delete(key)
    return template
  }

  cache.set(key, { pid, tab, revision, configRevision, aliasesSig, defSig, defDocSig, template })
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
    stats.evictions++
  }
  return template
}

/** 按页签 ID 的缓存版解析（页签不存在 ⇒ null，不静默返回空模板） */
export function resolveTemplateByIdCached(
  tabs: readonly TabDef[],
  tabId: string,
  opts: ResolveTemplateOptions = {},
  pid?: string,
): EffectiveTemplate | null {
  const tab = tabs.find(t => t.id === tabId)
  if (!tab) return null
  return pid == null ? resolveTemplateCached(tab, opts) : resolveTemplateCached(tab, opts, pid)
}

/**
 * 显式失效。
 *
 * · 传 `tabId` ⇒ 只清该页签（别名/配置改完后按表清）；
 * · 不传 ⇒ 全清（**项目恢复/导入/整库替换后必须调**）。
 *
 * 不调也能兜住的场景：换项目（pid 比对）、配置保存（revision 变）、别名保存（签名变）。
 * 兜不住、**必须显式调**的场景：备份恢复 / 版本回滚（项目数据被整份覆盖，
 * 页签配置的 revision 可能"降"回旧值，恰好与缓存里某条旧条目一致）。
 */
export function invalidateTemplateCache(tabId?: string): void {
  if (tabId) {
    for (const k of [...cache.keys()]) {
      // 键形如 `pid ␁ tabId ␁ purpose ␁ category ␁ ignore`，tabId 在第二段
      if (k.split(SEP)[1] === tabId) cache.delete(k)
    }
  } else {
    cache.clear()
  }
  subs.forEach(fn => fn())
}

/** 订阅模板缓存失效（组件据此重解析）。返回取消订阅函数 */
export function subscribeTemplateCache(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

/** 诊断用：真实计数，不做美化（测试与排查都看它） */
export function templateCacheStats(): Readonly<typeof stats> & { size: number } {
  return { ...stats, size: cache.size }
}

/** 仅测试用：重置计数与内容（生产代码不得调用） */
export function __resetTemplateCacheForTests(): void {
  cache.clear()
  stats.hits = 0
  stats.misses = 0
  stats.evictions = 0
  stats.skipped = 0
}

export { MAX_ENTRIES }
