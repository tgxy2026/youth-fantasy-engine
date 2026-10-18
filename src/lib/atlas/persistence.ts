/**
 * 图鉴（3.1.3）· **字段配置的读写层**。
 *
 * 依据：方案 §4.2 / §4.3 / §5.1。
 *
 * 🔴 三条红线（每一条都对应一个真实事故类型）：
 *   1. **显式 projectId**：一律走 `getSettingFor/setSettingFor`。用 `getSetting` 会拼当时的
 *      `currentProjectId` —— 异步任务跑完时项目早切了，于是 A 的字段配置写进 B（方案 §4.2）。
 *   2. **读到坏数据不许回写**：解析失败 / 版本更高时返回空配置**只用于显示**，
 *      绝不把它保存回去覆盖作者原配置（方案 §4.3 / §8.4）。
 *   3. **revision 单调递增**：每次写入 +1，AI 与异步任务拿旧 revision 的结果必须被拒（方案 §7.3）。
 */
import { getSettingFor, setSettingFor } from '@/lib/db'
import { uid } from '@/lib/app/id'
import { emptyAtlasSchema } from './schema'
import type { AtlasFieldDefinition, AtlasSchemaConfig, AtlasTabId, CustomFieldType } from './types'

/** 设置键：`atlasSchema::races` / `atlasSchema::items`（项目级，随项目走） */
export function atlasSchemaKey(tabId: AtlasTabId): string {
  return `atlasSchema::${tabId}`
}

/** 当前代码能读写的格式版本 */
export const ATLAS_FORMAT_VERSION = 1

/** 新建自定义字段的稳定 ID：`cf_<uid>`，创建后永不改变，同时充当 row.data 的键 */
export function newFieldId(): string {
  return `cf_${uid()}`
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * 把任意读到的值「补成」一份结构合法的配置。
 * 🔴 只在内存里补，**不写回**；可疑字段按最保守的默认处理（不可写、不归档、不隐藏）。
 */
function normalize(raw: unknown): AtlasSchemaConfig {
  if (!raw || typeof raw !== 'object') return emptyAtlasSchema()
  const o = raw as Record<string, unknown>
  const fields: AtlasFieldDefinition[] = Array.isArray(o.fields)
    ? (o.fields as unknown[])
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .map(f => ({
        id: typeof f.id === 'string' ? f.id : newFieldId(),
        label: typeof f.label === 'string' ? f.label : '未命名字段',
        type: (typeof f.type === 'string' ? f.type : 'text') as CustomFieldType,
        description: typeof f.description === 'string' ? f.description : '',
        unit: typeof f.unit === 'string' ? f.unit : undefined,
        options: asStringArray(f.options),
        appliesTo: f.appliesTo === '*' ? '*' : asStringArray(f.appliesTo),
        groupId: typeof f.groupId === 'string' ? f.groupId : 'extra',
        order: typeof f.order === 'number' ? f.order : 0,
        tableVisible: f.tableVisible !== false,
        detailVisible: f.detailVisible !== false,
        searchable: f.searchable !== false,
        aiReadable: f.aiReadable !== false,
        aiWritable: f.aiWritable === true,
        archived: f.archived === true,
      }))
    : []
  const groups = Array.isArray(o.groups)
    ? (o.groups as unknown[])
      .filter((g): g is { id: string; label: string; order: number } =>
        !!g && typeof g === 'object' && typeof (g as Record<string, unknown>).id === 'string')
      .map(g => ({ id: g.id, label: String(g.label ?? g.id), order: Number(g.order) || 0 }))
    : []
  return {
    formatVersion: ATLAS_FORMAT_VERSION,
    revision: typeof o.revision === 'number' && Number.isFinite(o.revision) ? o.revision : 0,
    fields,
    groups,
    builtinPresentation: o.builtinPresentation && typeof o.builtinPresentation === 'object'
      ? (o.builtinPresentation as AtlasSchemaConfig['builtinPresentation'])
      : {},
    summaryKeys: asStringArray(o.summaryKeys),
  }
}

export interface LoadedAtlasSchema {
  config: AtlasSchemaConfig
  /** 读到了比自己更新的格式：只许看、不许改（方案 §8.4） */
  newerFormat: boolean
  /** 读取过程报错（此时 config 是空默认，仅用于显示） */
  error?: string
}

/** 读取某项目的某个页签配置。永远返回一份可用的配置，不抛异常 */
export async function loadAtlasSchema(projectId: string, tabId: AtlasTabId): Promise<LoadedAtlasSchema> {
  try {
    const raw = await getSettingFor<unknown>(projectId, atlasSchemaKey(tabId), null)
    if (raw == null) return { config: emptyAtlasSchema(), newerFormat: false }
    const ver = (raw as Record<string, unknown>).formatVersion
    if (typeof ver === 'number' && ver > ATLAS_FORMAT_VERSION) {
      // 未来版本写的配置：结构可能完全不同，强行解析只会丢字段 —— 只读保护
      return { config: normalize(raw), newerFormat: true }
    }
    return { config: normalize(raw), newerFormat: false }
  } catch (e) {
    return {
      config: emptyAtlasSchema(),
      newerFormat: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 写入配置（revision 自动 +1）。
 * 🔴 返回**新配置** —— 调用方必须用返回值更新界面状态，否则下一次编辑会拿着旧 revision 再写一遍。
 */
export async function saveAtlasSchema(
  projectId: string,
  tabId: AtlasTabId,
  config: AtlasSchemaConfig,
): Promise<AtlasSchemaConfig> {
  const next: AtlasSchemaConfig = {
    ...config,
    formatVersion: ATLAS_FORMAT_VERSION,
    revision: config.revision + 1,
  }
  await setSettingFor(projectId, atlasSchemaKey(tabId), next)
  return next
}
