// 同步传输层抽象（#031 云盘中转同步）。
// 只做一件事：把「字节怎么落地 / 怎么读回来」与加密、载荷结构、rev 三路合并解耦。
//  - FileTransport：唯一在用的实现 —— 读写用户选定同步目录里的 .yfe 文件，
//    由 OneDrive / 百度网盘 / 坚果云 / WPS 云盘 等客户端负责跨设备搬运，全程不经过任何服务器。
//  - IdleTransport：未开启同步时的占位实现（一切操作按「不可用」上报，上层据此回退本机存储）。
//    ⚠️ 2026-09 服务器下线后移除：原先这里放的是走 /api/sync 的 HttpTransport（依赖服务器的中心化同步）。
// 加密、载荷结构、rev 三路合并、#030 空推防护均已迁至 syncCore.ts（本文件不再承担），
// 这里只负责「字节怎么落地 / 怎么读回来」，并把「文件不存在」与「读取失败」如实分开上报。

import { SYNC_POLL_MS } from './constants'
import { webcrypto } from './webcrypto'

export interface RawSyncResponse {
  status: number // 200 成功 / 401 码失效 / 409 冲突 / 413 过大 / 422 空推拒绝 / 0 网络异常（仅 http）
  rev?: number
  enc?: string | null
}

export interface SyncTransport {
  mode: 'none' | 'file'
  /** 告知当前密钥（派生文件槽位名；固定文件名模式下不影响槽位）。 */
  setCode(code: string): void
  /**
   * 拉取远端快照。
   * 文件模式无 401/429：文件**不存在**视为空库（status 200 + rev 0）；
   * 文件**读取失败或内容损坏**则返回 status 0 —— 上层按「不可用/离线」回退本地，
   * 绝不会当成空库（那会导致后续 push 覆盖云端真实数据）。HTTP 模式 status 0 = 网络异常。
   */
  pull(): Promise<RawSyncResponse>
  /**
   * 推送快照：baseRev 本地基线 rev，enc 加密载荷。
   * 文件模式下若远端读不到或已损坏，返回 status 0（拒绝写入）而非盲写覆盖。
   */
  push(baseRev: number, enc: string): Promise<RawSyncResponse>
  /** 启动远端变更监听（文件模式定时轮询；HTTP 模式无操作）。 */
  startWatch(onRemoteChange: () => void): void
  stopWatch(): void
}

// ============ 云盘文件中转 · 共享常量（#032）============
/**
 * 内置默认加密密钥（网页版云盘模式 / 桌面 / 便携版共用）。
 *
 * 为什么不需要用户填密码：文件同步走的是用户自己的网盘，不过任何服务器，
 * 加密只需要两端一致即可 —— 故用内置常量：所有设备同一密钥 → 指向同一目录就能互通。
 *
 * 安全边界（必须在 UI 如实告知用户）：此密钥是公开的源码常量，加密强度等同于「混淆」，
 * 仅防云盘明文扫描与误看，**不足以对抗蓄意破解**。机密稿件请放在私人目录、不要共享。
 */
export const DEFAULT_CLOUD_KEY = 'YFE-CLOUD-FILE-SYNC-V1'

/** 云盘同步文件名（固定，便于用户在云盘目录里认出它）。 */
export const CLOUD_FILE_NAME = '青春幻想引擎-同步数据.yfe'

// ============ 工具 ============
async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s)
  const buf = await webcrypto().subtle.digest('SHA-256', data)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ============ 占位传输（未开启同步时）============
/**
 * 未开启云盘同步时的占位实现。
 *
 * 为什么需要它：`createCloudStore` 必须先拿到一个 transport 才能构造实例，而同步目录是
 * 用户之后才选的（由 `setTransport` 替换）。占位实现把一切操作**如实上报为「不可用」**（status 0），
 * 上层据此回退本机存储 —— 绝不返回「空库」，否则一次 push 就会覆盖掉云端真实快照。
 */
