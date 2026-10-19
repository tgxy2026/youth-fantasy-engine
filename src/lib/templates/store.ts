/**
 * 3.2.0 · WT1-1：模板定义的**存储与采用**
 *
 * 存放位置（方案 §3.5 表格，逐字对齐）：
 *
 * | 数据 | 位置 | 同步 |
 * |---|---|---|
 * | 项目有效模板 | `settingsKV`：`projectTemplate32:<tabId>` | **随项目**正式备份 / 导出 / 同步 |
 * | 项目模板目录 | `settingsKV`：`projectTemplate32:index` | 同上 |
 * | 个人模板库 | `meta`：`templateLibrary32:<templateId>:v<version>` | **不进**日常云同步；分享走显式模板包 |
 *
 * 🔴 为什么项目快照必须在 `settingsKV` 而不在 `meta`：
 *    `meta` 里的东西**不随项目导出**（历史上还因此把 apiKey 明文留在备份外 = 漏带），
 *    而模板定义是「这个项目长什么样」的一部分 —— 作者换台机器打开备份，
 *    结构必须跟值一起回来。放 meta 就会出现"值在、结构没了"的半身备份。
 *    反过来，个人库是作者的私有资产、不该被项目备份带走，所以走 meta + 排除同步。
 *
 * 🔴 所有读写**显式传 pid**，不依赖 `currentProjectId` 这个全局状态
 *    （异步任务执行期间作者可能已经切书，见 `creative/interviewStore` 的教训）。
 */
import * as db from '@/lib/db'
import { bytesOfDef, checkTemplateDef, type LimitViolation } from './limits'
import {
  PROJECT_TEMPLATE_INDEX, TEMPLATE_DEF_VERSION, TEMPLATE_LIMITS,
  projectTemplateKeyOf, type TemplateDef, type TemplateIndex, type TemplateIndexEntry,
} from './definition'

// ────────────────────────── 读 ──────────────────────────

/** 形状校验：库里可能是老数据 / 手改的坏包，不能直接当成 TemplateDef 用 */
export function isTemplateDef(v: unknown): v is TemplateDef {
  if (!v || typeof v !== 'object') return false
  const d = v as Partial<TemplateDef>
  return d.formatVersion === TEMPLATE_DEF_VERSION
    && typeof d.tabId === 'string'
    && typeof d.templateId === 'string'
    && Array.isArray(d.fields)
    && Array.isArray(d.groups)
}

/** 读一个页签采用的定义；没有（= 仍在用内置 / 图鉴兼容适配器）⇒ null */
export async function loadTemplateDef(pid: string, tabId: string): Promise<TemplateDef | null> {
  if (!pid || !tabId) return null
  const raw = await db.getSettingFor<unknown>(pid, projectTemplateKeyOf(tabId), null)
  return isTemplateDef(raw) ? raw : null
}

/** 读目录索引（只用于索引，定义仍以每页签快照为准） */
export async function loadTemplateIndex(pid: string): Promise<TemplateIndex> {
  const raw = await db.getSettingFor<unknown>(pid, PROJECT_TEMPLATE_INDEX, null)
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as TemplateIndex).entries)) {
    return { formatVersion: TEMPLATE_DEF_VERSION, entries: [] }
  }
  return raw as TemplateIndex
}

// ────────────────────────── 写 ──────────────────────────

export type SaveTemplateResult =
  | { ok: true }
  | { ok: false; violations: LimitViolation[] }

/**
 * 串行队列：settingsKV 的「读-改-写」必须排队。
 *
 * 🔴 与 `db/meta.ts` 的 `addDailyWords` 同理 —— 模板保存会同时改「定义」与「索引」两处，
 *    两路保存几乎同时发生时，后写者会用自己读到的旧索引覆盖前者的写入，
 *    表现是"存了 A 页签再存 B，A 从目录里消失了"。单次失败不堵后续。
 */
let chain: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job)
  chain = run.then(() => undefined, () => undefined)
  return run
}

