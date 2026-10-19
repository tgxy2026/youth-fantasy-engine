/**
 * 3.2.0 · WT1-2：把**项目采用的模板快照**解析成有效模板
 *
 * 与 `legacyAdapter`（内置 schema / 图鉴配置）并列第三个来源。
 * 三者输出同一个 `EffectiveTemplate` 形状 ⇒ 消费者**不需要知道**结构来自哪。
 *
 * 过滤口径**逐字对齐** `resolveAtlasFields`（`lib/atlas/schema.ts`）：
 *   · 归档字段一律不进常规解析（归档＝不显示，不是删除）；
 *   · `appliesTo` 按本次 category 判，`ignoreAppliesTo` 时跳过该判断（全表视图）；
 *   · 各用途看各自的权限位：table / detail / search / aiRead / aiWrite；
 *   · `export` 不受权限限制（导出是作者自己的数据出门，不该被展示开关拦住）。
 */
import { semanticDigestOf } from './legacyAdapter'
import type { EffectiveField, EffectiveTemplate, TemplateDiagnostic, TemplatePurpose } from './types'
import { TEMPLATE_DEF_VERSION, type TemplateDef } from './definition'

export interface AdaptDefOptions {
  purpose?: TemplatePurpose
  /** 条目类别（图鉴四页签） */
  category?: string
  /** 忽略类别适用范围（全表视图用） */
  ignoreAppliesTo?: boolean
  /** 项目修订号 */
  revision?: number
}

function appliesToOk(appliesTo: '*' | string[], category?: string): boolean {
  if (appliesTo === '*') return true
  if (!category) return false
  return appliesTo.includes(category)
}

/** 某字段在某个用途下是否出现（与 `resolveAtlasFields` 同口径） */
function visibleAt(f: EffectiveField, purpose: TemplatePurpose): boolean {
  switch (purpose) {
    case 'table': return f.permissions.table
    case 'detail': return f.permissions.detail
    case 'search': return f.permissions.search
    case 'aiRead': return f.permissions.aiRead
    case 'aiWrite': return f.permissions.aiWrite
    // 🔴 export / index：导出不受展示开关限制；索引按 AI 可读口径
    case 'export': return true
    case 'index': return f.permissions.aiRead
    default: return true
  }
}

/**
 * 解析一份项目模板快照。
 *
 * 🔴 `templateId` 沿用定义里的那个（不是 `builtin:`），
 *    这样「结果是在哪个模板下算出来的」可被追踪 —— 模板换代次后旧结果要判失效。
 */
export function adaptTemplateDef(def: TemplateDef, opts: AdaptDefOptions = {}): EffectiveTemplate {
  const purpose = opts.purpose ?? 'detail'
  const fields = def.fields.filter(f => !f.archived && visibleAt(f, purpose))
    .filter(f => opts.ignoreAppliesTo || appliesToOk(f.appliesTo, opts.category))
  const diagnostics: TemplateDiagnostic[] = []
  for (const f of fields) {
    if (f.type === 'other') {
      diagnostics.push({
        code: 'unknown-field-type',
        detail: `字段「${f.label}」类型未识别，按只读处理`,
        fieldId: f.id,
      })
    }
  }
  return {
    templateId: def.templateId,
    version: TEMPLATE_DEF_VERSION,
    revision: opts.revision ?? def.revision,
    // 🔴 摘要按**过滤后**的字段算：不同用途看到的语义面本来就不同，
    //    用全集算会让"表格视图"和"AI 读取"得出同一个摘要，失效判定就失准了。
    semanticDigest: semanticDigestOf(fields),
    tabId: def.tabId,
    purpose,
    groups: def.groups.map(g => ({ ...g })),
    fields: fields.map(f => ({ ...f, permissions: { ...f.permissions } })),
    diagnostics,
  }
}