export function createIdleTransport(): SyncTransport {
  return {
    mode: 'none',
    setCode() {
      /* 未开启同步：无需派生槽位 */
    },
    async pull() {
      return { status: 0 }
    },
    async push() {
      return { status: 0 }
    },
    startWatch() {
      /* 未开启同步：无远端可监听 */
    },
    stopWatch() {
      /* 同上 */
    },
  }
}

// ============ 文件传输（云盘中转方案）============
// handle 可为 FileSystemDirectoryHandle（浏览器 FSA）或文件夹路径字符串（桌面 Electron 渲染进程 node fs 兜底）。
// fixedName：指定固定文件名（桌面/便携版云盘同步用，便于用户在云盘目录里认出它）；
// 不传则回退到 sha256(密钥) 命名（多套数据共用同一目录时按密钥分槽，避免互相覆盖）。
/**
 * 本地文件传输。
 * @param handle 目录句柄：桌面版是**字符串路径**（经 IPC / fs），网页版是
 *   `FileSystemDirectoryHandle` —— 两者没有公共类型，故形参是 any；
 *   由 `typeof handle === 'string'` 分支各自收窄（见函数内）。
 */
export function createFileTransport(handle: any, fixedName?: string): SyncTransport {
  const isFsa = typeof handle !== 'string'
  let code = ''
  let slot: string | null = fixedName || null
  let watchTimer: ReturnType<typeof setInterval> | null = null
  let lastSeenRev = -1

  async function slotName(): Promise<string> {
    if (!slot) slot = (await sha256Hex(code || 'x')) + '.yfe'
    return slot
  }

  async function ensurePerm(): Promise<void> {
    if (isFsa) {
      try {
        await handle.requestPermission?.({ mode: 'readwrite' })
      } catch {
        /* 权限弹窗被拒/不支持时静默继续，读写失败会被上层当作离线 */
      }
    }
  }

  // ---- 读取结果三态（2026-09-14 审计 P0-2 加固）----
  // 旧实现把「文件不存在」与「读取失败」一并 return null，上层据此认为「云端为空」，
  // 随后一次 push 就把本地内容整体覆盖掉云端真实快照。读取失败必须与空库严格分开。
  type RawRead = { ok: true; text: string | null } | { ok: false; reason: string }

  const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))
  /** 仅「文件不存在」类错误可安全视为空库；其余一律按读失败处理 */
  const isNotFoundErr = (e: unknown): boolean => {
    if (!e || typeof e !== 'object') return false
    const n = (e as { name?: string }).name
    const c = (e as { code?: string }).code
    return n === 'NotFoundError' || c === 'ENOENT'
  }

  // ---- 浏览器 FSA 读写 ----
  async function fsaRead(name: string): Promise<RawRead> {
    try {
      await ensurePerm()
      const fh = await handle.getFileHandle(name)
      const f = await fh.getFile()
      return { ok: true, text: await f.text() }
    } catch (e) {
      // NotFoundError：首次同步尚无文件 → 空库；
      // NotAllowedError（权限被拒）/ NotReadableError（被占用）→ 读失败，交给上层拒绝写入
      if (isNotFoundErr(e)) return { ok: true, text: null }
      return { ok: false, reason: errText(e) }
    }
  }
  async function fsaWrite(name: string, text: string): Promise<void> {
    await ensurePerm()
    const fh = await handle.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(text)
    await w.close()
  }

  // ---- 桌面文件读写 ----
  // 优先走 Electron 主进程 IPC（preload 注入 window.electronStore.syncRead/syncWrite）：
  //   桌面版渲染进程 nodeIntegration=false，globalThis.require('fs') 不可用，必须经 IPC 桥。
  // 其次回退到渲染进程内 require('fs')（极旧打包/特殊配置下），再其次失败。
  // any 理由：preload 注入的 IPC 桥（electron/main.cjs 定义），本项目内无类型来源；
  //           调用点用 `typeof eb.syncRead === 'function'` 运行时把守。
  let electronBackend: any = null
  function getElectronBackend(): any {
    if (electronBackend !== null) return electronBackend
    try {
      electronBackend = (typeof window !== 'undefined' && (window as any).electronStore) || null
    } catch {
      electronBackend = null
    }
    return electronBackend
  }
  // any 理由：Node 的 fs 模块（取值失败时置 false 表示「不可用」）——
  //           `require` 本身不在 DOM 类型里，只能经 globalThis 动态取；
  //           调用点逐个判 `typeof nodeFs.readFile === 'function'`。
  let nodeFs: any = null
  function getNodeFs(): any {
    if (nodeFs !== null) return nodeFs
    try {
      nodeFs = (globalThis as any).require('fs')
    } catch {
      nodeFs = false
    }
    return nodeFs
  }
  async function nodeRead(p: string): Promise<RawRead> {
    const eb = getElectronBackend()
    if (eb && typeof eb.syncRead === 'function') {
      try {
        const r = await eb.syncRead(p)
        // 新契约（electron/main.cjs）：{ ok,text } / { ok,reason }
        if (r && typeof r === 'object' && 'ok' in r) {
          return r.ok ? { ok: true, text: r.text ?? null } : { ok: false, reason: String(r.reason ?? '读取失败') }
        }
        // 旧契约（2.0.1 及更早的主进程）：string | null —— 无法区分空库与读失败，
        // 维持旧行为（当空库），待主进程随下次打包一并更新后自动走新契约。
        return { ok: true, text: r == null ? null : String(r) }
      } catch (e) {
        return { ok: false, reason: errText(e) }
      }
    }
    const fs = getNodeFs()
    // 无可用的文件后端：宁可如实报「读失败」而拒绝推送，也不要当空库去覆盖云端
    if (!fs) return { ok: false, reason: 'node fs 后端不可用' }
    try {
      return { ok: true, text: await fs.promises.readFile(p, 'utf8') }
    } catch (e) {
      if (isNotFoundErr(e)) return { ok: true, text: null }
      return { ok: false, reason: errText(e) }
    }
  }
  async function nodeWrite(p: string, text: string): Promise<void> {
    const eb = getElectronBackend()
    if (eb && typeof eb.syncWrite === 'function') {
      // 🔴 主进程写失败时**返回 {ok:false} 而不抛**。不查返回值就等于「以为写成功了」：
      //    写后回读 rev 不匹配 → 上层走 409 重试 → 重试耗尽后 pushNow 返回 conflict（不抛）
      //    → 界面状态永远停在「同步中」，而目录里一个字都没写进去（目录不可写/磁盘满时最常见）。
      const r = await eb.syncWrite(p, text)
      if (r && typeof r === 'object' && r.ok === false) {
        throw new Error('sync write failed: ' + (r.error || '未知原因'))
      }
      return
    }
    const fs = getNodeFs()
    // 与 nodeRead 同一条纪律：拿不到可写后端就如实报错，绝不静默「成功」
    if (!fs) throw new Error('node fs 后端不可用（同步文件未写入）')
    const tmp = p + '.tmp'
    await fs.promises.writeFile(tmp, text, 'utf8')
    try {
      await fs.promises.rename(p, p + '.bak')
    } catch {
      /* 首次写入无旧文件，忽略 */
    }
    await fs.promises.rename(tmp, p)
  }

  async function readRaw(name: string): Promise<RawRead> {
    return isFsa ? fsaRead(name) : nodeRead(String(handle) + '/' + name)
  }
  async function writeRaw(name: string, text: string): Promise<void> {
    return isFsa ? fsaWrite(name, text) : nodeWrite(String(handle) + '/' + name, text)
  }

  type ParsedRev = { rev: number; enc: string | null } | { corrupt: true }

  function parseRev(text: string | null): ParsedRev {
    // 文件不存在 / 空文件（写入被中断、被清空等）→ 空库，安全
    if (text == null || !text.trim()) return { rev: 0, enc: null }
    try {
      const o = JSON.parse(text)
      return { rev: Number(o.rev) || 0, enc: o.enc ?? null }
    } catch {
      // 内容存在却解析不了 → 明确标记 corrupt，**不再退化成 rev=0**。
      // 旧实现在此处返回 rev=0，等于对外宣称「云端是空的」，是「一次 push 覆盖云端真实数据」
      // 的直接成因（见 2026-09-14 审计 P0-2）。
      return { corrupt: true }
    }
  }

  // 损坏文件只隔离一次：避免 8 秒轮询每次都写一份备份把目录塞满
  let quarantined = false
  async function quarantine(name: string, text: string): Promise<void> {
    if (quarantined) return
    quarantined = true
    try {
      // 原样另存为 .corrupt-<时间戳>：数据虽当前解析不了，也要留给用户/后续人工抢救的余地，
      // 绝不能让它在被覆盖后无从追查。
      await writeRaw(`${name}.corrupt-${Date.now()}`, text)
      console.warn(`[sync] 同步文件无法解析，已另存备份并暂停写入以免覆盖云端数据：${name}`)
    } catch (e) {
      console.warn('[sync] 损坏同步文件备份失败：', errText(e))
    }
  }

  return {
    mode: 'file',
    setCode(c: string) {
      code = c
      slot = fixedName || null // 固定文件名模式下不因换码而改变槽位
      quarantined = false      // 换码/换槽位后重新评估新槽位的健康状况
    },
    async pull() {
      const name = await slotName()
      const r = await readRaw(name)
      // 读失败 → status 0（上层按「不可用/离线」回退本地，见 syncCore.ensureInit），绝不当空库
      if (!r.ok) return { status: 0 }
      const p = parseRev(r.text)
      if ('corrupt' in p) {
        await quarantine(name, r.text ?? '')
        return { status: 0 }
      }
      return { status: 200, rev: p.rev, enc: p.enc }
    },
    async push(baseRev: number, enc: string) {
      const name = await slotName()
      const r = await readRaw(name)
      // 读不到远端当前状态就不敢写：宁可报不可用，也不能盲写覆盖
      if (!r.ok) return { status: 0 }
      const cur = parseRev(r.text)
      if ('corrupt' in cur) {
        await quarantine(name, r.text ?? '')
        return { status: 0 }
      }
      // 远端已比本地基线新 → 冲突，交还 409 让上层合并后重试
      if (cur.rev > baseRev) return { status: 409, rev: cur.rev, enc: cur.enc }
      // 走到这里必有 cur.rev <= baseRev，故新 rev 恒为 baseRev + 1
      const newRev = baseRev + 1
      await writeRaw(name, JSON.stringify({ rev: newRev, enc }))
      lastSeenRev = newRev
      // 写后回读校验：若被他人中途覆盖（竞态），按冲突处理触发合并重试
      const afterRaw = await readRaw(name)
      if (!afterRaw.ok) return { status: 0 }
      const after = parseRev(afterRaw.text)
      if ('corrupt' in after) return { status: 0 }
      if (after.rev !== newRev) return { status: 409, rev: after.rev, enc: after.enc }
      return { status: 200, rev: newRev }
    },
    startWatch(onRemoteChange: () => void) {
      this.stopWatch()
      watchTimer = setInterval(async () => {
        const name = await slotName()
        const r = await readRaw(name)
        // 读失败：本轮跳过。绝不能把它当成「远端变成空库」而更新 lastSeenRev
        if (!r.ok) return
        const p = parseRev(r.text)
        if ('corrupt' in p) {
          await quarantine(name, r.text ?? '')
          return
        }
        const rev = p.rev
        if (rev !== lastSeenRev) {
          lastSeenRev = rev
          if (rev !== 0) onRemoteChange() // rev===0 视为空库，不触发
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
