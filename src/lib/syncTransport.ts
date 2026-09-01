// 同步传输层抽象（#031 云盘中转同步）。
// 把「数据发到中心服务器」这一动作抽成可替换的传输实现：
//  - HttpTransport：现有方案，走 /api/sync（依赖我们的服务器）。
//  - FileTransport：云盘中转方案，读写用户选定的本地同步目录里的 .yfe 文件，
//    由 OneDrive / Dropbox / Google Drive / 百度网盘 / 坚果云 / WPS 云盘 等客户端负责跨设备搬运。
// 加密、载荷结构、rev 合并、#030 空推防护全部保留在 serverStore，这里只管「字节怎么落地/读取」。

export interface RawSyncResponse {
  status: number // 200 成功 / 401 码失效 / 409 冲突 / 413 过大 / 422 空推拒绝 / 0 网络异常（仅 http）
  rev?: number
  enc?: string | null
}

export interface SyncTransport {
  mode: 'http' | 'file'
  /** 告知当前同步码（派生文件槽位名 / HTTP 鉴权头）。 */
  setCode(code: string): void
  /** 拉取远端快照：文件模式无 401/429，文件缺失即视为空库。 */
  pull(): Promise<RawSyncResponse>
  /** 推送快照：baseRev 本地基线 rev，enc 加密载荷。 */
  push(baseRev: number, enc: string): Promise<RawSyncResponse>
  /** 启动远端变更监听（文件模式定时轮询；HTTP 模式无操作）。 */
  startWatch(onRemoteChange: () => void): void
  stopWatch(): void
}

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
export function createFileTransport(handle: any): SyncTransport {
  const isFsa = typeof handle !== 'string'
  let code = ''
  let slot: string | null = null
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

  // ---- 浏览器 FSA 读写 ----
  async function fsaRead(name: string): Promise<string | null> {
    try {
      await ensurePerm()
      const fh = await handle.getFileHandle(name)
      const f = await fh.getFile()
      return await f.text()
    } catch {
      return null
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
  async function nodeRead(p: string): Promise<string | null> {
    const eb = getElectronBackend()
    if (eb && typeof eb.syncRead === 'function') {
      try {
        return await eb.syncRead(p)
      } catch {
        return null
      }
    }
    const fs = getNodeFs()
    if (!fs) return null
    try {
      return await fs.promises.readFile(p, 'utf8')
    } catch {
      return null
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

  async function readRaw(name: string): Promise<string | null> {
    return isFsa ? fsaRead(name) : nodeRead(String(handle) + '/' + name)
  }
  async function writeRaw(name: string, text: string): Promise<void> {
    return isFsa ? fsaWrite(name, text) : nodeWrite(String(handle) + '/' + name, text)
  }

  function parseRev(text: string | null): { rev: number; enc: string | null } {
    if (!text) return { rev: 0, enc: null }
    try {
      const o = JSON.parse(text)
      return { rev: Number(o.rev) || 0, enc: o.enc ?? null }
    } catch {
      return { rev: 0, enc: null } // 损坏文件当作空库处理
    }
  }

  return {
    mode: 'file',
    setCode(c: string) {
      code = c
      slot = null
    },
    async pull() {
      const name = await slotName()
      const text = await readRaw(name)
      const { rev, enc } = parseRev(text)
      return { status: 200, rev, enc }
    },
    async push(baseRev: number, enc: string) {
      const name = await slotName()
      const cur = parseRev(await readRaw(name))
      // 远端已比本地基线新 → 冲突，交还 409 让 serverStore 合并后重试
      if (cur.rev > baseRev) return { status: 409, rev: cur.rev, enc: cur.enc }
      const newRev = (cur.rev > baseRev ? cur.rev : baseRev) + 1
      await writeRaw(name, JSON.stringify({ rev: newRev, enc }))
      lastSeenRev = newRev
      // 写后回读校验：若被他人中途覆盖（竞态），按冲突处理触发合并重试
      const after = parseRev(await readRaw(name))
      if (after.rev !== newRev) return { status: 409, rev: after.rev, enc: after.enc }
      return { status: 200, rev: newRev }
    },
    startWatch(onRemoteChange: () => void) {
      this.stopWatch()
      watchTimer = setInterval(async () => {
        const name = await slotName()
        const { rev } = parseRev(await readRaw(name))
        if (rev !== -1 && rev !== lastSeenRev) {
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
