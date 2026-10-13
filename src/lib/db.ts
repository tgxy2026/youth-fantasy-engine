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
// 📌 `setStoreOps` 目前在 src/ + tests/ **零消费者**（真正调它的只有 enable / disableDesktopCloudSync，
//    两个都在 `db/core.ts` 模块内）。**2026-09-20 判断：有意保留在对外 API 面上** ——
//    它表达的是一项真实能力（存储层支持运行时换后端），也是那两个开关的底层原语；
//    摘掉的收益只是少一个 export 关键字，而将来若要写「模拟切换后端」的测试还得加回来。
//    ⚠️ 它经门面导出会被 audit-dead 记成「有外部引用」，因此**不会**出现在「多余 export」清单里 ——
//    所以别指望那份清单替你盯着它，判断写在这里。
//    它的导出理由（=`ops` 活绑定的唯一写入口）见 `db/core.ts` 里它自己的函数注释。
export {
  setCurrentProject, getCurrentProjectId, touchProject,
  makeCloudStoreWrapper, setStoreOps,
  isDesktopCloudSyncActive, enableDesktopCloudSync, disableDesktopCloudSync,
} from '@/lib/db/core'
export * from '@/lib/db/projects'
// volumes / meta 用**显式名单**：这两个模块内部还有跨域要用、但不该对外的成员
// （`VOL_LEDGER_PREFIX`、`addDailyWords`），用 export * 会把它们泄漏进公开 API。
export { getAllVolumes, saveVolume, deleteVolume, getAllChapterLedgerRows, purgeLedgerRowEverywhere } from '@/lib/db/volumes'
export * from '@/lib/db/chapters'
export * from '@/lib/db/tabs'
// 世界观 · 力量体系的「子级」（C10 · 2.4.2）：子项增删改 + 活跃开关。
// 母级不在这里 —— 它就是 tabs 的 formData 那一份，位置与 API 都没变。
export * from '@/lib/db/worldSets'
export type { DailyStat } from '@/lib/db/meta'
export { getMeta, setMeta, getDailyStats, putDailyStat, getSetting, setSetting, getSettingFor, setSettingFor, delSetting } from '@/lib/db/meta'
export * from '@/lib/db/tavernReports'
export * from '@/lib/db/aiRuns'
// 世界引擎（3.0 · W4-1b）：世界包 / 不可变版本。🔴 **非项目级** —— 全局可读、删项目不清理。
export * from '@/lib/db/worlds'
export * from '@/lib/db/migrations'
export * from '@/lib/db/backups'
