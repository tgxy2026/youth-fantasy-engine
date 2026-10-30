// ============ 3.3.2 · v2 接口的读侧客户端 ============
//
// 写侧在 `sync/projectUploader`（上传对象 + 条件提交），这里补的是**读**：
// 查云端状态、拉清单、下对象、新建云端作品。
//
// 🔴 所有请求带 `credentials: 'same-origin'`：网页版的会话是 httpOnly Cookie，
//    脚本拿不到也不该拿。桌面原生窗口走 `desktopFetch`（Bearer），不在这条路上。
//
// 🔴 网络失败一律返回 `null` / 抛可识别的错误，**不要静默返回空数据**：
//    "云端没有这本书"和"网络没通"在界面上是两句话，混在一起会让用户以为稿子丢了。
import { cookieFetch, type CloudFetch } from '@/lib/cloud/cloudTransport'

function apiBase(): string {
  const m = typeof window !== 'undefined' ? window.__YFE_PORTABLE__ : null
  if (m && typeof m === 'object' && typeof m.apiBase === 'string' && m.apiBase) return m.apiBase
  return ''
}

// ---------------- 请求通道（网页 Cookie / 桌面 Bearer） ----------------
//
// 🔴 默认不配置 = 网页行为逐字节不变（同源 Cookie）。
//    桌面版由 `syncBoot` 在**已登录**时调用 `configureCloudTransport({ base, fetch })`。
// 🔴 base 必须是绝对 origin（桌面页面在本机服务上，同源地址没有 `/api/v2` 路由）。
let activeBase: string | null = null
let activeFetch: CloudFetch | null = null

export function configureCloudTransport(next: { base?: string | null; fetch?: CloudFetch | null } | null): void {
  activeBase = next?.base ?? null
  activeFetch = next?.fetch ?? null
}

function f(): CloudFetch {
  return activeFetch ?? cookieFetch()
}

function baseOf(): string {
  return activeBase ?? apiBase()
}

/**
 * 当前生效的传输与基地址。
 * 🔴 上传编排（`syncClient`）也必须走这两个函数：只改读侧的话，桌面 Bearer 只会覆盖一半请求，
 *    表现为「能查状态、一上传就 401/404」。
 */
export function cloudFetch(): CloudFetch {
  return f()
}
export function cloudBase(): string {
  return baseOf()
}

/** 云端这一版的摘要（章节数 / 创建时间）—— 覆盖前给用户看的依据，不是判定依据 */
export interface CloudVersionSummary {
  createdAt: number
  counts: Record<string, number>
}

export interface CloudProjectState {
  exists: boolean
  revision: number
  snapshotId?: string
  /** 是否在回收站里 */
  deleted?: boolean
  /** 删除时间（服务端事实，用于展示"删除于…"） */
  deletedAt?: number
  name?: string
  /** 当前版本摘要（删除版没有） */
  summary?: CloudVersionSummary | null
}

/** 云端还连得上吗（用来区分"网络问题"与"确实没有"） */
export type CloudProbe =
  | { ok: true; state: CloudProjectState }
  | { ok: false; reason: 'network' | 'unauthorized' | 'not-found' | 'server'; status: number }

/**
 * 查一本云端作品的当前状态。
 *
 * 🔴 404 与"网络断"必须分开：404 说明确实没有（可以重新上传），
 *    网络断说明不知道（这轮别动）。见 `decideSync` 的 `remote-gone`。
 */
