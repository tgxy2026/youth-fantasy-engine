import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb'
import type { Project, Volume, Chapter, FormData, TableRow, CardRecord } from './types'
import type { StoreOps } from './storeOps'
import { DESKTOP, desktopStore, flushDesktop } from './desktop'
import {
  CLOUD_FILE_SYNC, desktopCloudStore, applyDesktopCloudFromPersisted,
  pullDesktopSnapshot, isDesktopCloudUnavailable, enableDesktopCloud, disableDesktopCloud,
  seedDesktopFromLocal, onDesktopSyncConflict, persistDesktopCloudEnabled, onDesktopCloudFallback,
  clearDesktopCloudEnabledFlag, flushDesktopCloud, snapshotDesktopCloudCache,
  CONFLICT_KEY_PREFIX, isExcludedMetaKey,
  type SyncConflictInfo,
} from './desktopCloudSync'
import { SYNC_STORES, totalRecords } from './syncCore'
import { uid } from './id'
import { countWords } from './textStats'
import { todayKey } from './date'
import { chapterSeqMap, flattenChapters } from './chapterSeq'
// 酒馆模式报告类型：该模块只导出类型、不引用任何运行时模块，故不构成循环依赖
import type { TavernReport } from './tavern/types'

const DB_NAME = 'novel-studio'
const DB_VERSION = 10

let dbPromise: Promise<IDBPDatabase> | null = null
/** 当前打开的项目 id（App 切换项目时设置） */
let currentProjectId = ''

