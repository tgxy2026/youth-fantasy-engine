// ============ 存储层 · 底座（连接 / 适配层 / 当前项目 / 云盘开关）============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
// 分层约定：本文件是最底层 —— **不 import 任何兄弟业务域**（projects / volumes / chapters / …），
// 各业务域都从这里取 `ops` 与 `currentProjectId`。唯一例外是 ./idbMigrations（比它更底层）。
//
// ⚠️ `ops` 与 `currentProjectId` 是**可重新赋值**的模块级单例（桌面版启动后由 setStoreOps 换掉；切项目时由 setCurrentProject 写入）：
//    **故它们必须 export** —— 兄弟业务域只读、不写（对 import 进来的绑定赋值是编译错误）；ESM 活绑定保证换值后各处都读到新值。
import { openDB, type IDBPDatabase } from 'idb'
import type { Project } from '../types'
import type { StoreOps } from '../storeOps'
import { DESKTOP, desktopStore, flushDesktop, KEY_PATHS, getDesktopState, desktopStoreReady } from '../desktop'
import {
  CLOUD_FILE_SYNC, desktopCloudStore, applyDesktopCloudFromPersisted,
  pullDesktopSnapshot, isDesktopCloudUnavailable, enableDesktopCloud, disableDesktopCloud,
  seedDesktopFromLocal, onDesktopSyncConflict, persistDesktopCloudEnabled, onDesktopCloudFallback,
  clearDesktopCloudEnabledFlag, flushDesktopCloud, snapshotDesktopCloudCache, onDesktopLocalSnapshot,
  CONFLICT_KEY_PREFIX, isExcludedMetaKey,
  type SyncConflictInfo, type SyncDirHandle,
} from '../desktopCloudSync'
import { SYNC_STORES, totalRecords, isLocalOnlyStore, onCloudRestored, type SyncStores, type SyncRow } from '../syncCore'
import { isDeleted } from '../syncTombstone'
import {
  migrateFreshInstall, migrateV1toV2, migrateV2toV3, migrateV3toV4, migrateV4toV5,
  migrateV5toV6, migrateV6toV7, migrateV7toV8, migrateV8toV9, migrateV9toV10,
  migrateV10toV11,
} from './idbMigrations'

const DB_NAME = 'youth-fantasy-engine'
const DB_VERSION = 11

let dbPromise: Promise<IDBPDatabase> | null = null
/** 当前打开的项目 id（App 切换项目时设置） */
export let currentProjectId = ''

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
        // 各段迁移已拆到 ./idbMigrations.ts 的独立函数；此处是「何时跑哪一段」的唯一判断点。
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
        if (oldVersion < 11) migrateV10toV11(db)
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

export let ops: StoreOps = DESKTOP ? desktopStore : idbOps

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
 * @param overwrite 是否允许覆盖本地已有记录。
 *   · `true`（默认，供「关闭同步」用）：本地库应当**完全等于**云端数据 → 整体 bulkPut。
 *   · `false`（供**异常兜底**用）：只补本地缺失的主键，已存在的一律不碰（理由见函数内注释）。
 *
 * 返回 Promise —— 「关闭同步」必须**等它写完**再切 ops 并 reload，否则写了一半就被打断。
 * 异常兜底那条路（pagehide/关窗）仍是 fire-and-forget，与原先一致。
 */
/**
 * 兜底镜像这条路上的写失败**不能抛**（会打断关窗/切后端流程），
 * 但也不能像原来那样 `.catch(() => {})` 一声不响 ——
 * 🔴 2026-09-22 六维审计 P2：静默吞掉写失败时，用户以为已经保存、实际没落盘，
 *    排查时又完全没有线索。这里统一留一行痕（口径与 `useTavernCardModel` 的失败明细一致）。
 */
const warnMirrorFail = (what: string) => (e: unknown) => {
  console.warn(`[db] ${what}失败（兜底路径，已忽略，不阻断流程）：`, e)
}

/**
 * 把云端 cache 镜像到本地。
 * 🔴 `overwrite` **刻意不给默认值**（2026-09-23 六维审计）：原来的 `= true`（整体覆盖本地）
 *    语义正好是「闩锁期用旧快照盖掉本地新稿」，而它恰恰是最危险的那个方向。
 *    去掉默认值后，每个调用点都必须显式说清「这次是覆盖还是只补缺失」——
 *    新增调用点时编译器会替你问这个问题。
 */
