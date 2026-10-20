/**
 * 图鉴页签的 **AI 读取字段清单**（3.1.3 · 方案 §7.1 第 3 条入口）。
 *
 * 为什么单独一个文件：`aiContext.ts` 已贴着 1200 行硬上限（结构闸 ①），
 * 把"加载字段配置 + 解析"塞进去必然爆线；抽出来也让这条链路可被单独复用。
 *
 * 🔴 三条口径：
 *   1. **按 `aiReadable` 过滤** —— 作者关掉「允许 AI 参考」的字段不能进提示词；
 *   2. **忽略类别适用范围**（`ignoreAppliesTo`）—— AI 看到的是整张表的字段结构，
 *      不该因为某个字段"只适用魔兽"就让模型以为这张表没有它；
 *   3. 归档字段不参与（`resolveAtlasFields` 内部已排除）。
 */
import type { TabDef } from '@/lib/types'
import type { AtlasSchemaConfig, ResolvedAtlasField } from '@/lib/atlas/types'
import { isAtlasTab } from '@/lib/atlas/schema'
import { loadAtlasSchema } from '@/lib/atlas/persistence'
import { resolveTemplateCached } from '@/lib/templates/cache'
import { loadTemplateDef } from '@/lib/templates/store'
import type { EffectiveTemplate, TemplatePurpose } from '@/lib/templates/types'
import type { TableFieldProjection, WriteFieldProjection } from '@/lib/templates/consumers'
import { aiReadableTableFieldsOf, writeTargetsOf, fieldHintForAI, toWriteFieldProjection } from '@/lib/templates/consumers'
import { effectiveFieldOfAtlas } from '@/lib/templates/legacyAdapter'
import * as db from '@/lib/db'

/**
 * 取当前项目对这个页签的有效模板：**采用快照 → 图鉴配置 → 内置**。
 *
 * 🔴 Q2：与索引 / 召回闸同一优先级。此前这里只读图鉴配置 —— 项目采用模板后，
 *    表格已经看不到的字段仍会经直接上下文发给模型，等于「同一个权限两套口径」。
 * 🔴 `purpose` 决定权限位：`aiRead` 看 `aiReadable`，`aiWrite` 看 `aiWritable`；
 *    两者独立，不能用一个开关代替另一个。
 */
async function resolveTemplateForAI(
  tab: TabDef,
  pid: string,
  purpose: Extract<TemplatePurpose, 'aiRead' | 'aiWrite'>,
): Promise<{
  tpl: EffectiveTemplate
  revision: number
  /** 图鉴配置读取失败的原因（快照路径为空） */
  readFailed?: string
}> {
  const def = await loadTemplateDef(pid, tab.id)
  if (def) {
    return {
      tpl: resolveTemplateCached(tab, { def, purpose, ignoreAppliesTo: true }, pid),
      revision: def.revision,
    }
  }
  const loaded = await loadAtlasSchema(pid, tab.id as Parameters<typeof loadAtlasSchema>[1])
  return {
    tpl: resolveTemplateCached(tab, { config: loaded.config, purpose, ignoreAppliesTo: true }, pid),
    revision: loaded.config.revision,
    ...(loaded.error ? { readFailed: loaded.error } : {}),
  }
}

/** 未锁写时的基准：用途过滤后的语义摘要（布局 / 分组顺序不参与） */
function basisOfTpl(tpl: EffectiveTemplate): string {
  return tpl.semanticDigest
}

/**
 * 读当前项目的图鉴字段（含自定义字段），失败时返回 `null`。
 * `null` 的语义是「按原 `tab.columns` 走」—— 单段读取失败不该让整份上下文崩掉。
 *
 * 3.2.0 · WT0-4：改为**从有效模板派生**（`resolveTemplateCached` + 投影），
 * 不再自己调 `resolveAtlasFields`。同一套口径连同缓存一起复用，
 * 输出与旧的 `resolveAtlasFields(...)` 逐字段一致（见 `tests/templatesConsumers.test.ts`）。
 */
export async function loadAtlasFieldsForAI(tab: TabDef): Promise<TableFieldProjection[] | null> {
  // 非图鉴页签 ⇒ null（= 走 tab.columns）。调用方本来就会先判 isAtlasTab，
  // 这里显式收口一次，既让类型收窄到 AtlasTabId，也避免将来有人误用拿到空清单。
  if (!isAtlasTab(tab.id)) return null
  try {
    const r = await resolveTemplateForAI(tab, db.getCurrentProjectId(), 'aiRead')
    return aiReadableTableFieldsOf(r.tpl)
  } catch {
    return null
  }
}

/**
 * **AI 可写入的目标**（3.1.3 · R12）：内置列 + 作者勾选了「允许 AI 填写」的自定义字段。
 *
 * 🔴 为什么必须单独解析、不从「表格可见列」派生：那会把「隐藏表格列」和「允许 AI 填写」
 *    绑成同一件事 —— 作者只想让某列不占地方（隐藏），结果 AI 也不能写了（验收 R12 点名）。
 *    这里走 `purpose: 'aiWrite'`，只看 `aiWritable`，不看 `tableVisible`。
 *
 * 🔴 为什么每次应用前**重读**一份：AI 生成可能跑了几十秒，期间字段定义可能被改掉
 *    （归档、关掉 AI 填写、甚至整个字段被删）。拿着旧清单回填，等于把值写进
 *    已经不存在的字段、或写进刚被作者禁写的字段。所以返回 `revision` 供调用方比对。
 */