async function writeIndex(pid: string, entries: TemplateIndexEntry[]): Promise<void> {
  await db.setSettingFor(pid, PROJECT_TEMPLATE_INDEX, {
    formatVersion: TEMPLATE_DEF_VERSION,
    entries,
  })
}

/**
 * 保存（采用）一份模板定义。
 *
 * 🔴 校验顺序：**先单份结构 → 再项目合计**。顺序反了会先把 8 MiB 的账算完
 *    才发现字段名 25 字，白跑一趟 IO；而且作者看到的报错顺序也会莫名其妙。
 * 🔴 超限**整体拒绝**：不写定义、不写索引，库里保持改动前的样子。
 *    半写状态比拒绝更糟 —— 索引说有、定义读不到，界面会显示一个打不开的模板。
 */
export async function saveTemplateDef(pid: string, def: TemplateDef): Promise<SaveTemplateResult> {
  if (!pid) return { ok: false, violations: [{ code: 'bad-field-name', detail: '缺少项目 id，无法保存模板定义' }] }

  const violations = [...checkTemplateDef(def)]
  if (violations.length > 0) return { ok: false, violations }

  const quota = await projectQuotaViolations(pid, def)
  if (quota.length > 0) return { ok: false, violations: quota }

  await enqueue(async () => {
    await db.setSettingFor(pid, projectTemplateKeyOf(def.tabId), def)
    const idx = await loadTemplateIndex(pid)
    const rest = idx.entries.filter(e => e.tabId !== def.tabId)
    rest.push(entryOf(def))
    await writeIndex(pid, rest)
  })
  emit()
  return { ok: true }
}

/**
 * 放弃自定义，退回内置 / 图鉴兼容适配器。
 * 🔴 只删**定义与索引条目**，绝不动条目值 —— 值是作者写的，模板结构不是。
 */
export async function deleteTemplateDef(pid: string, tabId: string): Promise<void> {
  if (!pid || !tabId) return
  await enqueue(async () => {
    await db.delSettingFor(pid, projectTemplateKeyOf(tabId))
    const idx = await loadTemplateIndex(pid)
    await writeIndex(pid, idx.entries.filter(e => e.tabId !== tabId))
  })
  emit()
}

// ────────────────────────── 配额（项目合计 8 MiB）──────────────────────────

/**
 * 项目内全部模板定义的合计字节是否超额。
 *
 * @param incoming 本次正要写入的定义（还没落库），参与合计 ——
 *        否则作者可以靠"一份一份存"绕过额度，每份都合法而总量爆掉。
 */
export async function projectQuotaViolations(
  pid: string,
  incoming: TemplateDef,
): Promise<LimitViolation[]> {
  const L = TEMPLATE_LIMITS
  const idx = await loadTemplateIndex(pid)
  const others = idx.entries.filter(e => e.tabId !== incoming.tabId)
  let total = bytesOfDef(incoming)
  for (const e of others) {
    const d = await loadTemplateDef(pid, e.tabId)
    if (d) total += bytesOfDef(d)
  }
  if (total > L.PROJECT_MAX_BYTES) {
    return [{
      code: 'project-defs-too-large',
      detail: `单项目模板定义合计上限 ${(L.PROJECT_MAX_BYTES / 1024 / 1024).toFixed(0)} MiB，写入后将为 ${(total / 1024 / 1024).toFixed(2)} MiB（${others.length + 1} 个页签）`,
    }]
  }
  return []
}

// ────────────────────────── 订阅 ──────────────────────────

const subs = new Set<() => void>()
function emit(): void {
  subs.forEach(fn => {
    try { fn() } catch { /* 订阅方异常不该影响其它订阅方 */ }
  })
}
/** 订阅模板定义变化（换书 / 采用 / 放弃自定义时刷新界面） */
export function subscribeTemplateStore(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

// ────────────────────────── 内部 ──────────────────────────

function entryOf(def: TemplateDef): TemplateIndexEntry {
  return {
    tabId: def.tabId,
    templateId: def.templateId,
    name: def.name,
    semanticDigest: def.semanticDigest,
    revision: def.revision,
    updatedAt: def.updatedAt,
  }
}
