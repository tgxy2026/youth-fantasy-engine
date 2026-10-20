/**
 * 3.2.0 · WT1-5：**个人模板库**（发布代次 + 升级预览）
 *
 * 方案 §3.5 原文：
 *   > 个人模板库 | `meta`：`templateLibrary32:<templateId>:v<version>`；只含定义，
 *   > 默认作为本机个人库，加入云同步排除；分享走显式模板包，不影响项目内快照同步。
 *
 * 方案 §3.6 原文：
 *   > 项目采用模板的**固定快照**。个人模板库发布新版本不修改已有项目；
 *   > 项目可独立编辑成新修订，或查看库版本差异后升级。
 *   > 已发布库版本不可原地覆盖，模板包同 ID/版本但内容摘要不同须报冲突或另存为新模板。
 *
 * 🔴 三条不许松动的规则：
 *   1. **库 → 项目是单向、显式、可预览的**：库发新版绝不自动改项目快照；
 *      项目升级必须走 `prepareLibraryUpgrade()`（只读计划）→ `migrate.applyTemplateMigration()`。
 *   2. **已发布版本不可原地覆盖**：同 ID 同版本、内容摘要不同 ⇒ 拒绝并给出两条出路
 *      （升版本 / 另存为新模板）。否则"作者以为升了版、对方拉到的是另一份定义"。
 *   3. **库只存结构**：值、正文、图片、密钥一律不进库；写入前按白名单重建对象。
 */
import * as db from '@/lib/db'
import {
  LIBRARY_PREFIX, TEMPLATE_DEF_VERSION,
  libraryKeyOf, type TemplateDef,
} from './definition'
import { checkTemplateDef, checkTemplatePack, type LimitViolation } from './limits'
import { semanticDigestOf } from './legacyAdapter'
import { newTemplateId } from './snapshot'
import { isTemplateDef, loadTemplateDef } from './store'
import { planTemplateChange, type TemplateChangePlan } from './plan'
import { countValuesForFields } from './migrate'

export const LIBRARY_FORMAT_VERSION = 1 as const
/** 库目录索引（可重建，不作为定义权威 —— 定义仍以 `v<version>` 记录为准） */
export const LIBRARY_INDEX_KEY = `${LIBRARY_PREFIX}index`

// ────────────────────────── 类型 ──────────────────────────

export interface LibraryVersionRecord {
  formatVersion: typeof LIBRARY_FORMAT_VERSION
  templateId: string
  version: number
  name: string
  tabId: string
  /** 语义摘要（与 `TemplateDef.semanticDigest` 同算法） */
  semanticDigest: string
  /** 内容摘要：**判"同 ID/版本但内容不同"的唯一依据**（见 `contentDigestOf`） */
  contentDigest: string
  publishedAt: number
  def: TemplateDef
}

export interface LibraryIndexEntry {
  templateId: string
  name: string
  tabId: string
  latestVersion: number
  /** 已发布版本号（升序） */
  versions: number[]
  updatedAt: number
}

export interface LibraryIndex {
  formatVersion: typeof LIBRARY_FORMAT_VERSION
  entries: LibraryIndexEntry[]
}

export type PublishFailCode =
  | 'invalid-def'
  | 'pack-too-large'
  | 'bad-version'
  | 'version-conflict'
  | 'tab-mismatch'

export type PublishResult =
  | { ok: true; templateId: string; version: number; /** `false` = 同内容重复发布，未产生新记录 */ created: boolean }
  | { ok: false; code: PublishFailCode; detail: string; violations?: LimitViolation[] }

// ────────────────────────── 只存结构 ──────────────────────────

/**
 * 按白名单重建一份**只含结构**的定义。
 *
 * 🔴 为什么不是"信任类型就行"：库定义可能来自导入的模板包（外部 JSON），
 *    里面完全可能夹着 `rows` / `data` / `image` / `token` 这类作者资料。
 *    类型系统只约束我们自己写出来的对象，管不了别人的文件 ——
 *    白名单重建是唯一靠得住的口径（未知键一律丢弃，不做"应该没事"的假设）。
 */
