/**
 * 3.2.0 · WT1-5：**仅结构**模板包（导入 / 导出）
 *
 * 方案 §3.5：
 *   > 模板包不带条目正文、角色记忆、图片或密钥；完整项目/图鉴资料包另行承载资料。
 * 方案 §17.3「导入验证」：
 *   > 模板包先做 schema/版本/大小检查，拒绝重复字段 ID、非法存储键、原型污染键、
 *   > 重复选项 ID、无法解释的引用和越界数量。
 *
 * 🔴 导入一律 fail-closed：任何一条校验不过就整包拒绝（返回全部问题，不是第一条）。
 *    "部分导入"听起来友好，实际会让作者拿到半个模板——比拒绝更难收拾：
 *    他会以为整包都进来了，然后在缺字段的结构上继续填资料。
 *
 * 🔴 大小检查必须在 `JSON.parse` **之前**：先解析再判大小，等于先把超大文本
 *    展开成对象树，卡死的是界面（判据同 `limits.checkTemplatePack`）。
 */
import {
  TEMPLATE_DEF_VERSION, TEMPLATE_LIMITS, type TemplateDef,
} from './definition'
import { checkTemplateDef, checkTemplatePack, bytesOf } from './limits'
import { semanticDigestOf } from './legacyAdapter'
import { structureOf, publishTemplateDef, type PublishResult } from './library'

export const PACK_FORMAT = 'yfe-template-pack'
export const PACK_FORMAT_VERSION = 1

export type PackIssueCode =
  | 'too-large'
  | 'bad-json'
  | 'not-a-pack'
  | 'unknown-version'
  | 'empty'
  | 'bad-template'
  | 'duplicate-field-id'
  | 'bad-storage-key'
  | 'prototype-pollution'
  | 'duplicate-option'
  | 'dangling-group'
  | 'bad-name-field'
  | 'limit'

export interface PackIssue {
  code: PackIssueCode
  detail: string
  templateId?: string
  fieldId?: string
}

export type PackParseResult =
  | { ok: true; defs: TemplateDef[]; warnings: PackIssue[] }
  | { ok: false; code: PackIssueCode; detail: string; issues: PackIssue[] }

/** 字段存储键的形状：字母开头 + 字母数字下划线（`cf_xxx` / 内置键都在此范围内） */
const STORAGE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/

// ────────────────────────── 导出 ──────────────────────────

export type PackExportResult =
  | { ok: true; text: string; bytes: number; count: number }
  | { ok: false; code: PackIssueCode; detail: string; issues: PackIssue[] }

/**
 * 打包若干模板定义（**只含结构**）。
 *
 * 🔴 导出的每份定义都过一遍 `structureOf` 白名单：库里的记录可能是从旧版本迁移来的，
 *    也可能被手改过；导出是"出门"的动作，出门前必查有没有夹带。
 */
export function exportTemplatePack(
  defs: readonly TemplateDef[],
  opts: { exportedAt?: number } = {},
): PackExportResult {
  if (defs.length === 0) {
    return { ok: false, code: 'empty', detail: '没有可导出的模板', issues: [] }
  }
  const issues: PackIssue[] = []
  const clean: TemplateDef[] = []
  for (const d of defs) {
    const s = structureOf(d)
    for (const v of checkTemplateDef(s)) {
      issues.push({ code: 'limit', detail: v.detail, templateId: s.templateId, ...(v.fieldId ? { fieldId: v.fieldId } : {}) })
    }
    clean.push(s)
  }
  if (issues.length > 0) {
    return {
      ok: false,
      code: 'limit',
      detail: issues.map(i => i.detail).join('；'),
      issues,
    }
  }

  const text = JSON.stringify({
    format: PACK_FORMAT,
    formatVersion: PACK_FORMAT_VERSION,
    exportedAt: opts.exportedAt ?? Date.now(),
    templates: clean,
  })
  const tooLarge = checkTemplatePack(text)
  if (tooLarge.length > 0) {
    return {
      ok: false,
      code: 'too-large',
      detail: tooLarge[0].detail,
      issues: [{ code: 'too-large', detail: tooLarge[0].detail }],
    }
  }
  return { ok: true, text, bytes: bytesOf(text), count: clean.length }
}

// ────────────────────────── 导入 ──────────────────────────

/**
 * 解析并校验模板包。
 *
 * @returns `ok:false` 时 `issues` 含**全部**问题（作者一次改完，而不是存一次报一条）。
 */