async function mirrorCloudCacheToLocal(cache: SyncStores, overwrite: boolean): Promise<void> {
  const tasks: Promise<unknown>[] = []
  for (const [store, rows] of Object.entries(cache)) {
    if (isLocalOnlyStore(store)) continue
    const list = store === 'meta'
      ? rows.filter(r => !isExcludedMetaKey(r?.key))
      : rows
    if (overwrite) {
      // 🔴 空 list 也必须走「删除镜像」（P0，2026-09-21 六维审计）：
      //    `list` 为空 = 这个 store 在云端被**整片清空**了 —— 恰恰是最需要删掉本地多余记录的那一份。
      //    旧实现把 `if (!list.length) continue` 排在 overwrite 分支之前，整个空 store 被跳过
      //    ⇒ 本地旧记录一条不删 ⇒ 关同步后立刻「复活」；
      //    更糟的是下次开同步时 seedFromLocal 会把它**当本地数据播种回云端** —— 删除被彻底撤销。
      if (list.length) tasks.push(desktopLocalStore.bulkPut(store, list).catch(warnMirrorFail(`镜像 ${store} 入本地`)))
      // 🔴 镜像的另一半：还要删掉「本地有、这份 cache 里没有」的记录（2026-09-20 六维审计 P1-1）。
      //    云模式下 `store.del` 只是把记录从云端 cache 摘掉，**本机数据文件没动**
      //    （读写都走 cache，本地库自开启同步那一刻起就不再更新）。
      //    只 put 不 del ⇒ 那条被删的记录仍躺在本地库里 ⇒ 关同步后立刻"复活"；
      //    更糟的是下次开启同步时 `seedFromLocal` 会把它**当本地数据播种回云端** —— 删除被彻底撤销。
      tasks.push(mirrorDeleteExtra(store, list))
      continue
    }

    // 兜底路径（overwrite=false）：这份 cache 是**闩锁前的旧数据**，绝不能删；
    // 且空 list 在这条路上没有任何意义 —— 保持原有语义，直接跳过。
    if (!list.length) continue

    // 🔴 只补缺失（异常兜底路径专用）：闩锁期包装层已把读写切到本地库，
    //    用户的新编辑正躺在那里，而这份 cache 是闩锁前的旧数据 ——
    //    整体 bulkPut 会把新稿整片盖回旧版（审计 P0-2 的静默回滚）。
    //    getAll 失败时按「本地有数据」处理：宁可不写，也绝不覆盖。
    const localRows = await desktopLocalStore.getAll(store).catch(() => null)
    if (localRows === null) continue
    const kp = KEY_PATHS[store] ?? 'id'
    const have = new Set((localRows as Record<string, unknown>[]).map(r => String(r[kp] ?? '')))
    // 🔴🔴 2026-09-22 六维审计 P0：**本机删过的记录绝不能补回**。
    //    `desktopLocalStore.bulkPut` 会顺手 `clearDeleted()` 抹掉同 key 的墓碑（`desktop.ts:484`）——
    //    于是「闩锁期删掉 → 兜底镜像从旧 cache 补回 → 墓碑被清掉」三步走完，
    //    下次开同步时 `seedFromLocal` 就会把这条当本地数据**播种回云端**，删除被彻底撤销。
    //    这与 overwrite 分支要防的「删了会复活」是同一个病，只是这条兜底路径漏了防。
    //    判据用墓碑而不是「本地有没有」：闩锁期的删除只记在本地库 + 墓碑里，旧 cache 并不知情。
    const missing = list.filter(r => {
      const k = (r as Record<string, unknown>)[kp]
      if (isDeleted(store, k)) return false
      return !have.has(String(k ?? ''))
    })
    if (missing.length) tasks.push(desktopLocalStore.bulkPut(store, missing).catch(warnMirrorFail(`兜底补 ${store} 入本地`)))
    // 🔴 2.4.4 六维审计 P1：**用户删过的记录**要在这条兜底路径上一并从本地清掉。
    //    旧实现只防了「补回」（上面的 missing 过滤），但那些记录仍留在本地文件里；
    //    随后关闭同步的 configure('') 会 resetTombs() 清空墓碑 ⇒ 重开同步时 seedFromLocal
    //    把它们当本地数据播种回云端 —— 删除被彻底撤销（「删了会复活」家族的最后一条路径）。
    //    墓碑命中 ⇒ 用户明确删过的数据，删它不违反「绝不覆盖本地新稿」（新稿没有墓碑）。
    //    注意 meta 的 excluded keys（本地专属密钥）不在 list 里，但它们从没被删过 ⇒ isDeleted=false，不受影响。
    const haveKeys = new Set((list as Record<string, unknown>[]).map(r => String((r as Record<string, unknown>)[kp] ?? '')))
    const stale = (localRows as Record<string, unknown>[])
      .filter(r => { const k = String(r[kp] ?? ''); return !haveKeys.has(k) && isDeleted(store, k) })
    if (stale.length) tasks.push(desktopLocalStore.bulkDel(store, stale.map(r => r[kp] as string | number)).catch(warnMirrorFail(`兜底清墓碑 ${store} 入本地`)))
  }
  await Promise.all(tasks)
}

