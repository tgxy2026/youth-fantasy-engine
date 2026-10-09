// 3.0 · W0-2 数据迁移 · IndexedDB 小工具
//
// 只服务迁移：判断某库是否存在（**不创建**）、安全删除某库。
// 🔴 刻意不放进 `lib/db` 门面 —— 那两个独立库（`-vec` / `-kb`）本就不走门面（见项目 MEMORY 红线）。

/** IndexedDB 库名是否存在。**不会创建**库（区别于 `openDB` 的副作用）。 */
export async function idbDbExists(name: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  try {
    // `indexedDB.databases()` 在 Chromium 93+ 可用（本项目 Electron 44 / Chromium 13x 必支持）
    const dbs = await indexedDB.databases()
    if (Array.isArray(dbs)) return dbs.some(d => d && d.name === name)
  } catch { /* 极端环境下 databases() 不可用 */ }
  // 兜底：假定存在 —— 交给 openDB 判定；若其实不存在会建一个空库，随后立刻被删，无副作用。
  return true
}

/** 删除 IndexedDB 库。**永不 reject**（迁移是尽力而为，删不掉旧库不应让整体失败）。 */
export function idbDeleteDatabase(name: string): Promise<void> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(); return }
    try {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve() // 有其他连接占用时可能 blocked，不阻塞迁移收尾
    } catch { resolve() }
  })
}
