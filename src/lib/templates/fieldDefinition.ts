/**
 * 3.2.0 · T3：**轻量字段定义**（`fieldDefinition32:<tabId>`）
 *
 * 适用对象：**尚未采用完整模板**的页签。历史别名只说明「换了叫法」，说不清
 * 「含义变没变」；方案 §3.12.2 要求作者对改义逐项确认，未确认的字段不得被 AI
 * 按旧名解释、也不得静默按新义回写。这个文档就是那份确认的落点。
 *
 * 与两套既有存储的分工：
 *   · `fieldAlias::<tabId>`       —— 旧改名通道，**只影响显示**。保留作恢复来源，不双写；
 *   · `projectTemplate32:<tabId>` —— 已采用模板（作者已接管结构），其 `label` 优先级最高；
 *   · `fieldDefinition32:<tabId>` —— 本文档：名称 / 说明 / 含义确认状态的轻量覆盖。
 *
 * 🔴 优先级：**采用快照 > 轻量定义 > 别名 > schema 原名**。
 * 🔴 `sourceKey` 仍是唯一存储键：本文档只覆盖 `label` / `description` / `meaningStatus`，
 *    取值、回填、检索、去重一律不动。
 * 🔴 读失败 / 坏包 ⇒ 当没有覆盖（`null`）。显示层可以退回原名，但**不得**据此把
 *    一个已改名页签当成「从没改过」发给 AI —— 那是消费层（T3-B2）的 fail-closed 职责。
 */
import * as db from '@/lib/db'
import { TABS } from '@/lib/schema'
import { aliasKeyOf, defaultLabelOf, sanitizeAliases } from '@/lib/settings/aliasCore'
import { storageKeysOf } from './schemaKeys'
import { loadTemplateDef } from './store'
import { semanticDigestOf } from './legacyAdapter'
import type { EffectiveTemplate, FieldMeaningStatus } from './types'

export const FIELD_DEFINITION_VERSION = 1
export const FIELD_DEFINITION_PREFIX = 'fieldDefinition32:'

export function fieldDefinitionKeyOf(tabId: string): string {
  return `${FIELD_DEFINITION_PREFIX}${tabId}`
}

/** 覆盖从哪来：历史别名迁移（含义**未确认**）或作者在编辑器里的明确声明 */
export type FieldDefinitionSource = 'alias-migrated' | 'author'

export interface FieldDefinitionOverride {
  /** 当前显示名；缺省 = 未改名 */
  label?: string
  /** 改名前的显示名（迁移来源，只用于界面说明与诊断，**不进语义摘要**） */
  defaultLabel?: string
  /** 当前含义说明（人看，也发给 AI） */
  description?: string
  /** 含义确认状态；缺省 = 沿用字段自身（内置字段视为已确认） */
  meaningStatus?: FieldMeaningStatus
  source: FieldDefinitionSource
  /** 最后修改时间（缓存签名 / 冲突比对用） */
  updatedAt: number
}

export interface FieldDefinitionDoc {
  formatVersion: typeof FIELD_DEFINITION_VERSION
  tabId: string
  /** 每次写入 +1。缓存据此判断「同一份对象是否已被新内容替换」 */
  revision: number
  updatedAt: number
  /** 存储键 → 轻量覆盖；只含作者/迁移实际动过的字段 */
  fields: Record<string, FieldDefinitionOverride>
}

/** 形状校验：库里可能是旧数据、手改的坏包或另一端的半截写入 */
export function isFieldDefinitionDoc(v: unknown): v is FieldDefinitionDoc {
  if (!v || typeof v !== 'object') return false
  const d = v as Partial<FieldDefinitionDoc>
  return d.formatVersion === FIELD_DEFINITION_VERSION
    && typeof d.tabId === 'string'
    && typeof d.revision === 'number'
    && typeof d.updatedAt === 'number'
    && !!d.fields && typeof d.fields === 'object' && !Array.isArray(d.fields)
}

