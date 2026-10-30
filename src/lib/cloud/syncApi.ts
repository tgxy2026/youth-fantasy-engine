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
function apiBase(): string {
  const m = typeof window !== 'undefined' ? window.__YFE_PORTABLE__ : null
  if (m && typeof m === 'object' && typeof m.apiBase === 'string' && m.apiBase) return m.apiBase
  return ''
}

export interface CloudProjectState {
  exists: boolean
  revision: number
  snapshotId?: string
  deleted?: boolean
  name?: string
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
export async function probeCloudProject(cloudProjectId: string, base = apiBase()): Promise<CloudProbe> {
  try {
    const res = await fetch(`${base}/api/v2/projects/${encodeURIComponent(cloudProjectId)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (res.status === 404) return { ok: false, reason: 'not-found', status: 404 }
    if (res.status === 401) return { ok: false, reason: 'unauthorized', status: 401 }
    if (!res.ok) return { ok: false, reason: 'server', status: res.status }
    const b = await res.json() as { revision?: number; snapshotId?: string; deleted?: boolean; name?: string }
    return {
      ok: true,
      state: {
        exists: true,
        revision: Number(b.revision) || 0,
        snapshotId: b.snapshotId,
        deleted: !!b.deleted,
        name: b.name,
      },
    }
  } catch {
    return { ok: false, reason: 'network', status: 0 }
  }
}

/** 只取 revision（给自动同步用的便捷函数；查不到返回 null） */
export async function fetchRemoteRevision(cloudProjectId: string, base = apiBase()): Promise<number | null> {
  const p = await probeCloudProject(cloudProjectId, base)
  return p.ok ? p.state.revision : null
}

/** 列出云端作品 */
export async function listCloudProjects(base = apiBase()): Promise<
  Array<{ cloudProjectId: string; name: string; revision: number; updatedAt: number; objectBytes: number; deleted?: boolean }>
> {
  try {
    const res = await fetch(`${base}/api/v2/projects`, { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) return []
    const b = await res.json() as { projects?: unknown }
    return Array.isArray(b.projects) ? b.projects as never : []
  } catch {
    return []
  }
}

/** 新建一本云端作品 */
export async function createCloudProject(
  input: { cloudProjectId?: string; name: string }, base = apiBase(),
): Promise<{ ok: true; cloudProjectId: string; revision: number } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${base}/api/v2/projects`, {
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
  cloudProjectId: string, rev?: number, base = apiBase(),
): Promise<Record<string, unknown> | null> {
  try {
    const q = rev ? `?rev=${rev}` : ''
    const res = await fetch(
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
  cloudProjectId: string, hash: string, base = apiBase(),
): Promise<Uint8Array | null> {
  try {
    const res = await fetch(
      `${base}/api/v2/projects/${encodeURIComponent(cloudProjectId)}/objects/${encodeURIComponent(hash)}`,
      { credentials: 'same-origin', cache: 'no-store' },
    )
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}
