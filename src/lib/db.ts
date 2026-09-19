// ============ 存储层 · 对外唯一入口（门面）============
// 2026-09-19 结构优化 D2：原 1,613 行的巨石已按域拆进 ./db/ 目录，本文件只做**再导出**。
//
// 分层（自下而上，禁止反向 import）：
//   ./db/idbMigrations（IndexedDB schema 迁移）
//     └─ ./db/core（连接 / 适配层 / 当前项目 / 云盘开关 / touchProject）
//          ├─ ./db/projects → ./db/volumes → ./db/tabs
//          ├─ ./db/chapters → ./db/meta
//          ├─ ./db/tavernReports
//          └─ ./db/{migrations, backups}（最上层，可依赖以下全部）
//
// 🔴 对外 API 的名字与签名一字未改 —— 69 个调用方（含 tests/）无需任何改动。
// ⚠️ 改 import 结构前先看 tests/build-test.mjs：它用 esbuild 插件把 './desktop' 换成内存桩，
//    ./db/ 里的模块改用 '../desktop'，那边的 filter 已同步放宽（否则测试会误载真实 Electron 模块）。
export {
  setCurrentProject, getCurrentProjectId, touchProject,
  makeCloudStoreWrapper, setStoreOps,
  isDesktopCloudSyncActive, enableDesktopCloudSync, disableDesktopCloudSync,
} from './db/core'
export * from './db/projects'
// volumes / meta 用**显式名单**：这两个模块内部还有跨域要用、但不该对外的成员
// （`VOL_LEDGER_PREFIX`、`addDailyWords`），用 export * 会把它们泄漏进公开 API。
export { getAllVolumes, saveVolume, deleteVolume, getAllChapterLedgerRows, purgeLedgerRowEverywhere } from './db/volumes'
export * from './db/chapters'
export * from './db/tabs'
export type { DailyStat } from './db/meta'
export { getMeta, setMeta, getDailyStats, putDailyStat, getSetting, setSetting } from './db/meta'
export * from './db/tavernReports'
export * from './db/migrations'
export * from './db/backups'
