// ============ 存储层 · IndexedDB 版本迁移 ============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。这里只放 **IndexedDB schema 的版本迁移段**
// （openDB 的 upgrade 回调里各段）；三支「数据迁移」在 ./migrations，连接与适配层在 ./core。
//
// 🔴 纪律（改这里之前必读）：
//   1. **迁移顺序即依赖顺序**，不可调换（v8→v9 给 tableRows 建索引，必须排在 v2→v3 建完基础 store 之后）。
//   2. 全新安装走 migrateFreshInstall 后**不 return**，会继续跑后面的段（对空库是空转，各自有守卫）。
//   3. 需要 `tx` 的段必须接收同一个 upgrade 事务，不要自己开事务。
//   4. 「何时该跑哪一段」的唯一判断点在 ./core 的 getDB()，这里不重复写版本判断。
import type { IDBPDatabase, IDBPTransaction } from 'idb'
import type { Project, FormData, TableRow, CardRecord } from '../types'

// ============ IndexedDB 版本迁移（自 getDB 的 upgrade 回调拆出）============
//
// 原先 9 个版本迁移挤在一个 185 行的 upgrade 回调里，既难读、也难以逐个验证。
// 本次只做**逐行搬运**：每段原样搬进一个函数、剥掉外层的 `if (oldVersion …) {` 外壳、
// 归一化缩进。**语句一字未改**——「何时该跑」这个判断改由下方 upgrade 调度处唯一承担，
// 不再在函数内重复一遍（两份判断迟早会不同步）。
//
// 🔴 三条纪律（改这里之前务必先读）：
//   1. **迁移顺序即依赖顺序**，不可调换。例如 v8→v9 给 tableRows 建索引，
//      必须排在 v2→v3 建完基础 store 之后。
//   2. 全新安装走 `migrateFreshInstall` 后**不 return**，会继续执行 v3 及之后的几段
//      （它们对空库是无副作用的空转，且各自有 indexNames.contains 守卫）——这是刻意保留的原行为。
//   3. 需要 `tx` 的段必须接收同一个 upgrade 事务，不要自己开事务。

/** upgrade 回调里的数据库句柄 */
type Vdb = IDBPDatabase<unknown>
/** upgrade 事务（versionchange） */
type Vtx = IDBPTransaction<unknown, string[], 'versionchange'>

/** 全新安装（自 getDB upgrade 回调逐行搬出，语句未改） */
export function migrateFreshInstall(db: Vdb) {
  // ---- 全新安装：创建基础 store（不 return，继续走下方 v3 分支补全新 store） ----
  db.createObjectStore('projects', { keyPath: 'id' })
  db.createObjectStore('volumes', { keyPath: 'id' })
  db.createObjectStore('chapters', { keyPath: 'id' })
  db.createObjectStore('formData', { keyPath: 'tabId' })
  const tableRowsStore = db.createObjectStore('tableRows', { keyPath: 'id' })
  // #020：按 tabId 建索引，getTableRows 改走索引查询，避免每开一张表就全表扫
  tableRowsStore.createIndex('tabId', 'tabId', { unique: false })
  db.createObjectStore('cardRecords', { keyPath: 'id' })
  db.createObjectStore('meta', { keyPath: 'key' })
}