export function structureOf(def: TemplateDef): TemplateDef {
  return {
    formatVersion: TEMPLATE_DEF_VERSION,
    templateId: String(def.templateId),
    name: String(def.name ?? ''),
    tabId: String(def.tabId ?? ''),
    origin: def.origin,
    groups: (def.groups ?? []).map(g => ({ id: g.id, label: g.label, order: g.order })),
    fields: (def.fields ?? []).map(f => ({
      id: f.id,
      sourceKey: f.sourceKey,
      source: f.source,
      label: f.label,
      type: f.type,
      groupId: f.groupId,
      order: f.order,
      appliesTo: f.appliesTo,
      archived: Boolean(f.archived),
      permissions: {
        table: Boolean(f.permissions?.table),
        detail: Boolean(f.permissions?.detail),
        search: Boolean(f.permissions?.search),
        aiRead: Boolean(f.permissions?.aiRead),
        aiWrite: Boolean(f.permissions?.aiWrite),
      },
      ...(f.options ? { options: [...f.options] } : {}),
      ...(f.fixedOptions ? { fixedOptions: true } : {}),
      ...(f.unit ? { unit: f.unit } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...(f.example ? { example: f.example } : {}),
    })),
    nameFieldId: String(def.nameFieldId ?? ''),
    semanticDigest: String(def.semanticDigest ?? ''),
    revision: Number(def.revision ?? 0),
    updatedAt: Number(def.updatedAt ?? Date.now()),
  }
}

/**
 * 内容摘要 —— 「同 ID/版本但内容不同」的判据。
 *
 * 组成：模板名 + 名称字段 + 字段语义摘要（复用 `semanticDigestOf`，排除纯布局乱序）
 *      + 分组（id/label/order）。
 * 🔴 **不含** revision / updatedAt：那两项是"保存了几次"，不是内容；
 *    含进去会让"重新保存一次"变成假冲突。
 * 🔴 **含**模板名：已发布版本连名字都不许偷换 —— 同版本不同名同样是覆盖。
 */
export function contentDigestOf(def: TemplateDef): string {
  const d = structureOf(def)
  const groups = [...d.groups]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(g => `${g.id}|${g.label}|${g.order}`)
    .join(';')
  return `c1:${semanticDigestOf(d.fields)}|${d.name}|${d.nameFieldId}|${groups}`
}

// ────────────────────────── 索引 ──────────────────────────

export async function loadLibraryIndex(): Promise<LibraryIndex> {
  const raw = await db.getMeta<unknown>(LIBRARY_INDEX_KEY, null)
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as LibraryIndex).entries)) {
    return { formatVersion: LIBRARY_FORMAT_VERSION, entries: [] }
  }
  return raw as LibraryIndex
}

export async function listLibraryTemplates(): Promise<LibraryIndexEntry[]> {
  const idx = await loadLibraryIndex()
  return [...idx.entries].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadLibraryVersion(
  templateId: string,
  version: number,
): Promise<LibraryVersionRecord | null> {
  if (!templateId || !Number.isInteger(version) || version < 1) return null
  const raw = await db.getMeta<unknown>(libraryKeyOf(templateId, version), null)
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<LibraryVersionRecord>
  if (r.formatVersion !== LIBRARY_FORMAT_VERSION) return null
  if (r.templateId !== templateId || r.version !== version) return null
  if (!r.def || !isTemplateDef(r.def)) return null
  return raw as LibraryVersionRecord
}

/** 某模板在库里的下一个可用版本号（没有 ⇒ 1） */
export async function nextLibraryVersion(templateId: string): Promise<number> {
  const idx = await loadLibraryIndex()
  const hit = idx.entries.find(e => e.templateId === templateId)
  return (hit?.latestVersion ?? 0) + 1
}

// ────────────────────────── 发布 ──────────────────────────

let chain: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job)
  chain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 发布一版模板到个人库。
 *
 * @param def      要发布的结构（会按白名单重建一遍）
 * @param opts.version 显式版本号；缺省 = `latest + 1`
 *
 * 🔴 幂等：同版本、同内容摘要重复发布 ⇒ `created: false`，不报错、不写库。
 *    作者连点两次"发布"不该变成两条记录或一次冲突。
 * 🔴 冲突：同版本、**内容摘要不同** ⇒ 拒绝（`version-conflict`），并明确给出出路。
 */