export function setCurrentProject(id: string) {
  currentProjectId = id
}
export function getCurrentProjectId() {
  return currentProjectId
}

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
function migrateFreshInstall(db: Vdb) {
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
async function migrateV1toV2(db: Vdb, tx: Vtx) {
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
function migrateV2toV3(db: Vdb) {
  // ---- v2 → v3 迁移：新增 快照 / 每日统计 / 项目设置 / 回收站 ----
  const snapStore = db.createObjectStore('snapshots', { keyPath: 'id' })
  snapStore.createIndex('projectId', 'projectId', { unique: false })
  snapStore.createIndex('chapterId', 'chapterId', { unique: false })
  db.createObjectStore('dailyStats', { keyPath: 'key' })
  db.createObjectStore('settingsKV', { keyPath: 'key' })
  db.createObjectStore('trash', { keyPath: 'id' })
}

/** v3 → v4 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
async function migrateV3toV4(tx: Vtx) {
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
async function migrateV4toV5(tx: Vtx) {
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
function migrateV5toV6(db: Vdb) {
  // ---- v5 → v6 迁移：新增「自动备份」独立存储 ----
  // 自动备份按项目独立存放，删除项目时不会被清掉（见 deleteProject）
  db.createObjectStore('backups', { keyPath: 'id' })
}

/** v6 → v7 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
async function migrateV6toV7(tx: Vtx) {
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
function migrateV7toV8(tx: Vtx) {
  // ---- v7 → v8 迁移：快照表加 projectId / chapterId 索引（按项目/章节查快照不再全表扫） ----
  const snapStore = tx.objectStore('snapshots')
  if (!snapStore.indexNames.contains('projectId')) snapStore.createIndex('projectId', 'projectId', { unique: false })
  if (!snapStore.indexNames.contains('chapterId')) snapStore.createIndex('chapterId', 'chapterId', { unique: false })
}

/** v8 → v9 迁移（自 getDB upgrade 回调逐行搬出，语句未改） */
function migrateV8toV9(tx: Vtx) {
  // ---- v8 → v9 迁移：tableRows 加 tabId 索引（#020 索引查询取代每表全扫） ----
  const trStore = tx.objectStore('tableRows')
  if (!trStore.indexNames.contains('tabId')) trStore.createIndex('tabId', 'tabId', { unique: false })
}

/** v9 → v10 迁移：新增酒馆模式「推演报告」独立存储（方案 §3.4） */
function migrateV9toV10(db: Vdb) {
  // 报告单独成表，不写回任何项目表（作者已定：酒馆模式只诊断、不动数据）
  const store = db.createObjectStore('tavernReports', { keyPath: 'id' })
  // 按 projectId 建索引：报告列表按当前项目过滤，避免列个清单就全表扫
  store.createIndex('projectId', 'projectId', { unique: false })
}

function getDB() {
  if (!dbPromise) {
    // 失败时重置缓存，避免 rejected promise 被永久缓存（如隐私模式打开失败后所有调用都失败）
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        // 各段迁移已拆到本文件上方的独立函数；此处是「何时跑哪一段」的唯一判断点。
        if (oldVersion === 0) migrateFreshInstall(db)
        else if (oldVersion < 2) await migrateV1toV2(db, tx)
        if (oldVersion < 3) migrateV2toV3(db)
        if (oldVersion < 4) await migrateV3toV4(tx)
        if (oldVersion < 5) await migrateV4toV5(tx)
        if (oldVersion < 6) migrateV5toV6(db)
        if (oldVersion < 7) await migrateV6toV7(tx)
        if (oldVersion < 8) migrateV7toV8(tx)
        if (oldVersion < 9) migrateV8toV9(tx)
        if (oldVersion < 10) migrateV9toV10(db)
      },
    }).catch(err => {
      // 失败时重置缓存，避免 rejected promise 被永久缓存（如隐私模式下打开失败后所有后续调用都失败）
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

// ============ 存储适配层 ============
// 桌面模式（Electron 安装版）：desktopStore —— 内存数据 + 防抖写回本机用户数据目录的 JSON 文件
// 浏览器兜底（dev 预览 / 无 Electron 环境）：IndexedDB（idb 封装）—— 不参与发布
// 两种实现共用同一组原语，上层所有函数签名与行为保持一致，组件层零改动。

const idbOps: StoreOps = {
  getAll: async store => (await getDB()).getAll(store),
  get: async (store, key) => (await getDB()).get(store, key),
  put: async (store, value) => { await (await getDB()).put(store, value) },
  del: async (store, key) => { await (await getDB()).delete(store, key) },
  getAllByIndex: async <T>(store: string, indexName: string, value: unknown): Promise<T[]> =>
    (await getDB()).getAllFromIndex(store, indexName, value as IDBValidKey) as Promise<T[]>,
  bulkPut: async (store, values) => {
    const d = await getDB()
    const tx = d.transaction(store, 'readwrite')
    const os = tx.objectStore(store)
    for (const v of values) await os.put(v)
    await tx.done
  },
  bulkDel: async (store, keys) => {
    if (keys.length === 0) return
    const d = await getDB()
    const tx = d.transaction(store, 'readwrite')
    const os = tx.objectStore(store)
    for (const k of keys) await os.delete(k)
    await tx.done
  },
}

let ops: StoreOps = DESKTOP ? desktopStore : idbOps

// #005 冲突备份：云盘与本机都改过同一条记录时，本地优先采用，
// 但云端那版不再无声丢弃 —— 另存本地副本供用户比对恢复。副本只落**当前平台的本地存储**，
// key 以 syncConflict: 开头，由 isExcludedMetaKey 保证不上传云端。
//
// 🔴 2026-09-15 修复：此前这里订阅的是**网页版** serverStore 的冲突回调，而桌面版云盘同步
//    用的是 desktopCloudSync 的**独立实例** —— 那个实例的 conflictHandler 从未被注册，
//    syncCore 里的 `conflictHandler?.()` 全走空，于是三路合并冲突时**云端那版被静默丢弃**，
//    saveConflictCopy 全程不会执行（改副本落点时才发现这个真因）。现改订桌面实例。
onDesktopSyncConflict((info: SyncConflictInfo) => {
  void saveConflictCopy(info)
})

// 🔴 P0 兜底：云盘**推不出去**的时刻，把内存 cache 镜像进本地存储。
//
// 为什么需要它：云模式下 `ops` 是云端实例，写入先进 syncCore 的内存 cache，再由防抖 schedulePush
// 推到同步目录。若推送被挡（断网 / 网盘客户端占用文件 / 目录不可写 / 凭据失效），这批改动就**只在内存里** ——
// 而关窗兜底的 flushDesktopSync() 写的是 desktopStore（云模式下根本不经过它）→ 两边都没有，**关窗丢稿**。
//
// ⚠️ 为什么不干脆每次都双写：那会破坏「云模式下普通 store 不写本地」的常态约定
// （本地作为「最后一次成功同步的快照」，混入未上传的改动会让它与云端分歧）。
// 所以只在异常路径兜底 —— 宁可本地暂时多一份，也不能让稿子凭空消失。
//
// 注：回调里的 desktopLocalStore 是模块级 const，注册时尚未初始化，但回调只在关窗/异常时才执行，届时已就绪。
/**
 * 把云端内存 cache 镜像进**当前平台的本地存储**（异常兜底与「关闭同步」共用）。
 *
 * 返回 Promise —— 「关闭同步」必须**等它写完**再切 ops 并 reload，否则写了一半就被打断。
 * 异常兜底那条路（pagehide/关窗）仍是 fire-and-forget，与原先一致。
 */
async function mirrorCloudCacheToLocal(cache: Record<string, any[]>): Promise<void> {
  const tasks: Promise<unknown>[] = []
  for (const [store, rows] of Object.entries(cache)) {
    if (store === 'backups') continue
    const list = store === 'meta'
      ? (rows as any[]).filter(r => !isExcludedMetaKey(r?.key))
      : (rows as any[])
    if (list.length) tasks.push(desktopLocalStore.bulkPut(store, list).catch(() => {}))
  }
  await Promise.all(tasks)
}

onDesktopCloudFallback((cache) => { void mirrorCloudCacheToLocal(cache) })

async function saveConflictCopy(info: SyncConflictInfo) {
  try {
    // 🔴 必须写**当前平台的本地存储**，不能固定写 idbOps：
    //    桌面版的数据在用户目录的 JSON 文件里，冲突副本写进 IndexedDB 等于扔进没人打开的抽屉
    //    （界面读的是 desktopLocalStore），作者永远看不到「云端那版」。
    await desktopLocalStore.put('meta', {
      key: `${CONFLICT_KEY_PREFIX}${info.at}:${info.store}:${String(info.key)}`,
      value: {
        store: info.store,
        key: info.key,
        at: info.at,
        local: info.local,
        server: info.server,
      },
    })
    try {
      // 让用户知道「发生了冲突、云端那版已留副本」——否则存了副本也没人看得见
      window.dispatchEvent(
        new CustomEvent('yfe:sync-conflict', { detail: { store: info.store, key: info.key } }),
      )
    } catch {
      /* 忽略 */
    }
  } catch {
    /* 副本保存失败绝不影响主同步流程 */
  }
}

// 云端同步包装层工厂（#003）：在云端 StoreOps 之上叠加「本地回退」与「敏感 meta 不上云」特权。
// 云盘文件同步（desktopCloudStore / desktopStore）与浏览器兜底（null / idbOps）共用同一套包装逻辑，
// 仅传入各自的云端实例、本地实例与「不可用判定」。
// #008：云端不可用时透明回退本地，保证用户看到的始终是自己的数据，而非空白缓存。
// 🔬 导出仅供单测（tests/cloudStoreWrapper.test.ts）：本函数是纯工厂、无副作用，
// 且「backups 落本地 / 敏感 meta 不上云 / 云端不可用回退本地」三条语义都只在这里，
// 不导出就无法在不跑浏览器的前提下锁住它们（与 setStoreOps 同理）。
export function makeCloudStoreWrapper(cloud: StoreOps, local: StoreOps, isUnavailable: () => boolean): StoreOps {
  async function cloudOrLocal(op: keyof StoreOps, ...args: any[]): Promise<any> {
    // 🔴 backups 是「本地专属保险」(#026)：syncCore.liveStores 上传前会把它从载荷里剔除
    // （云端永不参与备份的增删）。因此这里必须直接落本地——否则会出现「云端不要、本地不写」
    // 的两头不靠：备份只存在于云端实例的内存 cache 里，刷新/关页即丢，备份列表还会显示为空。
    // 与下面「敏感 meta 走本地」同构，故在唯一入口处统一短路，覆盖 getAll/get/put/del/bulkPut/bulkDel。
    if (args[0] === 'backups') return (local as any)[op](...args)
    if (isUnavailable()) return (local as any)[op](...args)
    const r = await (cloud as any)[op](...args)
    return isUnavailable() ? (local as any)[op](...args) : r
  }
  return {
    getAll: async <T,>(store: string): Promise<T[]> => {
      if (store !== 'meta') return cloudOrLocal('getAll', store)
      if (isUnavailable()) return local.getAll<T>('meta')
      const localMeta = (await local.getAll<T>('meta')).filter((r: any) => isExcludedMetaKey(r.key))
      const cloudMeta = await cloud.getAll<T>('meta')
      if (isUnavailable()) return local.getAll<T>('meta')
      return [...localMeta, ...cloudMeta] as T[]
    },
    get: async <T,>(store: string, key: string): Promise<T | undefined> => {
      if (store === 'meta' && isExcludedMetaKey(key)) return local.get<T>('meta', key)
      return cloudOrLocal('get', store, key)
    },
    put: async (store: string, value: any) => {
      if (store === 'meta' && isExcludedMetaKey(value?.key)) return local.put('meta', value)
      return cloudOrLocal('put', store, value)
    },
    del: async (store: string, key: string) => {
      if (store === 'meta' && isExcludedMetaKey(key)) return local.del('meta', key)
      return cloudOrLocal('del', store, key)
    },
    getAllByIndex: async <T,>(store: string, indexName: string, value: unknown): Promise<T[]> =>
      cloudOrLocal('getAllByIndex', store, indexName, value),
    bulkPut: async (store: string, values: any[]) => {
      if (store === 'meta') {
        const excl = values.filter((v) => isExcludedMetaKey(v?.key))
        const rest = values.filter((v) => !isExcludedMetaKey(v?.key))
        if (excl.length) await local.bulkPut('meta', excl)
        if (rest.length) {
          if (isUnavailable()) return local.bulkPut('meta', rest)
          await cloud.bulkPut('meta', rest)
          if (isUnavailable()) await local.bulkPut('meta', rest)
        }
        return
      }
      return cloudOrLocal('bulkPut', store, values)
    },
    bulkDel: async (store: string, keys: string[]) => {
      if (store === 'meta') {
        const excl = keys.filter((k) => isExcludedMetaKey(k))
        const rest = keys.filter((k) => !isExcludedMetaKey(k))
        if (excl.length) await local.bulkDel('meta', excl)
        if (rest.length) {
          if (isUnavailable()) return local.bulkDel('meta', rest)
          await cloud.bulkDel('meta', rest)
          if (isUnavailable()) await local.bulkDel('meta', rest)
        }
        return
      }
      return cloudOrLocal('bulkDel', store, keys)
    },
  }
}

// 云盘文件同步包装层（desktopCloudStore 之上叠加本地回退）。
// 本地回退目标为平台基础本地存储（桌面=desktopStore，浏览器兜底=idbOps）。
const desktopLocalStore: StoreOps = DESKTOP ? desktopStore : idbOps
const desktopCloudFileStore: StoreOps = makeCloudStoreWrapper(desktopCloudStore, desktopLocalStore, isDesktopCloudUnavailable)

// 云盘文件同步（#032 起已去掉同步码）：启动时若持久化过同步目录，则自动切到云端文件存储。
// 数据以加密文件落在用户选定的云盘目录（OneDrive / 坚果云 / WPS 云盘等客户端负责搬运），
// 全程不依赖任何服务器。失败一律回退到本地存储，不会让界面变成空白。
if (CLOUD_FILE_SYNC) {
  void (async () => {
    try {
      const ok = await applyDesktopCloudFromPersisted()
      if (ok) {
        // 🔴 切换前必须先确认云端**真的**有数据。
        //    同步目录里的 .yfe 被删掉、或还没从网盘客户端下载下来时，读到的是
        //    rev=0 + 空 stores —— 会被当成「空库」直接切过去，界面瞬间变成空项目，
        //    进而触发示范项目播种、反写覆盖云端快照（用户看到的是"我的书全没了"）。
        //    这与 enableDesktopCloudSync 的空快照守卫同构：那边是「空则播种」，这边是「空则不切」。
        let empty = true
        try {
          const snap = await pullDesktopSnapshot()
          empty = totalRecords(snap.stores) === 0
        } catch {
          // 拉取失败（文件损坏 / 网盘未就绪）→ 保持本地存储，绝不把界面切空；
          // 同时清掉「已开启」标记，免得界面显示在同步而 ops 其实是本地。
          clearDesktopCloudEnabledFlag()
          return
        }
        if (empty) {
          // 云端为空：留在本地（用户显式开启同步时才播种上传）；标记同样要清，别撒谎。
          // 目录偏好保留 —— 网盘把 .yfe 同步下来之后再选一次目录即可。
          clearDesktopCloudEnabledFlag()
          return
        }
        ops = desktopCloudFileStore
      }
    } catch {
      /* 持久化读取失败 → 保持本地存储 */
    }
  })()
}

/** 运行时切换底层存储（云端同步特权开启时切到 cloudStore / desktopCloudFileStore） */
export function setStoreOps(o: StoreOps) {
  ops = o
}

/**
 * 开启云盘文件同步（#031 引入，#032 去掉同步码）。
 * 数据以加密文件落在用户选定的云盘同步目录，全程不依赖服务器。
 * 加密使用内置默认密钥（DEFAULT_CLOUD_KEY），所有设备一致 → 指向同一目录即可互通，无需输入任何码。
 * @param handle 同步目录句柄（桌面版为目录路径字符串）
 */
/**
 * 抓一份「当前 ops 里参与同步的数据」快照。
 * 只给「换同步目录」这类**必须在 configure() 之前**取数的场合用。
 */
async function captureSyncData(): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {}
  for (const s of SYNC_STORES) {
    if (s === 'backups') continue
    try {
      out[s] = (await ops.getAll(s)) || []
    } catch {
      out[s] = []
    }
  }
  return out
}

export async function enableDesktopCloudSync(handle: any) {
  // 🔴 必须在 enableDesktopCloud() **之前**把当前数据抓下来：
  //    enableDesktopCloud → configure() 会清空 syncCore 的单例 cache，而「同步本来就开着、
  //    只是换/重选目录」时 ops 正指向**同一个**单例 → 播种读到的是全空，
  //    于是把一份空快照写进新目录（界面看起来「书全没了」，还会被同步到其他设备）。
  const carry = await captureSyncData()
  await enableDesktopCloud(handle)
  const snap = await pullDesktopSnapshot()
  const empty = totalRecords(snap.stores) === 0
  if (empty) {
    // 新目录还是空的 → 用刚才抓下来的数据播种（不能用「此刻的 ops」，它可能已被清空）
    await seedDesktopFromLocal((s) => Promise.resolve(carry[s] ?? []))
  }
  // 🔴 持久化必须在**上面全部成功之后**：原先写在 enableDesktopCloud 内部（即拉快照之前），
  //    拉快照 / 播种失败时标记已落盘 → 下次启动 UI 仍显示「已开启」，实际却走本地存储（界面撒谎）。
  persistDesktopCloudEnabled(handle)
  setStoreOps(desktopCloudFileStore)
}

/**
 * 关闭云盘文件同步，并切回平台默认本地存储。调用方应随后刷新页面。
 *
 * 🔴 审计 2026-09-17（P1-1）：必须**先 flush + 把云端数据镜像进本地**，再切回本地库。
 *    原实现直接 `disableDesktopCloud()`（= `cloud.configure('')`，清空内存 cache）后
 *    `setStoreOps(desktopLocalStore)` —— 而云模式下本地库自「开启同步」那一刻起就没再更新过
 *    （见 enableDesktopCloudSync 末尾的 setStoreOps(desktopCloudFileStore)），于是关闭后
 *    界面读到的是**启用同步之前的陈旧本地库**：同步期间写的内容会从界面「消失」
 *    （云端 .yfe 仍在，重开同目录可找回），而缓冲里未推送的改动（防抖窗口内）**不可逆丢失**。
 */
export async function disableDesktopCloudSync() {
  // 1) 先把未推送的改动推出去（推不出去时 flushNow 内部会走 fallback 兜底写本地）
  await flushDesktopCloud()
  // 2) 把云端当前数据镜像进本地库 —— 关闭后界面读的就是这份，不再「少一截」
  await mirrorCloudCacheToLocal(snapshotDesktopCloudCache())
  // 3) 落盘（桌面版走 JSON 文件；非桌面是空操作），确保 reload 前已持久化
  await flushDesktop().catch(() => {})
  // 4) 清标记、复位传输层，切回本地
  disableDesktopCloud()
  setStoreOps(desktopLocalStore)
}

// ============ 项目 ============
// 旧版项目形态 'lite'(精简) / 'minimal'(极简) 已移除；把存储中残留的旧值归一化为 'full'
// （等同旧版"全功能可见"回退行为，避免神秘降级）。读取即归一化，写回迁移见 migrateProjectTypes。
function isLegacyProjectType(t: unknown): t is 'lite' | 'minimal' {
  return t === 'lite' || t === 'minimal'
}
function normalizeProject(p: Project): Project {
  if (isLegacyProjectType(p.projectType)) return { ...p, projectType: 'full' }
  return p
}
export async function getAllProjects(): Promise<Project[]> {
  const all = (await ops.getAll<Project>('projects')).map(normalizeProject)
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}
export async function getProject(id: string): Promise<Project | undefined> {
  const p = await ops.get<Project>('projects', id)
  return p ? normalizeProject(p) : undefined
}
/** 一次性迁移：把存储中所有残留的 lite/minimal 项目形态写回为 'full'，真正清理历史数据（幂等，无旧值则不写库） */
export async function migrateProjectTypes(): Promise<number> {
  const all = await ops.getAll<Project>('projects')
  let changed = 0
  for (const p of all) {
    if (isLegacyProjectType(p.projectType)) {
      await ops.put('projects', { ...p, projectType: 'full' })
      changed++
    }
  }
  return changed
}
export async function createProject(name: string, genre = '', intro = '', cover = '', projectType: 'full' | 'custom' = 'full', features?: string[]): Promise<Project> {
  const now = Date.now()
  const p: Project = { id: uid(), name, genre, intro, ...(cover ? { cover } : {}), projectType, ...(features ? { features } : {}), createdAt: now, updatedAt: now }
  await ops.put('projects', p)
  return p
}
export async function updateProject(patch: Partial<Project> & { id: string }) {
  const old = await ops.get<Project>('projects', patch.id)
  if (!old) return
  await ops.put('projects', { ...old, ...patch, updatedAt: Date.now() })
}
export async function touchProject(id: string) {
  const old = await ops.get<Project>('projects', id)
  if (old) await ops.put('projects', { ...old, updatedAt: Date.now() })
}
/** 删除项目及其全部数据 */
export async function deleteProject(id: string) {
  // 章节行在下面那轮按 projectId 批量删，这里不必先全表读一遍 chapters（曾只为快照守卫而读）
  await ops.del('projects', id)
  // 收集各 store 待删主键，统一批量删除
  const delKeys: Record<string, string[]> = {}
  // tavernReports 也是项目级数据（报告随项目走），务必一并清理，否则项目删了报告还在
  for (const name of ['volumes', 'chapters', 'tableRows', 'cardRecords', 'trash', 'tavernReports'] as const) {
    const all = await ops.getAll<{ id: string; projectId?: string }>(name)
    const keys = all.filter(r => r.projectId === id).map(r => r.id)
    if (keys.length) delKeys[name] = keys
  }
  const forms = await ops.getAll<FormData>('formData')
  const formKeys = forms.filter(f => f.tabId.startsWith(`${id}::`)).map(f => f.tabId)
  // 快照按 projectId 索引批量取。
  // 🔴 不能挂 `chapterIds.size` 这个前提：章节全在回收站时 chapters 为空 → 该项目的快照
  //    一份都不删，成了界面上永远看不到、却持续进云载荷的孤儿。
  const snapKeys = (await ops.getAllByIndex<Snapshot>('snapshots', 'projectId', id)).map(s => s.id)
  // 每日统计与设置按 projectId 前缀（含项目独立自定义下拉选项 customOption::<projectId>::...）
  const statKeys: string[] = []
  const setKeys: string[] = []
  const daily = await ops.getAll<{ key: string }>('dailyStats')
  for (const r of daily) if (r.key.startsWith(`${id}::`)) statKeys.push(r.key)
  const settings = await ops.getAll<{ key: string }>('settingsKV')
  for (const r of settings) if (r.key.startsWith(`${id}::`) || r.key.startsWith(`customOption::${id}::`)) setKeys.push(r.key)

  for (const [name, keys] of Object.entries(delKeys)) await ops.bulkDel(name, keys)
  if (formKeys.length) await ops.bulkDel('formData', formKeys)
  if (snapKeys.length) await ops.bulkDel('snapshots', snapKeys)
  if (statKeys.length) await ops.bulkDel('dailyStats', statKeys)
  if (setKeys.length) await ops.bulkDel('settingsKV', setKeys)
}

// ============ 卷 ============
export async function getAllVolumes(): Promise<Volume[]> {
  const all = await ops.getAll<Volume>('volumes')
  return all.filter(v => v.projectId === currentProjectId).sort((a, b) => a.order - b.order)
}
export async function saveVolume(v: Volume) {
  await ops.put('volumes', { ...v, projectId: v.projectId || currentProjectId })
  touchProject(currentProjectId)
}
export async function deleteVolume(id: string) {
  const allCh = await ops.getAll<Chapter>('chapters')
  const now = Date.now()
  await ops.del('volumes', id)
  for (const c of allCh) {
    if (c.projectId === currentProjectId && c.volumeId === id) {
      await ops.put('trash', { ...c, deletedAt: now, kind: 'chapter' })
      await ops.del('chapters', c.id)
      await ops.del('tableRows', `ch-${c.id}`)
      // 级联清理该章的「时光机」快照，避免删除后孤儿快照在库里无限堆积
      const volSnaps = await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', c.id)
      if (volSnaps.length) await ops.bulkDel('snapshots', volSnaps.map(s => s.id))
    }
  }
}

// ============ 章 ============
export async function getAllChapters(): Promise<Chapter[]> {
  const all = await ops.getAll<Chapter>('chapters')
  return all
    .filter(c => c.projectId === currentProjectId)
    .sort((a, b) => {
      const av = a.volumeId ?? ''
      const bv = b.volumeId ?? ''
      if (av !== bv) return av.localeCompare(bv)
      return a.order - b.order
    })
}
export async function saveChapter(c: Chapter) {
  const old = await ops.get<Chapter>('chapters', c.id)
  await ops.put('chapters', { ...c, projectId: c.projectId || currentProjectId })
  // 记录当日码字增量（正负都记，累加）
  if (old && old.wordCount !== c.wordCount) {
    await addDailyWords(c.wordCount - old.wordCount)
  }
  // 时光机：内容有变化时按策略快照（距上次快照 >5 分钟 或 字数差 >200）
  if (old && old.content !== c.content) {
    const snaps = await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', c.id)
    const last = snaps.sort((a, b) => b.createdAt - a.createdAt)[0]
    const diff = Math.abs(countWords(c.content) - countWords(old.content))
    if (!last || Date.now() - last.createdAt > 5 * 60 * 1000 || diff > 200) {
      await createSnapshot(c)
    }
  }
  touchProject(currentProjectId)
}

/** 删除章节 → 移入回收站（可恢复），并级联删除总表联动行 */
export async function deleteChapter(id: string) {
  const ch = await ops.get<Chapter>('chapters', id)
  if (ch) {
    await ops.put('trash', { ...ch, deletedAt: Date.now(), kind: 'chapter' })
  }
  await ops.del('chapters', id)
  await ops.del('tableRows', `ch-${id}`)
  // 级联清理该章的「时光机」快照
  const chSnaps = await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', id)
  if (chSnaps.length) await ops.bulkDel('snapshots', chSnaps.map(s => s.id))
}

// ============ 表单数据 ============
export async function getFormData(tabId: string): Promise<Record<string, string>> {
  const rec = await ops.get<FormData>('formData', `${currentProjectId}::${tabId}`)
  return rec?.data ?? {}
}
export async function saveFormData(tabId: string, data: Record<string, string>) {
  await ops.put('formData', { tabId: `${currentProjectId}::${tabId}`, data } as FormData)
  touchProject(currentProjectId)
}

// ============ 表格行 ============
export async function getTableRows(tabId: string): Promise<TableRow[]> {
  // #020：走 tabId 索引只取本表行，避免每开一张表就全表扫（portable/desktop/cloud 三端
  // 的 getAllByIndex 均按字段过滤，等价于索引查询；仅 idb 端真正用 IndexedDB 索引）。
  const rows = await ops.getAllByIndex<TableRow>('tableRows', 'tabId', tabId)
  return rows
    .filter(r => r.projectId === currentProjectId)
    .sort((a, b) => a.order - b.order)
}
export async function saveTableRow(row: TableRow) {
  await ops.put('tableRows', { ...row, projectId: row.projectId || currentProjectId, updatedAt: Date.now() })
  touchProject(currentProjectId)
}
export async function deleteTableRow(id: string) {
  await ops.del('tableRows', id)
}

// ============ 卷台账（按卷建表） ============
/** 卷台账表的 tabId 前缀（与 schema.getVolumeLedgerTabId 保持一致，避免循环依赖此处直接拼） */
const VOL_LEDGER_PREFIX = 'chapter-vol-'

/**
 * 聚合所有卷的章节台账行（按卷建表后，章节台账分散在 chapter-vol-<volumeId> 各表中）。
 * 返回打平的 TableRow[]，供伏笔引擎 / 一致性核查 / 全文检索 / 情节推演等需要"全卷视角"的地方使用。
 */
export async function getAllChapterLedgerRows(): Promise<TableRow[]> {
  const vols = await getAllVolumes()
  const out: TableRow[] = []
  for (const v of vols) {
    const rows = await getTableRows(`${VOL_LEDGER_PREFIX}${v.id}`)
    out.push(...rows)
  }
  return out
}

/** 章节移动卷后，清理其在"其它卷台账表"里的孤儿行（行 id 形如 ch-<chapterId>，跨表唯一） */
export async function purgeLedgerRowEverywhere(chId: string, exceptVolumeId: string) {
  const rid = `ch-${chId}`
  const all = await ops.getAll<TableRow>('tableRows')
  const targets = all.filter(
    r => r.projectId === currentProjectId && r.id === rid && r.tabId !== `${VOL_LEDGER_PREFIX}${exceptVolumeId}`,
  )
  if (targets.length) await ops.bulkDel('tableRows', targets.map(t => t.id))
}

/**
 * 旧版「单张章节总表 + 所属卷自引用」迁移到「按卷建表」。
 * 幂等：若 chapter-master 已无行则直接返回。迁移前不删原数据，成功后再清空旧表。
 * 卷定义行（所属卷为空）转为 volumes 库记录；章行按所属卷归入对应卷台账表，并剥离「所属卷」列。
 */
export async function migrateChapterLedger() {
  const pid = currentProjectId
  if (!pid) return
  const old = (await ops.getAll<TableRow>('tableRows'))
    .filter(r => r.projectId === pid && r.tabId === 'chapter-master')
  if (old.length === 0) return
  const vols = await getAllVolumes()
  const titleToVolId = new Map<string, string>()
  const ensureVolume = async (title: string): Promise<string | null> => {
    const t = title.trim()
    if (!t) return null
    const hit = vols.find(v => v.title === t)
    if (hit) return hit.id
    const vol = { id: uid(), projectId: pid, order: vols.length, title: t, description: '', createdAt: Date.now() }
    await ops.put('volumes', vol)
    vols.push(vol)
    return vol.id
  }
  // 1) 先处理卷定义行，建立 卷名→卷id 映射
  for (const r of old) {
    if ((r.data['所属卷'] ?? '').trim() === '') {
      const vid = await ensureVolume(r.data['章节标题'] ?? '')
      if (vid) titleToVolId.set(r.data['章节标题'] ?? '', vid)
    }
  }
  // 2) 章行按所属卷归入对应卷台账表
  const movedIds = new Set<string>()
  for (const r of old) {
    const volTitle = (r.data['所属卷'] ?? '').trim()
    if (volTitle === '') continue
    let vid: string | null = titleToVolId.get(volTitle) ?? null
    if (!vid) {
      vid = await ensureVolume(volTitle)
      if (vid) titleToVolId.set(volTitle, vid)
    }
    if (!vid) continue
    const { '所属卷': _drop, ...data } = r.data
    // 行 id 保持不变（编辑器用 ch-<chapterId> 定位台账行），原地改 tabId 覆盖写
    await ops.put('tableRows', { ...r, tabId: `${VOL_LEDGER_PREFIX}${vid}`, data })
    movedIds.add(r.id)
  }
  // 3) 清空旧表：只删「未被迁移覆盖写」的行（卷定义行等）。
  //    ⚠️ 迁移走的行 id 未变，若按旧 id 全删会把刚写入新表的行一起删掉（数据丢失，1.9.2 审计修复）
  const stale = old.filter(r => !movedIds.has(r.id)).map(r => r.id)
  if (stale.length) await ops.bulkDel('tableRows', stale)
}

/**
 * 1.9.2：把各卷台账的「章节号」重算为**全局连续**号（此前是卷内独立编号）。
 * 序号本身是派生的，这里只是把显示用的字符串刷成最新值；
 * 幂等——跑第二次时每行都已是目标值，不会重复写库。
 * 「不计入序号」的章保持作者手填的原值（如「番外」），不被清空。
 */
export async function migrateChapterNumbering(): Promise<void> {
  const pid = currentProjectId
  if (!pid) return
  const [vols, chs] = await Promise.all([getAllVolumes(), getAllChapters()])
  if (chs.length === 0) return
  const seqs = chapterSeqMap(vols, chs)
  // 按卷预取台账行，避免逐章重复读库
  const byTab = new Map<string, TableRow[]>()
  for (const v of vols) {
    const tabId = `${VOL_LEDGER_PREFIX}${v.id}`
    byTab.set(tabId, await getTableRows(tabId))
  }
  const writes: Promise<void>[] = []
  flattenChapters(vols, chs).forEach((c, i) => {
    const no = seqs.get(c.id) ?? 0
    const row = byTab.get(`${VOL_LEDGER_PREFIX}${c.volumeId}`)?.find(r => r.id === `ch-${c.id}`)
    if (!row) return
    const want = no > 0 ? `第${no}章` : (row.data['章节号'] ?? '')
    if (row.data['章节号'] === want && row.order === i) return
    writes.push(saveTableRow({ ...row, data: { ...row.data, '章节号': want }, order: i }))
  })
  await Promise.all(writes)
}

/**
 * 多地图迁移（2.1.0 · 地图列表方案 B）：
 * 把「升级前唯一的那块画布」登记为一张「默认地图」，并把现有《地理风物》行全部归入它 ——
 * 升级后打开与升级前**完全一致**（零感知）。
 *
 * 幂等：已有地图行时不再新建，只回填「所属地图」为空的地理行。
 * 格档沿用旧的全局设置 `geoMapCellKm`（原实现把每格公里存在 setting 里）。
 */
export async function migrateGeoMaps(): Promise<number> {
  const pid = currentProjectId
  if (!pid) return 0
  const rows = await ops.getAll<TableRow>('tableRows')
  const maps = rows.filter(r => r.projectId === pid && r.tabId === 'geomaps')
  let changed = 0

  let defaultName = maps[0]?.data?.['名称']
  if (!maps.length) {
    const legacyKm = await getSetting<number>('geoMapCellKm', 1)
    defaultName = '默认地图'
    await ops.put('tableRows', {
      id: uid(),
      projectId: pid,
      tabId: 'geomaps',
      data: {
        '编号': 'MAP0001',
        '名称': defaultName,
        '每格公里': legacyKm === 10 ? '10' : '1',
        '说明': '升级时自动创建：承接升级前的全部地图内容。',
      },
      order: 0,
      createdAt: Date.now(),
    })
    changed++
  }
  if (!defaultName) return changed

  for (const r of rows) {
    if (r.projectId !== pid || r.tabId !== 'geography') continue
    if (r.data?.['所属地图']) continue
    await saveTableRow({ ...r, data: { ...r.data, '所属地图': defaultName } })
    changed++
  }
  return changed
}

// ============ 迁移统一入口 ============

/**
 * 按序跑完「当前项目」所需的全部结构迁移，幂等。
 *
 * 🔴 调用纪律：**凡把项目置为当前项目（setCurrentProject）后，都必须紧接着调它**——
 *    包括「启动时自动恢复上次项目」和「用户手动打开项目」两条路径。
 *
 * 为什么要有这个统一入口（2026-09-14 审计 P1-7）：
 *   此前迁移入口散落在 App.tsx 的两处调用点，且**两处跑的集合不一样**——
 *   手动 openProject 跑了 ledger + numbering + types 三件，
 *   而启动恢复上次项目那条路径**只跑了 migrateProjectTypes**。
 *   于是「关掉再开 → 自动回到上次项目」这条最常用路径上，旧的单表台账与卷内编号
 *   不会被纠正；期间台账展示、全文检索、AI 上下文都会继续读到旧结构，
 *   直到用户手动重新打开一次项目才自愈——属于「不报错但数据视图不对」的隐性偏差。
 *
 * 顺序要求（不可调换）：
 *   types（归一化项目形态，只碰 projects 库，与另两个独立）
 *   → ledger（把旧单表章节总表拆成按卷台账）
 *   → numbering（重算全局连续章节号）
 *   ⚠️ numbering **必须**排在 ledger 之后：它读写的正是 ledger 拆分后才存在的
 *      `chapter-vol-<卷id>` 台账行；顺序颠倒会对着空表白跑一遍、编号不生效。
 *
 * 注意：这里只做「数据」迁移，不含 UI 侧缓存刷新。调用方若需要刷新侧栏卷页签，
 *       请自行再调 schema.refreshVolumeTabs()——db 层不引用 schema，以免形成循环依赖。
 */
export async function runMigrations(): Promise<void> {
  if (!currentProjectId) return
  await migrateProjectTypes()
  await migrateChapterLedger()
  await migrateChapterNumbering()
  await migrateGeoMaps()
}
// ============ 卡片记录 ============
export async function getCardRecords(tabId: string): Promise<CardRecord[]> {
  const all = await ops.getAll<CardRecord>('cardRecords')
  return all.filter(r => r.projectId === currentProjectId && r.tabId === tabId).sort((a, b) => a.order - b.order)
}
export async function saveCardRecord(rec: CardRecord) {
  await ops.put('cardRecords', { ...rec, projectId: rec.projectId || currentProjectId })
  touchProject(currentProjectId)
}
export async function deleteCardRecord(id: string) {
  await ops.del('cardRecords', id)
}

// ============ 项目统计（项目列表页用，不依赖 currentProjectId） ============
export async function getProjectStats(id: string): Promise<{ chapters: number; words: number; volumes: number }> {
  const [chs, vols] = await Promise.all([ops.getAll<Chapter>('chapters'), ops.getAll<Volume>('volumes')])
  const mine = chs.filter(c => c.projectId === id)
  return {
    chapters: mine.length,
    words: mine.reduce((s, c) => s + (c.wordCount || 0), 0),
    volumes: vols.filter(v => v.projectId === id).length,
  }
}

// ============ 导出 / 导入（JSON 备份） ============
export interface ProjectBundle {
  app: 'youth-fantasy-engine'
  version: number
  exportedAt: number
  project: Project
  volumes: Volume[]
  chapters: Chapter[]
  formData: { tabId: string; data: Record<string, string> }[]
  tableRows: TableRow[]
  cardRecords: CardRecord[]
  dailyStats?: DailyStat[]
  settings?: { key: string; value: unknown }[]
  /** 自定义下拉选项（人物状态等）：key 为 `<tabId>::<colName>`，不含项目前缀 */
  customOptions?: { key: string; value: unknown }[]
  /** 酒馆模式 · 推演报告（可选字段：旧备份没有，导入时按向后兼容处理） */
  tavernReports?: TavernReport[]
}

export async function exportProject(id: string): Promise<ProjectBundle> {
  const project = await ops.get<Project>('projects', id)
  if (!project) throw new Error('项目不存在')
  const [volumes, chapters, formData, tableRows, cardRecords, dailyStats, settingsKV, tavernReports] = await Promise.all([
    ops.getAll<Volume>('volumes'), ops.getAll<Chapter>('chapters'), ops.getAll<FormData>('formData'),
    ops.getAll<TableRow>('tableRows'), ops.getAll<CardRecord>('cardRecords'),
    ops.getAll<DailyStat>('dailyStats'), ops.getAll<{ key: string; value: unknown }>('settingsKV'),
    ops.getAll<TavernReport>('tavernReports'),
  ])
  const prefix = `${id}::`
  const customOptPrefix = `customOption::${id}::`
  return {
    app: 'youth-fantasy-engine',
    version: 3,
    exportedAt: Date.now(),
    project,
    volumes: volumes.filter(v => v.projectId === id),
    chapters: chapters.filter(c => c.projectId === id),
    formData: formData
      .filter(f => f.tabId.startsWith(prefix))
      .map(f => ({ tabId: f.tabId.slice(prefix.length), data: f.data })),
    tableRows: tableRows.filter(r => r.projectId === id),
    cardRecords: cardRecords.filter(r => r.projectId === id),
    dailyStats: dailyStats.filter(s => s.projectId === id),
    settings: settingsKV
      .filter(s => s.key.startsWith(prefix))
      .map(s => ({ key: s.key.slice(prefix.length), value: s.value })),
    customOptions: settingsKV
      .filter(s => s.key.startsWith(customOptPrefix))
      .map(s => ({ key: s.key.slice(customOptPrefix.length), value: s.value })),
    tavernReports: tavernReports.filter(r => r.projectId === id),
  }
}

/** 导入项目：生成全新 projectId / 内部 id，避免与现有数据冲突；返回新项目 id */
export async function importProject(bundle: ProjectBundle): Promise<string> {
  if (!bundle || bundle.app !== 'youth-fantasy-engine' || !bundle.project) {
    throw new Error('不是有效的项目备份文件')
  }
  const newPid = uid()
  const now = Date.now()
  const map = new Map<string, string>() // 旧 chapterId -> 新 id（章节总表联动行名需要同步换）

  await ops.put('projects', {
    ...bundle.project, id: newPid,
    name: bundle.project.name,
    createdAt: now, updatedAt: now,
  } as Project)

  const volMap = new Map<string, string>()
  for (const v of bundle.volumes) {
    const nid = uid()
    volMap.set(v.id, nid)
    await ops.put('volumes', { ...v, id: nid, projectId: newPid })
  }
  for (const c of bundle.chapters) {
    const nid = uid()
    map.set(c.id, nid)
    await ops.put('chapters', { ...c, id: nid, projectId: newPid, volumeId: volMap.get(c.volumeId) ?? c.volumeId })
  }
  for (const f of bundle.formData) {
    await ops.put('formData', { tabId: `${newPid}::${f.tabId}`, data: f.data })
  }
  for (const r of bundle.tableRows) {
    // 联动行（id 形如 ch-xxx）重定向到新章节 id；普通行换新 id
    const m = r.id.match(/^ch-(.+)$/)
    const nid = m && map.has(m[1]) ? `ch-${map.get(m[1])}` : uid()
    // ⚠️ 卷台账行的 tabId 内嵌卷 id（chapter-vol-<volumeId>），必须重映射到新卷 id——
    // 否则导入后台账行指向不存在的卷，章节总表/连续性检查/搜索/AI 上下文的台账数据全部丢失
    const rawTab = String(r.tabId)
    const tabId = rawTab.startsWith(VOL_LEDGER_PREFIX)
      ? `${VOL_LEDGER_PREFIX}${volMap.get(rawTab.slice(VOL_LEDGER_PREFIX.length)) ?? rawTab.slice(VOL_LEDGER_PREFIX.length)}`
      : r.tabId
    await ops.put('tableRows', { ...r, id: nid, tabId, projectId: newPid })
  }
  for (const r of bundle.cardRecords) {
    await ops.put('cardRecords', { ...r, id: uid(), projectId: newPid })
  }
  // 每日统计与设置（可选字段，向后兼容旧备份）
  if (bundle.dailyStats) {
    for (const s of bundle.dailyStats) {
      await ops.put('dailyStats', { ...s, key: `${newPid}::${s.date}`, projectId: newPid })
    }
  }
  if (bundle.settings) {
    for (const s of bundle.settings) {
      await ops.put('settingsKV', { key: `${newPid}::${s.key}`, value: s.value })
    }
  }
  if (bundle.customOptions) {
    for (const s of bundle.customOptions) {
      await ops.put('settingsKV', { key: `customOption::${newPid}::${s.key}`, value: s.value })
    }
  }
  // 酒馆模式报告：换新 id 与新 projectId。
  // sessionId 无需重映射——会话本身存在 settingsKV 里（value 整体搬运、会话 id 不变），
  // 故报告仍能指回原会话。
  if (bundle.tavernReports) {
    for (const r of bundle.tavernReports) {
      await ops.put('tavernReports', { ...r, id: uid(), projectId: newPid })
    }
  }
  return newPid
}

/** 供 SettingSearch 使用：读取当前项目全部数据 */
export async function loadAllData() {
  const [formData, tableRows, cardRecords] = await Promise.all([
    ops.getAll<FormData>('formData'), ops.getAll<TableRow>('tableRows'), ops.getAll<CardRecord>('cardRecords'),
  ])
  const prefix = `${currentProjectId}::`
  return {
    formData: formData
      .filter(f => f.tabId.startsWith(prefix))
      .map(f => ({ tabId: f.tabId.slice(prefix.length), data: f.data as Record<string, string> })),
    tableRows: tableRows.filter(r => r.projectId === currentProjectId),
    cardRecords: cardRecords.filter(r => r.projectId === currentProjectId),
  }
}

// ============ Meta ============
export async function getMeta<T>(key: string, def: T): Promise<T> {
  const rec = await ops.get<{ key: string; value: T }>('meta', key)
  return rec?.value ?? def
}
export async function setMeta(key: string, value: unknown) {
  await ops.put('meta', { key, value })
}

// ============ 时光机：章节版本快照 ============
export interface Snapshot {
  id: string
  projectId: string
  chapterId: string
  chapterTitle: string
  content: string
  wordCount: number
  createdAt: number
}

const MAX_SNAPSHOTS_PER_CHAPTER = 12

export async function createSnapshot(ch: Chapter): Promise<Snapshot> {
  const snap: Snapshot = {
    id: uid(), projectId: ch.projectId || currentProjectId, chapterId: ch.id,
    chapterTitle: ch.title, content: ch.content, wordCount: ch.wordCount, createdAt: Date.now(),
  }
  await ops.put('snapshots', snap)
  // 只保留最近 N 版（按 chapterId 索引取，避免全表扫）
  const all = await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', ch.id)
  if (all.length > MAX_SNAPSHOTS_PER_CHAPTER) {
    const drop = all.sort((a, b) => b.createdAt - a.createdAt).slice(MAX_SNAPSHOTS_PER_CHAPTER)
    await ops.bulkDel('snapshots', drop.map(d => d.id))
  }
  return snap
}
export async function getSnapshots(chapterId: string): Promise<Snapshot[]> {
  return (await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', chapterId))
    .sort((a, b) => b.createdAt - a.createdAt)
}
// ============ 每日码字统计 ============
export interface DailyStat { key: string; projectId: string; date: string; words: number }

/** 累加当日字数增量（可为负，最低 0） */
async function addDailyWords(delta: number) {
  if (!currentProjectId || !delta) return
  const key = `${currentProjectId}::${todayKey()}`
  const rec = await ops.get<DailyStat>('dailyStats', key)
  const words = Math.max(0, (rec?.words ?? 0) + delta)
  await ops.put('dailyStats', { key, projectId: currentProjectId, date: todayKey(), words })
}
/** 获取当前项目全部每日统计 */
export async function getDailyStats(): Promise<DailyStat[]> {
  const all = await ops.getAll<DailyStat>('dailyStats')
  return all.filter(s => s.projectId === currentProjectId).sort((a, b) => a.date.localeCompare(b.date))
}
/** 直接写入某日统计（种子数据用，不累加） */
export async function putDailyStat(date: string, words: number) {
  await ops.put('dailyStats', { key: `${currentProjectId}::${date}`, projectId: currentProjectId, date, words } as DailyStat)
}

// ============ 项目设置（自定义敏感词 / 取名收藏） ============
export async function getSetting<T>(key: string, def: T): Promise<T> {
  const rec = await ops.get<{ key: string; value: T }>('settingsKV', `${currentProjectId}::${key}`)
  return rec?.value ?? def
}
export async function setSetting(key: string, value: unknown) {
  await ops.put('settingsKV', { key: `${currentProjectId}::${key}`, value })
}

// ============ 酒馆模式 · 推演报告 ============
// 报告是**项目级**数据（方案 §3.1）：随项目走，导出项目时一并带走，删项目时一并清理。
export async function getReport(id: string): Promise<TavernReport | undefined> {
  return ops.get<TavernReport>('tavernReports', id)
}

/** 某项目的全部报告（走 projectId 索引，避免全表扫） */
export async function listProjectReports(projectId: string): Promise<TavernReport[]> {
  return ops.getAllByIndex<TavernReport>('tavernReports', 'projectId', projectId)
}

export async function saveReport(r: TavernReport): Promise<void> {
  await ops.put('tavernReports', r)
}

export async function deleteReport(id: string): Promise<void> {
  await ops.del('tavernReports', id)
}

// ============ 回收站 ============
export interface TrashItem extends Chapter {
  kind: 'chapter'
  deletedAt: number
  volumeTitle?: string // 删除时记录所属卷名（恢复时提示用）
}
export async function listTrash(): Promise<TrashItem[]> {
  const all = await ops.getAll<TrashItem>('trash')
  return all.filter(t => t.projectId === currentProjectId).sort((a, b) => b.deletedAt - a.deletedAt)
}
/** 恢复章节：原卷还在则放回原卷末尾，否则放入「已恢复章节」卷 */
export async function restoreFromTrash(id: string): Promise<Chapter | null> {
  const item = await ops.get<TrashItem>('trash', id)
  if (!item) return null
  const { kind: _k, deletedAt: _d, ...ch } = item
  let volumeId = ch.volumeId
  const volExists = await ops.get<Volume>('volumes', volumeId)
  if (!volExists) {
    const vols = (await ops.getAll<Volume>('volumes')).filter(v => v.projectId === currentProjectId)
    let vol = vols.find(v => v.title === '已恢复章节')
    if (!vol) {
      vol = { id: uid(), projectId: currentProjectId, order: vols.length, title: '已恢复章节', description: '回收站恢复的章节默认放这里', createdAt: Date.now() }
      await ops.put('volumes', vol)
    }
    volumeId = vol.id
  }
  const sib = (await ops.getAll<Chapter>('chapters')).filter(c => c.projectId === currentProjectId && c.volumeId === volumeId)
  const restored: Chapter = { ...ch, volumeId, order: sib.length, updatedAt: Date.now() }
  await ops.put('chapters', restored)
  // 删除章节时会一并删除「章节台账」中的 ch-<id> 联动行；恢复时必须重建到对应卷台账表，
  // 否则该章在台账中消失，直到再次编辑触发 syncChapterMaster 才回来。
  const masterRows = (await ops.getAll<TableRow>('tableRows')).filter(
    r => r.tabId === `chapter-vol-${volumeId}` && r.projectId === currentProjectId,
  )
  const maxOrder = masterRows.reduce((mx, r) => Math.max(mx, r.order ?? 0), 0)
  await ops.put('tableRows', {
    id: `ch-${restored.id}`,
    projectId: currentProjectId,
    tabId: `chapter-vol-${volumeId}`,
    data: {
      '章节号': '', '章节标题': restored.title,
      '一句话事件': restored.summary, '出场人物': '', '埋设伏笔编号': '',
      '回收伏笔编号': '', '细纲状态': '无', '字数': String(restored.wordCount),
      '发布日期': '', '备注': '',
    },
    order: maxOrder + 1,
  })
  await ops.del('trash', id)
  return restored
}
export async function purgeTrashItem(id: string) {
  await ops.del('trash', id)
}
export async function emptyTrash() {
  const all = await ops.getAll<TrashItem>('trash')
  for (const t of all) {
    if (t.projectId === currentProjectId) await ops.del('trash', t.id)
  }
}

// ============ 项目独立自定义下拉选项 ============
// key 格式：customOption::<projectId>::<tabId>::<colName>，value 为 { items: string[], hidden: string[] }
// items = 用户可见的全部（=内置 ∪ 自定义） - hidden；hidden = 已删除的内置项
// 每个项目独立管理下拉选项
const CUSTOM_OPTION_PREFIX = 'customOption::'

export interface CustomOptionPayload {
  items: string[]   // 用户新增的项（不含被删除的内置项）
  hidden: string[]  // 用户删除的内置项
  renamed?: Record<string, string>  // 内置项改名（原名 -> 新名）
}

export async function getCustomOptions(tabId: string, colName: string): Promise<CustomOptionPayload> {
  const rec = await ops.get<{ key: string; value: CustomOptionPayload }>('settingsKV', `${CUSTOM_OPTION_PREFIX}${currentProjectId}::${tabId}::${colName}`)
  return rec?.value ?? { items: [], hidden: [] }
}

export async function saveCustomOptions(tabId: string, colName: string, payload: CustomOptionPayload) {
  await ops.put('settingsKV', { key: `${CUSTOM_OPTION_PREFIX}${currentProjectId}::${tabId}::${colName}`, value: payload })
}

/** 便捷：新增一个用户项 */
export async function addCustomItem(tabId: string, colName: string, value: string): Promise<CustomOptionPayload> {
  const v = value.trim()
  if (!v) return getCustomOptions(tabId, colName)
  const cur = await getCustomOptions(tabId, colName)
  if (cur.items.includes(v) || cur.hidden.includes(v) || Object.values(cur.renamed ?? {}).includes(v)) return cur
  const next = { ...cur, items: [...cur.items, v] }
  await saveCustomOptions(tabId, colName, next)
  return next
}

/** 便捷：隐藏内置项（不会清空数据，只是不在下拉里出现） */
export async function hideBuiltinItem(tabId: string, colName: string, name: string): Promise<CustomOptionPayload> {
  const cur = await getCustomOptions(tabId, colName)
  if (cur.hidden.includes(name)) return cur
  const renamed = { ...(cur.renamed ?? {}) }
  delete renamed[name]
  const next = { ...cur, hidden: [...cur.hidden, name], renamed }
  await saveCustomOptions(tabId, colName, next)
  return next
}

/** 便捷：恢复一个内置项 */
export async function restoreBuiltinItem(tabId: string, colName: string, name: string): Promise<CustomOptionPayload> {
  const cur = await getCustomOptions(tabId, colName)
  const next = { ...cur, hidden: cur.hidden.filter(h => h !== name) }
  await saveCustomOptions(tabId, colName, next)
  return next
}

/** 便捷：重命名内置项（不影响数据迁移：把已使用的旧值替换为新值交给上层） */
export async function renameBuiltinItem(tabId: string, colName: string, oldName: string, newName: string): Promise<CustomOptionPayload> {
  const v = newName.trim()
  if (!v || v === oldName) return getCustomOptions(tabId, colName)
  const cur = await getCustomOptions(tabId, colName)
  const renamed = { ...(cur.renamed ?? {}) }
  // 同名则覆盖
  for (const k of Object.keys(renamed)) if (renamed[k] === v) delete renamed[k]
  renamed[oldName] = v
  const next = { ...cur, renamed }
  await saveCustomOptions(tabId, colName, next)
  return next
}

/** 便捷：删除用户自定义项 */
export async function removeCustomItem(tabId: string, colName: string, value: string): Promise<CustomOptionPayload> {
  const cur = await getCustomOptions(tabId, colName)
  const next = { ...cur, items: cur.items.filter(i => i !== value) }
  await saveCustomOptions(tabId, colName, next)
  return next
}

// ============ 自动备份（v1.3 备份策略加固） ============
// 每个项目一份独立「备份夹」（逻辑上按 projectId 归组），删除项目不掉备份；
// 三类：'auto5min'（打开项目时每 5 分钟滚动，最多保留 MAX_AUTO_BACKUPS 份）、
//       'daily'（每天首次打开自动 1 份，最多保留 MAX_DAILY_BACKUPS 份）、
//       'manual'（用户手动「立即备份」，不设上限 —— 主动留档不该被系统删掉）。
// #012：每日备份此前不限量，写一年即 365 份全量快照，便携版（单 JSON 全量写盘）会持续膨胀。
export type BackupKind = 'auto5min' | 'daily' | 'manual'

export interface BackupRecord {
  id: string
  projectId: string
  kind: BackupKind
  label: string
  createdAt: number
  bundle: ProjectBundle
}

/** 5 分钟自动备份滚动保留上限（#012：60 → 30） */
export const MAX_AUTO_BACKUPS = 30
/** 每日自动备份保留上限（#012：原先不限量 → 30，约一个月） */
export const MAX_DAILY_BACKUPS = 30
/** 保留上限查表：手动备份为 0，表示不限制 */
function backupLimit(kind: BackupKind): number {
  if (kind === 'auto5min') return MAX_AUTO_BACKUPS
  if (kind === 'daily') return MAX_DAILY_BACKUPS
  return 0 // manual：用户主动留档，永不自动删
}

/** 创建一次全量自动备份（默认上限由调用方保证） */
export async function createAutoBackup(projectId: string, kind: BackupKind, label?: string): Promise<BackupRecord> {
  const bundle = await exportProject(projectId)
  const now = Date.now()
  const rec: BackupRecord = {
    id: uid(),
    projectId,
    kind,
    label: label ?? (kind === 'daily' ? `每日自动备份` : `自动备份`),
    createdAt: now,
    bundle,
  }
  await ops.put('backups', rec)
  // 滚动淘汰：超过该类型上限则删除最早的。手动备份（limit=0）不淘汰。
  const limit = backupLimit(kind)
  if (limit > 0) {
    const all = (await ops.getAll<BackupRecord>('backups'))
      .filter(b => b.projectId === projectId && b.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)
    if (all.length > limit) {
      for (const drop of all.slice(limit)) await ops.del('backups', drop.id)
    }
  }
  return rec
}

/** 列出某项目的全部备份（按时间倒序） */
export async function listBackups(projectId: string): Promise<BackupRecord[]> {
  const all = await ops.getAll<BackupRecord>('backups')
  return all.filter(b => b.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt)
}

async function getBackup(id: string): Promise<BackupRecord | undefined> {
  return ops.get<BackupRecord>('backups', id)
}

export async function deleteBackup(id: string) {
  await ops.del('backups', id)
}

/** 孤儿备份：备份记录存在但其项目已被删除（删除项目时按约定保留备份，导致此类记录积累） */
export async function listOrphanBackups(): Promise<BackupRecord[]> {
  const [all, projs] = await Promise.all([ops.getAll<BackupRecord>('backups'), ops.getAll<{ id: string }>('projects')])
  const pids = new Set(projs.map(p => p.id))
  return all.filter(b => !pids.has(b.projectId)).sort((a, b) => b.createdAt - a.createdAt)
}

/** 删除全部孤儿备份，返回删除条数 */
export async function deleteOrphanBackups(): Promise<number> {
  const orphans = await listOrphanBackups()
  for (const o of orphans) await ops.del('backups', o.id)
  return orphans.length
}

/**
 * 将一份项目数据包「覆盖写回」到目标项目（恢复历史版本用）。
 * 保留目标项目 id，但用备份包的内容替换其全部数据（卷/章/表/卡/表单/统计/设置），
 * 并将书名、封面、类型、简介同步为备份当时的快照。
 */
export async function restoreBackup(id: string): Promise<void> {
  const rec = await getBackup(id)
  if (!rec) throw new Error('备份不存在')
  await applyBundleToProject(rec.projectId, rec.bundle)
}

async function applyBundleToProject(targetPid: string, bundle: ProjectBundle): Promise<void> {
  // 1. 收集该项目现有的键 —— ⚠️ 只收集，**先不删**。
  //    🔴 旧实现是「先清空、再写回」：写到一半失败（配额满、断网、用户关窗），
  //    项目就变半空且无从恢复。改成「先写后删」之后，任一步失败最多留下些
  //    可以再清理的多余记录 —— **原数据自始至终完好**。
  const delKeys: Record<string, string[]> = {}
  for (const name of ['volumes', 'chapters', 'tableRows', 'cardRecords', 'trash', 'tavernReports'] as const) {
    const all = await ops.getAll<{ id: string; projectId?: string }>(name)
    const keys = all.filter(r => r.projectId === targetPid).map(r => r.id)
    if (keys.length) delKeys[name] = keys
  }
  const prefix = `${targetPid}::`
  const forms = await ops.getAll<FormData>('formData')
  const formKeys = forms.filter(f => f.tabId.startsWith(prefix)).map(f => f.tabId)
  // 快照按 projectId 索引取，避免全表扫
  const snapKeys = (await ops.getAllByIndex<Snapshot>('snapshots', 'projectId', targetPid)).map(s => s.id)
  const statKeys: string[] = []
  const setKeys: string[] = []
  const daily = await ops.getAll<{ key: string }>('dailyStats')
  for (const r of daily) if (r.key.startsWith(prefix)) statKeys.push(r.key)
  const settings = await ops.getAll<{ key: string }>('settingsKV')
  for (const r of settings) {
    if (r.key.startsWith(prefix)) setKeys.push(r.key)
    // 自定义下拉选项 key 形如 customOption::<pid>::…，需用专属前缀清理，否则恢复会残留旧项目选项
    else if (r.key.startsWith(`customOption::${targetPid}::`)) setKeys.push(r.key)
  }
  // 2. 写入备份包数据（内部 id 全部重生成，避免与残留/冲突）
  const volMap = new Map<string, string>()
  for (const v of bundle.volumes) {
    const nid = uid()
    volMap.set(v.id, nid)
    await ops.put('volumes', { ...v, id: nid, projectId: targetPid })
  }
  const chMap = new Map<string, string>()
  for (const c of bundle.chapters) {
    const nid = uid()
    chMap.set(c.id, nid)
    await ops.put('chapters', { ...c, id: nid, projectId: targetPid, volumeId: volMap.get(c.volumeId) ?? c.volumeId })
  }
  for (const f of bundle.formData) {
    await ops.put('formData', { tabId: `${targetPid}::${f.tabId}`, data: f.data })
  }
  for (const r of bundle.tableRows) {
    const m = r.id.match(/^ch-(.+)$/)
    const nid = m && chMap.has(m[1]) ? `ch-${chMap.get(m[1])}` : uid()
    // 卷台账行的 tabId 内嵌卷 id（chapter-vol-<volumeId>），须随新卷 id 重映射，
    // 否则恢复后台账行指向不存在的卷，卷台账数据全部丢失（与 importProject 的写法一致）
    const rawTab = String(r.tabId)
    const tabId = rawTab.startsWith(VOL_LEDGER_PREFIX)
      ? `${VOL_LEDGER_PREFIX}${volMap.get(rawTab.slice(VOL_LEDGER_PREFIX.length)) ?? rawTab.slice(VOL_LEDGER_PREFIX.length)}`
      : r.tabId
    await ops.put('tableRows', { ...r, id: nid, tabId, projectId: targetPid })
  }
  for (const r of bundle.cardRecords) {
    await ops.put('cardRecords', { ...r, id: uid(), projectId: targetPid })
  }
  if (bundle.dailyStats) {
    for (const s of bundle.dailyStats) {
      await ops.put('dailyStats', { ...s, key: `${targetPid}::${s.date}`, projectId: targetPid })
    }
  }
  if (bundle.settings) {
    for (const s of bundle.settings) {
      await ops.put('settingsKV', { key: `${targetPid}::${s.key}`, value: s.value })
    }
  }
  if (bundle.customOptions) {
    for (const s of bundle.customOptions) {
      await ops.put('settingsKV', { key: `customOption::${targetPid}::${s.key}`, value: s.value })
    }
  }
  // 酒馆模式报告：随备份一并恢复（换新 id；sessionId 不需重映射，理由同 importProject）
  if (bundle.tavernReports) {
    for (const r of bundle.tavernReports) {
      await ops.put('tavernReports', { ...r, id: uid(), projectId: targetPid })
    }
  }

  // 3. 写入已全部成功 —— 这才删除旧记录。
  //    ⚠️ 以 key 为标识的存储（formData / settingsKV / dailyStats）新旧键**可能同名**：
  //       同名时上面的 put 已就地覆盖，无需再删；若不过滤掉它们，会把刚写好的新数据一起删掉。
  const newFormKeys = new Set(bundle.formData.map(f => `${targetPid}::${f.tabId}`))
  const newStatKeys = new Set((bundle.dailyStats ?? []).map(s => `${targetPid}::${s.date}`))
  const newSetKeys = new Set<string>([
    ...(bundle.settings ?? []).map(s => `${targetPid}::${s.key}`),
    ...(bundle.customOptions ?? []).map(s => `customOption::${targetPid}::${s.key}`),
  ])
  for (const [name, keys] of Object.entries(delKeys)) await ops.bulkDel(name, keys)
  const staleForms = formKeys.filter(k => !newFormKeys.has(k))
  if (staleForms.length) await ops.bulkDel('formData', staleForms)
  if (snapKeys.length) await ops.bulkDel('snapshots', snapKeys)
  const staleStats = statKeys.filter(k => !newStatKeys.has(k))
  if (staleStats.length) await ops.bulkDel('dailyStats', staleStats)
  const staleSets = setKeys.filter(k => !newSetKeys.has(k))
  if (staleSets.length) await ops.bulkDel('settingsKV', staleSets)

  // 4. 同步项目元数据（成为该历史版本）
  const old = await ops.get<Project>('projects', targetPid)
  if (old) {
    await ops.put('projects', {
      ...old,
      name: bundle.project.name,
      genre: bundle.project.genre ?? '',
      intro: bundle.project.intro ?? '',
      ...(bundle.project.cover !== undefined ? { cover: bundle.project.cover } : {}),
      updatedAt: Date.now(),
    })
  }
  await touchProject(targetPid)
}