export interface AtlasAiWriteTargets {
  /** 允许写入的存储键（内置列 + 允许 AI 填写的自定义字段） */
  allowedKeys: Set<string>
  /** 自定义字段投影（按存储键）；内置列不在里面。形状即 `coerceAiValue` 的入参 */
  fields: Map<string, WriteFieldProjection>
  /** 这份配置的版本号（仅展示 / 兼容；**不要用它判失效**） */
  revision: number
  /**
   * 生成期失效判据（3.2.0 · WT2）：`purpose:'aiWrite'` 解析结果的语义摘要。
   *
   * 🔴 为什么不用 `revision`：采用过快照的页签，`revision` 是**快照自己的**代号，
   *    与图鉴配置的 revision 各数各的 —— 拿两者比会「没改也说改过」，把正常回填全作废。
   * 🔴 为什么用语义摘要：只挪位置 / 改分组顺序不会变，改名 / 改说明 / 改类型 / 改权限 /
   *    删字段 / 归档都会变 —— 正好对应「相关字段变了才失效、布局无关变更可继续」。
   * 🔴 锁写 / 读取失败时为空串：调用方本来就会因 `lockedReason` 放弃，不必再比。
   */
  basis: string
  /** 非空 ⇒ 这份配置**锁写**（未来版本 / 读取失败），调用方必须放弃本次回填 */
  lockedReason?: string
}

/**
 * 只取**内置**部分的允许键（降级路径用：配置读不了 / 来自更新版本时，
 * 至少内置列还能写 —— 与旧行为一致）。
 */
function builtinAllowKeys(tab: TabDef): Set<string> {
  const tpl = resolveTemplateCached(tab, { purpose: 'aiWrite' })
  return new Set(tpl.fields.filter(f => f.source === 'builtin').map(f => f.sourceKey))
}

export async function loadAtlasAiWriteTargets(tab: TabDef, projectId: string): Promise<AtlasAiWriteTargets> {
  // 🔴 卡片 / 表单页签的写回目标**尚未迁移**：保持原口径（非隐藏列）。
  //    这类页签的字段是 `模块::字段`，一下子全放开等于把 AI 能写的范围扩大几十倍，
  //    必须等 WT0-4 的用例（AI 补全卡片）单独验过再动。
  if (!isAtlasTab(tab.id)) {
    const keys = (tab.columns ?? []).filter(c => !c.hidden).map(c => c.name)
    return { allowedKeys: new Set(keys), fields: new Map(), revision: 0, basis: '' }
  }

  // 🔴 Q2：采用快照优先。只读图鉴配置时，快照里已归档 / 已禁写的字段仍会被 AI 回填，
  //    「可写」与页面结构再次分叉。读快照失败 ⇒ 锁写（不能退回权限更大的旧配置）。
  let def: Awaited<ReturnType<typeof loadTemplateDef>>
  try {
    def = await loadTemplateDef(projectId, tab.id)
  } catch (e) {
    return {
      allowedKeys: builtinAllowKeys(tab), fields: new Map(), revision: 0, basis: '',
      lockedReason: `读取项目模板失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (def) {
    const tpl = resolveTemplateCached(tab, { def, purpose: 'aiWrite', ignoreAppliesTo: true }, projectId)
    const targets = writeTargetsOf(tpl)
    return {
      allowedKeys: new Set(targets.keys), fields: targets.custom,
      revision: def.revision, basis: basisOfTpl(tpl),
    }
  }

  let loaded: { config: AtlasSchemaConfig; newerFormat: boolean; error?: string }
  try {
    loaded = await loadAtlasSchema(projectId, tab.id)
  } catch (e) {
    return {
      allowedKeys: builtinAllowKeys(tab), fields: new Map(), revision: 0, basis: '',
      lockedReason: `字段配置读取失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (loaded.newerFormat || loaded.error) {
    return {
      allowedKeys: builtinAllowKeys(tab), fields: new Map(), revision: loaded.config.revision, basis: '',
      lockedReason: loaded.error ?? '字段配置来自更新的版本，已锁定为只读',
    }
  }
  // 3.2.0 · WT0-4：改从有效模板取（连带缓存）。
  // 实测四页签的 `keys` 与旧口径逐字一致；隐藏内置列（如《地理风物》的「地图格子」）
  // 由模板解析排除，不再靠这里单独 filter。
  const tpl = resolveTemplateCached(tab, { config: loaded.config, purpose: 'aiWrite', ignoreAppliesTo: true })
  const targets = writeTargetsOf(tpl)
  return {
    allowedKeys: new Set(targets.keys),
    fields: targets.custom,
    revision: loaded.config.revision,
    basis: basisOfTpl(tpl),
  }
}

/**
 * 把一个字段定义说成**一句模型能懂的话**（3.1.3 · R12）。
 *
 * 🔴 WT0-4：实现已挪到 `templates/consumers.fieldHintForAI`（唯一实现）。
 *    本函数保留为**旧形状入口**（`ResolvedAtlasField`），转成投影后委托过去 ——
 *    两份实现必然漂移，所以这里一行逻辑都不留。
 */
export function atlasFieldHintForAI(f: ResolvedAtlasField): string {
  return fieldHintForAI(toWriteFieldProjection(effectiveFieldOfAtlas(f)))
}