export function parseTemplatePack(text: string): PackParseResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, code: 'bad-json', detail: '模板包内容为空', issues: [] }
  }
  // ① 大小先于解析
  const tooLarge = checkTemplatePack(text)
  if (tooLarge.length > 0) {
    return {
      ok: false, code: 'too-large', detail: tooLarge[0].detail,
      issues: [{ code: 'too-large', detail: tooLarge[0].detail }],
    }
  }
  // ② 原型污染键：解析前就扫文本（解析后再扫也行，但此时对象树里 `__proto__` 已被特殊处理）
  if (/"(?:__proto__|constructor|prototype)"\s*:/.test(text)) {
    const detail = '模板包含有原型污染风险的键（__proto__ / constructor / prototype），已拒绝'
    return { ok: false, code: 'prototype-pollution', detail, issues: [{ code: 'prototype-pollution', detail }] }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    const detail = `模板包不是合法 JSON：${e instanceof Error ? e.message : String(e)}`
    return { ok: false, code: 'bad-json', detail, issues: [{ code: 'bad-json', detail }] }
  }
  if (!raw || typeof raw !== 'object') {
    const detail = '模板包顶层不是对象'
    return { ok: false, code: 'not-a-pack', detail, issues: [{ code: 'not-a-pack', detail }] }
  }
  const o = raw as Record<string, unknown>
  if (o.format !== PACK_FORMAT) {
    const detail = `不是模板包（format=${String(o.format)}）；资料包/项目包有各自的导入入口`
    return { ok: false, code: 'not-a-pack', detail, issues: [{ code: 'not-a-pack', detail }] }
  }
  const fv = Number(o.formatVersion)
  if (!Number.isInteger(fv) || fv < 1) {
    const detail = `模板包格式版本非法：${String(o.formatVersion)}`
    return { ok: false, code: 'not-a-pack', detail, issues: [{ code: 'not-a-pack', detail }] }
  }
  if (fv > PACK_FORMAT_VERSION) {
    const detail = `模板包格式版本 ${fv} 高于本版本支持的 ${PACK_FORMAT_VERSION}，拒绝写入（请升级软件后再导入）`
    return { ok: false, code: 'unknown-version', detail, issues: [{ code: 'unknown-version', detail }] }
  }

  const templates = o.templates
  if (!Array.isArray(templates) || templates.length === 0) {
    const detail = '模板包里没有任何模板'
    return { ok: false, code: 'empty', detail, issues: [{ code: 'empty', detail }] }
  }
  if (templates.length > TEMPLATE_LIMITS.MAX_TOTAL_CUSTOM_FIELDS) {
    const detail = `模板包内模板数量异常（${templates.length} 个）`
    return { ok: false, code: 'empty', detail, issues: [{ code: 'empty', detail }] }
  }

  const issues: PackIssue[] = []
  const warnings: PackIssue[] = []
  const defs: TemplateDef[] = []
  for (const [i, item] of templates.entries()) {
    const one = readOneDef(item, i, issues, warnings)
    if (one) defs.push(one)
  }
  if (issues.length > 0) {
    return {
      ok: false,
      code: issues[0].code,
      detail: issues.map(x => x.detail).join('；'),
      issues,
    }
  }
  return { ok: true, defs, warnings }
}

/**
 * 校验并规整**一份**导入的定义。
 *
 * 🔴 `semanticDigest` / `contentDigest` 一律**重算**：包里带的是导出方的算法结果，
 *    可能是旧版本算的、也可能被手改过。摘要参与"语义是否变化"的判定，
 *    照抄等于把一个外来字符串当成可信依据。
 */
