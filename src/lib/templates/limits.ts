/**
 * 3.2.0 · WT1-1：模板定义的**限额校验**
 *
 * 方案 §3.5「初始限制」逐条落地。
 *
 * 🔴 唯一硬性规则：**超限一律拒绝，绝不截断**。
 *    截断说明 / 砍选项 / 丢字段，都是"存进去了但和作者设计的不一样"，
 *    而且下次读出来会以被截断的版本为新基准，偏差逐次累积、无法回溯。
 *    作者宁可看到一句"选项最多 100 项，当前 137 项"，也不该发现自己存的悄悄少了 37 项。
 */
import { TEMPLATE_LIMITS, type TemplateDef } from './definition'

export interface LimitViolation {
  code:
    | 'too-many-active-fields'   // 未归档自定义字段超限
    | 'too-many-total-fields'    // 自定义字段总数超限（含归档）
    | 'too-many-groups'          // 分组数超限
    | 'bad-field-name'           // 字段名长度非法
    | 'description-too-long'     // 字段说明超长
    | 'too-many-options'         // 候选项超限
    | 'pack-too-large'           // 模板包超 2 MiB
    | 'project-defs-too-large'   // 项目模板定义合计超 8 MiB
  detail: string
  fieldId?: string
}

/** 汉字的「字」数：按码点算，避免代理对被算成 2（emoji 仍算 2，可接受） */
export function charLen(s: string): number {
  return [...s.trim()].length
}

/**
 * 序列化字节数。
 * 🔴 用 UTF-8 而不是 `s.length`：中文一个字 3 字节，按字符数算会低估 3 倍，
 *    2 MiB 的额度实际能塞进 6 MiB 的内容 —— 额度形同虚设。
 */
export function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length
}

/** 单份模板定义占用的字节数（归档定义也计入 —— 丢了就恢复不了） */
export function bytesOfDef(def: TemplateDef): number {
  return bytesOf(JSON.stringify(def))
}

/**
 * 校验一份模板定义。
 *
 * @returns 违规项数组；**空数组 = 通过**。
 *
 * 🔴 一次性返回**全部**违规，不遇到第一条就停 ——
 *    作者要改的是一份结构，只报一条就得存一次看一次，来回几十趟。
 */
export function checkTemplateDef(def: TemplateDef): LimitViolation[] {
  const out: LimitViolation[] = []
  const L = TEMPLATE_LIMITS

  const custom = def.fields.filter(f => f.source === 'custom')
  const active = custom.filter(f => !f.archived)
  if (active.length > L.MAX_ACTIVE_CUSTOM_FIELDS) {
    out.push({
      code: 'too-many-active-fields',
      detail: `未归档自定义字段最多 ${L.MAX_ACTIVE_CUSTOM_FIELDS} 个，当前 ${active.length} 个；请先归档不再使用的字段`,
    })
  }
  if (custom.length > L.MAX_TOTAL_CUSTOM_FIELDS) {
    out.push({
      code: 'too-many-total-fields',
      detail: `自定义字段定义合计最多 ${L.MAX_TOTAL_CUSTOM_FIELDS} 个（含归档），当前 ${custom.length} 个`,
    })
  }
  if (def.groups.length > L.MAX_GROUPS) {
    out.push({
      code: 'too-many-groups',
      detail: `分组最多 ${L.MAX_GROUPS} 个，当前 ${def.groups.length} 个`,
    })
  }

  for (const f of def.fields) {
    const n = charLen(f.label)
    if (n < L.NAME_MIN || n > L.NAME_MAX) {
      out.push({
        code: 'bad-field-name',
        detail: `字段名需 ${L.NAME_MIN}–${L.NAME_MAX} 字，「${f.label}」为 ${n} 字`,
        fieldId: f.id,
      })
    }
    if (f.description && charLen(f.description) > L.DESCRIPTION_MAX) {
      out.push({
        code: 'description-too-long',
        detail: `字段「${f.label}」的说明最多 ${L.DESCRIPTION_MAX} 字，当前 ${charLen(f.description)} 字`,
        fieldId: f.id,
      })
    }
    if (f.options && f.options.length > L.MAX_OPTIONS) {
      out.push({
        code: 'too-many-options',
        detail: `字段「${f.label}」的候选项最多 ${L.MAX_OPTIONS} 项，当前 ${f.options.length} 项`,
        fieldId: f.id,
      })
    }
  }

  return out
}

/**
 * 校验**整个项目**的模板定义合计（≤ 8 MiB）。
 *
 * 🔴 方案原文：8 MiB 包括项目模板、T3 轻量覆盖及发布清单；
 *    「归档定义也计入字节额度，另限制每页签全部自定义字段定义最多 200 个，
 *     避免只限制活跃字段却无限积累归档」。
 *    ⇒ 所以这里 `checkTemplateDef` 的每条规则都照跑，不清归档。
 */
export function checkProjectTemplateDefs(defs: readonly TemplateDef[]): LimitViolation[] {
  const out: LimitViolation[] = []
  for (const d of defs) out.push(...checkTemplateDef(d))

  const total = defs.reduce((sum, d) => sum + bytesOfDef(d), 0)
  const L = TEMPLATE_LIMITS
  if (total > L.PROJECT_MAX_BYTES) {
    out.push({
      code: 'project-defs-too-large',
      detail: `单项目模板定义合计上限 ${(L.PROJECT_MAX_BYTES / 1024 / 1024).toFixed(0)} MiB，当前 ${(total / 1024 / 1024).toFixed(2)} MiB（${defs.length} 个页签）`,
    })
  }
  return out
}

/**
 * 模板包的大小校验（≤ 2 MiB）。
 *
 * 🔴 方案：「包导入先验证完整结构、引用、大小和未知版本，再建立变更计划」。
 *    大小检查必须**在**解析之前 —— 先解析再判大小，等于先把 200 MiB 的文本
 *    展开成对象树，卡死的是界面。
 */
export function checkTemplatePack(text: string): LimitViolation[] {
  const b = bytesOf(text)
  const L = TEMPLATE_LIMITS
  if (b > L.PACK_MAX_BYTES) {
    return [{
      code: 'pack-too-large',
      detail: `模板包上限 ${(L.PACK_MAX_BYTES / 1024 / 1024).toFixed(0)} MiB，当前 ${(b / 1024 / 1024).toFixed(2)} MiB`,
    }]
  }
  return []
}
