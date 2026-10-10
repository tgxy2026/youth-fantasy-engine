/**
 * 世界引擎 · 世界包（WorldPack）—— 抽取 / 指纹 / 序列化（3.0 · W4-1a）
 *
 * 【它解决什么】3.0 之前，「世界」只活在**某个项目里**（世界设定 / 力量体系 / 世界构建组），
 *   换一本书就得重录一遍。世界包把这份内容抽成一个**可封存、可跨作品引用**的语义快照。
 *
 * 【边界（方案 §10.3 #8 原文口径）】
 *   · 只收**可版本化的语义内容** —— 章节正文、卷/章结构、角色卡、对话、向量索引**一概不收**；
 *   · 原作品后续修改**不会**自动同步到派生世界（引用＝快照复制，不是活链接）。
 *
 * 【单一真源】「抽什么」由下面的 `worldPackTabSpecs()` 决定 —— 抽取 / 封存 / 引入 / UI 都从它取，
 *   🔴 别在别处再列一份（2026-10-10 W4-1a 立）。
 *
 * 【只读】本模块**只读**存储，不改任何数据；落库在 W4-1b/c。
 */
import { uid } from '@/lib/app/id'
import { hashOf } from '@/lib/semantic/chunk'
import * as db from '@/lib/db'
// 🔴 世界包的**形状**集中在 `worldTypes.ts`（无依赖）—— 存储层 `db/worlds.ts` 也要用它，
//    留在这里会让 `db → worldPack` 成环。此处只 re-export，既有 import 路径一字不变。
import type { WorldPackKind, WorldPackTable, WorldPackOrigin, WorldPack } from '@/lib/world/worldTypes'
export type { WorldPackKind, WorldPackRow, WorldPackTable, WorldPackOrigin, WorldPack } from '@/lib/world/worldTypes'
export type { WorldVersion, WorldStoredRecord } from '@/lib/world/worldTypes'

export interface WorldPackTabSpec {
  /** 页签 id（母级）。`kind='sub'` 时实际存储在 `${tabId}-sub` 下（见 `worldSets.subTabIdOf`） */
  tabId: string
  kind: WorldPackKind
}

/**
 * 「世界」包含哪些表 —— **单一真源**（2026-10-10 逐条回源码核过）。
 *
 * 三族：
 *  ① 开书定位里的世界类：`worldbase`（世界设定）、`power`（力量体系）—— 有母级（formData）＋ 子项；
 *  ② 制度类并列设定：`politics`（政治架构）/ `economy`（经济基础）/ `belief`（宗教信仰）/ `justice`（司法制度）
 *     —— **只有子项，没有母级**（2.7.2 起的并列结构）；
 *  ③ 世界构建组：`nations`（国家势力）/ `geography`（地理风物）/ `races`（种族生物）/ `items`（物品资源）/
 *     `history`（历史事件）/ `terms`（名词术语）/ `misc-settings`（其他设定）。
 *
 * 🔴 与方案 D2=B 的一处差异：原文写「世界设定 ＋ 力量体系 ＋ 世界构建组 7 表」，
 *    实现时核出**第 ② 族漏列** —— 依据是 `schemaTemplates/packs.ts` 的 `PACK_TAB_IDS`
 *    与 `schemaShared.ts` 的 `INSTITUTION_TABS`。那四张同属世界内容、AI 也读它们
 *    （见 `aiDataSources.ts` 的 politics / economy / belief / justice 条目）；
 *    漏了会让「引入世界」凭空少掉一半制度设定，故一并纳入。
 */
export function worldPackTabSpecs(): WorldPackTabSpec[] {
  const withParent = ['worldbase', 'power']
  const onlySub = ['politics', 'economy', 'belief', 'justice']
  const tables = ['nations', 'geography', 'races', 'items', 'history', 'terms']
  const cards = ['misc-settings']
  const out: WorldPackTabSpec[] = []
  for (const t of withParent) {
    out.push({ tabId: t, kind: 'form' })
    out.push({ tabId: t, kind: 'sub' })
  }
  for (const t of onlySub) out.push({ tabId: t, kind: 'sub' })
  for (const t of tables) out.push({ tabId: t, kind: 'table' })
  for (const t of cards) out.push({ tabId: t, kind: 'card' })
  return out
}