function readOneDef(
  raw: unknown,
  index: number,
  issues: PackIssue[],
  warnings: PackIssue[],
): TemplateDef | null {
  const where = `第 ${index + 1} 份模板`
  if (!raw || typeof raw !== 'object') {
    issues.push({ code: 'bad-template', detail: `${where}不是对象` })
    return null
  }
  const d = raw as Record<string, unknown>
  const templateId = typeof d.templateId === 'string' ? d.templateId : ''
  const tabId = typeof d.tabId === 'string' ? d.tabId : ''
  if (!templateId || !tabId) {
    issues.push({ code: 'bad-template', detail: `${where}缺少 templateId 或 tabId` })
    return null
  }
  const defVersion = Number(d.formatVersion)
  if (defVersion > TEMPLATE_DEF_VERSION) {
    issues.push({
      code: 'unknown-version',
      detail: `${where}（${templateId}）定义格式版本 ${defVersion} 高于本版本支持的 ${TEMPLATE_DEF_VERSION}，拒绝写入`,
      templateId,
    })
    return null
  }
  if (!Array.isArray(d.fields) || !Array.isArray(d.groups)) {
    issues.push({ code: 'bad-template', detail: `${where}（${templateId}）缺少 fields / groups`, templateId })
    return null
  }

  const groups = (d.groups as unknown[]).filter(g => g && typeof g === 'object').map(g => g as Record<string, unknown>)
  const groupIds = new Set(groups.map(g => String(g.id ?? '')))
  const fields = (d.fields as unknown[]).filter(f => f && typeof f === 'object').map(f => f as Record<string, unknown>)

  const seenField = new Set<string>()
  for (const f of fields) {
    const id = String(f.id ?? '')
    const label = String(f.label ?? '')
    if (!STORAGE_KEY_RE.test(id)) {
      issues.push({
        code: 'bad-storage-key',
        detail: `${where}（${templateId}）字段「${label || id}」的存储键「${id}」非法：只允许字母开头 + 字母数字下划线`,
        templateId,
        ...(id ? { fieldId: id } : {}),
      })
      continue
    }
    if (seenField.has(id)) {
      issues.push({
        code: 'duplicate-field-id',
        detail: `${where}（${templateId}）字段 ID 重复：${id}`,
        templateId,
        fieldId: id,
      })
    }
    seenField.add(id)
    const gid = String(f.groupId ?? '')
    if (!groupIds.has(gid)) {
      issues.push({
        code: 'dangling-group',
        detail: `${where}（${templateId}）字段「${label || id}」引用了不存在的分组 ${gid}`,
        templateId,
        fieldId: id,
      })
    }
    if (Array.isArray(f.options)) {
      const opts = (f.options as unknown[]).map(String)
      if (new Set(opts).size !== opts.length) {
        issues.push({
          code: 'duplicate-option',
          detail: `${where}（${templateId}）字段「${label || id}」有重复候选项`,
          templateId,
          fieldId: id,
        })
      }
    }
  }

  const nameFieldId = String(d.nameFieldId ?? '')
  if (nameFieldId && !seenField.has(nameFieldId)) {
    // 不阻断：计划层会以 `name-field-missing` 拦住执行，作者在这里只是需要选一个
    warnings.push({
      code: 'bad-name-field',
      detail: `${where}（${templateId}）的名称字段 ${nameFieldId} 不在字段清单里，采用时需要重新指定`,
      templateId,
      fieldId: nameFieldId,
    })
  }

  // 一份字段都没有的"模板"没有意义：写进库只会让作者以为导入成功了
  if (fields.length === 0) {
    issues.push({ code: 'bad-template', detail: `${where}（${templateId}）没有任何字段`, templateId })
    return null
  }

  const def = structureOf({
    ...(d as unknown as TemplateDef),
    fields: fields as unknown as TemplateDef['fields'],
    groups: groups as unknown as TemplateDef['groups'],
    templateId,
    tabId,
    nameFieldId,
  })
  // 摘要重算（外来字符串不可信）
  const recomputed = semanticDigestOf(def.fields)
  const normalized: TemplateDef = {
    ...def,
    formatVersion: TEMPLATE_DEF_VERSION,
    semanticDigest: recomputed,
    revision: Number.isFinite(Number(d.revision)) ? Number(d.revision) : 0,
    updatedAt: Number.isFinite(Number(d.updatedAt)) ? Number(d.updatedAt) : Date.now(),
  }
  for (const v of checkTemplateDef(normalized)) {
    issues.push({
      code: 'limit',
      detail: `${where}（${templateId}）${v.detail}`,
      templateId,
      ...(v.fieldId ? { fieldId: v.fieldId } : {}),
    })
  }
  return normalized
}

// ────────────────────────── 导入 → 发布到个人库 ──────────────────────────

export type PackPublishOutcome =
  | { kind: 'published'; templateId: string; version: number; created: boolean }
  | { kind: 'conflict'; templateId: string; detail: string }

export type PackPublishResult =
  | { ok: true; outcomes: PackPublishOutcome[]; warnings: PackIssue[] }
  | { ok: false; code: PackIssueCode; detail: string; issues: PackIssue[] }

/**
 * 解析模板包并逐份发布到个人库。
 *
 * 🔴 冲突**不中断**其它模板：两份模板互不相干，一份撞版本不该连坐另一份。
 *    但冲突必须逐条回报（`kind:'conflict'`），由作者决定升版本还是另存新模板。
 *
 * 🔴 来自库的模板按**它自己的已发布版本号**入库（`origin.version`）：
 *    方案 §3.5「模板包同 ID/版本但内容摘要不同须报冲突或另存为新模板」——
 *    这条规则只有在导入时保留版本号才成立。若一律自动升版本，
 *    "同名同版却是另一份定义"就永远不会被发现，只会悄悄长出 v2、v3。
 */
export async function importPackToLibrary(text: string): Promise<PackPublishResult> {
  const parsed = parseTemplatePack(text)
  if (!parsed.ok) return { ok: false, code: parsed.code, detail: parsed.detail, issues: parsed.issues }

  const outcomes: PackPublishOutcome[] = []
  for (const def of parsed.defs) {
    const origin = def.origin
    const publishedVersion = origin?.kind === 'library' && origin.templateId === def.templateId
      ? origin.version
      : undefined
    const r: PublishResult = await publishTemplateDef(
      def,
      publishedVersion != null ? { version: publishedVersion } : {},
    )
    if (r.ok) outcomes.push({ kind: 'published', templateId: r.templateId, version: r.version, created: r.created })
    else {
      outcomes.push({
        kind: 'conflict',
        templateId: def.templateId,
        detail: r.code === 'version-conflict'
          ? r.detail
          : `发布失败（${r.code}）：${r.detail}`,
      })
    }
  }
  return { ok: true, outcomes, warnings: parsed.warnings }
}
