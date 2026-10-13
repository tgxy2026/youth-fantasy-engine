// S3 兼容直连传输（3.0.2 · 私人网盘 / NAS 同步）
//
// 面向「S3 兼容对象存储」：MinIO（自建 NAS）、Cloudflare R2、阿里云 OSS、腾讯云 COS、
// 七牛、Backblaze B2 等 —— 它们在 S3 协议这一层互通，故一套实现全覆盖。
//
// 语义与 FileTransport / WebdavTransport **完全一致**（同 SyncTransport 三态口径）：
//   404 → 空库；网络失败 / 认证失败 / 损坏 → status 0（绝不当空库）。
//
// 签名：由主进程 electron/remoteSync.cjs 的 signS3 完成（AWS SigV4）；
//      渲染层只负责组装 { endpoint, path, method, body, 凭据 }，凭据不落盘。
//
// 🔴 2026-10-13 六维审计（arch A2）：三态骨架 / rev 比对 / 隔离 / 轮询**已抽到**
//   `syncRemoteCore.ts` —— 与 WebDAV 传输逐字同构的那 50 余行收成一处，本文件只留
//   「S3 怎么读写远端」这三个原语（对象路径拼装、状态码语义、桥调用）。
import { createRemoteSyncTransport } from '@/lib/sync/syncRemoteCore'
import type { SyncTransport } from '@/lib/sync/syncTransport'

export interface S3Config {
  /** 端点，如 https://s3.us-east-1.amazonaws.com 或 http://192.168.1.10:9000（MinIO） */
  endpoint: string
  /** 存储桶名 */
  bucket: string
  /** 远端对象键（含前缀），如 yfe/青春幻想引擎-同步数据.yfe */
  objectKey: string
  region: string
  accessKey: string
  secretKey: string
  /** path 风格（MinIO 常用）或 virtual 风格（AWS 常用，bucket 作子域） */
  style?: 'path' | 'virtual'
  /**
   * 🔴 信任自签证书（默认关）：自建 MinIO / NAS 常用自签证书，打开后本传输层会请主进程
   * 放行「证书链不受信」这类错误（详见 electron/remoteSync.cjs）。属安全取舍，边界同 WebDAV。
   */
  trustSelfSigned?: boolean
}

interface ElectronS3Bridge {
  s3?(spec: unknown): Promise<unknown>
}

function bridge(): ElectronS3Bridge | null {
  try {
    return (typeof window !== 'undefined' && (window as { electronStore?: ElectronS3Bridge }).electronStore) || null
  } catch {
    return null
  }
}

type BridgeResult = { ok?: boolean; status?: number; text?: string; error?: string }

/** 对象存储 key 里允许的前缀斜杠需保留（SigV4 路径按段编码）；组装成 path 风格路径 */
function objectPath(cfg: S3Config): string {
  const key = String(cfg.objectKey || '').replace(/^\/+/, '')
  // path 风格：/bucket/key；virtual 风格：/key（bucket 进 host）
  return cfg.style === 'virtual' ? '/' + key : '/' + String(cfg.bucket || '').replace(/^\/+|\/+$/g, '') + '/' + key
}

/** 对指定对象路径发一次请求（SigV4 由主进程签） */
async function callS3Path(cfg: S3Config, path: string, method: string, body?: string | null): Promise<BridgeResult> {
  const b = bridge()
  if (!b || typeof b.s3 !== 'function') return { ok: false, error: '主进程 S3 桥不可用' }
  try {
    const raw = (await b.s3({
      endpoint: cfg.endpoint, path, method,
      body: body == null ? null : body,
      bucket: cfg.bucket, style: cfg.style || 'path',
      accessKey: cfg.accessKey, secretKey: cfg.secretKey, region: cfg.region,
      // 🔴 逐请求显式授权：开关关时传 false，主进程保持系统严格校验
      trustSelfSigned: cfg.trustSelfSigned === true,
    })) as BridgeResult | undefined
    return raw && typeof raw === 'object' ? raw : { ok: false, error: '主进程未返回结果' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function callS3(cfg: S3Config, method: string, body?: string | null): Promise<BridgeResult> {
  return callS3Path(cfg, objectPath(cfg), method, body)
}

/**
 * S3 兼容直连传输。
 *
 * 🔴 与 WebDAV 的**唯一语义差别**在状态码口径：S3 只把 **404** 当"对象不存在"
 *    （没有 204 那一路），其余 4xx/5xx 一律按"读失败" —— 见下面 read 原语。
 */
export function createS3Transport(cfg: S3Config): SyncTransport {
  return createRemoteSyncTransport({
    /** 读远端：404 → 空库；其余非 2xx → 读失败（认证失败等**绝不当空库**） */
    async read() {
      const r = await callS3(cfg, 'GET')
      if (!r.ok) return { ok: false }
      const st = Number(r.status) || 0
      if (st === 404) return { ok: true, text: null }
      if (st >= 400) return { ok: false }
      return { ok: true, text: r.text ?? '' }
    },
    /** 写远端：PUT 后判状态码（非 4xx/5xx 视为成功） */
    async write(text) {
      const put = await callS3(cfg, 'PUT', text)
      if (!put.ok) return false
      return (Number(put.status) || 0) < 400
    },
    /** 隔离损坏内容：另存到 `<objectKey>.corrupt-<stamp>` */
    async quarantine(text) {
      const qKey = cfg.objectKey + '.corrupt-' + Date.now()
      const qPath = cfg.style === 'virtual' ? '/' + qKey : '/' + cfg.bucket + '/' + qKey
      const raw = await callS3Path(cfg, qPath, 'PUT', text)
      if (raw.ok) {
        console.warn('[sync] 远端同步对象无法解析，已另存备份并暂停写入以免覆盖云端数据：' + qKey)
      } else {
        console.warn('[sync] 损坏远端对象备份失败：' + (raw.error || 'HTTP ' + (Number(raw.status) || 0)))
      }
    },
  })
}

/** 测试 S3 连接：GET 一次对象（404 = 服务器与签名都正常，只是还没同步过）。 */
export async function testS3(cfg: S3Config): Promise<{ ok: boolean; message: string }> {
  const r = await callS3(cfg, 'GET')
  const st = Number(r.status) || 0
  if (st === 401 || st === 403) return { ok: false, message: '认证失败（HTTP ' + st + '）：请检查 AccessKey / SecretKey / Region' }
  if (st === 404) return { ok: true, message: '连接成功：端点可达、签名有效（远端暂无同步对象，首次同步会自动创建）' }
  if (r.ok && st < 400) return { ok: true, message: '连接成功：已发现远端同步对象（可继续）' }
  if (!r.ok && !st) return { ok: false, message: '无法连接：' + (r.error || '请检查地址 / 网络') }
  return { ok: false, message: '服务器返回 HTTP ' + st + '：请检查桶名 / 区域 / 权限' }
}
