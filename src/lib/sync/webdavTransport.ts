// WebDAV 直连传输（3.0.2 · 私人网盘 / NAS 同步）
//
// 语义与 FileTransport **完全一致**（同为 SyncTransport）：把「字节怎么落地 / 怎么读回来」
// 与加密、载荷结构、rev 三路合并解耦。差别只在「远端」从「本地同步目录里的 .yfe」换成
// 「WebDAV 服务器上的一个文件」。
//
// 🔴 复用同一套三态口径（见 syncTransport.FileTransport 的注释）：
//   · 404 / 文件不存在 → 安全地视为空库（status 200 + rev 0）
//   · 网络失败 / 认证失败 / 内容损坏 → status 0（上层按「不可用」回退本地，**绝不当空库**）
//   这条纪律是「一次 push 覆盖云端真实数据」的唯一防线，两种传输必须一致。
//
// 🔴 为什么走主进程：WebDAV 服务器几乎都不返回 Access-Control-Allow-Origin，渲染进程直连被拦。
//   故所有请求经 preload 注入的 window.electronStore.webdav → IPC → electron/remoteSync.cjs。
import { SYNC_POLL_MS } from '@/lib/constants'
import type { RawSyncResponse, SyncTransport } from '@/lib/sync/syncTransport'

/** WebDAV 连接参数（由 desktopCloudSync 组装；凭据存 settingsKV，本地专属不入云）。 */
export interface WebdavConfig {
  /** 服务器基址，如 https://dav.jianguoyun.com/dav/ 或 http://192.168.1.10:5005/ */
  baseUrl: string
  /** 远端相对路径（目录 + 文件名），如 yfe/青春幻想引擎-同步数据.yfe */
  remotePath: string
  username: string
  password: string
}

/** preload 注入的 WebDAV 桥（按用到的成员声明最小形状；主进程是 CJS，不在前端 tsconfig 里）。 */
interface ElectronWebdavBridge {
  webdav?(url: string, init: unknown): Promise<unknown>
}

function bridge(): ElectronWebdavBridge | null {
  try {
    // 复用 electronStore 命名空间（与 syncRead/syncWrite 同一桥）
    return (typeof window !== 'undefined' && (window as { electronStore?: ElectronWebdavBridge }).electronStore) || null
  } catch {
    return null
  }
}

type BridgeResult = { ok?: boolean; status?: number; text?: string; error?: string }

