// ============ 3.3.2 · P4-3 拉取（把云端版本下载并生成计划）============
//
// 【补的是哪一段】P2 有 `planApply`（纯函数算"该做什么"），但**没人去把内容下下来**。
// 结果这套同步只能单向推：另一台设备就算知道云端有新版本，也拿不到正文。
// 跨设备接续写作的核心就是这一段。
//
// 🔴 下载必须**全部成功**才算数：缺一个分片就切换，用户会看到一堆加载失败的图、
//    或者某几张角色卡凭空消失。`planApply` 已经会用 `MISSING_OBJECT` 挡掉，
//    这里负责如实把"缺哪些"报上去。
//
// 🔴 图片**必须还原成 dataURL**：快照生成时把 `portrait` / `atlasImage.dataUrl`
//    抽成了 `sha256:<hash>` 引用（见 `projectSnapshot.extractAssets`）。
//    拉下来若不还原，另一台设备上所有立绘与图鉴图都会变成一行哈希字符串 ——
//    正文同步了，看起来却像"图全丢了"。还原是对称动作，不是可选优化。
//
// 🔴 某张图没下到时，**删掉那个字段**而不是留 `sha256:` 字符串：
//    留字符串等于给对方塞一张永远加载失败的图（与快照生成时的处理对称）。
//
// 🔴 本模块**不写库**：只下、只算。写入在 `projectPullWrite`（要做备份、要兜错）。
//    分开是为了让"计划对不对"可以脱离数据库穷举验证。
import type { ApplyPlan, ApplyOp } from '@/lib/sync/projectApply'
import { planApply } from '@/lib/sync/projectApply'
import type { SnapshotManifest } from '@/lib/sync/projectSnapshot'

export interface PullDeps {
  /** 取清单（不传 rev = 最新） */
  fetchManifest: (cloudProjectId: string, rev?: number) => Promise<unknown>
  /** 下载一个内容对象 */
  downloadObject: (cloudProjectId: string, hash: string) => Promise<Uint8Array | null>
}

export interface PullResult {
  /** 应用计划（`ok:false` 时 ops 为空，可以直接显示 reason） */
  plan: ApplyPlan
  /** 下到的分片（hash → 记录数组，图片已还原），只含解析成功的 */
  loaded: Record<string, Record<string, unknown>[]>
  /** 下载失败的哈希（用于日志与"再试一次"） */
  failed: string[]
  /** 有图没下到（记下来提示"有几张图没取到"，但不拦正文切换） */
  missingAssets: number
  /** 清单本身（界面要显示 revision / 创建时间） */
  manifest: (SnapshotManifest & { revision?: number; snapshotId?: string }) | null
}

const REF_PREFIX = 'sha256:'

function decodeJson(bytes: Uint8Array): Record<string, unknown>[] | null {
  try {
    const text = new TextDecoder().decode(bytes)
    const v = JSON.parse(text)
    return Array.isArray(v) ? v as Record<string, unknown>[] : null
  } catch {
    return null
  }
}

/** 字节 → dataURL（与快照生成时的 mime 口径一致） */
function toDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return `data:${mime || 'application/octet-stream'};base64,${btoa(bin)}`
}

/**
 * 把 `sha256:<hash>` 引用还原成 dataURL。
 *
 * @param refs hash → dataURL（没下到的 hash 不在表里）
 * @returns 还原后的记录（**不改原数组**，纯函数）
 */
export function restoreAssetRefs(
  records: readonly Record<string, unknown>[], refs: Map<string, string>,
): { records: Record<string, unknown>[]; missing: number } {
  let missing = 0
  const out = records.map((row) => {
    const next: Record<string, unknown> = { ...row }
    for (const field of ['portrait', 'portrait2'] as const) {
      const v = next[field]
      if (typeof v === 'string' && v.startsWith(REF_PREFIX)) {
        const url = refs.get(v.slice(REF_PREFIX.length))
        if (url) next[field] = url
        else { delete next[field]; missing++ }
      }
    }
    const img = next.atlasImage as { dataUrl?: unknown } | undefined
    if (img && typeof img === 'object' && typeof img.dataUrl === 'string' && img.dataUrl.startsWith(REF_PREFIX)) {
      const url = refs.get(img.dataUrl.slice(REF_PREFIX.length))
      if (url) next.atlasImage = { ...img, dataUrl: url }
      // 🔴 图没下到：整个 atlasImage 去掉（只删 dataUrl 会留下一个空壳图，界面照样报错）
      else { delete next.atlasImage; missing++ }
    }
    return next
  })
  return { records: out, missing }
}

