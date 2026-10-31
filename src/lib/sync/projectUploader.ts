// ============ 3.3.2 · P2-7 上传编排 ============
//
// 【它补的是哪一段】`projectSnapshot` 只负责「算出要传什么」，`/api/v2` 只负责「收一个对象」。
// 中间这段——先传对象、再提交清单、失败重试、把服务端结果翻译成四种结局——一直没人写。
// 没有它，快照算得再对也上不去。
//
// 🔴 顺序不能反：**对象全部就位才提交**。先提交后补对象会让云端出现一个指向空气的版本，
//    读者（另一台设备）拉到清单却下不到内容，只能判成"损坏"。
//
// 🔴 重试只对「可能自己会好」的错误做：网络中断、5xx、超时。
//    409（基线不符）/413（配额）/400（哈希不符、对象缺失）重试一万次也不会好，
//    只会把用户的电量与服务器的连接数耗光。
//
// 🔴 这一层不做状态持久化：队列在 `P3 客户端同步核心`（持久待同步队列 + 崩溃恢复）。
//    本模块是**无状态的单次尝试**，好测、也能被队列反复调用。
import type { BuiltSnapshot, SnapshotObject, SnapshotAsset } from '@/lib/sync/projectSnapshot'

/** 提交结局：调用方据此决定「显示已同步 / 进冲突 / 提示空间不足 / 重试」 */
export type UploadOutcome =
  | { ok: true; status: 'published'; revision: number; snapshotId: string }
  | { ok: true; status: 'replayed'; revision: number; snapshotId: string }
  | { ok: false; status: 'conflict'; revision: number }
  | { ok: false; status: 'quota'; usedBytes?: number; quotaBytes?: number }
  | { ok: false; status: 'error'; code: string; message: string; retryable: boolean }

/** 传输层：由调用方注入（浏览器 fetch / 桌面 HTTP / 测试里的假实现） */
export interface UploadTransport {
  /** 上传一个内容对象；服务端按哈希去重，重复上传应返回 reused:true 而非报错 */
  putObject(cloudProjectId: string, hash: string, bytes: Uint8Array): Promise<{ ok: boolean; code?: string }>
  /** 条件提交 */
  commit(cloudProjectId: string, body: {
    opId: string
    baseRevision: number
    manifest: unknown
  }): Promise<{
    ok: boolean
    status: number
    code?: string
    revision?: number
    snapshotId?: string
    replayed?: boolean
    usedBytes?: number
    quotaBytes?: number
    message?: string
  }>
}

