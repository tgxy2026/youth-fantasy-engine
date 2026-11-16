/**
 * 作者成果记录 · 读写层（3.6.0 · A1）
 *
 * 落点与理由（M0 §6.1）：`settingsKV` 的 `<projectId>::artefacts` 单键。
 *   · 导出/导入/分片备份/云同步/删除五条路径对 `settingsKV` 已经全部打通；
 *   · 新开 ObjectStore 要同时改这五处 + IDB 版本迁移，收益不值这个风险。
 *
 * 🔴 值一律以**字符串**存取（理由见 `remap.ts` 文件头：避免被敏感键的值探测误剥）。
 * 🔴 读到损坏 / 更高版本 ⇒ `writable: false`，调用方**不得调 save**（那会把作者的原记录整份覆盖）。
 */
import { getSettingFor, setSettingFor } from '@/lib/db/meta'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import {
  ARTEFACT_SETTING_KEY, checkArtefactWrite, emptyArtefacts, markStaleByChanges,
  parseArtefacts, serializeArtefacts, type ArtefactChange,
} from './remap'
import type { ArtefactKind, ArtefactRecord, ArtefactState, ArtefactStore } from './types'

export interface LoadedArtefacts {
  store: ArtefactStore
  /** 读/解析失败原因（UI 应提示且禁止写回） */
  error?: string
  /** 来自更新版本：只读展示 */
  newer: boolean
  /** 是否允许写回（`false` ⇒ 记录损坏或来自更新版本） */
  writable: boolean
}

/** 读当前项目的成果记录。读失败不抛，返回空 + error（与 `loadAtlasSchema` 同口径） */
export async function loadArtefacts(projectId: string, owner?: OwnedOperation): Promise<LoadedArtefacts> {
  let raw: unknown
  try {
    raw = await getSettingFor<unknown>(projectId, ARTEFACT_SETTING_KEY, null, owner)
  } catch (e) {
    return {
      store: emptyArtefacts(),
      error: `成果记录读取失败：${e instanceof Error ? e.message : String(e)}`,
      newer: false,
      writable: false,
    }
  }
  const parsed = parseArtefacts(raw)
  if (!parsed.ok) {
    return {
      store: emptyArtefacts(),
      error: parsed.reason,
      newer: parsed.newer,
      writable: false,
    }
  }
  return { store: parsed.store, newer: false, writable: true }
}

export type SaveArtefactsResult = { ok: true; bytes: number } | { ok: false; reason: string }

/**
 * 写回整份成果记录（调用方负责先 `loadArtefacts` 并确认 `writable`）。
 *
 * 超限**拒绝并说明**（M0 §6.2：不静默淘汰作者保存的东西）。
 */
export async function saveArtefacts(
  projectId: string, store: ArtefactStore, owner?: OwnedOperation,
  incoming?: readonly ArtefactRecord[],
): Promise<SaveArtefactsResult> {
  const check = checkArtefactWrite(store, incoming)
  if (!check.ok) return { ok: false, reason: check.reason }
  try {
    await setSettingFor(projectId, ARTEFACT_SETTING_KEY, check.text, owner)
    return { ok: true, bytes: check.bytes }
  } catch (e) {
    return { ok: false, reason: `成果记录写入失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 新增或替换一条（同 id 覆盖，保留 `createdAt`） */
export function withUpserted(store: ArtefactStore, record: ArtefactRecord): ArtefactStore {
  const idx = store.items.findIndex(it => it.id === record.id)
  if (idx < 0) return { ...store, items: [record, ...store.items] }
  const prev = store.items[idx]
  const next = store.items.slice()
  next[idx] = { ...record, createdAt: prev.createdAt || record.createdAt }
  return { ...store, items: next }
}

export function withRemoved(store: ArtefactStore, id: string): ArtefactStore {
  return { ...store, items: store.items.filter(it => it.id !== id) }
}

export function withState(store: ArtefactStore, id: string, state: ArtefactState, now: number): ArtefactStore {
  return {
    ...store,
    items: store.items.map(it => (it.id === id ? { ...it, state, updatedAt: now } : it)),
  }
}

/** 清除过期标记（作者明确「仍按此结果继续」时用；不会动 payload） */
export function withStaleCleared(store: ArtefactStore, id: string): ArtefactStore {
  return {
    ...store,
    items: store.items.map(it => {
      if (it.id !== id || !it.stale) return it
      const { stale: _drop, ...rest } = it
      return rest
    }),
  }
}

/** 筛选（UI 与 B/C/D/F 共用；`kept` 之外默认不参与发送） */
export function selectArtefacts(
  store: ArtefactStore,
  opts: { kind?: ArtefactKind; states?: readonly ArtefactState[]; includeStale?: boolean } = {},
): ArtefactRecord[] {
  const states = opts.states ?? ['kept']
  const includeStale = opts.includeStale ?? true
  return store.items.filter(it =>
    (!opts.kind || it.kind === opts.kind)
    && states.includes(it.state)
    && (includeStale || !it.stale),
  )
}

/** 依赖变化 → 标过期（不删除、不应用） */
export function withStaleByChanges(
  store: ArtefactStore, changes: readonly ArtefactChange[], now: number,
): { store: ArtefactStore; changedIds: string[] } {
  return markStaleByChanges(store, changes, now)
}

/** 序列化（供导出/诊断/测试；正常写入走 `saveArtefacts`） */
export function serializeForExport(store: ArtefactStore): string {
  return serializeArtefacts(store)
}
