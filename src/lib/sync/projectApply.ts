// ============ 3.3.2 · P2-3 拉取与应用计划 ============
//
// 【为什么单独一个「计划」而不是直接写库】拉取要同时满足三件互相冲突的事：
//   ① 全部内容齐了才能动本地（缺一张图就切过去 ⇒ 用户看到一堆加载失败的图）；
//   ② 本地有未同步改动时**不能**被云端默默覆盖（那是丢稿）；
//   ③ 墓碑要真的删掉本地那条，否则「别的设备删了，我这边还在」。
// 把它们压成一份**纯函数产出的计划**，就能先算、再让上层决定要不要执行 ——
// 执行失败也不会留下写了一半的本地库。
//
// 🔴 未知 kind 一律拒绝整次应用（协议 §5）：宁可「这台设备暂时不更新」，
//    也不要静默丢掉它不认识的数据。新版软件新增的类型必须同步维护 KNOWN_KINDS。
import type { SnapshotManifest } from '@/lib/sync/projectSnapshot'

/** 当前客户端认识的 kind（与 `buildProjectSnapshot` 的 slices 一一对应） */
export const KNOWN_KINDS = [
  'chapters', 'volumes', 'tableRows', 'cardRecords', 'formData',
  'settings', 'dailyStats', 'aiRuns', 'tavernReports', 'snapshots',
] as const

export type ApplyOp =
  | { type: 'put'; kind: string; records: Record<string, unknown>[] }
  | { type: 'delete'; kind: string; ids: string[] }

export type ApplyCode =
  | 'OK'
  | 'LOCAL_DIRTY'
  | 'MISSING_OBJECT'
  | 'UNKNOWN_KIND'
  | 'PROTOCOL'
  | 'NOTHING_TO_DO'

export interface ApplyPlan {
  ok: boolean
  code: ApplyCode
  /** 中文人话原因（直接可显示给作者，别让 UI 再翻译一遍） */
  reason: string
  ops: ApplyOp[]
  summary: { put: number; deleted: number; kinds: string[] }
  /** 计划生成时用的快照身份：上层执行完应据此记录「已应用到哪个 revision」 */
  snapshotId: string
  revision: number
}

export interface PlanApplyInput {
  /** 服务端返回的 manifest（含 revision/snapshotId，由 HTTP 层附加） */
  manifest: SnapshotManifest & { revision?: number; snapshotId?: string }
  /** 已下载并校验通过的对象载荷：hash → 记录数组 */
  loaded: Record<string, Record<string, unknown>[]>
  /**
   * 本地是否有未同步改动。
   * 🔴 由调用方判定（草稿、待上传队列、在途写入都算），本模块不猜。
   */
  localDirty: boolean
}

/**
 * 生成应用计划。**不动任何数据**，只回答「该做什么」。
 */
export function planApply(input: PlanApplyInput): ApplyPlan {
  const empty = (code: ApplyCode, reason: string): ApplyPlan => ({
    ok: false, code, reason, ops: [], summary: { put: 0, deleted: 0, kinds: [] },
    snapshotId: input.manifest?.snapshotId || '', revision: input.manifest?.revision ?? 0,
  })

  const m = input.manifest
  if (!m || typeof m !== 'object' || !Array.isArray(m.objects)) {
    return empty('PROTOCOL', '云端清单格式无法识别，本机未做任何改动')
  }

  if (input.localDirty) {
    return empty('LOCAL_DIRTY', '本机还有未同步的改动，先不套用云端版本（避免覆盖你的稿子）')
  }

  // ① 完整性：清单列出的每个对象都必须已经拿到
  const missing: string[] = []
  for (const o of m.objects) {
    if (!Array.isArray(input.loaded[o.hash])) missing.push(o.hash)
  }
  if (missing.length) {
    return empty('MISSING_OBJECT', `还有 ${missing.length} 份内容没下载完，本次不切换`)
  }

  // ② 未知类型：拒绝整次应用
  const unknown = m.objects.map((o) => o.kind).filter((k) => !(KNOWN_KINDS as readonly string[]).includes(k))
  if (unknown.length) {
    return empty('UNKNOWN_KIND', `云端有本版本不认识的数据类型（${[...new Set(unknown)].join('、')}），请升级软件后再同步`)
  }

  // ③ 正常：每个 kind 一条 put；墓碑按 kind 聚合成 delete
  const ops: ApplyOp[] = []
  let put = 0
  const kinds: string[] = []
  for (const o of m.objects) {
    const records = input.loaded[o.hash]
    ops.push({ type: 'put', kind: o.kind, records })
    put += records.length
    kinds.push(o.kind)
  }

  const byKind = new Map<string, string[]>()
  for (const t of m.tombstones ?? []) {
    // 整项目墓碑由上层处理（删除整本）；这里只处理记录级
    if (!t || t.kind === 'project' || !t.id) continue
    const list = byKind.get(t.kind) ?? []
    list.push(String(t.id))
    byKind.set(t.kind, list)
  }
  let deleted = 0
  for (const [kind, ids] of byKind) {
    ops.push({ type: 'delete', kind, ids })
    deleted += ids.length
  }

  if (put === 0 && deleted === 0 && m.objects.length === 0) {
    return empty('NOTHING_TO_DO', '云端这一版没有任何内容')
  }

  return {
    ok: true,
    code: 'OK',
    reason: '',
    ops,
    summary: { put, deleted, kinds: [...new Set(kinds)] },
    snapshotId: m.snapshotId || '',
    revision: m.revision ?? 0,
  }
}

/**
 * 记录主键（执行删除时按它匹配；与 `projectSnapshot.KEY_OF` 同口径）。
 * 单独导出一份是为了让「计划」与「执行」用同一把尺子，避免一边按 id 一边按 key。
 */
export function primaryKeyOf(kind: string, record: Record<string, unknown>): string {
  switch (kind) {
    case 'formData': return String(record.tabId ?? '')
    case 'settings': return String(record.key ?? '')
    case 'dailyStats': return String(record.key ?? record.date ?? '')
    default: return String(record.id ?? '')
  }
}