export async function probeCloudProject(cloudProjectId: string, base = baseOf()): Promise<CloudProbe> {
  try {
    const res = await f()(`${base}/api/v2/projects/${encodeURIComponent(cloudProjectId)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (res.status === 404) return { ok: false, reason: 'not-found', status: 404 }
    if (res.status === 401) return { ok: false, reason: 'unauthorized', status: 401 }
    if (!res.ok) return { ok: false, reason: 'server', status: res.status }
    const b = await res.json() as {
      revision?: number; snapshotId?: string; deleted?: boolean; deletedAt?: number; name?: string
      summary?: { createdAt?: number; counts?: Record<string, number> } | null
    }
    const sum = b.summary && typeof b.summary === 'object'
      ? {
          createdAt: Number(b.summary.createdAt) || 0,
          counts: (b.summary.counts && typeof b.summary.counts === 'object') ? b.summary.counts : {},
        }
      : null
    return {
      ok: true,
      state: {
        exists: true,
        revision: Number(b.revision) || 0,
        snapshotId: b.snapshotId,
        deleted: !!b.deleted,
        deletedAt: Number(b.deletedAt) || 0,
        name: b.name,
        summary: sum,
      },
    }
  } catch {
    return { ok: false, reason: 'network', status: 0 }
  }
}

/** 只取 revision（给自动同步用的便捷函数；查不到返回 null） */
export async function fetchRemoteRevision(cloudProjectId: string, base = baseOf()): Promise<number | null> {
  const p = await probeCloudProject(cloudProjectId, base)
  return p.ok ? p.state.revision : null
}

/** 列出云端作品 */
export async function listCloudProjects(base = baseOf()): Promise<
  Array<{ cloudProjectId: string; name: string; revision: number; updatedAt: number; objectBytes: number; deleted?: boolean }>
> {
  try {
    const res = await f()(`${base}/api/v2/projects`, { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) return []
    const b = await res.json() as { projects?: unknown }
    return Array.isArray(b.projects) ? b.projects as never : []
  } catch {
    return []
  }
}

/** 新建一本云端作品 */
export async function createCloudProject(
  input: { cloudProjectId?: string; name: string }, base = baseOf(),
): Promise<{ ok: true; cloudProjectId: string; revision: number } | { ok: false; error: string }> {
  try {
    const res = await f()(`${base}/api/v2/projects`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const b = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: String(b.error || `创建失败（HTTP ${res.status}）`) }
    return { ok: true, cloudProjectId: String(b.cloudProjectId || ''), revision: Number(b.revision) || 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '创建失败' }
  }
}

/** 取清单（不传 rev 就是最新） */
export async function fetchManifest(
  cloudProjectId: string, rev?: number, base = baseOf(),
): Promise<Record<string, unknown> | null> {
  try {
    const q = rev ? `?rev=${rev}` : ''
    const res = await f()(
      `${base}/api/v2/projects/${encodeURIComponent(cloudProjectId)}/manifest${q}`,
      { credentials: 'same-origin', cache: 'no-store' },
    )
    if (!res.ok) return null
    return await res.json() as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 下载一个内容对象。
 * @returns 字节；失败返回 null（调用方据此判"内容没下齐"，不要拿半个文件去应用）
 */
export async function downloadObject(
  cloudProjectId: string, hash: string, base = baseOf(),
): Promise<Uint8Array | null> {
  try {
    const res = await f()(
      `${base}/api/v2/projects/${encodeURIComponent(cloudProjectId)}/objects/${encodeURIComponent(hash)}`,
      { credentials: 'same-origin', cache: 'no-store' },
    )
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}

/**
 * 从回收站恢复云端作品。
 *
 * 🔴 服务端会**写一个新 revision**（删除前的最后一个内容版本 → 新版本），不是"倒退回去"：
 *    倒退会让握着删除版基线的离线设备判成云端回滚，甚至用旧基线把别人的版本盖掉。
 * 🔴 恢复后云端 revision 变大，本机绑定里的基线自然落后 —— 客户端该显示"云端有新版本"，
 *    不自动把内容套到本机（原地落地未做）。
 */
export async function restoreCloudProject(
  cloudProjectId: string, opId: string, base = baseOf(),
): Promise<{ ok: true; revision: number; restoredFrom: number } | { ok: false; error: string; code?: string }> {
  try {
    const res = await f()(
      `${base}/api/v2/projects/${encodeURIComponent(cloudProjectId)}/restore?opId=${encodeURIComponent(opId)}`,
      { method: 'POST', credentials: 'same-origin' },
    )
    const b = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        error: String(b.error || `恢复失败（HTTP ${res.status}）`),
        code: b.code ? String(b.code) : undefined,
      }
    }
    return { ok: true, revision: Number(b.revision) || 0, restoredFrom: Number(b.restoredFrom) || 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '恢复失败' }
  }
}

/**
 * 彻底删除云端作品（回收站里的「永久删除」）。
 *
 * 🔴 服务端只允许**已进回收站**的作品走这一步；未删除的会被拒（409）。
 * 🔴 只删项目目录与索引条目，**不删共享对象库** —— 对象交给 GC 按引用回收，
 *    所以"配额立刻释放"与"磁盘空间立刻释放"不是同一时刻。
 */
export async function purgeCloudProject(
  cloudProjectId: string, opId: string, base = baseOf(),
): Promise<{ ok: true; removedBytes: number } | { ok: false; error: string; code?: string }> {
  try {
    const res = await f()(
      `${base}/api/v2/projects/${encodeURIComponent(cloudProjectId)}?purge=1&opId=${encodeURIComponent(opId)}`,
      { method: 'DELETE', credentials: 'same-origin' },
    )
    const b = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        error: String(b.error || `删除失败（HTTP ${res.status}）`),
        code: b.code ? String(b.code) : undefined,
      }
    }
    return { ok: true, removedBytes: Number(b.removedBytes) || 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' }
  }
}
