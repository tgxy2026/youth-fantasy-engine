// ============ WCP 网页资料包 · 双层配置读写（3.7.3 · W0）============
//
// 两层存储（规划 §3.4 / §0.1 R2）：
//   · 全局偏好 → `meta`（`getMeta/setMeta`，键 `wcpGlobalConfig`）—— 跨项目、跨设备形态共用；
//   · 单项目状态 → `settingsKV`（`getSettingFor/setSettingFor`，键 `wcpProjectState`）—— 按项目隔离。
//
// 🔴 为什么单项目读写用 `getSettingFor/setSettingFor` 而不是 `getSetting/setSetting`：
//   后者拼的是 `currentProjectId`（当前打开的那本）。若将来在「项目管理页」批量导出其它书，
//   会把状态写到当前书上 —— 表现是「改了 A 的底包勾选，B 的过期提示变了」。
//   显式传 pid 是同一件事的最稳写法（与 `getSettingFor` 的注释同口径）。
//
// 🔴 容错口径：读取一律**回退默认值**，绝不抛错。
//   3.7.3 之前没有这两个键 ⇒ 老库首次读取必须安全落到出厂默认（W0 退出条件）。
import * as db from '@/lib/db'
import {
  DEFAULT_WCP_BASE_MODULES,
  DEFAULT_WCP_GLOBAL_CONFIG,
  DEFAULT_WCP_PROJECT_STATE,
  WCP_BASE_MODULE_IDS,
  WCP_BUDGET_MAX,
  WCP_BUDGET_MIN,
  WCP_GLOBAL_CONFIG_KEY,
  WCP_PREV_CHAPTER_MAX,
  WCP_PREV_SUMMARY_MAX,
  WCP_PROJECT_STATE_KEY,
  type WcpFileExt,
  type WcpGlobalConfig,
  type WcpProjectState,
  type WcpSummaryFormat,
} from '@/lib/wcp/wcpTypes'

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function pickOne<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 勾选模块归一化：只保留已知 id、去重；**空数组是合法选择**（作者可以全不勾） */
function normalizeModules(v: unknown): string[] {
  if (!Array.isArray(v)) return [...DEFAULT_WCP_BASE_MODULES]
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || !WCP_BASE_MODULE_IDS.includes(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/** 把任意历史脏数据收敛成合法的全局偏好（纯函数，便于单测钉边界） */
export function normalizeWcpGlobalConfig(raw: unknown): WcpGlobalConfig {
  const r = isRecord(raw) ? raw : {}
  return {
    defaultFileExt: pickOne<WcpFileExt>(r.defaultFileExt, ['md', 'txt'], DEFAULT_WCP_GLOBAL_CONFIG.defaultFileExt),
    defaultPackKind: pickOne<'delta' | 'full'>(r.defaultPackKind, ['delta', 'full'], DEFAULT_WCP_GLOBAL_CONFIG.defaultPackKind),
    summaryFormat: pickOne<WcpSummaryFormat>(r.summaryFormat, ['json', 'markdown'], DEFAULT_WCP_GLOBAL_CONFIG.summaryFormat),
    prevChapterCount: clampInt(r.prevChapterCount, DEFAULT_WCP_GLOBAL_CONFIG.prevChapterCount, 0, WCP_PREV_CHAPTER_MAX),
    prevSummaryCount: clampInt(r.prevSummaryCount, DEFAULT_WCP_GLOBAL_CONFIG.prevSummaryCount, 0, WCP_PREV_SUMMARY_MAX),
    includeWriterNotes: typeof r.includeWriterNotes === 'boolean' ? r.includeWriterNotes : DEFAULT_WCP_GLOBAL_CONFIG.includeWriterNotes,
    maxPackBudgetChars: clampInt(r.maxPackBudgetChars, DEFAULT_WCP_GLOBAL_CONFIG.maxPackBudgetChars, WCP_BUDGET_MIN, WCP_BUDGET_MAX),
  }
}

/** 把任意历史脏数据收敛成合法的单项目状态（纯函数） */
export function normalizeWcpProjectState(raw: unknown): WcpProjectState {
  const r = isRecord(raw) ? raw : {}
  const at = typeof r.lastBaseExportAt === 'number' && Number.isFinite(r.lastBaseExportAt) && r.lastBaseExportAt > 0
    ? Math.floor(r.lastBaseExportAt)
    : null
  return {
    baseModules: normalizeModules(r.baseModules),
    lastBaseExportAt: at,
    lastBaseFingerprint: typeof r.lastBaseFingerprint === 'string' ? r.lastBaseFingerprint : '',
  }
}

// ---------- 全局偏好（meta） ----------

/** 读取全局偏好（无记录 / 损坏 ⇒ 出厂默认） */
export async function loadWcpGlobalConfig(): Promise<WcpGlobalConfig> {
  try {
    return normalizeWcpGlobalConfig(await db.getMeta<unknown>(WCP_GLOBAL_CONFIG_KEY, DEFAULT_WCP_GLOBAL_CONFIG))
  } catch {
    return normalizeWcpGlobalConfig(DEFAULT_WCP_GLOBAL_CONFIG)
  }
}

/**
 * 合并写入全局偏好，返回写入后的完整配置。
 *
 * 读-改-写串行：管理页可能同时改「默认后缀」与「摘要格式」（两次点击落在同一键上），
 * 不串行时后写者会用自己读到的旧值覆盖前者。
 */
let globalChain: Promise<unknown> = Promise.resolve()
export function saveWcpGlobalConfig(patch: Partial<WcpGlobalConfig>): Promise<WcpGlobalConfig> {
  const run = globalChain.then(async () => {
    const cur = await loadWcpGlobalConfig()
    const next = normalizeWcpGlobalConfig({ ...cur, ...patch })
    await db.setMeta(WCP_GLOBAL_CONFIG_KEY, next)
    return next
  })
  globalChain = run.then(() => undefined, () => undefined)
  return run
}

// ---------- 单项目状态（settingsKV） ----------

/** 读取某项目的底包状态；无 pid（未打开项目）时返回默认，绝不去读写 `::` 空键 */
export async function loadWcpProjectState(pid = db.getCurrentProjectId()): Promise<WcpProjectState> {
  if (!pid) return normalizeWcpProjectState(DEFAULT_WCP_PROJECT_STATE)
  try {
    return normalizeWcpProjectState(await db.getSettingFor<unknown>(pid, WCP_PROJECT_STATE_KEY, DEFAULT_WCP_PROJECT_STATE))
  } catch {
    return normalizeWcpProjectState(DEFAULT_WCP_PROJECT_STATE)
  }
}

/** 合并写入某项目的底包状态（按 pid 串行，避免两次勾选互相覆盖） */
const projectChains = new Map<string, Promise<unknown>>()
export function saveWcpProjectState(
  patch: Partial<WcpProjectState>,
  pid = db.getCurrentProjectId(),
): Promise<WcpProjectState> {
  if (!pid) return Promise.resolve(normalizeWcpProjectState(DEFAULT_WCP_PROJECT_STATE))
  const prev = projectChains.get(pid) ?? Promise.resolve()
  const run = prev.then(async () => {
    const cur = await loadWcpProjectState(pid)
    const next = normalizeWcpProjectState({ ...cur, ...patch })
    await db.setSettingFor(pid, WCP_PROJECT_STATE_KEY, next)
    return next
  })
  projectChains.set(pid, run.then(() => undefined, () => undefined))
  return run
}

/**
 * 记录一次底包导出（时间 + 源数据指纹）。
 *
 * 🔴 只写这一处：底包下载或复制成功后调用；不要在仅预览时调用 ——
 *    「已导出过的指纹」必须对应真实交付过的文件/剪贴板内容，否则过期提示会谎报「最新」。
 */
export async function markWcpBaseExported(fingerprint: string, pid = db.getCurrentProjectId()): Promise<WcpProjectState> {
  return saveWcpProjectState({ lastBaseExportAt: Date.now(), lastBaseFingerprint: fingerprint }, pid)
}