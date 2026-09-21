/**
 * 同步**墓碑**：记住「这条记录被本机删过」，让删除能跨启动、跨设备生效。
 *
 * 🔴 为什么需要它（2026-09-19 老大实测的「幽灵项目」）：
 *    `baseCache`（三路合并的基线快照）只活在内存里、**每次启动都是空的**。启动后第一次合并时，
 *    「本地没有、云端有」的记录因为基线里查不到，被一律判成「另一端新增」而采用云端 ——
 *    于是云端还留着的旧记录（包括早已删掉的项目）就**复活**了；复活后又被推回云端，
 *    此后每次启动稳定复现（自锁），删多少次都没用。
 *
 *    单凭「基线里有没有这条」无法区分下面两件事，必须靠明确的删除记忆：
 *      · 本机删掉了它              → 保持删除（有墓碑）
 *      · 本机还从没见过它（新设备）→ 采用云端（无墓碑）
 *
 * ⚠️ 墓碑落在**本机** localStorage（不随同步上传）：
 *    删除真正跨设备传播，靠的是「删除后的快照被正常推上云端」—— 那是常规三路合并的职责。
 *    墓碑只负责堵住「本机已删、云端尚未更新」这个窗口期，而这正是幽灵项目发生的地方。
 * ⚠️ **写入（put）会自动清掉同 key 的墓碑** —— 允许「删掉之后又重建同 id」（从项目备份导入等），
 *    否则那条记录会被墓碑永久挡住，变成删得掉、进不来的死记录。
 */

const TOMB_KEY = 'yfe-sync-tombstones'
/** 单 store 墓碑上限（超限丢最早的）：墓碑只在"云端尚未跟上"的窗口期有用，不需要长期保留 */
const TOMB_MAX_PER_STORE = 5000

/** store 名 → 主键 → 删除时间戳 */
export type Tombs = Record<string, Record<string, number>>

function load(): Tombs {
  try {
    const raw = localStorage.getItem(TOMB_KEY)
    if (!raw) return {}
    const o: unknown = JSON.parse(raw)
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: Tombs = {}
    for (const store of Object.keys(o as Record<string, unknown>)) {
      const m = (o as Record<string, unknown>)[store]
      if (!m || typeof m !== 'object' || Array.isArray(m)) continue
      const inner: Record<string, number> = {}
      for (const k of Object.keys(m as Record<string, unknown>)) {
        const t = (m as Record<string, unknown>)[k]
        if (typeof t === 'number' && Number.isFinite(t)) inner[k] = t
      }
      out[store] = inner
    }
    return out
  } catch {
    /* 配额满 / 隐私模式 / 数据损坏：当空处理（最多退回旧行为，绝不拖垮同步） */
    return {}
  }
}

let tombs: Tombs = load()

function persist(): void {
  try {
    localStorage.setItem(TOMB_KEY, JSON.stringify(tombs))
  } catch {
    /* 同上：落盘失败不影响同步主流程 */
  }
}

// 📌 2026-09-20 死代码查证：这里原有 `getTombs()` 与 `reloadTombs()` 两个导出，已删。
//    · `getTombs()` —— 注释写「合并时读取用」，但三路合并实际走的是 `isDeleted(store, key)`
//      （见 syncCore.mergeCaches）——**用途已被取代，注释是过时的**。
//    · `reloadTombs()` —— 注释写「换同步目录 / 外部改动后」重载。但换目录走的是 `resetTombs()`，
//      而墓碑的运行时**唯一**改动源就是本进程（markDeleted / clearDeleted / resetTombs），
//      单窗口下不存在「外部改动」，该场景不成立。模块初始化时已 `load()` 过一次。
//    ⚠️ 当时并列提到的三个「无引用导出」，现状（2026-09-20 晚复核）：
//      · `pruneGhostFreeChars` / `pruneGhostFreeSessions` —— **已不再是缺口**：数据体检第 5 类
//        「酒馆列表残留」接上了清理入口，它们由 `tavern/store.ts` 的 `pruneGhostsSafely` 调用
//        （这也是这两个「能力缺口」函数第一次有了真实消费者）。已从 audit-dead 白名单撤下。
//      · `promptText` —— 仍零引用，但**有意保留**（预留 API），仍在白名单里。

/**
 * 记录删除。`keys` 可传多个（批量删除场景）。
 *
 * ⚠️ 只在**真正从存储里移除**时调用。移到回收站（`trash`）不算删除 —— 那条记录还在云端。
 */
export function markDeleted(store: string, keys: readonly unknown[]): void {
  if (!keys.length) return
  const now = Date.now()
  const m = tombs[store] ?? (tombs[store] = {})
  for (const k of keys) m[String(k)] = now
  const all = Object.keys(m)
  if (all.length > TOMB_MAX_PER_STORE) {
    // 丢最早的（Map 的插入顺序不保证跨次运行，这里按删除时间排序取最新的那批）
    const keep = all.sort((a, b) => m[b] - m[a]).slice(0, TOMB_MAX_PER_STORE)
    const next: Record<string, number> = {}
    for (const k of keep) next[k] = m[k]
    tombs[store] = next
  }
  persist()
}

/** 记录（重新）写入 → 清掉同 key 的墓碑，允许"删掉又重建" */
export function clearDeleted(store: string, keys: readonly unknown[]): void {
  if (!keys.length) return
  const m = tombs[store]
  if (!m) return
  let changed = false
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(m, String(k))) {
      delete m[String(k)]
      changed = true
    }
  }
  if (changed) {
    if (Object.keys(m).length === 0) delete tombs[store]
    persist()
  }
}

/** 这条记录是否被本机删过 */
export function isDeleted(store: string, key: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(tombs[store] ?? {}, String(key))
}

/** 关闭同步 / 换到别的云端时忘掉全部删除记忆 */
export function resetTombs(): void {
  tombs = {}
  try {
    localStorage.removeItem(TOMB_KEY)
  } catch {
    /* 忽略 */
  }
}