/**
 * 清洗覆盖表：未知存储键、空名称、撞名、超长一律丢弃。
 *
 * 🔴 名称清洗与别名走**同一份** `sanitizeAliases` —— 两条通道叠在一起时，
 *    不能出现「别名里合法、轻量定义里却放过」的口子，否则界面会显示两列同名。
 * 🔴 只对模板里真实存在的 `sourceKey` 生效：换题材包后残留的旧键不该继续影响解析。
 */
export function sanitizeFieldDefinitionDoc(
  doc: FieldDefinitionDoc | null | undefined,
  keys: readonly string[],
): FieldDefinitionDoc | null {
  if (!doc || !isFieldDefinitionDoc(doc)) return null
  const allowed = new Set(keys)
  const rawLabels: Record<string, string> = {}
  for (const [key, ov] of Object.entries(doc.fields)) {
    if (!allowed.has(key) || !ov || typeof ov !== 'object') continue
    const label = typeof ov.label === 'string' ? ov.label.trim() : ''
    if (label) rawLabels[key] = label
  }
  // 与别名同口径：与默认名相同视为未改；与任何默认名 / 已占用名称重名 ⇒ 丢弃
  const labels = sanitizeAliases([...keys], rawLabels)
  const out: Record<string, FieldDefinitionOverride> = {}
  for (const [key, ov] of Object.entries(doc.fields)) {
    if (!allowed.has(key) || !ov || typeof ov !== 'object') continue
    const hadLabel = typeof ov.label === 'string' && !!ov.label.trim()
    const label = labels[key]
    const description = typeof ov.description === 'string' && ov.description.trim()
      ? ov.description.trim()
      : undefined
    // 改名本身被清洗掉（撞名 / 超长）⇒ 这条覆盖只剩一个无依据的「待确认」标记，整条丢弃
    if (!label && !description) continue
    const meaningStatus = hadLabel && !label
      ? undefined
      : ov.meaningStatus === 'pending' || ov.meaningStatus === 'confirmed'
        ? ov.meaningStatus
        : undefined
    const defaultLabel = typeof ov.defaultLabel === 'string' && ov.defaultLabel.trim()
      ? ov.defaultLabel.trim()
      : undefined
    out[key] = {
      ...(label ? { label } : {}),
      ...(defaultLabel ? { defaultLabel } : {}),
      ...(description ? { description } : {}),
      ...(meaningStatus ? { meaningStatus } : {}),
      source: ov.source === 'alias-migrated' ? 'alias-migrated' : 'author',
      updatedAt: typeof ov.updatedAt === 'number' ? ov.updatedAt : 0,
    }
  }
  return { ...doc, fields: out }
}

/**
 * 缓存签名：修订号 + 时间戳。
 * 🔴 每次写入都会同时推进两者（同一次读-改-写），所以任一变化都意味着内容换了来源；
 *    与别名的内容签名并列参与缓存比对，见 `templates/cache.ts`。
 */
export function fieldDefinitionSig(doc: FieldDefinitionDoc | null | undefined): string {
  return doc ? `${doc.revision}@${doc.updatedAt}` : ''
}

/** 只取「改过的显示名」（叠加到渲染 / AI 清单用）；空表表示什么都不用叠 */
export function overrideLabelsOf(
  doc: FieldDefinitionDoc | null | undefined,
  keys: readonly string[],
): Record<string, string> {
  const clean = sanitizeFieldDefinitionDoc(doc, keys)
  const out: Record<string, string> = {}
  if (!clean) return out
  for (const [key, ov] of Object.entries(clean.fields)) if (ov.label) out[key] = ov.label
  return out
}

/**
 * 把轻量定义叠到有效模板上。
 *
 * 🔴 只改 `label` / `description` / `meaningStatus`；`id` / `sourceKey` / 类型 / 选项 /
 *    权限全部原样 —— 回写目标与索引键不受改名影响。
 * 🔴 **轻量定义接管的字段不再回退到旧别名**：作者在弹窗里「恢复原名」后，别名若还生效，
 *    名字会被顶回来，等于保存没反应。所以只要这条覆盖还在（哪怕只剩说明），
 *    名称就按覆盖（没有 label ⇒ 原名）解析。
 * 🔴 摘要按叠完的字段重算：改名 / 改说明 / 确认状态都改变「模型看到的依据」，
 *    索引与 AI 候选必须据此判失效（T3-05）；布局因素不参与。
 * 🔴 没有覆盖 ⇒ **返回同一个对象**（调用方与缓存不必处理"等价但不同"的结果）。
 */
