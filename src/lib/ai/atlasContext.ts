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
import { isAtlasTab, resolveAtlasFields } from '@/lib/atlas/schema'
import { loadAtlasSchema } from '@/lib/atlas/persistence'
import { resolveTemplateCached } from '@/lib/templates/cache'
import { aiReadableTableFieldsOf, type TableFieldProjection } from '@/lib/templates/consumers'
import * as db from '@/lib/db'

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
    const cfg = (await loadAtlasSchema(db.getCurrentProjectId(), tab.id)).config
    const tpl = resolveTemplateCached(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true })
    return aiReadableTableFieldsOf(tpl)
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
  /** 自定义字段定义（按存储键）；内置列不在里面 */
  fields: Map<string, ResolvedAtlasField>
  /** 这份配置的版本号（应用前与发起时的基准比对） */
  revision: number
  /** 非空 ⇒ 这份配置**锁写**（未来版本 / 读取失败），调用方必须放弃本次回填 */
  lockedReason?: string
}

export async function loadAtlasAiWriteTargets(tab: TabDef, projectId: string): Promise<AtlasAiWriteTargets> {
  const builtinKeys = (tab.columns ?? []).filter(c => !c.hidden).map(c => c.name)
  if (!isAtlasTab(tab.id)) {
    return { allowedKeys: new Set(builtinKeys), fields: new Map(), revision: 0 }
  }
  let loaded: { config: AtlasSchemaConfig; newerFormat: boolean; error?: string }
  try {
    loaded = await loadAtlasSchema(projectId, tab.id)
  } catch (e) {
    return {
      allowedKeys: new Set(builtinKeys), fields: new Map(), revision: 0,
      lockedReason: `字段配置读取失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (loaded.newerFormat || loaded.error) {
    return {
      allowedKeys: new Set(builtinKeys), fields: new Map(), revision: loaded.config.revision,
      lockedReason: loaded.error ?? '字段配置来自更新的版本，已锁定为只读',
    }
  }
  const fields = new Map<string, ResolvedAtlasField>()
  for (const f of resolveAtlasFields(tab, { config: loaded.config, purpose: 'aiWrite', ignoreAppliesTo: true })) {
    if (f.source !== 'custom') continue
    fields.set(f.key, f)
  }
  return {
    allowedKeys: new Set([...builtinKeys, ...fields.keys()]),
    fields,
    revision: loaded.config.revision,
  }
}

/** 六类型的人话名（给模型看，别给 `cf_` 键） */
const TYPE_HINT: Record<string, string> = {
  text: '短文本',
  longText: '长文本',
  number: '数字',
  select: '单选',
  multiSelect: '多选',
  boolean: '是/否',
}

/**
 * 把一个字段定义说成**一句模型能懂的话**（3.1.3 · R12）。
 *
 * 🔴 修复前只把 `key / label / locked` 交给补全模型：模型不知道这是数字还是多选、
 *    不知道单位、不知道候选里有哪些值 ⇒ 只能瞎编（"18岁"填进数字列、"大概"填进单选列），
 *    然后被 `coerceAiValue` 拒掉，作者看到的是"AI 又跳过了一堆字段"。
 */
export function atlasFieldHintForAI(f: ResolvedAtlasField): string {
  const parts: string[] = [TYPE_HINT[f.customType ?? 'text'] ?? '文本']
  if (f.unit) parts.push(`单位：${f.unit}`)
  if (f.options?.length) parts.push(`候选：${f.options.join(' / ')}`)
  if (f.description?.trim()) parts.push(f.description.trim())
  if (f.appliesTo !== '*' && f.appliesTo.length) parts.push(`只对类别「${f.appliesTo.join('、')}」有意义`)
  return parts.join('；')
}
