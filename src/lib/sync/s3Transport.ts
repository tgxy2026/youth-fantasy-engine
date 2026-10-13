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
import { SYNC_POLL_MS } from '@/lib/constants'
import type { RawSyncResponse, SyncTransport } from '@/lib/sync/syncTransport'

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

async function callS3(cfg: S3Config, method: string, body?: string | null): Promise<BridgeResult> {
  const b = bridge()
  if (!b || typeof b.s3 !== 'function') return { ok: false, error: '主进程 S3 桥不可用' }
  try {
    const raw = (await b.s3({
      endpoint: cfg.endpoint, path: objectPath(cfg), method,
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

export function createS3Transport(cfg: S3Config): SyncTransport {
  let watchTimer: ReturnType<typeof setInterval> | null = null
  let lastSeenRev = -1
  let quarantined = false

  type ParsedRev = { rev: number; enc: string | null } | { corrupt: true }

  function parseRev(text: string | null | undefined): ParsedRev {
    if (text == null || !String(text).trim()) return { rev: 0, enc: null }
    try {
      const o = JSON.parse(String(text))
      return { rev: Number(o.rev) || 0, enc: o.enc ?? null }
    } catch {
      return { corrupt: true }
    }
  }

  let quarantinedOnce = false
  async function quarantine(text: string): Promise<void> {
    if (quarantinedOnce || quarantined) return
    quarantinedOnce = true
    quarantined = true
    try {
      const qKey = cfg.objectKey + '.corrupt-' + Date.now()
      const b = bridge()
      const raw = (await b?.s3?.({
        endpoint: cfg.endpoint, path: cfg.style === 'virtual' ? '/' + qKey : '/' + cfg.bucket + '/' + qKey,
        method: 'PUT', body: text, bucket: cfg.bucket, style: cfg.style || 'path',
        accessKey: cfg.accessKey, secretKey: cfg.secretKey, region: cfg.region,
        trustSelfSigned: cfg.trustSelfSigned === true,
      })) as BridgeResult | undefined
      if (raw && raw.ok) console.warn('[sync] 远端同步对象无法解析，已另存备份并暂停写入以免覆盖云端数据：' + qKey)
    } catch (e) {
      console.warn('[sync] 损坏远端对象备份失败：', e)
    }
  }

  return {
    mode: 'file',
    setCode() {
      quarantined = false
      quarantinedOnce = false
    },
    async pull(): Promise<RawSyncResponse> {
      const r = await callS3(cfg, 'GET')
      if (!r.ok) return { status: 0 }
      const st = Number(r.status) || 0
      if (st === 404) return { status: 200, rev: 0, enc: null } // 对象不存在 → 空库
      if (st >= 400) return { status: 0 }
      const p = parseRev(r.text)
      if ('corrupt' in p) {
        await quarantine(r.text ?? '')
        return { status: 0 }
      }
      return { status: 200, rev: p.rev, enc: p.enc }
    },
    async push(baseRev: number, enc: string): Promise<RawSyncResponse> {
      const r = await callS3(cfg, 'GET')
      if (!r.ok) return { status: 0 }
      const gst = Number(r.status) || 0
      if (gst >= 400 && gst !== 404) return { status: 0 } // 认证失败等 → 不敢写
      const cur = parseRev(gst === 404 ? null : r.text)
      if ('corrupt' in cur) {
        await quarantine(r.text ?? '')
        return { status: 0 }
      }
      if (cur.rev > baseRev) return { status: 409, rev: cur.rev, enc: cur.enc }
      const newRev = baseRev + 1
      const put = await callS3(cfg, 'PUT', JSON.stringify({ rev: newRev, enc }))
      if (!put.ok) return { status: 0 }
      const pst = Number(put.status) || 0
      if (pst >= 400) return { status: 0 }
      lastSeenRev = newRev
      const after = await callS3(cfg, 'GET')
      if (!after.ok) return { status: 0 }
      const ast = Number(after.status) || 0
      if (ast >= 400) return { status: 0 }
      const a = parseRev(after.text)
      if ('corrupt' in a) return { status: 0 }
      if (a.rev !== newRev) return { status: 409, rev: a.rev, enc: a.enc }
      return { status: 200, rev: newRev }
    },
    startWatch(onRemoteChange: () => void) {
      this.stopWatch()
      watchTimer = setInterval(async () => {
        const r = await callS3(cfg, 'GET')
        if (!r.ok) return
        const st = Number(r.status) || 0
        if (st >= 400 && st !== 404) return
        const p = parseRev(st === 404 ? null : r.text)
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
