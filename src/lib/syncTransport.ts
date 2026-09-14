// 同步传输层抽象（#031 云盘中转同步）。
// 把「数据发到中心服务器」这一动作抽成可替换的传输实现：
//  - HttpTransport：现有方案，走 /api/sync（依赖我们的服务器）。
//  - FileTransport：云盘中转方案，读写用户选定的本地同步目录里的 .yfe 文件，
//    由 OneDrive / Dropbox / Google Drive / 百度网盘 / 坚果云 / WPS 云盘 等客户端负责跨设备搬运。
// 加密、载荷结构、rev 三路合并、#030 空推防护均已迁至 syncCore.ts（本文件不再承担），
// 这里只负责「字节怎么落地 / 怎么读回来」，并把「文件不存在」与「读取失败」如实分开上报。

export interface RawSyncResponse {
  status: number // 200 成功 / 401 码失效 / 409 冲突 / 413 过大 / 422 空推拒绝 / 0 网络异常（仅 http）
  rev?: number
  enc?: string | null
}

export interface SyncTransport {
  mode: 'http' | 'file'
  /** 告知当前同步码（派生文件槽位名 / HTTP 鉴权头）。 */
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
 * 为什么不需要同步码：同步码在「服务器模式」身兼两职——①HTTP 鉴权（换服务器槽位）、②AES 密钥。
 * 云盘文件中转走的是用户自己的网盘，不过我们的服务器，①根本不存在；
 * ②只需要两端一致即可，故用内置常量：所有设备同一密钥 → 指向同一目录就能互通。
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
  const buf = await (globalThis as any).crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ============ HTTP 传输（现有服务器方案）============
export function createHttpTransport(): SyncTransport {
  let code = ''
  const auth = () => ({ Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' })
  return {
    mode: 'http',
    setCode(c: string) {
      code = c
    },
    async pull() {
      try {
        const r = await fetch('/api/sync', { headers: { Authorization: `Bearer ${code}` } })
        if (r.ok) {
          const d = await r.json().catch(() => ({}))
          return { status: 200, rev: d.rev, enc: d.enc }
        }
        return { status: r.status }
      } catch {
        return { status: 0 } // 0 = 网络异常（serverStore 按 offline 处理）
      }
    },
    async push(baseRev: number, enc: string) {
      try {
        const r = await fetch('/api/sync', { method: 'POST', headers: auth(), body: JSON.stringify({ rev: baseRev, enc }) })
        if (r.status === 409 || r.ok) {
          const d = await r.json().catch(() => ({}))
          return { status: r.status, rev: d.rev, enc: d.enc }
        }
        return { status: r.status }
      } catch {
        return { status: 0 }
      }
    },
    startWatch() {},
    stopWatch() {},
  }
}

// ============ 文件传输（云盘中转方案）============
// handle 可为 FileSystemDirectoryHandle（浏览器 FSA）或文件夹路径字符串（桌面 Electron 渲染进程 node fs 兜底）。
// fixedName：指定固定文件名（桌面/便携版云盘同步用，便于用户在云盘目录里认出它）；
// 不传则回退到 sha256(code) 命名（网页版云盘中转按码分槽，避免多码互相覆盖）。
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
      await eb.syncWrite(p, text)
      return
    }
    const fs = getNodeFs()
    if (!fs) return
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
      }, 8000)
    },
    stopWatch() {
      if (watchTimer) {
        clearInterval(watchTimer)
        watchTimer = null
      }
    },
  }
}

// ============ 模式与目录句柄持久化 ============
const MODE_KEY = 'yfe-sync-mode'
export type SyncMode = 'http' | 'file'

export function getSyncMode(): SyncMode {
  try {
    return (localStorage.getItem(MODE_KEY) as SyncMode) || 'http'
  } catch {
    return 'http'
  }
}
export function setSyncMode(m: SyncMode) {
  try {
    localStorage.setItem(MODE_KEY, m)
  } catch {
    /* 忽略 */
  }
}

// FileSystemDirectoryHandle 可序列化存入 IndexedDB，重启后免重复选目录（首次仍需授权）。
const IDB_NAME = 'yfe-sync-folder'
const IDB_STORE = 'handles'
function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
export async function saveSyncFolderHandle(h: any): Promise<void> {
  const db = await openIdb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(h, 'active')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}
export async function loadSyncFolderHandle(): Promise<any | null> {
  try {
    const db = await openIdb()
    return await new Promise<any | null>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const g = tx.objectStore(IDB_STORE).get('active')
      g.onsuccess = () => {
        db.close()
        resolve(g.result || null)
      }
      g.onerror = () => {
        db.close()
        resolve(null)
      }
    })
  } catch {
    return null
  }
}
export async function clearSyncFolderHandle(): Promise<void> {
  try {
    const db = await openIdb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).delete('active')
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
    db.close()
  } catch {
    /* 忽略 */
  }
}
