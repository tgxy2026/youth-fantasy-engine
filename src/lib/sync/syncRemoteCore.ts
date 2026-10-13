// ============ 远端同步 · 协议无关引擎（2026-10-13 六维审计 · arch A2 抽公共）============
//
// WebDAV 直连与 S3 兼容直连（3.0.2 新增）的**三态口径 / rev 比对 / 损坏隔离 / 轮询**
// 逐字同构，差别只在「怎么读写远端」这几个原语。原先两份实现各写一遍 ——
// 而这段骨架承载的正是那条唯一防线：
//
//   · 404 / 不存在 → **安全地**视为空库（status 200 + rev 0）
//   · 网络失败 / 认证失败 / 内容损坏 → status 0（上层按「不可用」回退本地，**绝不当空库**）
//
// 🔴 为什么必须收成一处：这条纪律若在两端各写一遍，改一处漏一处的后果是
//    「某一次 push 把云端真实数据覆盖成空库」—— 静默且不可逆。收成一处后，
//    `tests/privateCloudSync.test.ts` 的三态断言只需盯住**这一份**（原先要盯两份）。
//
// ⚠️ 协议侧只提供 {@link RemotePrimitives} 三个原语；**协议差异全部留在原语里**：
//    WebDAV 有 204 / 需要拼 URL；S3 有 bucket / style / SigV4 签名。引擎不关心这些。
import { SYNC_POLL_MS } from '@/lib/constants'
import type { RawSyncResponse, SyncTransport } from '@/lib/sync/syncTransport'

/**
 * 一次远端读的结果。
 * 🔴 **必须**把「不存在」与「读失败」分开上报 —— 合成一个 null 就是「一次 push 覆盖云端」的起点。
 *   · `{ ok: true, text: null }` = 远端还没有这个对象（安全视为空库）
 *   · `{ ok: false }`            = 读不到（网络 / 认证 / 5xx）→ 上层按不可用处理
 */
export type RemoteRead = { ok: true; text: string | null } | { ok: false }

/** 协议侧要实现的原语（每个协议的差异都收在这里） */
export interface RemotePrimitives {
  /** 读远端当前内容（不存在 → `text: null`；读失败 → `ok: false`） */
  read(): Promise<RemoteRead>
  /** 写远端（PUT）。返回是否成功（非 2xx 一律 false） */
  write(text: string): Promise<boolean>
  /**
   * 把**解析不了**的远端内容另存到隔离路径（如 `<path>.corrupt-<stamp>`）。
   * 🔴 实现**不得抛**：隔离失败只该留日志 —— 它的意义是"别让损坏内容被覆盖"，不是让本次同步崩。
   */
  quarantine(text: string): Promise<void>
}

/** 远端 rev 载荷的解析结果（`corrupt` 表示"存在但解析不了"，**不能退化成 rev=0**） */
type ParsedRev = { rev: number; enc: string | null } | { corrupt: true }

/** 解析远端载荷。空 / 不存在 → 空库；存在却解析不了 → 明确 corrupt */
function parseRev(text: string | null | undefined): ParsedRev {
  if (text == null || !String(text).trim()) return { rev: 0, enc: null }
  try {
    const o = JSON.parse(String(text))
    return { rev: Number(o.rev) || 0, enc: o.enc ?? null }
  } catch {
    return { corrupt: true }
  }
}

/**
 * 由原语组装出一个完整的 {@link SyncTransport}。
 *
 * 与 `syncTransport.ts` 的 `FileTransport`（本地同步目录）语义**完全一致** —— 三者可互换。
 */
export function createRemoteSyncTransport(p: RemotePrimitives): SyncTransport {
  let watchTimer: ReturnType<typeof setInterval> | null = null
  let lastSeenRev = -1
  let quarantined = false
  let quarantinedOnce = false

  /** 隔离**只做一次**（一次会话里同一份损坏内容不反复另存，避免把远端刷满） */
  async function quarantineOnce(text: string): Promise<void> {
    if (quarantinedOnce || quarantined) return
    quarantinedOnce = true
    quarantined = true
    await p.quarantine(text)
  }

  return {
    mode: 'file',
    setCode() {
      // 远端路径由各协议配置决定槽位；换码不改变远端对象，仅重置隔离状态
      quarantined = false
      quarantinedOnce = false
    },
    async pull(): Promise<RawSyncResponse> {
      const r = await p.read()
      if (!r.ok) return { status: 0 } // 网络失败 / 认证失败 → 不可用（上层回退本地），绝不当空库
      const parsed = parseRev(r.text)
      if ('corrupt' in parsed) {
        await quarantineOnce(r.text ?? '')
        return { status: 0 }
      }
      return { status: 200, rev: parsed.rev, enc: parsed.enc }
    },
    async push(baseRev: number, enc: string): Promise<RawSyncResponse> {
      const r = await p.read()
      if (!r.ok) return { status: 0 } // 读不到远端当前状态就不敢写，宁可报不可用
      const cur = parseRev(r.text)
      if ('corrupt' in cur) {
        await quarantineOnce(r.text ?? '')
        return { status: 0 }
      }
      if (cur.rev > baseRev) return { status: 409, rev: cur.rev, enc: cur.enc }
      const newRev = baseRev + 1
      const wrote = await p.write(JSON.stringify({ rev: newRev, enc }))
      if (!wrote) return { status: 0 }
      lastSeenRev = newRev
      // 写后回读校验：被他人中途覆盖（竞态）时按冲突处理，触发上层合并重试
      const after = await p.read()
      if (!after.ok) return { status: 0 }
      const a = parseRev(after.text)
      if ('corrupt' in a) return { status: 0 }
      if (a.rev !== newRev) return { status: 409, rev: a.rev, enc: a.enc }
      return { status: 200, rev: newRev }
    },
    startWatch(onRemoteChange: () => void) {
      this.stopWatch()
      watchTimer = setInterval(async () => {
        const r = await p.read()
        if (!r.ok) return // 读失败：本轮跳过，绝不更新 lastSeenRev
        const parsed = parseRev(r.text)
        if ('corrupt' in parsed) {
          await quarantineOnce(r.text ?? '')
          return
        }
        if (parsed.rev !== lastSeenRev) {
          lastSeenRev = parsed.rev
          if (parsed.rev !== 0) onRemoteChange()
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