/**
 * 把「本机数据文件里有、而这份云端 cache 里没有」的记录删掉 —— 镜像的另一半（P1-1）。
 *
 * ⚠️ 只在 `overwrite`（云端**可用**、且已 `flushDesktopCloud` 推完未落盘改动）时才调用：
 *    那种状态下 cache 就是权威。闩锁兜底那条路传 `overwrite=false`，**绝不能删** ——
 *    那时的 cache 是闩锁前的旧数据，删了就是静默回滚用户的新稿（审计 P0-2）。
 *
 * ⚠️ 读失败（`getAll` 抛错）一律**不删**：宁可多留一条，也不能因读失败误删。
 * ⚠️ `backups` 由调用方的 `continue` 跳过（本地专属）；`meta` 的本地专属键要单独滤掉。
 */
async function mirrorDeleteExtra(store: string, cloudRows: SyncRow[]): Promise<void> {
  try {
    const localRows = await desktopLocalStore.getAll(store)
    const kp = KEY_PATHS[store] ?? 'id'
    const rows = localRows as Record<string, unknown>[]
    const keep = new Set(cloudRows.map(r => String((r as Record<string, unknown>)[kp] ?? '')))
    const extra = rows
      .filter(r => !keep.has(String(r[kp] ?? '')))
      // meta 里的排除键（如同步冲突记录）是本机专属、根本不上云 —— 不能因为"云端没有"就删掉
      .filter(r => !(store === 'meta' && isExcludedMetaKey(String(r.key ?? ''))))
      .map(r => r[kp])
      .filter((k): k is string | number => typeof k === 'string' || typeof k === 'number')
    if (extra.length) await desktopLocalStore.bulkDel(store, extra)
  } catch (e) {
    /* 兜底镜像：读/删失败都保持现状（下次关同步或再开同步还有机会纠正），绝不向上抛。
       但**必须留痕** —— 镜像删不掉 = 本地多余记录残留，下次开同步可能被当成「本机新增」播回云端
       （正是「删了会复活」那个家族）。静默吞掉会让这个现象完全无迹可查。 */
    console.warn('[db] 镜像删除失败（下次同步可能把它当本机新增播回云端）：', e)
  }
}

// 异常兜底路径：**只补缺失**（overwrite=false）—— 闩锁期本地库才是最权威的那一份
onDesktopCloudFallback((cache) => { void mirrorCloudCacheToLocal(cache, false) })

/**
 * 「从云端备份恢复」成功后：把恢复结果**整体镜像回本机数据文件**，确保 reload 前已落盘。
 *
 * 🔴 2026-10-10 六维审计 P1：不镜像的话，恢复后界面 reload、三路合并拿「开启同步那一刻的冻结文件」
 *    当本地那一份，按「本地优先」把恢复结果盖回去 —— 作者以为恢复成功了，其实被静默撤销。
 *    `overwrite = true` 是刻意的：恢复本就是「整体回滚到该检查点」，与 disable 那条
 *    「闩锁期只补缺失」的语义不同（那里云端可能不可用，这里 pushNow 刚成功、云端是权威）。
 */
onCloudRestored(async (cache) => {
  await mirrorCloudCacheToLocal(cache, true)
  // 写失败时 flushDesktop 是 return false（不 reject）—— 只挂 catch 会漏掉「没落盘」
  const flushed = await flushDesktop().catch(() => false)
  if (!flushed) console.warn('[sync] 从备份恢复后落盘未完成：数据可能仍在内存，请稍后确认已写入磁盘')
})

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
    } catch (e) {
      console.warn('[sync] 冲突提示派发失败（不影响同步结果）：', e)
    }
  } catch (e) {
    /* 副本保存失败绝不影响主同步流程 —— 但必须留痕：副本存在的**唯一意义**就是
       「云端那一版不再被静默丢弃」，连副本都存不下还不吭声，等于又回到了静默丢弃。 */
    console.warn('[sync] 冲突副本保存失败（云端那一版可能已丢失，请检查磁盘空间与文件权限）：', e)
  }
}