export function applyFieldDefinitions(
  tpl: EffectiveTemplate,
  doc: FieldDefinitionDoc | null | undefined,
  keys: readonly string[] = tpl.fields.map(f => f.sourceKey),
): EffectiveTemplate {
  const clean = sanitizeFieldDefinitionDoc(doc, keys)
  if (!clean || !Object.keys(clean.fields).length) return tpl
  let changed = false
  const fields = tpl.fields.map(f => {
    const ov = clean.fields[f.sourceKey]
    if (!ov) return f
    changed = true
    return {
      ...f,
      label: ov.label ?? defaultLabelOf(f.sourceKey),
      defaultLabel: ov.defaultLabel ?? f.defaultLabel ?? defaultLabelOf(f.sourceKey),
      ...(ov.description ? { description: ov.description } : {}),
      ...(ov.meaningStatus ? { meaningStatus: ov.meaningStatus } : {}),
    }
  })
  if (!changed) return tpl
  return { ...tpl, fields, semanticDigest: semanticDigestOf(fields) }
}

// ────────────────────────── 读写 ──────────────────────────

/** 读一个页签的轻量定义；没有 / 坏包 ⇒ null */
export async function loadFieldDefinitions(
  pid: string,
  tabId: string,
): Promise<FieldDefinitionDoc | null> {
  if (!pid || !tabId) return null
  const raw = await db.getSettingFor<unknown>(pid, fieldDefinitionKeyOf(tabId), null)
  return isFieldDefinitionDoc(raw) ? raw : null
}

/**
 * 串行队列：读-改-写必须排队，否则两路确认几乎同时到达时，后写者会用自己读到的
 * 旧文档覆盖前者刚确认的字段（与 `templates/store.ts` 同一教训）。
 */
let chain: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job)
  chain = run.then(() => undefined, () => undefined)
  return run
}

export interface FieldDefinitionPatch {
  /** `null` / 空串 = 恢复原名 */
  label?: string | null
  /** `null` / 空串 = 清除说明 */
  description?: string | null
  /** `null` = 清除确认状态（回到字段自身口径） */
  meaningStatus?: FieldMeaningStatus | null
}

/**
 * 写一个字段的轻量覆盖（作者明确声明）。返回写入后的整份文档。
 *
 * 🔴 名称与「默认显示名」相同 ⇒ 视为恢复原名，不保留一条无意义的覆盖。
 * 🔴 名称被清掉时一并清掉确认状态：没有改名就没有「这条改名是否改义」的问题。
 * 🔴 `defaultLabel` 在首次改名时固化：之后再改名，界面仍能告诉作者「原来叫什么」。
 */
