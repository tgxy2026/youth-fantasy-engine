// 三路合并规则（从 syncCore 外抽，可单独验证）。
//
// 【为什么抽出来】syncCore.ts 同时承担加密 / 载荷结构 / rev 合并 / 空推防护 / 三路合并 / 状态机 /
//   传输调度，边界不清增加回归范围（3.5.3 规划 §P1-B）。合并规则是其中**纯逻辑**的一块：
//   不碰传输、加密、调度，也不读模块级状态，最适合先固定行为再单独验证。
//
// 🔴 行为与外抽前逐字一致：四条「删了会复活」防护、localHasContent 空库闸、两端都改本地优先 + 冲突副本。
// 🔴 运行时依赖（主键表 / 本地专属判据 / 冲突回调）通过 MergeContext 注入，而不是 import syncCore：
//    syncCore 运行时 import 本文件，本文件若再运行时 import syncCore 就凑成环（importCycles 会红）。
//    类型只 type-only import syncCore（importCycles 擦除类型边，不成环）；墓碑判据直接取叶子模块
//    syncTombstone（它不反向依赖 sync 层）。
import { isDeleted } from '@/lib/sync/syncTombstone'
import type { SyncRow, SyncStores, SyncConflictInfo } from '@/lib/sync/syncCore'

/**
 * 合并所需的运行时依赖（由 syncCore 用 KEY_FIELD / isLocalOnlyStore / conflictHandler 构造一次）。
 * 注入而非 import，是为了让本模块成为可单独验证的纯逻辑叶子，且不与 syncCore 形成 import 环。
 */
export interface MergeContext {
  /** 各 store 主键字段（KEY_FIELD）；缺省回退 'id'。 */
  keyField: Record<string, string>
  /** 本地专属 store 判据（isLocalOnlyStore）：云端永不参与其增删，一律以本机为准。 */
  isLocalOnly: (store: string) => boolean
  /** 冲突回调（#005）：两端都改时把云端那版交上层另存副本。须读**当前** handler，失败绝不影响主流程。 */
  onConflict?: (info: SyncConflictInfo) => void
}