// 云端同步包装层工厂（#003）：在云端 StoreOps 之上叠加「本地回退」与「敏感 meta 不上云」特权。
// 云盘文件同步（desktopCloudStore / desktopStore）与浏览器兜底（null / idbOps）共用同一套包装逻辑，
// 仅传入各自的云端实例、本地实例与「不可用判定」。
// #008：云端不可用时透明回退本地，保证用户看到的始终是自己的数据，而非空白缓存。
// 🔬 导出仅供单测（tests/cloudStoreWrapper.test.ts）：本函数是纯工厂、无副作用，
// 且「backups 落本地 / 敏感 meta 不上云 / 云端不可用回退本地」三条语义都只在这里，
// 不导出就无法在不跑浏览器的前提下锁住它们。
// ⚠️ 2026-09-20：这句末尾原有「（与 setStoreOps 同理）」，**是错的类比**，已删 ——
//    本函数导出是「为了单测」且确实被 tests/cloudStoreWrapper.test.ts 引用；而 `setStoreOps`
//    没有任何测试引用它，导出理由完全不同（见其函数注释）。
export function makeCloudStoreWrapper(cloud: StoreOps, local: StoreOps, isUnavailable: () => boolean): StoreOps {
  /**
   * 动态分发的统一取用形状：StoreOps 六个方法签名各不相同，按名字分发只能先擦成这个。
   * 🔴 断言**只在这一个函数里**，调用点各自断言回自己需要的返回类型 —— 散着写就会看不出
   *    「哪一处是真的无法静态描述」，这正是本轮收窄 any 想消灭的那种含混。
   */
  type OpFn = (...a: unknown[]) => Promise<unknown>

  async function cloudOrLocal(op: keyof StoreOps, ...args: unknown[]): Promise<unknown> {
    // 🔴 本地专属 store（backups / backupPayloads，判据见 syncCore.LOCAL_ONLY_STORES）：
    //    syncCore.liveStores 上传前会把它从载荷里剔除（云端永不参与其增删）。
    //    因此这里必须直接落本地——否则会出现「云端不要、本地不写」的两头不靠：
    //    记录只存在于云端实例的内存 cache 里，刷新/关页即丢。
    //    与下面「敏感 meta 走本地」同构，故在唯一入口处统一短路，覆盖 getAll/get/put/del/bulkPut/bulkDel。
    if (isLocalOnlyStore(String(args[0]))) return (local[op] as OpFn)(...args)
    if (isUnavailable()) return (local[op] as OpFn)(...args)
    const r = await (cloud[op] as OpFn)(...args)
    return isUnavailable() ? (local[op] as OpFn)(...args) : r
  }
  return {
    getAll: async <T,>(store: string): Promise<T[]> => {
      if (store !== 'meta') return cloudOrLocal('getAll', store) as Promise<T[]>
      if (isUnavailable()) return local.getAll<T>('meta')
      const localMeta = (await local.getAll<T>('meta')).filter((r) => isExcludedMetaKey((r as { key?: unknown }).key))
      const cloudMeta = await cloud.getAll<T>('meta')
      if (isUnavailable()) return local.getAll<T>('meta')
      return [...localMeta, ...cloudMeta] as T[]
    },
    get: async <T,>(store: string, key: string): Promise<T | undefined> => {
      if (store === 'meta' && isExcludedMetaKey(key)) return local.get<T>('meta', key)
      return cloudOrLocal('get', store, key) as Promise<T | undefined>
    },
    put: async (store: string, value: unknown) => {
      if (store === 'meta' && isExcludedMetaKey((value as { key?: unknown })?.key)) return local.put('meta', value)
      // StoreOps.put 返回 Promise<void>，而 cloudOrLocal 统一返回 unknown → 用 await 丢弃，不 return
      await cloudOrLocal('put', store, value)
    },
    del: async (store: string, key: string) => {
      if (store === 'meta' && isExcludedMetaKey(key)) return local.del('meta', key)
      await cloudOrLocal('del', store, key)
    },
    getAllByIndex: async <T,>(store: string, indexName: string, value: unknown): Promise<T[]> =>
      cloudOrLocal('getAllByIndex', store, indexName, value) as Promise<T[]>,
    bulkPut: async (store: string, values: unknown[]) => {
      if (store === 'meta') {
        const excl = values.filter((v) => isExcludedMetaKey((v as { key?: unknown })?.key))
        const rest = values.filter((v) => !isExcludedMetaKey((v as { key?: unknown })?.key))
        if (excl.length) await local.bulkPut('meta', excl)
        if (rest.length) {
          if (isUnavailable()) return local.bulkPut('meta', rest)
          await cloud.bulkPut('meta', rest)
          if (isUnavailable()) await local.bulkPut('meta', rest)
        }
        return
      }
      await cloudOrLocal('bulkPut', store, values)
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
      await cloudOrLocal('bulkDel', store, keys)
    },
  }
}

// 云盘文件同步包装层（desktopCloudStore 之上叠加本地回退）。
// 本地回退目标为平台基础本地存储（桌面=desktopStore，浏览器兜底=idbOps）。
const desktopLocalStore: StoreOps = DESKTOP ? desktopStore : idbOps
const desktopCloudFileStore: StoreOps = makeCloudStoreWrapper(desktopCloudStore, desktopLocalStore, isDesktopCloudUnavailable)