export function publishTemplateDef(def: TemplateDef, opts: { version?: number } = {}): Promise<PublishResult> {
  return enqueue(() => publishNow(def, opts))
}

async function publishNow(def: TemplateDef, opts: { version?: number }): Promise<PublishResult> {
  const clean = structureOf(def)
  if (!clean.templateId || !clean.tabId) {
    return { ok: false, code: 'invalid-def', detail: '模板缺少标识或所属页签，不能发布' }
  }

  const violations = [
    ...checkTemplateDef(clean),
    ...checkTemplatePack(JSON.stringify(clean)),
  ]
  if (violations.length > 0) {
    const worst = violations[0]
    return {
      ok: false,
      code: worst.code === 'pack-too-large' ? 'pack-too-large' : 'invalid-def',
      detail: violations.map(v => v.detail).join('；'),
      violations,
    }
  }

  const idx = await loadLibraryIndex()
  const entry = idx.entries.find(e => e.templateId === clean.templateId)

  // 同 templateId 的页签必须一致：跨页签复用同一个 id 会让"升级到哪个页签"无从判断
  if (entry && entry.tabId !== clean.tabId) {
    return {
      ok: false,
      code: 'tab-mismatch',
      detail: `模板 ${clean.templateId} 已属于页签「${entry.tabId}」，不能再发布成「${clean.tabId}」的模板`,
    }
  }

  const digest = contentDigestOf(clean)
  let version: number
  if (opts.version != null) {
    version = opts.version
    if (!Number.isInteger(version) || version < 1) {
      return { ok: false, code: 'bad-version', detail: `版本号必须是 ≥1 的整数（收到 ${String(opts.version)}）` }
    }
    const existing = await loadLibraryVersion(clean.templateId, version)
    if (existing) {
      if (existing.contentDigest === digest) {
        return { ok: true, templateId: clean.templateId, version, created: false }
      }
      return {
        ok: false,
        code: 'version-conflict',
        detail: `模板 ${clean.templateId} 的第 ${version} 版已发布过且内容不同（已发布版本不可原地覆盖）。`
          + '请发布为新版本，或用「另存为新模板」换个 templateId。',
      }
    }
  } else {
    // 自动版本：内容与最新版完全相同 ⇒ 幂等，不再涨版本号
    const latest = entry?.latestVersion ?? 0
    if (latest > 0) {
      const rec = await loadLibraryVersion(clean.templateId, latest)
      if (rec && rec.contentDigest === digest) {
        return { ok: true, templateId: clean.templateId, version: latest, created: false }
      }
    }
    version = latest + 1
  }

  const record: LibraryVersionRecord = {
    formatVersion: LIBRARY_FORMAT_VERSION,
    templateId: clean.templateId,
    version,
    name: clean.name,
    tabId: clean.tabId,
    semanticDigest: clean.semanticDigest,
    contentDigest: digest,
    publishedAt: Date.now(),
    def: clean,
  }
  await db.setMeta(libraryKeyOf(clean.templateId, version), record)

  const nextEntries = idx.entries.filter(e => e.templateId !== clean.templateId)
  nextEntries.push({
    templateId: clean.templateId,
    name: clean.name,
    tabId: clean.tabId,
    latestVersion: Math.max(version, entry?.latestVersion ?? 0),
    versions: [...new Set([...(entry?.versions ?? []), version])].sort((a, b) => a - b),
    updatedAt: record.publishedAt,
  })
  await db.setMeta(LIBRARY_INDEX_KEY, {
    formatVersion: LIBRARY_FORMAT_VERSION,
    entries: nextEntries,
  } satisfies LibraryIndex)

  return { ok: true, templateId: clean.templateId, version, created: true }
}