export interface UploadOptions {
  cloudProjectId: string
  built: BuiltSnapshot
  baseRevision: number
  opId: string
  transport: UploadTransport
  /** 网络/5xx 的重试次数（不含首次） */
  retries?: number
  /** 退避基数（ms）：第 n 次重试等 base * 2^n，测试里注入 0 */
  backoffMs?: number
  /** 注入 sleep，测试里用立即返回 */
  sleep?: (ms: number) => Promise<void>
  /** 进度回调：UI 用它显示「正在上传 3/17」 */
  onProgress?: (done: number, total: number) => void
  /**
   * 云端**基线版本已包含**的对象哈希。这些不必再传。
   *
   * 🔴 为什么必须有：内容寻址不跳过就等于「每 20 秒重传整本书」——
   *    改一个字触发自动同步，40 MiB 的含图作品就再走一遍 40 MiB 上行。
   *    实测（2026-10-31 实机）：一次推送里同一个哈希被 PUT 了 5 次
   *    （11 个分片里有 5 个是空数组、内容相同），更要按哈希去重。
   *
   * 来源必须是**服务端回来的清单**（`GET manifest?rev=baseRevision`），不能是本地缓存：
   * 对象可能被回收或换了账号。真出现「以为有、其实没有」，服务端会回 OBJECT_MISSING，
   * 那时会自动补传一轮（见下方 `uploadSnapshot`）。
   */
  knownHashes?: ReadonlySet<string>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** dataURL → 字节（与服务端 stageObject 的校验口径一致：它按这些字节算哈希） */
function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const m = /^data:([^;,]+)?(;base64)?,/.exec(dataUrl || '')
  if (!m || !m[2]) return null
  try {
    const bin = atob(dataUrl.slice(m[0].length))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** 一个结果是否需要重试：网络异常 / 5xx / 限流 */
function isRetryable(r: { ok: boolean; status?: number; code?: string }): boolean {
  if (r.ok) return false
  const s = r.status ?? 0
  if (s >= 500 || s === 429) return true
  // 🔴 只有明确的网络类 code 才算可重试。不能把「status 缺失」一律当成可重试：
  //    哈希不符、格式非法这类 4xx 也常常没有 status，重试一万次也不会好，
  //    只会把用户的电量和服务器连接数耗光（这条是单测第 7 条抓出来的）。
  return r.code === 'NETWORK' || r.code === 'TIMEOUT' || r.code === 'ECONNRESET'
}

/**
 * 上传一份快照。
 *
 * @returns 四种结局之一；**不抛异常**（网络异常会被翻译成 status:'error'），
 *   因为调用方是「队列」，抛异常会逼它包一层 try/catch 并容易漏掉重试标记。
 */
export async function uploadSnapshot(opts: UploadOptions): Promise<UploadOutcome> {
  const known = opts.knownHashes ?? EMPTY_HASHES
  const first = await runUpload(opts, known)
  // 服务端判定「对象缺失」⇒ 我们以为云端已有的那批不成立（被回收 / 换了账号 / 残留记录）。
  // 这时**补传一轮、一个都不跳**；只补这一次，避免把 4xx 变成无限重试。
  if (!first.ok && first.status === 'error' && first.code === 'OBJECT_MISSING' && known.size > 0) {
    return runUpload(opts, EMPTY_HASHES)
  }
  return first
}

const EMPTY_HASHES: ReadonlySet<string> = new Set<string>()

async function runUpload(opts: UploadOptions, knownHashes: ReadonlySet<string>): Promise<UploadOutcome> {
  const {
    cloudProjectId, built, baseRevision, opId, transport,
    retries = 2, backoffMs = 400, sleep = defaultSleep, onProgress,
  } = opts

  const objects: SnapshotObject[] = built.objects
  const assets: SnapshotAsset[] = built.assets
  const total = objects.length + assets.length
  let done = 0
  // 已确定在云端的哈希：基线清单里的 + 本轮传成功的。同一个哈希只发一次。
  const have = new Set<string>(knownHashes)

  /** 带重试地上传一批字节；返回 null 表示「重试完仍失败」或「云端已有、跳过」 */
  const push = async (hash: string, bytes: Uint8Array, label: string): Promise<UploadOutcome | null> => {
    if (have.has(hash)) {
      // 跳过也要推进进度，否则界面停在「3/17」不动，用户以为卡住了
      done++
      onProgress?.(done, total)
      return null
    }
    let attempt = 0
    for (;;) {
      let r: { ok: boolean; code?: string }
      try {
        r = await transport.putObject(cloudProjectId, hash, bytes)
      } catch (e) {
        r = { ok: false, code: 'NETWORK' }
        void e
      }
      if (r.ok) {
        have.add(hash)
        done++
        onProgress?.(done, total)
        return null
      }
      if (!isRetryable({ ok: r.ok, code: r.code }) || attempt >= retries) {
        return {
          ok: false, status: 'error', code: r.code || 'UPLOAD_FAILED',
          message: `${label}上传失败${r.code ? `（${r.code}）` : ''}`, retryable: isRetryable({ ok: r.ok, code: r.code }),
        }
      }
      attempt++
      await sleep(backoffMs * 2 ** (attempt - 1))
    }
  }

  // ① 先传资源（图片），再传文本对象：图片大、更容易在网络抖动里失败，早点暴露
  for (const a of assets) {
    const bytes = dataUrlBytes(a.dataUrl)
    if (!bytes) {
      // 快照生成阶段应已过滤掉非法 dataURL；走到这里说明上游有 bug，宁可停下也不传半张图
      return { ok: false, status: 'error', code: 'ASSET_DECODE_FAILED', message: '有图片无法解码，本次未提交', retryable: false }
    }
    const bad = await push(a.hash, bytes, '图片')
    if (bad) return bad
  }

  // ② 再传文本对象
  for (const o of objects) {
    const bad = await push(o.hash, toBytes(o.payload), `${o.kind} `)
    if (bad) return bad
  }

  // ③ 全部就位才提交
  let attempt = 0
  for (;;) {
    let r: Awaited<ReturnType<UploadTransport['commit']>>
    try {
      r = await transport.commit(cloudProjectId, { opId, baseRevision, manifest: built.manifest })
    } catch {
      r = { ok: false, status: 0, code: 'NETWORK' }
    }
    if (r.ok) {
      return {
        ok: true,
        status: r.replayed ? 'replayed' : 'published',
        revision: r.revision ?? 0,
        snapshotId: r.snapshotId ?? '',
      }
    }
    if (r.status === 409 && r.code === 'BASELINE_MISMATCH') {
      return { ok: false, status: 'conflict', revision: r.revision ?? 0 }
    }
    if (r.status === 413 || r.code === 'QUOTA_EXCEEDED') {
      return { ok: false, status: 'quota', usedBytes: r.usedBytes, quotaBytes: r.quotaBytes }
    }
    if (!isRetryable(r) || attempt >= retries) {
      return {
        ok: false, status: 'error', code: r.code || 'COMMIT_FAILED',
        message: r.message || '提交失败', retryable: isRetryable(r),
      }
    }
    attempt++
    await sleep(backoffMs * 2 ** (attempt - 1))
  }
}