/**
 * 下载云端某个版本并算出应用计划。
 *
 * @param localDirty 本机是否有未同步改动 —— 由调用方判定（本模块不猜）
 */
export async function buildPullPlan(
  deps: PullDeps,
  input: { cloudProjectId: string; localDirty: boolean; rev?: number },
): Promise<PullResult> {
  const raw = await deps.fetchManifest(input.cloudProjectId, input.rev)
  if (!raw || typeof raw !== 'object') {
    return {
      plan: {
        ok: false, code: 'PROTOCOL', reason: '取不到云端清单（网络或权限问题），本机未做任何改动',
        ops: [], summary: { put: 0, deleted: 0, kinds: [] }, snapshotId: '', revision: 0,
      },
      loaded: {}, failed: [], missingAssets: 0, manifest: null,
    }
  }

  const manifest = raw as SnapshotManifest & { revision?: number; snapshotId?: string }
  const objects = Array.isArray(manifest.objects) ? manifest.objects : []
  const assets = Array.isArray(manifest.assets) ? manifest.assets : []

  const loaded: Record<string, Record<string, unknown>[]> = {}
  const failed: string[] = []
  const refs = new Map<string, string>()

  // ① 先把图下下来：后面还原引用要用。缺图不拦，但要计数。
  for (const a of assets) {
    const hash = String(a?.hash || '')
    if (!hash) continue
    const bytes = await deps.downloadObject(input.cloudProjectId, hash)
    if (!bytes) { failed.push(hash); continue }
    refs.set(hash, toDataUrl(bytes, String(a?.mime || 'image/webp')))
  }

  // ② 再下内容分片。先内容后图片的顺序不能反：能否切换取决于内容是否齐，
  //    图片只影响显示（缺图会删字段，不会让整次切换失败）。
  let missingAssets = 0
  for (const o of objects) {
    const hash = String(o?.hash || '')
    if (!hash) { failed.push('(空哈希)'); continue }
    const bytes = await deps.downloadObject(input.cloudProjectId, hash)
    if (!bytes) { failed.push(hash); continue }
    const rows = decodeJson(bytes)
    if (!rows) { failed.push(hash); continue }
    if (String(o.kind) === 'cardRecords' || String(o.kind) === 'tableRows') {
      const r = restoreAssetRefs(rows, refs)
      loaded[hash] = r.records
      missingAssets += r.missing
    } else {
      loaded[hash] = rows
    }
  }

  const plan = planApply({ manifest, loaded, localDirty: input.localDirty })
  return { plan, loaded, failed, missingAssets, manifest }
}

/** 人话总结（界面直接显示，不要让每个调用方各写一份） */
export function pullSummary(r: PullResult): string {
  if (!r.plan.ok) return r.plan.reason
  const { put, deleted, kinds } = r.plan.summary
  const parts: string[] = []
  if (put) parts.push(`${put} 条记录`)
  if (deleted) parts.push(`删除 ${deleted} 条`)
  const base = parts.length ? `将更新 ${parts.join('、')}（涉及 ${kinds.length} 类数据）` : '云端这一版没有内容变化'
  return r.missingAssets > 0 ? `${base}；有 ${r.missingAssets} 张图没取到，已跳过（不影响正文）` : base
}

/** 计划里的 put 操作（写库层用它逐类替换） */
export function putOpsOf(plan: ApplyPlan): Extract<ApplyOp, { type: 'put' }>[] {
  return plan.ops.filter((o): o is Extract<ApplyOp, { type: 'put' }> => o.type === 'put')
}

/** 计划里的 delete 操作 */
export function deleteOpsOf(plan: ApplyPlan): Extract<ApplyOp, { type: 'delete' }>[] {
  return plan.ops.filter((o): o is Extract<ApplyOp, { type: 'delete' }> => o.type === 'delete')
}