/**
 * 注册「读本机数据文件快照」回调 —— 云合并靠它区分「本机删掉了这个记录」与「本机还没见过它」。
 *
 * 🔴🔴 **必须放在模块顶层，不能只挂在某条开启路径上**（2026-09-20 六维审计 P0）。
 *    原先只在 `enableDesktopCloudSync()`（手动开启）里注册，而**启动自动恢复同步**
 *    走的是下面 `CLOUD_FILE_SYNC` 那个块 —— 那条路径从未注册。后果是一条完整的静默链：
 *      1. 启动时 `applyDesktopCloudFromPersisted()` → `cloud.configure()` 清空内存 cache；
 *      2. 紧接着的 `pullDesktopSnapshot()` 首次合并，此刻 `localSnapshotProvider` 为 null
 *         ⇒ `syncCore` 拿不到本机库 ⇒ `localHasContent` 恒假；
 *      3. 墓碑判定被那道安全闸短路（它怕误删云端数据，见 `syncGuards` 的 `localHasContent` 说明）；
 *      4. 云端旧快照里的记录一律按「另一端新增」采用 ⇒ **手动删掉的项目每次启动都复活**，
 *         复活后又推回云端 ⇒ 此后每次启动稳定复现（自锁）。
 *    放到顶层 ＝ 放在**所有云模式入口的必经之路**上，将来再新增入口也不会漏。
 *    （`cloud.configure()` **不重置** provider，所以先注册、后 configure 的时序是安全的。）
 *
 * ⚠️ 读的是 `desktopLocalStore`（本机数据文件），**不是当前的 `ops`** —— 云模式下 `ops`
 *    是内存 cache，启动那一刻它刚被清空，拿它当「本地实况」等于什么都没证明。
 */
onDesktopLocalSnapshot(async () => {
  const out: SyncStores = {}
  const failed: string[] = []
  for (const s of SYNC_STORES) {
    // 本地专属 store（backups / backupPayloads）不进本机快照：它们本就在本机，同步层不消费
    if (isLocalOnlyStore(s)) continue
    try {
      // StoreOps.getAll 的签名是 Promise<unknown[]>（各业务域的记录类型），
      // 落进同步通用载荷前断言成 SyncRow[] —— 形状由写入方保证
      const rows = (await desktopLocalStore.getAll(s)) as SyncRow[]
      // 🔴 2026-09-22 六维审计 P2：meta 要与 `mirrorDeleteExtra`（本文件 :211）**同口径过滤**
      //    本地专属键（aiProviders 三键 / app.search / syncConflict:*）。
      //    不过滤的后果不是密钥上云（上传侧 liveStores 还会再滤一道），而是这些键被灌进合并 cache，
      //    让 `eqRecord` 每次都判出无意义的 diff。
      out[s] = s === 'meta'
        ? rows.filter(r => !isExcludedMetaKey(r?.key))
        : rows
    } catch {
      // 🔴 读失败**绝不能**降级成 []（2026-09-20 六维审计 P2）：
      //    一份"少了几张表"的快照会被下游当成"本机就这些" —— 缺的那些记录从此被判成
      //    「本机删过」或「本机没见过」，两个方向都可能丢数据。
      //    与 captureSyncData 的「读失败即中止」同口径：整体抛出去，让 syncCore 放弃本次合并。
      failed.push(s)
      out[s] = []
    }
  }
  if (failed.length) throw new Error(`读取本机数据失败（${failed.join('、')}）`)
  return out
})

