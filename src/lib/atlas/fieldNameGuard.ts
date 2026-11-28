// ============ 自定义字段命名守卫（3.7.6 · P2） ============
//
// 作者可以在图鉴里给页签加自定义字段。如果加的是「名称 / 标题 / 名字」这类内置字段已有的语义，
// 同一条记录就会有两套名字：老数据留在内置列、新数据写进自定义列。表格按列显示看不出来，
// 但设定检索、正文引用与 AI 上下文会分不清哪个才是条目名（2026-11-28 用户反馈）。
//
// 🔴 这里只**拦新增/改名**，不改任何已有字段与数据：历史项目里已经存在的同名字段由
//    「数据体检 · 名字字段重复」报告并提供合并入口，绝不静默改名或清值。

/** 名称类语义 */
const NAME_RE = /名称|标题|名字/

/**
 * 返回与内置字段冲突的说明；没有冲突返回空串。
 *
 * @param label 作者输入的自定义字段名
 * @param builtinLabels 内置字段的**当前显示名**（已应用别名 / 模板标签）
 */
export function builtinFieldNameConflict(label: string, builtinLabels: Iterable<string>): string {
  const trimmed = label.trim()
  if (!trimmed) return ''
  const labels = [...builtinLabels].map(s => s.trim()).filter(Boolean)
  if (labels.includes(trimmed)) {
    return `内置字段已经叫「${trimmed}」：要换显示名请用下方「内置字段显示名」，不要新增同名字段 —— 否则同一行会有两套值，检索与正文引用会对不上`
  }
  if (NAME_RE.test(trimmed)) {
    const hit = labels.find(b => NAME_RE.test(b))
    if (hit) {
      return `内置已有名称列「${hit}」。同一条记录出现两个名字字段会让检索/引用分不清条目名；改名请用「内置字段显示名」，确实要记别的信息请换个字段名（如「别称」「尊称」）`
    }
  }
  return ''
}
