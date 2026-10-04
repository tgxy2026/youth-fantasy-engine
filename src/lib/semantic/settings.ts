// ============ 语义检索 · 嵌入模型配置 ============
//
// 🔴 设计取舍（先说清楚，免得后人以为是漏写）：
//    **嵌入模型只能从「模型配置」里已有的模型里挑**，本模块**不新增密钥载体**。
//    为什么不给「手填 baseUrl + apiKey」那条路：
//      密钥只要多一个落点，就多一处要同步进 `EXCLUDED_META_KEYS`（不上云）的地方 ——
//      `app.search` 就是这么漏过一次（搜索密钥随 `.yfe` 落到网盘）。
//      而作者本来就要为对话配一个模型（本地 Ollama 或云端），复用现成的那个 provider
//      既省事、又让密钥只有 `aiProviders` 一个出口。
//    想用别的嵌入模型（如 Ollama 的 `nomic-embed-text`）？在本模块**单独填模型名**即可 ——
//    provider 提供的是地址与密钥，模型名按嵌入场景单独指定，两者职责分得开。
//
// 因此 `meta.aiEmbedding` 里**只有 providerId / model / autoIndexOnSave，没有密钥**，
// **不需要**（也不应该）加进 `EXCLUDED_META_KEYS`。加进去反而会让它变成"本地专属"、
// 换设备后配置丢失 —— 那是密钥才需要的保护。

import * as db from '../db'
import { loadProviders } from '../aiCore/session'
import type { AIProvider } from '../aiCore/core'
import type { EmbedConfig } from './embed'

/** 存储键（落 `meta`，全局共享 —— 与模型配置同理，不随小说项目切换） */
export const K_EMBEDDING = 'aiEmbedding'

export interface EmbeddingSettings {
  /** 用的哪个已配置模型（`providers` 里的 id）；空串 = 未配置 ⇒ 语义检索整体关闭 */
  providerId: string
  /** 嵌入模型名；留空则用 provider 自己的 model 名 */
  model: string
  /** 章节保存后自动索引本章（默认关 —— 每次保存都花嵌入额度，得作者自己点头） */
  autoIndexOnSave: boolean
}

export const DEFAULT_EMBEDDING: EmbeddingSettings = {
  providerId: '',
  model: '',
  autoIndexOnSave: false,
}

/** 归一化（**纯函数**）：读到的可能是老版本 / 手改过的脏数据，一律收敛成完整形状 */
export function normalizeEmbeddingSettings(raw: unknown): EmbeddingSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    providerId: typeof o.providerId === 'string' ? o.providerId : '',
    model: typeof o.model === 'string' ? o.model : '',
    autoIndexOnSave: o.autoIndexOnSave === true,
  }
}

export async function loadEmbeddingSettings(): Promise<EmbeddingSettings> {
  try {
    return normalizeEmbeddingSettings(await db.getMeta<unknown>(K_EMBEDDING, null))
  } catch {
    return { ...DEFAULT_EMBEDDING }
  }
}

/** 合并写入并回读（归一化后落盘，避免脏字段长期留在库里） */
export async function saveEmbeddingSettings(patch: Partial<EmbeddingSettings>): Promise<EmbeddingSettings> {
  const cur = await loadEmbeddingSettings()
  const next = normalizeEmbeddingSettings({ ...cur, ...patch })
  await db.setMeta(K_EMBEDDING, next)
  return next
}

/**
 * 解析出可直接发请求的嵌入配置；不可用时返回 null（🔴 **不抛** —— 未配置是常态，不是错误）。
 *
 * @param s 已读到的设置（不传则自己读库）
 * @param providers 已读到的模型列表（不传则自己读库）—— 供单测注入
 */
export async function resolveEmbedConfig(
  s?: EmbeddingSettings,
  providers?: AIProvider[],
): Promise<EmbedConfig | null> {
  const set = s ?? (await loadEmbeddingSettings())
  if (!set.providerId) return null
  const list = providers ?? (await loadProviders())
  const p = list.find(x => x.id === set.providerId)
  if (!p) return null
  const model = set.model.trim() || p.model
  if (!model) return null
  if (!(p.baseUrl ?? '').trim()) return null
  return { type: p.type, baseUrl: p.baseUrl, apiKey: p.apiKey, model }
}

export interface EmbeddingStatus {
  ready: boolean
  /** 不可用时的原因（界面据此写置灰说明）；可用为空串 */
  reason: string
  /** 可用时的简短标识，如「本地 · nomic-embed-text」 */
  label: string
}

/**
 * 语义检索是否可用（**给界面用**）。三条原因分开说，作者才知道该去改哪一处：
 * 1. 没选 provider → 去挑一个；
 * 2. 选的 provider 已被删 / 没填地址 → 去模型配置补；
 * 3. 缺模型名 → 补嵌入模型名。
 */
export async function embeddingStatus(
  s?: EmbeddingSettings,
  providers?: AIProvider[],
): Promise<EmbeddingStatus> {
  const set = s ?? (await loadEmbeddingSettings())
  if (!set.providerId) return { ready: false, reason: '未选择嵌入模型', label: '' }
  const list = providers ?? (await loadProviders())
  const p = list.find(x => x.id === set.providerId)
  if (!p) return { ready: false, reason: '所选的模型已被删除，请重新选择', label: '' }
  const model = set.model.trim() || p.model
  if (!model) return { ready: false, reason: '未填写嵌入模型名', label: '' }
  if (!(p.baseUrl ?? '').trim()) return { ready: false, reason: '所选的模型缺少接口地址', label: '' }
  const where = p.type === 'ollama' || p.local ? '本地' : '联网'
  return { ready: true, reason: '', label: `${where} · ${model}` }
}