async function call(init: Record<string, unknown>): Promise<BridgeResult> {
  const b = bridge()
  if (!b || typeof b.webdav !== 'function') return { ok: false, error: '主进程 WebDAV 桥不可用' }
  try {
    const raw = (await b.webdav(joinUrl(init.baseUrl as string, init.path as string), {
      method: init.method,
      headers: init.headers,
      body: init.body,
      username: init.username,
      password: init.password,
    })) as BridgeResult | undefined
    return raw && typeof raw === 'object' ? raw : { ok: false, error: '主进程未返回结果' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 拼接 baseUrl 与相对路径（都可能是「带/不带尾斜杠」的任意组合）。 */
function joinUrl(base: string, rel: string): string {
  const b = String(base || '').replace(/\/+$/, '')
  const r = String(rel || '').replace(/^\/+/, '')
  return r ? b + '/' + r : b
}

/**
 * WebDAV 直连传输。
 * @param cfg 服务器与凭据；`remotePath` 是**相对 baseUrl** 的完整文件路径。
 */
export function createWebdavTransport(cfg: WebdavConfig): SyncTransport {
  let watchTimer: ReturnType<typeof setInterval> | null = null
  let lastSeenRev = -1
  let quarantined = false

  type ParsedRev = { rev: number; enc: string | null } | { corrupt: true }

  function parseRev(text: string | null | undefined): ParsedRev {
    // 空 / 不存在 → 空库；存在却解析不了 → 明确 corrupt（**不退化成 rev=0**）
    if (text == null || !String(text).trim()) return { rev: 0, enc: null }
    try {
      const o = JSON.parse(String(text))
      return { rev: Number(o.rev) || 0, enc: o.enc ?? null }
    } catch {
      return { corrupt: true }
    }
  }

  /** 拉一次远端：{ ok:true, text } / { ok:true, text:null }（不存在）/ { ok:false }（失败/认证） */
  async function fetchRemote(): Promise<{ ok: true; text: string | null } | { ok: false; reason: string; auth?: boolean }> {
    const r = await call({ baseUrl: cfg.baseUrl, path: cfg.remotePath, method: 'GET', username: cfg.username, password: cfg.password })
    if (!r.ok) return { ok: false, reason: r.error || '请求失败', auth: r.status === 401 || r.status === 403 }
    const status = Number(r.status) || 0
    if (status === 404 || status === 204) return { ok: true, text: null }
    if (status >= 400) return { ok: false, reason: 'HTTP ' + status, auth: status === 401 || status === 403 }
    return { ok: true, text: r.text ?? '' }
  }

  let quarantinedOnce = false
  async function quarantine(text: string): Promise<void> {
    if (quarantinedOnce || quarantined) return
    quarantinedOnce = true
    quarantined = true
    try {
      const stamp = Date.now()
      const qPath = cfg.remotePath + '.corrupt-' + stamp
      await call({ baseUrl: cfg.baseUrl, path: qPath, method: 'PUT', body: text, username: cfg.username, password: cfg.password })
      console.warn('[sync] 远端同步文件无法解析，已另存备份并暂停写入以免覆盖云端数据：' + qPath)
    } catch (e) {
      console.warn('[sync] 损坏远端同步文件备份失败：', e)
    }
  }

  return {
    mode: 'file',
    setCode() {
      // WebDAV 固定远端路径（由 config 决定槽位）；换码不改变远端文件，仅重置隔离状态
      quarantined = false
      quarantinedOnce = false
    },
    async pull(): Promise<RawSyncResponse> {
      const r = await fetchRemote()
      if (!r.ok) return { status: 0 } // 网络失败 / 认证失败 → 不可用（上层回退本地），绝不当空库
      const p = parseRev(r.text)
      if ('corrupt' in p) {
        await quarantine(r.text ?? '')
        return { status: 0 }
      }
      return { status: 200, rev: p.rev, enc: p.enc }
    },
    async push(baseRev: number, enc: string): Promise<RawSyncResponse> {
      const r = await fetchRemote()
      if (!r.ok) return { status: 0 } // 读不到远端当前状态就不敢写，宁可报不可用
      const cur = parseRev(r.text)
      if ('corrupt' in cur) {
        await quarantine(r.text ?? '')
        return { status: 0 }
      }
      if (cur.rev > baseRev) return { status: 409, rev: cur.rev, enc: cur.enc }
      const newRev = baseRev + 1
      const put = await call({
        baseUrl: cfg.baseUrl, path: cfg.remotePath, method: 'PUT',
        body: JSON.stringify({ rev: newRev, enc }),
        headers: { 'Content-Type': 'application/json' },
        username: cfg.username, password: cfg.password,
      })
      if (!put.ok) return { status: 0 }
      const st = Number(put.status) || 0
      // WebDAV PUT 成功：200 OK / 201 Created / 204 No Content（不同服务商不同）
      if (st >= 400) return { status: 0 }
      lastSeenRev = newRev
      // 写后回读校验：被他人中途覆盖（竞态）时按冲突处理，触发上层合并重试
      const after = await fetchRemote()
      if (!after.ok) return { status: 0 }
      const a = parseRev(after.text)
      if ('corrupt' in a) return { status: 0 }
      if (a.rev !== newRev) return { status: 409, rev: a.rev, enc: a.enc }
      return { status: 200, rev: newRev }
    },
    startWatch(onRemoteChange: () => void) {
      this.stopWatch()
      watchTimer = setInterval(async () => {
        const r = await fetchRemote()
        if (!r.ok) return // 读失败：本轮跳过，绝不更新 lastSeenRev
        const p = parseRev(r.text)
        if ('corrupt' in p) {
          await quarantine(r.text ?? '')
          return
        }
        const rev = p.rev
        if (rev !== lastSeenRev) {
          lastSeenRev = rev
          if (rev !== 0) onRemoteChange()
        }
      }, SYNC_POLL_MS)
    },
    stopWatch() {
      if (watchTimer) {
        clearInterval(watchTimer)
        watchTimer = null
      }
    },
  }
}

/**
 * 测试 WebDAV 连接（UI「测试连接」按钮用）：
 * 先 PROPFIND 探目录，再对目标文件做一次 GET —— 返回可读的结论。
 */
export async function testWebdav(cfg: WebdavConfig): Promise<{ ok: boolean; message: string }> {
  // ① 探文件是否已存在（HEAD/PROPFIND 语义）：GET 一次即可，404 = 服务器正常但文件还没建
  const r = await call({ baseUrl: cfg.baseUrl, path: cfg.remotePath, method: 'GET', username: cfg.username, password: cfg.password })
  if (r.ok) {
    const st = Number(r.status) || 0
    if (st === 401 || st === 403) return { ok: false, message: '认证失败（HTTP ' + st + '）：请检查用户名 / 密码' }
    if (st === 404 || st === 204) return { ok: true, message: '连接成功：服务器可达、凭据有效（远端暂无同步文件，首次同步会自动创建）' }
    if (st >= 400) return { ok: false, message: '服务器返回 HTTP ' + st + '：请检查地址与目录权限' }
    return { ok: true, message: '连接成功：已发现远端同步文件（可继续）' }
  }
  const st = Number(r.status) || 0
  if (st === 401 || st === 403) return { ok: false, message: '认证失败（HTTP ' + st + '）：请检查用户名 / 密码' }
  return { ok: false, message: '无法连接：' + (r.error || '请检查地址 / 网络 / 密码') }
}
