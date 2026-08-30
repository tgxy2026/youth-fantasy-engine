import { openDB, type IDBPDatabase } from 'idb'
import type { Project, Volume, Chapter, FormData, TableRow, CardRecord } from './types'
import { PORTABLE, portableStore, type StoreOps } from './portable'
import { DESKTOP, desktopStore } from './desktop'
import { WEB } from './env'
import {
  serverStore, configureServerStore, pullSnapshot, seedFromLocal, isExcludedMetaKey,
  isCloudUnavailable, CloudAuthError, onSyncConflict, CONFLICT_KEY_PREFIX,
  type SyncConflictInfo,
} from './serverStore'
import { uid } from './id'
import { countWords } from './textStats'
import { todayKey } from './date'
import { chapterSeqMap, flattenChapters } from './chapterSeq'

const DB_NAME = 'novel-studio'
const DB_VERSION = 8

let dbPromise: Promise<IDBPDatabase> | null = null
/** 当前打开的项目 id（App 切换项目时设置） */
let currentProjectId = ''

export function setCurrentProject(id: string) {
  currentProjectId = id
}
export function getCurrentProjectId() {
  return currentProjectId
}

function getDB() {
  if (!dbPromise) {
    // 失败时重置缓存，避免 rejected promise 被永久缓存（如隐私模式打开失败后所有调用都失败）
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        // ---- 全新安装：创建基础 store（不 return，继续走下方 v3 分支补全新 store） ----
        if (oldVersion === 0) {
          db.createObjectStore('projects', { keyPath: 'id' })
          db.createObjectStore('volumes', { keyPath: 'id' })
          db.createObjectStore('chapters', { keyPath: 'id' })
          db.createObjectStore('formData', { keyPath: 'tabId' })
          db.createObjectStore('tableRows', { keyPath: 'id' })
          db.createObjectStore('cardRecords', { keyPath: 'id' })
          db.createObjectStore('meta', { keyPath: 'key' })
        }
        // ---- v1 → v2 迁移：旧数据全部归入「default」项目 ----
        else if (oldVersion < 2) {
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
        // ---- v2 → v3 迁移：新增 快照 / 每日统计 / 项目设置 / 回收站 ----
        if (oldVersion < 3) {
          const snapStore = db.createObjectStore('snapshots', { keyPath: 'id' })
          snapStore.createIndex('projectId', 'projectId', { unique: false })
          snapStore.createIndex('chapterId', 'chapterId', { unique: false })
          db.createObjectStore('dailyStats', { keyPath: 'key' })
          db.createObjectStore('settingsKV', { keyPath: 'key' })
          db.createObjectStore('trash', { keyPath: 'id' })
        }
        // ---- v3 → v4 迁移：时间脉络表列名 "故事内日期" → "故事内时间" ----
        if (oldVersion < 4) {
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
        // ---- v4 → v5 迁移：分卷大纲/章节细纲 由单份表单改为多记录卡片 ----
        // 旧 formData（projectId::volume-outline / chapter-outline）中已填写的内容
        // 转换为一张卡片记录（追加到该项目该页签末尾），然后删除旧表单数据
        if (oldVersion < 5) {
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
        // ---- v5 → v6 迁移：新增「自动备份」独立存储 ----
        // 自动备份按项目独立存放，删除项目时不会被清掉（见 deleteProject）
        if (oldVersion < 6) {
          db.createObjectStore('backups', { keyPath: 'id' })
        }
        // ---- v6 → v7 迁移：表头统一（术语→名称、类型→类别） ----
        // 列名即数据键，改名需同步重映射已存数据的 data 键，否则旧数据在该列显示为空白；
        // 同时重映射自定义下拉选项 settingsKV 的键中列名段，避免选项丢失。
        if (oldVersion < 7) {
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
        // ---- v7 → v8 迁移：快照表加 projectId / chapterId 索引（按项目/章节查快照不再全表扫） ----
        if (oldVersion < 8) {
          const snapStore = tx.objectStore('snapshots')
          if (!snapStore.indexNames.contains('projectId')) snapStore.createIndex('projectId', 'projectId', { unique: false })
          if (!snapStore.indexNames.contains('chapterId')) snapStore.createIndex('chapterId', 'chapterId', { unique: false })
        }
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
// 开发 / 网页模式：IndexedDB（idb 封装）
// 便携模式（U 盘单文件版）：portableStore —— 内存数据 + 防抖写回 U 盘上的 JSON 数据文件
// 桌面模式（Electron 安装版）：desktopStore —— 内存数据 + 防抖写回本机用户数据目录的 JSON 文件
// 三种实现共用同一组原语，上层所有函数签名与行为保持一致，组件层零改动。

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

let ops: StoreOps = PORTABLE ? portableStore : (DESKTOP ? desktopStore : idbOps)

// #005 冲突备份（网页版专用）：云端与本地都改过同一条记录时，本地优先采用，
// 但云端那版不再无声丢弃——另存本地副本供用户比对恢复。副本只落本地 IndexedDB，
// key 以 syncConflict: 开头，由 isExcludedMetaKey 保证不上传云端。
onSyncConflict((info: SyncConflictInfo) => {
  void saveConflictCopy(info)
})

async function saveConflictCopy(info: SyncConflictInfo) {
  try {
    await idbOps.put('meta', {
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

// 云端同步特权（#003）：敏感 meta（AI 配置/密钥）仅留本地 IndexedDB，不进云端缓存、
// 不同步、也不会被拉取覆盖。cloudStore 在 serverStore 之上对这类 key 做本地回退。
// #008：云端鉴权失效（401）时透明回退本地 IndexedDB。
// 旧行为是让空缓存接管存储——用户看到空白项目列表（本地数据被遮蔽而非丢失），
// 之后每次编辑都静默 401 丢弃，全程零提示。这里改为双判：调用前已失效直接走本地，
// 调用后才失效（本次才触发握手）同样回退，保证用户看到的始终是自己的本地数据。
async function cloudOrLocal(op: keyof StoreOps, ...args: any[]): Promise<any> {
  if (isCloudUnavailable()) return (idbOps as any)[op](...args)
  const r = await (serverStore as any)[op](...args)
  return isCloudUnavailable() ? (idbOps as any)[op](...args) : r
}

const cloudStore: StoreOps = {
  getAll: async <T,>(store: string): Promise<T[]> => {
    if (store !== 'meta') return cloudOrLocal('getAll', store)
    if (isCloudUnavailable()) return idbOps.getAll<T>('meta')
    const local = (await idbOps.getAll<T>('meta')).filter((r: any) => isExcludedMetaKey(r.key))
    const cloud = await serverStore.getAll<T>('meta')
    if (isCloudUnavailable()) return idbOps.getAll<T>('meta')
    return [...local, ...cloud] as T[]
  },
  get: async <T,>(store: string, key: string): Promise<T | undefined> => {
    if (store === 'meta' && isExcludedMetaKey(key)) return idbOps.get<T>('meta', key)
    return cloudOrLocal('get', store, key)
  },
  put: async (store: string, value: any) => {
    if (store === 'meta' && isExcludedMetaKey(value?.key)) return idbOps.put('meta', value)
    return cloudOrLocal('put', store, value)
  },
  del: async (store: string, key: string) => {
    if (store === 'meta' && isExcludedMetaKey(key)) return idbOps.del('meta', key)
    return cloudOrLocal('del', store, key)
  },
  getAllByIndex: async <T,>(store: string, indexName: string, value: unknown): Promise<T[]> =>
    cloudOrLocal('getAllByIndex', store, indexName, value),
  bulkPut: async (store: string, values: any[]) => {
    if (store === 'meta') {
      const excl = values.filter((v) => isExcludedMetaKey(v?.key))
      const rest = values.filter((v) => !isExcludedMetaKey(v?.key))
      if (excl.length) await idbOps.bulkPut('meta', excl)
      if (rest.length) {
        if (isCloudUnavailable()) return idbOps.bulkPut('meta', rest)
        await serverStore.bulkPut('meta', rest)
        if (isCloudUnavailable()) await idbOps.bulkPut('meta', rest)
      }
      return
    }
    return cloudOrLocal('bulkPut', store, values)
  },
  bulkDel: async (store: string, keys: string[]) => {
    if (store === 'meta') {
      const excl = keys.filter((k) => isExcludedMetaKey(k))
      const rest = keys.filter((k) => !isExcludedMetaKey(k))
      if (excl.length) await idbOps.bulkDel('meta', excl)
      if (rest.length) {
        if (isCloudUnavailable()) return idbOps.bulkDel('meta', rest)
        await serverStore.bulkDel('meta', rest)
        if (isCloudUnavailable()) await idbOps.bulkDel('meta', rest)
      }
      return
    }
    return cloudOrLocal('bulkDel', store, keys)
  },
}

// 网页版云端同步特权（#003）：启动时若本地存有同步邀请码，则自动切换到云端存储。
// 仅网页体验版生效（WEB 由构建期 __WEB__ 决定），dev / 桌面 / 便携 恒不触发。
if (WEB) {
  try {
    const sc = localStorage.getItem('yfe-sync-code')
    if (sc) {
      configureServerStore(sc)
      ops = cloudStore
      // 主动握手一次：码若已失效（服务端轮换白名单、槽位被清理等）立刻发现，
      // 清掉失效码并通知 UI。数据侧由 cloudStore 自动回退本地，用户不会看到空白（#008）。
      void pullSnapshot().catch((err: unknown) => {
        if (err instanceof CloudAuthError) {
          try {
            localStorage.removeItem('yfe-sync-code')
          } catch {
            /* 忽略 */
          }
          try {
            window.dispatchEvent(new CustomEvent('yfe:cloud-auth-failed'))
          } catch {
            /* 忽略 */
          }
        }
      })
    }
  } catch {
    /* localStorage 不可用时退化为本地 IndexedDB */
  }
}

/** 运行时切换底层存储（云端同步特权开启时切到 cloudStore） */
export function setStoreOps(o: StoreOps) {
  ops = o
}

/**
 * 开启云端同步（#003 云端同步特权）：用专属同步邀请码登录。
 * 1) 拉取远端快照；2) 若远端为空，用当前本地数据播种上传；
 * 3) 切换到云端存储并持久化邀请码。调用方应随后刷新页面以载入云端数据。
 */
export async function enableCloudSync(code: string) {
  configureServerStore(code)
  const snap = await pullSnapshot()
  const empty = snap.rev === 0 && Object.keys(snap.stores).length === 0
  if (empty) {
    // 此刻 ops 仍为默认本地存储（网页版即 idbOps），用其数据播种
    await seedFromLocal((s) => ops.getAll(s))
  }
  setStoreOps(cloudStore)
  try {
    localStorage.setItem('yfe-sync-code', code)
  } catch {
    /* 忽略 */
  }
}

// ============ 项目 ============
export async function getAllProjects(): Promise<Project[]> {
  const all = await ops.getAll<Project>('projects')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}
export async function getProject(id: string): Promise<Project | undefined> {
  return ops.get<Project>('projects', id)
}
export async function createProject(name: string, genre = '', intro = '', cover = '', projectType: 'full' | 'lite' | 'minimal' | 'custom' = 'full', features?: string[]): Promise<Project> {
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
  const chapters = await ops.getAll<Chapter>('chapters')
  const chapterIds = new Set(chapters.filter(c => c.projectId === id).map(c => c.id))
  await ops.del('projects', id)
  // 收集各 store 待删主键，统一批量删除
  const delKeys: Record<string, string[]> = {}
  for (const name of ['volumes', 'chapters', 'tableRows', 'cardRecords', 'trash'] as const) {
    const all = await ops.getAll<{ id: string; projectId?: string }>(name)
    const keys = all.filter(r => r.projectId === id).map(r => r.id)
    if (keys.length) delKeys[name] = keys
  }
  const forms = await ops.getAll<FormData>('formData')
  const formKeys = forms.filter(f => f.tabId.startsWith(`${id}::`)).map(f => f.tabId)
  // 快照按 projectId 索引批量取，删除该项目全部章节快照
  const snapKeys = chapterIds.size
    ? (await ops.getAllByIndex<Snapshot>('snapshots', 'projectId', id)).map(s => s.id)
    : []
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
  const all = await ops.getAll<TableRow>('tableRows')
  return all
    .filter(r => r.projectId === currentProjectId && r.tabId === tabId)
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
}

export async function exportProject(id: string): Promise<ProjectBundle> {
  const project = await ops.get<Project>('projects', id)
  if (!project) throw new Error('项目不存在')
  const [volumes, chapters, formData, tableRows, cardRecords, dailyStats, settingsKV] = await Promise.all([
    ops.getAll<Volume>('volumes'), ops.getAll<Chapter>('chapters'), ops.getAll<FormData>('formData'),
    ops.getAll<TableRow>('tableRows'), ops.getAll<CardRecord>('cardRecords'),
    ops.getAll<DailyStat>('dailyStats'), ops.getAll<{ key: string; value: unknown }>('settingsKV'),
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
// 两类：'auto5min'（打开项目时每 5 分钟滚动，最多保留 60 份）与
//       'daily'（每天首次打开自动 1 份，保留数量不设上限）。
export type BackupKind = 'auto5min' | 'daily'

export interface BackupRecord {
  id: string
  projectId: string
  kind: BackupKind
  label: string
  createdAt: number
  bundle: ProjectBundle
}

/** 5 分钟自动备份滚动保留上限 */
export const MAX_AUTO_BACKUPS = 60

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
  // 5 分钟类型滚动淘汰：超过上限删除最早（最旧）的
  if (kind === 'auto5min') {
    const all = (await ops.getAll<BackupRecord>('backups'))
      .filter(b => b.projectId === projectId && b.kind === 'auto5min')
      .sort((a, b) => b.createdAt - a.createdAt)
    if (all.length > MAX_AUTO_BACKUPS) {
      for (const drop of all.slice(MAX_AUTO_BACKUPS)) await ops.del('backups', drop.id)
    }
  }
  return rec
}

/** 列出某项目的全部备份（按时间倒序） */
export async function listBackups(projectId: string): Promise<BackupRecord[]> {
  const all = await ops.getAll<BackupRecord>('backups')
  return all.filter(b => b.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt)
}

export async function getBackup(id: string): Promise<BackupRecord | undefined> {
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
  // 1. 清空目标项目现有数据（批量删除，大备份恢复更快）
  const delKeys: Record<string, string[]> = {}
  for (const name of ['volumes', 'chapters', 'tableRows', 'cardRecords', 'trash'] as const) {
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
  for (const [name, keys] of Object.entries(delKeys)) await ops.bulkDel(name, keys)
  if (formKeys.length) await ops.bulkDel('formData', formKeys)
  if (snapKeys.length) await ops.bulkDel('snapshots', snapKeys)
  if (statKeys.length) await ops.bulkDel('dailyStats', statKeys)
  if (setKeys.length) await ops.bulkDel('settingsKV', setKeys)

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

  // 3. 同步项目元数据（成为该历史版本）
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
