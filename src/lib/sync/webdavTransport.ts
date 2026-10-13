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
//
// 🔴 2026-10-13 六维审计（arch A2）：三态骨架 / rev 比对 / 隔离 / 轮询**已抽到**
//   `syncRemoteCore.ts` —— 与 S3 传输逐字同构的那 50 余行收成一处，本文件只留
//   「WebDAV 怎么读写远端」这三个原语（URL 拼接、状态码语义、桥调用）。
import { createRemoteSyncTransport } from '@/lib/sync/syncRemoteCore'
import type { SyncTransport } from '@/lib/sync/syncTransport'

/** WebDAV 连接参数（由 desktopCloudSync 组装；凭据存 localStorage，本机专属不入云）。 */
export interface WebdavConfig {
  /** 服务器基址，如 https://dav.jianguoyun.com/dav/ 或 http://192.168.1.10:5005/ */
  baseUrl: string
  /** 远端相对路径（目录 + 文件名），如 yfe/青春幻想引擎-同步数据.yfe */
  remotePath: string
  username: string
  password: string
  /**
   * 🔴 信任自签证书（默认关）：自建 NAS（群晖 / 威联通 / 极空间）常用自签证书，
   * 打开后本传输层会请主进程放行「证书链不受信」这类错误（详见 electron/remoteSync.cjs）。
   * 这是**安全取舍**：只对本功能生效、其余流量不受影响，且主机名不符 / 已吊销 / 过期仍会拒绝。
   */
  trustSelfSigned?: boolean
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
      // 🔴 逐请求显式授权：开关关时传 false，主进程保持系统严格校验
      trustSelfSigned: init.trustSelfSigned === true,
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

/** 对指定远端路径发一次请求（带凭据与自签授权） */
function callPath(cfg: WebdavConfig, path: string, method: string, body?: string | null): Promise<BridgeResult> {
  return call({
    baseUrl: cfg.baseUrl, path, method, body,
    username: cfg.username, password: cfg.password, trustSelfSigned: cfg.trustSelfSigned,
  })
}

/**
 * WebDAV 直连传输。
 * @param cfg 服务器与凭据；`remotePath` 是**相对 baseUrl** 的完整文件路径。
 */
export function createWebdavTransport(cfg: WebdavConfig): SyncTransport {
  return createRemoteSyncTransport({
    /**
     * 读远端。
     * 🔴 WebDAV 特有：**204 No Content 也当「没有内容」**（部分服务商对空文件回 204），
     *    而 404 是标准的"不存在" —— 两者都安全地视为空库；其余 4xx/5xx 一律按"读失败"。
     */
    async read() {
      const r = await callPath(cfg, cfg.remotePath, 'GET')
      if (!r.ok) return { ok: false }
      const st = Number(r.status) || 0
      if (st === 404 || st === 204) return { ok: true, text: null }
      if (st >= 400) return { ok: false }
      return { ok: true, text: r.text ?? '' }
    },
    /**
     * 写远端。
     * 🔴 WebDAV PUT 成功码有 200 / 201 / 204 三种（不同服务商不同）⇒ 只判"非 4xx/5xx"。
     */
    async write(text) {
      const put = await callPath(cfg, cfg.remotePath, 'PUT', text)
      if (!put.ok) return false
      return (Number(put.status) || 0) < 400
    },
    /** 隔离损坏内容：另存到 `<remotePath>.corrupt-<stamp>` */
    async quarantine(text) {
      const qPath = cfg.remotePath + '.corrupt-' + Date.now()
      // ⚠️ 与 S3 侧口径统一（2026-10-13 抽公共时顺手修正）：原先这里**无条件**打印
      //    「已另存备份」，即使 PUT 实际失败 —— 日志会骗人。现在按真实结果打印。
      const r = await callPath(cfg, qPath, 'PUT', text)
      if (r.ok && (Number(r.status) || 0) < 400) {
        console.warn('[sync] 远端同步文件无法解析，已另存备份并暂停写入以免覆盖云端数据：' + qPath)
      } else {
        console.warn('[sync] 损坏远端同步文件备份失败：' + (r.error || 'HTTP ' + (Number(r.status) || 0)))
      }
    },
  })
}

/**
 * 测试 WebDAV 连接（UI「测试连接」按钮用）：
 * 先 PROPFIND 探目录，再对目标文件做一次 GET —— 返回可读的结论。
 */
export async function testWebdav(cfg: WebdavConfig): Promise<{ ok: boolean; message: string }> {
  // ① 探文件是否已存在（HEAD/PROPFIND 语义）：GET 一次即可，404 = 服务器正常但文件还没建
  const r = await callPath(cfg, cfg.remotePath, 'GET')
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