export function eqRecord(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
/**
 * 两个 store 快照内容是否一致。
 * 用途：三路合并后判断「是否留下了云端没有的本地改动」（是则必须立刻推回，见 backgroundPull）。
 */
export function sameStores(a: SyncStores, b: SyncStores, keyField: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  for (const k of keys) {
    const av = a?.[k] ?? []
    const bv = b?.[k] ?? []
    if (av.length !== bv.length) return false
    // 🔴 2026-09-22 六维审计 P1：主键必须走主键表（keyField），不能只认 `id ?? key`。
    //    `formData` 的主键是 **tabId**，既没有 `id` 也没有 `key`，手写 `id ?? key` 会把它的每一条
    //    都映射成 `undefined`，Map 里互相覆盖只剩最后一条：formData ≥2 条时本函数**恒返回 false**
    //    ⇒ `backgroundPull` 恒判 drifted ⇒ `schedulePush`，两端都持有 formData 时会形成「收到即回推」
    //    的同步乒乓、rev 持续自增。syncCore 别处统一用 `KEY_FIELD[store] ?? 'id'`，这里同口径。
    const kf = keyField[k] ?? 'id'
    const bm = new Map<unknown, SyncRow>(bv.map(r => [(r as SyncRow)?.[kf], r] as const))
    for (const r of av) {
      const other = bm.get((r as SyncRow)?.[kf])
      if (!other || !eqRecord(r, other)) return false
    }
  }
  return true
}

export function snapshotOf(c: SyncStores): SyncStores {
  const out: SyncStores = {}
  for (const k of Object.keys(c || {})) out[k] = (c[k] || []).slice()
  return out
}

/**
 * 三路合并（base 基线 / server 云端 / local 本地）。
 * 与旧版「一律本地覆盖」的区别：只有云端改时采用云端；两端都改时才以本地为准，
 * 并把云端那版交给冲突回调另存副本，用户可比对照恢复（#005）。
 */
export function mergeCaches(
  base: SyncStores,
  server: SyncStores,
  local: SyncStores,
  ctx: MergeContext,
): SyncStores {
  const out: SyncStores = {}
  const stores = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(server || {}),
    ...Object.keys(local || {}),
  ])
  /**
   * 「本地这份快照算不算一份有内容的库」。
   * 只有它非空时，才能把"本地没有这条记录"读成"本机删掉了它" —— 若整库为空
   * （新设备首同步 / 启动瞬间 cache 尚未建立），那只说明"还没拉下来"，必须采用云端。
   * 缺了这道闸，新设备首次同步会把云端数据整片丢掉。
   */
  const localHasContent = Object.keys(local || {}).some((k) => ((local || {})[k] || []).length > 0)

  for (const s of stores) {
    // #026：本地专属 store（backups / backupPayloads）云端永不参与其增删，一律以本机为准
    if (ctx.isLocalOnly(s)) {
      out[s] = (local && local[s]) || []
      continue
    }
    const kf = ctx.keyField[s] ?? 'id'
    const bMap = new Map<unknown, SyncRow>()
    const sMap = new Map<unknown, SyncRow>()
    const lMap = new Map<unknown, SyncRow>()
    for (const r of (base && base[s]) || []) if (r && r[kf] !== undefined) bMap.set(r[kf], r)
    for (const r of (server && server[s]) || []) if (r && r[kf] !== undefined) sMap.set(r[kf], r)
    for (const r of (local && local[s]) || []) if (r && r[kf] !== undefined) lMap.set(r[kf], r)

    const arr: SyncRow[] = []
    for (const k of new Set([...bMap.keys(), ...sMap.keys(), ...lMap.keys()])) {
      const b = bMap.get(k)
      const sv = sMap.get(k)
      const lo = lMap.get(k)
      const note = (localV: unknown, serverV: unknown) => {
        try {
          ctx.onConflict?.({ store: s, key: k, local: localV, server: serverV, at: Date.now() })
        } catch {
          /* 冲突处理失败绝不影响主同步流程 */
        }
      }

      // —— 本地没有这条记录 ——
      if (lo === undefined) {
        if (sv === undefined) continue // 两端皆无
        if (b === undefined) {
          /**
           * 基线快照里也没有它 —— 「谁删的」只能靠**墓碑**（本机明确的删除记忆）来判断。
           * 🔴 这一步就是「幽灵项目」的修复点：旧实现一律判为「另一端新增」而采用云端，
           *    于是凡是云端还留着、而本机早已删掉的记录都会被搬回来（2026-09-19 实测）。
           * ⚠️ 必须同时满足 `localHasContent`（见其说明）—— 否则会丢掉整库云端数据。
           */
          if (localHasContent && isDeleted(s, k)) {
            continue // 本机删过 + 本地没有 + 云端有 → 尊重删除，不采用云端
          }
          arr.push(sv) // 没删过 + 云端有 → 另一端新增（或本地尚未拉取），采用云端
          continue
        }
        if (!eqRecord(sv, b)) {
          // 🔴 云端改过、而本机删过它（2026-09-23 六维审计）：这一支原先无条件采用云端，
          //    与上面那支（本地删过 + 本地没有 + 云端有）**不对称**，是第三条「删了会复活」路径 ——
          //    尊重删除，但把云端的改动记进冲突，作者在冲突面板里仍能捞回来。
          if (localHasContent && isDeleted(s, k)) {
            note(null, sv)
            continue
          }
          arr.push(sv)
          note(null, sv)
        }
        continue // 云端未改 → 尊重本地删除
      }

      // —— 云端没有这条记录 ——
      if (sv === undefined) {
        /**
         * 🔴 这一支同样要查墓碑（P0，2026-09-21 六维审计）—— 原先它完全没有墓碑判断，
         *    与上一支（本地没有、云端有）**不对称**，于是留下第二条「删了会复活」的路径：
         *
         * 云模式下**本机数据文件是「开启同步那一刻」的冻结快照**（此后读写都走 memory cache，
         * 见 db/core.ts 的 mirrorCloudCacheToLocal 说明）。于是
         * 「开着同步删掉某条 → 不关同步直接关窗重启」时，陈旧本地文件里那条**还在**：
         * 合并遇到 lo 有、sv 无 ⇒ 旧实现无条件 arr.push(lo) ⇒ 删除被撤销并回推云端（自锁）。
         *
         * 判据与上一支对齐：本机明确删过（墓碑）+ 本地确有内容（防空库误判）+ 本地那份没被改过。
         */
        if (localHasContent && isDeleted(s, k) && (b === undefined || eqRecord(lo, b))) continue
        if (b !== undefined && eqRecord(lo, b)) continue
        arr.push(lo)
        continue
      }

      if (eqRecord(lo, sv)) {
        /**
         * 🔴 两端一致也要查墓碑（2026-10-01 六维审计 P0）—— 这是「删了会复活」的**第四条**路径，
         *    判据必须与上面两支（本地没有 / 云端没有）口径一致：
         *
         * 云模式下本机数据文件是「开启同步那一刻」的冻结快照（见本函数上方那段说明）。
         * 某条记录 Y 在开启同步前就已存在（冻结文件里有它、云端也有它，**逐字相同**），
         * 开启同步后本机删掉 Y（`store.del` 记墓碑 + cache 移除），但这次 push **没成功**
         * （断网 / 网盘占住同步目录 / 防抖窗口内关窗）。重启后 baseCache 为空（只活在内存），
         * 而 `lo`（冻结文件）与 `sv`（云端）都还留着 Y 且相等 ⇒ 原实现无条件 `arr.push(lo)`
         * ⇒ 删除被撤销、还会被推回云端，此后每次启动稳定复现。
         *
         * ⚠️ 为什么只有这一支会漏：另两支的 `lo`/`sv` 有一侧是 undefined，
         *   写「本地删过」的判断时很自然；而「两端一致」看着最无害，最容易被当成不需要判。
         */
        if (localHasContent && isDeleted(s, k)) continue // 本机删过 → 尊重删除，两端一致也不采用
        arr.push(lo) // 两端一致
        continue
      }
      const localChanged = !eqRecord(lo, b)
      const serverChanged = !eqRecord(sv, b)
      if (!localChanged) {
        arr.push(sv) // 只有云端改 → 采用云端
        continue
      }
      if (!serverChanged) {
        arr.push(lo) // 只有本地改 → 采用本地
        continue
      }
      // 两端都改且不同 → 本地优先，云端那版另存副本供比对恢复
      arr.push(lo)
      note(lo, sv)
    }
    out[s] = arr
  }
  return out
}