// 形状定义见 `./worldTypes.ts`（本文件 re-export，既有 import 路径不变）。

/** 稳定序列化：键名排序 ⇒ 同一份内容无论键序如何，指纹一致 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

/** 内容指纹（不含 id / name / origin） */
export function worldPackFingerprint(pack: Pick<WorldPack, 'tables' | 'activeSubs'>): string {
  return hashOf(stableStringify({ tables: pack.tables ?? [], activeSubs: pack.activeSubs ?? {} }))
}

/**
 * 从**当前项目**抽一个世界包（只读）。
 * 空表**不产出条目** —— 否则引入方会凭空多出一堆空页签。
 */
export async function collectWorldPack(opts: { name: string; projectName?: string }): Promise<WorldPack> {
  const projectId = db.getCurrentProjectId()
  const tables: WorldPackTable[] = []
  const activeSubs: Record<string, string[]> = {}

  for (const spec of worldPackTabSpecs()) {
    if (spec.kind === 'form') {
      const data = await db.getFormData(spec.tabId)
      const filled = Object.keys(data).filter(k => String(data[k] ?? '').trim() !== '')
      if (filled.length) tables.push({ tabId: spec.tabId, kind: 'form', rows: [{ id: spec.tabId, data, order: 0 }] })
      continue
    }
    if (spec.kind === 'sub') {
      const subs = await db.getSubSets(spec.tabId)
      if (!subs.length) continue
      tables.push({
        tabId: spec.tabId,
        kind: 'sub',
        rows: subs.map(s => ({ id: s.id, name: s.name || '', data: s.data ?? {}, order: s.order ?? 0 })),
      })
      activeSubs[spec.tabId] = await db.getActiveSubIds(spec.tabId)
      continue
    }
    const rows = spec.kind === 'table' ? await db.getTableRows(spec.tabId) : await db.getCardRecords(spec.tabId)
    if (!rows.length) continue
    tables.push({
      tabId: spec.tabId,
      kind: spec.kind,
      rows: rows.map(r => {
        const c = r as { id: string; name?: string; data?: Record<string, string>; order?: number }
        return { id: c.id, ...(spec.kind === 'card' ? { name: c.name || '' } : {}), data: c.data ?? {}, order: c.order ?? 0 }
      }),
    })
  }

  const pack: WorldPack = {
    schema: 1,
    id: uid(),
    name: opts.name.trim() || '未命名世界',
    origin: { projectId, projectName: opts.projectName ?? '', at: Date.now() },
    tables,
    activeSubs,
    fingerprint: '',
  }
  pack.fingerprint = worldPackFingerprint(pack)
  return pack
}

/** 序列化（导出 / 落盘 / 同步都用它，不另造形态） */
export function serializeWorldPack(pack: WorldPack): string {
  return JSON.stringify(pack, null, 2)
}

/** 反序列化：**形状不对一律返回 null**（不抛，调用方按「读不出来」处理） */
export function parseWorldPack(text: string): WorldPack | null {
  try {
    const o = JSON.parse(text) as Partial<WorldPack> | null
    if (!o || typeof o !== 'object') return null
    if (o.schema !== 1) return null
    if (!Array.isArray(o.tables)) return null
    if (!o.activeSubs || typeof o.activeSubs !== 'object') return null
    const origin = (o.origin ?? {}) as Partial<WorldPackOrigin>
    return {
      schema: 1,
      id: String(o.id ?? ''),
      name: String(o.name ?? ''),
      origin: {
        projectId: String(origin.projectId ?? ''),
        projectName: String(origin.projectName ?? ''),
        at: Number(origin.at ?? 0),
      },
      tables: o.tables as WorldPackTable[],
      activeSubs: o.activeSubs as Record<string, string[]>,
      fingerprint: String(o.fingerprint ?? ''),
    }
  } catch {
    return null
  }
}