// 云盘文件同步（#032 起选目录即用）：启动时若持久化过同步目录，则自动切到云端文件存储。
// 数据以加密文件落在用户选定的云盘目录（OneDrive / 坚果云 / WPS 云盘等客户端负责搬运），
// 全程不依赖任何服务器。失败一律回退到本地存储，不会让界面变成空白。
if (CLOUD_FILE_SYNC) {
  void (async () => {
    try {
      // 🔴 2026-09-22 六维审计 P1：启动自动恢复**必须与手动路径同口径**。
      //    `enableDesktopCloudSync`（见本文件下半段）明确 `if (st.writeLocked) throw`，
      //    理由写得很清楚：数据文件读不出来时本地存储是不可信的 —— 读快照会拿到一份空/残缺载荷，
      //    一旦参与合并就可能把「本机删过」与「本机没见过」混淆，甚至反写覆盖云端快照。
      //    而这条启动路径原先**不查**，等于给同一道红线开了个后门。
      //    处理方式与手动路径不同（那里是抛给用户看，这里是**静默保持本地存储**）：
      //    启动期没人看着界面，弹错反而更糟；不切过去、下次启动 / 文件恢复后可读时再试即可。
      //
      // 🔴🔴 2026-10-01 六维审计 P1：**上面那句判定原先排在数据文件加载之前** —— 本块是在
      //    模块求值期就启动的，而数据文件要到 `initDesktopStore()`（App 的 effect）才读进来。
      //    在那一刻 `writeLocked` 恒为 false（守卫等于死代码），**更糟的是** `localSnapshotProvider`
      //    读到的还是空库 ⇒ 首次合并算出 `localHasContent=false` ⇒ 墓碑闸被短路 ⇒
      //    「本机删掉的记录」被云端快照原样带回来（幽灵项目的又一条启动路径）。
      //    ⇒ 必须**先等数据文件就绪**再判、再切。
      // 🔴 2026-10-02 六维审计 P2：**超时不能当「已就绪」放行** —— 那一刻 writeLocked 仍是 false、
      //    本地快照还是空库 ⇒ 首次合并算出 localHasContent = false ⇒ 墓碑闸被短路 ⇒
      //    「本机删掉的记录」被云端带回来。超时就本次不切云同步，下次启动再试
      //    （与下面 writeLocked 的处理同口径：静默保持本地存储）。
      const storeReady = await desktopStoreReady()
      if (!storeReady) return
      if (DESKTOP && getDesktopState().writeLocked) return
      const ok = await applyDesktopCloudFromPersisted()
      if (ok) {
        // ⓘ 「读本机数据文件快照」的回调已在**模块顶层**注册（见 desktopCloudFileStore 之后那段），
        //    所以下面这次 pull 触发的首次合并就能认出「本机删过哪些记录」—— 墓碑闸生效的前提。
        // 🔴 切换前必须先确认云端**真的**有数据。
        //    同步目录里的 .yfe 被删掉、或还没从网盘客户端下载下来时，读到的是
        //    rev=0 + 空 stores —— 会被当成「空库」直接切过去，界面瞬间变成空项目，
        //    进而触发示范项目播种、反写覆盖云端快照（用户看到的是"我的书全没了"）。
        //    这与 enableDesktopCloudSync 的空快照守卫同构：那边是「空则播种」，这边是「空则不切」。
        let empty = true
        try {
          const snap = await pullDesktopSnapshot()
          empty = totalRecords(snap.stores) === 0
          // 🔴 2026-09-26：与手动开启路径同款缓解——网盘「按需下载 / 未同步完成」时首拉为空
          //    是**瞬态**，3s 后重拉一次，两次都空才认「云端为空」并清标记（避免网盘就绪前
          //    每次启动都被要求重新选择文件夹）。
          if (empty) {
            await new Promise(r => setTimeout(r, 3000))
            const snap2 = await pullDesktopSnapshot()
            empty = totalRecords(snap2.stores) === 0
          }
        } catch {
          // 拉取失败（文件损坏 / 网盘未就绪）→ 保持本地存储，绝不把界面切空。
          // 🔴 **不再清「已开启」标记**（2026-09-19 六维审计 P1-7）：拉不到 ≠ 云端是空的。
          //    清了标记就等于把同步**静默关掉** —— 下次启动 isDesktopCloudEnabled() 为 false，
          //    而界面上看不出任何变化，作者会以为一直在同步。保留标记，下次启动 / 网盘就绪后再试。
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

/**
 * 运行时切换底层存储（云端同步特权开启时切到 cloudStore / desktopCloudFileStore）。
 *
 * ⚠️ 为什么必须 export（2026-09-20 补记）：它是模块级 `ops` 的**唯一写入口**，而 `ops` 按文件顶部
 *    的约定必须 export（兄弟业务域只读活绑定）。此前 `makeCloudStoreWrapper` 的注释把这写成
 *    「（与 setStoreOps 同理）」，**是错的类比** —— 那个函数导出是「为了单测」，本函数不是。
 *
 * ⚠️ 它目前**没有单测，且这不是疏漏**：唯一可观测出口 `isDesktopCloudSyncActive()` 在测试环境
 *    恒为 false（`desktopCloudFileStore` 是模块内部引用，测试拿不到），正向断言写不出来；
 *    而它本身只是一行赋值，真正有风险的是两个调用方（enable / disableDesktopCloudSync 里
 *    「先 flush + 镜像再切」的顺序），那需要真实桌面环境才跑得起来。硬写只会得到恒真的假 PASS。
 */
export function setStoreOps(o: StoreOps) {
  ops = o
}

/**
 * 当前底层存储是否走「云盘文件同步」。
 *
 * 🔴 审计 2026-09-18（P1-6）：导入数据文件前必须问它 —— 同步开启时界面读的是云端 cache，
 *    而导入只替换本机 desktopStore：导入的内容既看不见（reload 后 ops 又切回云存储），
 *    下次兜底镜像 / 关闭同步时还会被云端旧行按主键覆盖回同 key（等于白导，用户却以为成功了）。
 *
 * 🔴🔴 这个判断**绝不能放进 desktop.ts**：那边 import desktopCloudSync 会形成
 *    `desktop → desktopCloudSync → env → desktop` 的环（env.ts 反过来 import DESKTOP），
 *    实测在浏览器里模块求值期直接 TDZ 崩 —— Cannot access 'DESKTOP' before initialization。
 *    tsc 与单测都看不出来，只有真跑 ESM 才炸（用 tests/importCycles 静态闸兜底）。
 */
export function isDesktopCloudSyncActive(): boolean {
  return ops === desktopCloudFileStore
}

/**
 * 开启云盘文件同步（#031 引入，#032 起选目录即用）。
 * 数据以加密文件落在用户选定的云盘同步目录，全程不依赖服务器。
 * 加密使用内置默认密钥（DEFAULT_CLOUD_KEY），所有设备一致 → 指向同一目录即可互通，无需输入任何凭据。
 * @param handle 同步目录句柄（桌面版为目录路径字符串）
 */
/**
 * 抓一份「当前 ops 里参与同步的数据」快照。
 * 只给「换同步目录」这类**必须在 configure() 之前**取数的场合用。
 */
async function captureSyncData(): Promise<SyncStores> {
  const out: SyncStores = {}
  const failed: string[] = []
  for (const s of SYNC_STORES) {
    if (isLocalOnlyStore(s)) continue
    try {
      out[s] = (await ops.getAll(s)) || []
    } catch {
      // 🔴 读失败**不能**静默降级成 []（2026-09-19 六维审计 P2-4）：这份载荷会被当成
      //    「rev=1 的第一份」推上新目录，本机该 store 于是显示为空，还可能被别的设备
      //    按「云端没有该记录」当成删除。与 seedFromLocal 的「读失败就中止痛播」同口径。
      failed.push(s)
      out[s] = []
    }
  }
  if (failed.length) {
    throw new Error(`读取本地数据失败（${failed.join('、')}）—— 已中止开启同步，以免把空数据推上云端`)
  }
  return out
}

export async function enableDesktopCloudSync(handle: SyncDirHandle) {
  // 🔴 审计 2026-09-17（P1-5）：数据文件读不出来时（writeLocked）**绝不能开启云同步**。
  //    那种状态下本地存储是空的、不可信的：captureSyncData 会抓到一份空载荷，新目录为空
  //    → 播种把空载荷推上云端（rev=1）；另一台设备 mergeCaches 时按「云端没有该记录、
  //    本地也没改过」丢弃全部记录 → **两台设备一起变空**。
  //    `writeLocked` 的语义本来就是「绝不落盘」（红线），云同步入口必须一并纳入。
  if (DESKTOP) {
    const st = getDesktopState()
    if (st.writeLocked) {
      throw new Error(st.writeLockReason || '本地数据文件当前不可读，已阻止开启云盘同步（以免把空数据推上云端）')
    }
  }
  // 🔴 必须在 enableDesktopCloud() **之前**把当前数据抓下来：
  //    enableDesktopCloud → configure() 会清空 syncCore 的单例 cache，而「同步本来就开着、
  //    只是换/重选目录」时 ops 正指向**同一个**单例 → 播种读到的是全空，
  //    于是把一份空快照写进新目录（界面看起来「书全没了」，还会被同步到其他设备）。
  const carry = await captureSyncData()
  await enableDesktopCloud(handle)
  const snap = await pullDesktopSnapshot()
  let empty = totalRecords(snap.stores) === 0
  // 🔴 2026-09-26 社区反馈（双电脑数据覆盖事故）：网盘客户端「按需下载 / 未同步完成」时，
  //    .yfe 可能**还没下载**（文件缺失）或只有**占位/残缺头部**（用户实测仅 1KB）——
  //    首拉读到空 ≠ 云端真没数据。此时「空则播种」会把本机（可能为空的）数据推上去，
  //    **直接覆盖原电脑的全量快照**（固定文件名，无 rev 协商），两台电脑一起丢数据；
  //    且本机重开后云端是空库 → 清「已开启」标记 → 又提示重新选择（用户报告的现象）。
  //    缓解：间隔 3s 重拉一次，两次都空才认「云端为空」。
  if (empty) {
    await new Promise(r => setTimeout(r, 3000))
    const snap2 = await pullDesktopSnapshot()
    empty = totalRecords(snap2.stores) === 0
  }
  if (empty) {
    // 🔴 云端空 + 本机也几乎没有数据 → **拒绝开启**（这是「新电脑抢先开启」的事故形态：
    //    播种会把空库推上去覆盖另一台电脑的全量）。本机有数据 → 播种上传（新盘初始化的合法场景）。
    if (totalRecords(carry) < 5) {
      await disableDesktopCloud()
      throw new Error(
        '同步文件夹里没有检测到同步数据，本机也几乎没有数据 —— 已阻止开启，以免空数据覆盖另一台电脑的备份。' +
          '如果你是想在另一台电脑上继续写作：请先在原电脑上开启一次云盘同步，并确认网盘客户端已把' +
          '「青春幻想引擎-同步数据.yfe」「完整下载」到这个文件夹（百度网盘等可能需要右键手动下载），再重新选择。',
      )
    }
    // 新目录还是空的 → 用刚才抓下来的数据播种（不能用「此刻的 ops」，它可能已被清空）
    await seedDesktopFromLocal((s) => Promise.resolve(carry[s] ?? []))
  }
  // 🔴 持久化必须在**上面全部成功之后**：原先写在 enableDesktopCloud 内部（即拉快照之前），
  //    拉快照 / 播种失败时标记已落盘 → 下次启动 UI 仍显示「已开启」，实际却走本地存储（界面撒谎）。
  // 🔴 注册「读本地库快照」**不在这里** —— 已提到模块顶层（见 `desktopCloudFileStore` 之后那段）。
  //    原先只在本函数里注册，而启动自动恢复同步走的是 `CLOUD_FILE_SYNC` 块、那条路径从未注册，
  //    于是「手动删掉的项目重启后复活」长期存在（2026-09-20 六维审计 P0）。
  //    ⚠️ 别为了「顺手」在这里再加一次：两处注册就是两处会各自漂移的口径，
  //    而漏掉的那一处**静态检查与单测都看不出来**（只有真跑云盘同步才复现）。
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
  // 🔴 2) 云端**不可用**（闩锁期：网盘目录被占用 / 断网）时，这份 cache 是**闩锁前**的旧数据 ——
  //    整体覆盖会把闩锁期用户新写的内容整片盖回旧版并立即落盘，磁盘级不可逆。
  //    这正是 mirrorCloudCacheToLocal 注释里点名要防的「审计 P0-2 静默回滚」
  //    （2026-09-19 六维审计 P0-3）。此时只能「只补缺失」，让本地新数据活下来。
  const cloudUnavailable = isDesktopCloudUnavailable()
  await mirrorCloudCacheToLocal(snapshotDesktopCloudCache(), !cloudUnavailable)
  if (cloudUnavailable) {
    // 如实告知（只记日志：lib 层不能 import components 弹 toast，会形成反向依赖）
    console.warn('[sync] 云端不可用，关闭同步时以本地数据为准（未用旧快照覆盖本地新改动）')
  }
  // 3) 落盘（桌面版走 JSON 文件；非桌面是空操作），确保 reload 前已持久化。
  // 🔴 不能只 `.catch()` —— `flushDesktop()` 写失败时是 **return false**（不 reject），
  //    只挂 catch 会把「没落盘」整个漏掉，而下一步就要切回本地 ops 并准备 reload。
  const flushed = await flushDesktop().catch(() => false)
  if (!flushed) {
    console.warn('[sync] 关闭云同步前落盘未完成：数据可能仍在内存，请稍后确认已写入磁盘')
  }
  // 4) 清标记、复位传输层，切回本地
  disableDesktopCloud()
  setStoreOps(desktopLocalStore)
}

// ============ 项目时间戳（下沉到本层）============
// 🔴 touchProject 放在底座、而不是 ./projects：卷 / 章 / 页签 / 备份都要「顺手刷新项目更新时间」，
//    留在 projects 里会让它们全部反向依赖 projects 并绕成环。
export async function touchProject(id: string) {
  // 🔴 2026-09-22 六维审计 P2：这是「顺手刷新项目更新时间」的**附带动作**
  //    （卷 / 章 / 页签 / 备份写完都会调它），失败不该影响本次主写入 ——
  //    但它内部不兜错时，那几处**浮动调用**（`touchProject(id)` 不 await）会变成**未处理拒绝**，
  //    严重点会在控制台炸一片、且没有任何上下文。在源头兜住，调用方就能安心 fire-and-forget。
  try {
    const old = await ops.get<Project>('projects', id)
    if (old) await ops.put('projects', { ...old, updatedAt: Date.now() })
  } catch (e) {
    console.warn('[db] 刷新项目更新时间失败（不影响本次写入）：', e)
  }
}