/**
 * 另存为新模板（`version-conflict` 的第二条出路）。
 *
 * 🔴 换的是 `templateId` 而不是版本号：作者改的可能是一份**已经发过版的**结构，
 *    强行升版本会让下游分不清"这是同一套结构的演进"还是"另一套东西"。
 */
export function publishAsNewTemplate(def: TemplateDef): Promise<PublishResult> {
  const src = structureOf(def)
  return publishTemplateDef({
    ...src,
    templateId: newTemplateId(),
    // 🔴 换了 id 就必须同时换出处：否则新模板的 `origin.templateId` 还指着旧的，
    //    下次「发布新版本」会显得它来自另一条版本线。
    origin: { kind: 'copy', fromTemplateId: src.templateId, fromName: src.name },
  })
}

// ────────────────────────── 升级预览 ──────────────────────────

export interface LibraryUpgradePreview {
  tabId: string
  /** 项目当前是否采用了库里的某个版本（不是则 `null` = 走"首次采用"语义） */
  fromLibraryVersion: number | null
  toTemplateId: string
  toVersion: number
  /** 与迁移执行层完全同一份计划（禁止另算一套差异） */
  plan: TemplateChangePlan
  /** 能否直接执行（计划无阻断） */
  executable: boolean
  /** 预览用的一句话结论 */
  summaryText: string
}

/**
 * 预览"把个人库的某个版本升级到项目"会发生什么 —— **只读**。
 *
 * 🔴 为什么必须复用 `planTemplateChange`：升级与迁移是同一件事的两条入口，
 *    各算一套差异必然分叉（一个说"只改了 2 个字段"，另一个归档了 5 个）。
 * 🔴 值规模也一并算（`countValuesForFields`）：作者在点"升级"之前就该知道
 *    会影响多少条资料，而不是升级完才发现"整本书的字段都变了"。
 */
export async function previewLibraryUpgrade(
  pid: string,
  tabId: string,
  libDef: TemplateDef,
  opts: { projectDef?: TemplateDef | null } = {},
): Promise<LibraryUpgradePreview> {
  const projectDef = opts.projectDef !== undefined ? opts.projectDef : await loadTemplateDef(pid, tabId)
  const fieldIds = (projectDef?.fields ?? []).map(f => f.id)
  const valueCounts = await countValuesForFields(pid, tabId, fieldIds)
  const plan = planTemplateChange(projectDef, libDef, { valueCounts })

  let fromLibraryVersion: number | null = null
  if (projectDef?.origin?.kind === 'library' && projectDef.origin.templateId === libDef.templateId) {
    fromLibraryVersion = projectDef.origin.version
  }

  const summaryText = plan.blockers.length > 0
    ? `有 ${plan.blockers.length} 项必须先解决：${plan.blockers[0].detail}`
    : `保留 ${plan.summary.kept} / 改动 ${plan.summary.modified} / 新增 ${plan.summary.added} / 归档 ${plan.summary.archived}`
      + (plan.valueScaleKnown ? `，影响 ${plan.affectedValueCount} 条资料` : '，影响规模未知')

  return {
    tabId,
    fromLibraryVersion,
    toTemplateId: libDef.templateId,
    toVersion: (libDef.origin?.kind === 'library' ? libDef.origin.version : 0),
    plan,
    executable: plan.blockers.length === 0,
    summaryText,
  }
}