/** v1 → v2 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
export async function migrateV1toV2(db: Vdb, tx: Vtx) {
  // ---- v1 → v2 迁移：旧数据全部归入「default」项目 ----
  db.createObjectStore('projects', { keyPath: 'id' })
  // v1→v2 补建 meta（v0 在上方 oldVersion===0 分支已建；此处补齐避免旧版升级后缺 meta 库导致 put('meta') 抛错）
  if (!db.objectStoreNames.contains('meta')) {
    db.createObjectStore('meta', { keyPath: 'key' })
  }
  const now = Date.now()
  await tx.objectStore('projects').put({
    id: 'default', name: '我的小说（旧数据迁移）', genre: '', intro: '', createdAt: now, updatedAt: now,
  } as Project)
  for (const name of ['volumes', 'chapters', 'tableRows', 'cardRecords']) {
    const store = tx.objectStore(name)
    let cursor = await store.openCursor()
    while (cursor) {
      if (!cursor.value.projectId) {
        const rec = { ...cursor.value, projectId: 'default' }
        await store.put(rec)
      }
      cursor = await cursor.continue()
    }
  }
  // formData 的 key 从 tabId 改为 projectId::tabId
  const fs = tx.objectStore('formData')
  let fc = await fs.openCursor()
  while (fc) {
    const rec = fc.value as FormData
    if (!rec.tabId.includes('::')) {
      await fs.delete(rec.tabId)
      await fs.put({ tabId: `default::${rec.tabId}`, data: rec.data })
    }
    fc = await fc.continue()
  }
}

/** v2 → v3 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
export function migrateV2toV3(db: Vdb) {
  // ---- v2 → v3 迁移：新增 快照 / 每日统计 / 项目设置 / 回收站 ----
  const snapStore = db.createObjectStore('snapshots', { keyPath: 'id' })
  snapStore.createIndex('projectId', 'projectId', { unique: false })
  snapStore.createIndex('chapterId', 'chapterId', { unique: false })
  db.createObjectStore('dailyStats', { keyPath: 'key' })
  db.createObjectStore('settingsKV', { keyPath: 'key' })
  db.createObjectStore('trash', { keyPath: 'id' })
}

/** v3 → v4 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
export async function migrateV3toV4(tx: Vtx) {
  // ---- v3 → v4 迁移：时间脉络表列名 "故事内日期" → "故事内时间" ----
  const store = tx.objectStore('tableRows')
  let cursor = await store.openCursor()
  while (cursor) {
    const rec = cursor.value as TableRow
    if (rec.tabId === 'timeline' && rec.data && rec.data['故事内日期'] !== undefined) {
      const data = { ...rec.data }
      if (data['故事内时间'] === undefined) data['故事内时间'] = data['故事内日期']
      delete data['故事内日期']
      await store.put({ ...rec, data })
    }
    cursor = await cursor.continue()
  }
}

/** v4 → v5 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
export async function migrateV4toV5(tx: Vtx) {
  // ---- v4 → v5 迁移：分卷大纲/章节细纲 由单份表单改为多记录卡片 ----
  // 旧 formData（projectId::volume-outline / chapter-outline）中已填写的内容
  // 转换为一张卡片记录（追加到该项目该页签末尾），然后删除旧表单数据
  const fs = tx.objectStore('formData')
  const cards = tx.objectStore('cardRecords')
  // 预统计每个 (projectId, tabId) 已有卡片数，作为迁移记录的 order
  const countMap = new Map<string, number>()
  let cc = await cards.openCursor()
  while (cc) {
    const r = cc.value as CardRecord
    if (r.tabId === 'volume-outline' || r.tabId === 'chapter-outline') {
      const k = `${r.projectId}::${r.tabId}`
      countMap.set(k, (countMap.get(k) ?? 0) + 1)
    }
    cc = await cc.continue()
  }
  let fc = await fs.openCursor()
  while (fc) {
    const key = fc.key as string
    const m = key.match(/^(.+)::(volume-outline|chapter-outline)$/)
    const rec = fc.value as FormData
    if (m) {
      const hasData = rec.data && Object.values(rec.data).some(v => v && String(v).trim())
      if (hasData) {
        const tabId = m[2]
        const nameKey = tabId === 'volume-outline' ? '一、本卷定位::卷名' : '一、本章定位::章节号/标题'
        const name = (rec.data[nameKey] && rec.data[nameKey].trim())
          || Object.entries(rec.data).find(([, v]) => v && v.trim())?.[1] || '未命名'
        const k = `${m[1]}::${tabId}`
        const order = countMap.get(k) ?? 0
        countMap.set(k, order + 1)
        await cards.put({
          id: `mig-${key}`, projectId: m[1], tabId,
          name: String(name).slice(0, 50), data: rec.data, order,
        } as CardRecord)
      }
      await fs.delete(key)
    }
    fc = await fc.continue()
  }
}

/** v5 → v6 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
export function migrateV5toV6(db: Vdb) {
  // ---- v5 → v6 迁移：新增「自动备份」独立存储 ----
  // 自动备份按项目独立存放，删除项目时不会被清掉（见 deleteProject）
  db.createObjectStore('backups', { keyPath: 'id' })
}

/** v6 → v7 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
export async function migrateV6toV7(tx: Vtx) {
  // ---- v6 → v7 迁移：表头统一（术语→名称、类型→类别） ----
  // 列名即数据键，改名需同步重映射已存数据的 data 键，否则旧数据在该列显示为空白；
  // 同时重映射自定义下拉选项 settingsKV 的键中列名段，避免选项丢失。
  const renameMap: Record<string, Record<string, string>> = {
    terms: { '术语': '名称' },
    nations: { '类型': '类别' },
    geography: { '类型': '类别' },
    subplots: { '类型': '类别' },
  }
  // 1) tableRows.data 键重映射
  const rowsStore = tx.objectStore('tableRows')
  let rcursor = await rowsStore.openCursor()
  while (rcursor) {
    const rec = rcursor.value as TableRow
    const map = rec.tabId ? renameMap[rec.tabId] : undefined
    if (map && rec.data) {
      let changed = false
      const data = { ...rec.data }
      for (const [oldKey, newKey] of Object.entries(map)) {
        if (data[oldKey] !== undefined && data[oldKey] !== '') {
          // 避免覆盖同表已存在的目标键数据
          if (data[newKey] === undefined || data[newKey] === '') data[newKey] = data[oldKey]
          delete data[oldKey]
          changed = true
        }
      }
      if (changed) await rowsStore.put({ ...rec, data })
    }
    rcursor = await rcursor.continue()
  }
  // 2) 自定义下拉选项的 settingsKV 键中列名段重映射
  // key 形如 customOption::<pid>::<tabId>::<colName>
  const skStore = tx.objectStore('settingsKV')
  let skCursor = await skStore.openCursor()
  while (skCursor) {
    const key = skCursor.key as string
    if (key.startsWith('customOption::')) {
      const parts = key.split('::')
      if (parts.length >= 4) {
        const tabId = parts[2]
        const colName = parts[3]
        const newCol = renameMap[tabId]?.[colName]
        if (newCol) {
          const newKey = `customOption::${parts[1]}::${tabId}::${newCol}`
          if (newKey !== key) {
            await skStore.put({ key: newKey, value: (skCursor.value as { value: unknown }).value })
            await skStore.delete(key)
          }
        }
      }
    }
    skCursor = await skCursor.continue()
  }
}

/** v7 → v8 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
export function migrateV7toV8(tx: Vtx) {
  // ---- v7 → v8 迁移：快照表加 projectId / chapterId 索引（按项目/章节查快照不再全表扫） ----
  const snapStore = tx.objectStore('snapshots')
  if (!snapStore.indexNames.contains('projectId')) snapStore.createIndex('projectId', 'projectId', { unique: false })
  if (!snapStore.indexNames.contains('chapterId')) snapStore.createIndex('chapterId', 'chapterId', { unique: false })
}

/** v8 → v9 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
export function migrateV8toV9(tx: Vtx) {
  // ---- v8 → v9 迁移：tableRows 加 tabId 索引（#020 索引查询取代每表全扫） ----
  const trStore = tx.objectStore('tableRows')
  if (!trStore.indexNames.contains('tabId')) trStore.createIndex('tabId', 'tabId', { unique: false })
}

/** v9 → v10 迁移：新增酒馆模式「推演报告」独立存储（方案 §3.4） */
export function migrateV9toV10(db: Vdb) {
  // 报告单独成表，不写回任何项目表（作者已定：酒馆模式只诊断、不动数据）
  const store = db.createObjectStore('tavernReports', { keyPath: 'id' })
  // 按 projectId 建索引：报告列表按当前项目过滤，避免列个清单就全表扫
  store.createIndex('projectId', 'projectId', { unique: false })
}