export async function saveFieldDefinition(
  pid: string,
  tabId: string,
  sourceKey: string,
  patch: FieldDefinitionPatch,
): Promise<FieldDefinitionDoc | null> {
  if (!pid || !tabId || !sourceKey) return null
  // 能查到页签就校验存储键；动态分卷台账等不在 TABS 里的页签不因查不到而被拒绝
  const tab = TABS.find(t => t.id === tabId)
  if (tab && !storageKeysOf(tab).includes(sourceKey)) return null

  return enqueue(async () => {
    const cur = await loadFieldDefinitions(pid, tabId)
    const fields: Record<string, FieldDefinitionOverride> = { ...(cur?.fields ?? {}) }
    const prev = fields[sourceKey]
    const next: FieldDefinitionOverride = {
      ...(prev ?? { source: 'author' as const, updatedAt: 0 }),
      source: 'author',
      updatedAt: Date.now(),
    }

    if (patch.label !== undefined) {
      const label = (patch.label ?? '').trim()
      if (label && label !== defaultLabelOf(sourceKey)) {
        next.label = label
        if (!next.defaultLabel) next.defaultLabel = defaultLabelOf(sourceKey)
      } else {
        delete next.label
        delete next.meaningStatus
      }
    }
    if (patch.description !== undefined) {
      const desc = (patch.description ?? '').trim()
      if (desc) next.description = desc
      else delete next.description
    }
    if (patch.meaningStatus !== undefined) {
      if (patch.meaningStatus) next.meaningStatus = patch.meaningStatus
      else delete next.meaningStatus
    }

    if (!next.label && !next.description) delete fields[sourceKey]
    else fields[sourceKey] = next

    const doc: FieldDefinitionDoc = {
      formatVersion: FIELD_DEFINITION_VERSION,
      tabId,
      revision: (cur?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      fields,
    }
    await db.setSettingFor(pid, fieldDefinitionKeyOf(tabId), doc)
    emit()
    return doc
  })
}

// ────────────────────────── 历史别名迁移 ──────────────────────────

export interface FieldDefinitionMigrationResult {
  /** 新写入的待确认字段数（已迁移过的不会重复计） */
  added: number
  /** 实际写入文档的页签数 */
  tabs: number
  /** 已采用完整模板的页签：快照自己就是当前定义，不需要轻量覆盖 */
  skippedAdopted: string[]
  /** 读 / 写失败的页签（不阻断其它页签） */
  failed: string[]
}

/**
 * 把既有的 `fieldAlias::<tabId>` 逐字段迁移成轻量定义，**默认标记为待确认**。
 *
 * 🔴 幂等：已存在的键一定跳过；第二次运行不写库、`added` 为 0。
 * 🔴 不删旧别名：它是恢复来源，且未迁移的字段仍靠它显示。迁移后原字段按钮改为写新定义，
 *    但旧别名保留（方案 §3.12.3.5）。
 * 🔴 已采用模板的页签跳过：模板 `label` 优先级最高，迁过去也只会被覆盖。
 * 🔴 迁移**不等于确认**：旧别名只说明换了叫法，说明不了含义，必须由作者逐项确认
 *    （方案 §3.12.3.2「确认必须由作者提交」）。
 */
export async function migrateAliasesToFieldDefinitions(
  pid: string,
): Promise<FieldDefinitionMigrationResult> {
  const result: FieldDefinitionMigrationResult = { added: 0, tabs: 0, skippedAdopted: [], failed: [] }
  if (!pid) return result

  for (const tab of TABS) {
    let def: unknown
    try {
      def = await loadTemplateDef(pid, tab.id)
    } catch {
      result.failed.push(tab.id)
      continue
    }
    if (def) {
      result.skippedAdopted.push(tab.id)
      continue
    }

    let raw: unknown
    try {
      raw = await db.getSettingFor<unknown>(pid, aliasKeyOf(tab.id), null)
    } catch {
      result.failed.push(tab.id)
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue

    const keys = storageKeysOf(tab)
    const aliases = sanitizeAliases(keys, raw as Record<string, string>)
    if (!Object.keys(aliases).length) continue

    try {
      const cur = await loadFieldDefinitions(pid, tab.id)
      const fields: Record<string, FieldDefinitionOverride> = { ...(cur?.fields ?? {}) }
      let added = 0
      for (const key of keys) {
        const label = aliases[key]
        if (!label || fields[key]) continue
        fields[key] = {
          label,
          defaultLabel: defaultLabelOf(key),
          meaningStatus: 'pending',
          source: 'alias-migrated',
          updatedAt: Date.now(),
        }
        added++
      }
      if (added === 0) continue
      await db.setSettingFor(pid, fieldDefinitionKeyOf(tab.id), {
        formatVersion: FIELD_DEFINITION_VERSION,
        tabId: tab.id,
        revision: (cur?.revision ?? 0) + 1,
        updatedAt: Date.now(),
        fields,
      } satisfies FieldDefinitionDoc)
      result.added += added
      result.tabs++
      emit()
    } catch {
      result.failed.push(tab.id)
    }
  }
  return result
}

// ────────────────────────── 订阅 ──────────────────────────

const subs = new Set<() => void>()
function emit(): void {
  subs.forEach(fn => {
    try { fn() } catch { /* 订阅方异常不该影响其它订阅方 */ }
  })
}

/** 订阅轻量定义变化（确认清单 / 字段名展示据此刷新） */
export function subscribeFieldDefinitions(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}
