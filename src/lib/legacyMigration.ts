// 3.0 · W0-2 老用户数据迁移 · 渲染侧编排
//
// 职责：① 探测旧版数据（经主进程 fs）；② 整库 JSON 的 app/kind remap（**纯函数，可单测**）；
//       ③ 调向量库 / 知识库各自的迁移函数做转库；④ 调主进程复制 Chromium profile；⑤ 汇总报告。
//
// 🔴 分层口径：主进程（`electron/migration.cjs`）只搬字节（fs 读写 / 复制）；
//    「怎么判定、怎么改写」放在这里 —— 纯函数，Node 单测能直接跑（主进程模块依赖 electron 跑不了）。
import { migrateVecFromLegacy } from './semantic/store'
import { migrateKbFromLegacy } from './knowledgeBase'
import { idbDbExists, idbDeleteDatabase } from './idbMigrateUtil'

/** 旧版 app 标识（唯一权威源；迁移内部识别用，不参与运行时校验） */
export const LEGACY_APP = 'novel-studio'
/** 新品牌 app 标识 */
export const NEW_APP = 'youth-fantasy-engine'

/**
 * 旧 → 新 kind 映射（`docs/3.0-开发方案.md` §1 命名映射总表）。
 * 整库 JSON 里通常**不含**这些（它们出现在独立证据包 / 酒馆预设文件里），
 * 但迁移时一并兜底 remap，避免漏网。
 */
export const LEGACY_KIND_MAP: Record<string, string> = {
  'novel-studio-trajectory': 'youth-fantasy-engine-trajectory',
  'novel-studio-trajectory-book': 'youth-fantasy-engine-trajectory-book',
  'novel-studio.tavern-preset': 'youth-fantasy-engine.tavern-preset',
}

/** 旧版数据探测结果（主进程整形后返回） */
export interface LegacyProbe {
  exists: boolean
  legacyDir?: string
  jsonPath?: string
  jsonExists?: boolean
  idbDir?: string
  idbExists?: boolean
  profile?: Record<string, boolean>
  customDataPath?: string
}

/** preload 注入的迁移 API（仅桌面版存在） */
export interface ElectronMigrationAPI {
  probe(): Promise<LegacyProbe>
  readLegacyJson(): Promise<{ ok: boolean; text?: string; path?: string; error?: string }>
  writeNewJson(text: string): Promise<{ ok: boolean; path?: string; error?: string }>
  copyProfile(): Promise<{ ok: boolean; copied?: string[]; error?: string }>
  findUninstaller(): Promise<{ ok: boolean; hits: { dir: string; uninstaller: string }[] }>
  runUninstaller(p: string): Promise<{ ok: boolean; error?: string }>
  revealLegacyDir(): Promise<{ ok: boolean; path?: string; error?: string }>
}

/** 取迁移 API；非桌面版（dev 浏览器）返回 null（一切调用静默降级） */
export function migrationApi(): ElectronMigrationAPI | null {
  const w = window as unknown as { electronMigration?: ElectronMigrationAPI }
  return w.electronMigration ?? null
}

export type RemapResult =
  | { ok: true; text: string; stats: { app: number; kinds: number } }
  | { ok: false; error: string }

/**
 * 把旧整库 JSON 文本 remap 成新品牌值。**纯函数**（不碰 DOM / IO）。
 *
 * - 顶层 `app: 'novel-studio'` → `'youth-fantasy-engine'`（这是本机实测数据里**唯一**会出现旧值的地方）；
 * - 递归兜底：把任何等于旧 kind 的字符串值改成新 kind；
 * - 🔴 `generator.app = '青春幻想引擎'`（中文显示串）**不改** —— 它本就是正确品牌（§3.3 注）。
 */
export function remapLegacyJsonText(text: string): RemapResult {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return { ok: false, error: '旧数据文件不是合法 JSON' }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '旧数据文件结构异常（不是对象）' }
  }
  let app = 0
  let kinds = 0
  const root = obj as Record<string, unknown>
  if (root.app === LEGACY_APP) { root.app = NEW_APP; app++ }
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (v && typeof v === 'object') {
      const rec = v as Record<string, unknown>
      for (const k of Object.keys(rec)) {
        const val = rec[k]
        if (typeof val === 'string' && LEGACY_KIND_MAP[val]) { rec[k] = LEGACY_KIND_MAP[val]; kinds++ }
        else walk(val)
      }
    }
  }
  walk(root)
  return { ok: true, text: JSON.stringify(root), stats: { app, kinds } }
}

/** 探测旧版数据（桌面版才有效；非桌面返回 { exists:false }） */
export async function probeLegacy(): Promise<LegacyProbe> {
  const api = migrationApi()
  if (!api) return { exists: false }
  try {
    return await api.probe()
  } catch {
    return { exists: false }
  }
}

/** 各步骤结果 */
export interface MigrationReport {
  json: { ok: boolean; skipped?: boolean; path?: string; remapped?: { app: number; kinds: number }; error?: string }
  vec: { ok: boolean; count: number; error?: string }
  kb: { ok: boolean; count: number; error?: string }
  mainDb: { ok: boolean }
  profile: { ok: boolean; copied: string[]; error?: string }
}

/**
 * 删除旧品牌主库 IndexedDB（`novel-studio`）。
 * 🔴 桌面模式下主数据源是**整库 JSON**（见 `db/core.ts` `ops = DESKTOP ? desktopStore : idbOps`），
 *    主库 IDB 在桌面下基本为空 ⇒ 迁移时无需搬数据，直接清掉旧库即可。
 */
async function dropLegacyMainDb(): Promise<boolean> {
  if (!(await idbDbExists(LEGACY_APP))) return true
  await idbDeleteDatabase(LEGACY_APP)
  return true
}

/**
 * 执行一次完整迁移（作者在向导里点「导入」后调用）。
 * 🔴 **失败不中断**：任一步失败只记进报告，其它步骤照常跑完（§3.4 第 4 条）。
 * @param opts.overwriteJson=false 表示「跳过整库 JSON」（仅搬 IDB / profile，用于新库已有数据的合并场景）
 */
export async function runLegacyMigration(opts: { overwriteJson?: boolean } = {}): Promise<MigrationReport> {
  const report: MigrationReport = {
    json: { ok: false },
    vec: { ok: false, count: 0 },
    kb: { ok: false, count: 0 },
    mainDb: { ok: false },
    profile: { ok: false, copied: [] },
  }
  const api = migrationApi()
  if (!api) return report

  // ① 整库 JSON：读旧 → remap → 写新
  if (opts.overwriteJson === false) {
    report.json.skipped = true
  } else {
    const r = await api.readLegacyJson()
    if (!r.ok || !r.text) {
      report.json.error = r.error || '读取旧整库失败'
    } else {
      const rm = remapLegacyJsonText(r.text)
      if (!rm.ok) {
        report.json.error = rm.error
      } else {
        const w = await api.writeNewJson(rm.text)
        report.json.ok = w.ok
        report.json.path = w.path
        report.json.remapped = rm.stats
        if (!w.ok) report.json.error = w.error
      }
    }
  }

  // ② 向量库转库 ③ 知识库转库 ④ 清旧主库（各自独立 try，互不影响）
  try { report.vec = await migrateVecFromLegacy() } catch (e) { report.vec = { ok: false, count: 0, error: String((e as Error)?.message ?? e) } }
  try { report.kb = await migrateKbFromLegacy() } catch (e) { report.kb = { ok: false, count: 0, error: String((e as Error)?.message ?? e) } }
  try { report.mainDb = { ok: await dropLegacyMainDb() } } catch { report.mainDb = { ok: false } }

  // ⑤ Chromium profile 复制
  try {
    const p = await api.copyProfile()
    report.profile = { ok: p.ok, copied: p.copied ?? [], error: p.error }
  } catch (e) {
    report.profile = { ok: false, copied: [], error: String((e as Error)?.message ?? e) }
  }

  return report
}
