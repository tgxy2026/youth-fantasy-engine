/**
 * 首页「作品简介」取值（3.7.5 · 方案 B）
 *
 * 【为什么要有这个文件】首页卡片那块简介位原先读的是项目记录上的 `Project.intro`，
 * 而这个字段**只有示范项目**（`seedData` 硬写「废脉？我吞的就是天！」）和
 * 备份还原会写 —— 新建项目传空串、「编辑项目」弹窗里也没有输入框，
 * 于是除示范项目外，任何作品的简介位永远是「暂无简介」。
 * 作者真正会填的地方是《作品信息》页的「四、简介与物料」，所以改为读那里：
 *
 *   正式简介 → 一句话简介 → 项目记录上的旧 `intro`（兼容存量）→ 空（卡片给兜底文案）
 *
 * 🔴 为什么「正式简介」优先：它信息更完整，作者既然写了正式简介，
 *    就是要对外用的那一版；只写了一句话简介时自然用它。
 * 🔴 为什么还要回退 `Project.intro`：示范项目、备份还原、老版本导出的数据都可能有值，
 *    而《作品信息》表可能是空的（自定义项目甚至可以不含这一页）——
 *    不回退就会把本来能显示的简介变成「暂无简介」（对存量项目是倒退）。
 * 🔴 本文件**只放纯函数、不引 db**：表单的批量读取在调用方（ProjectHub）做，
 *    这样这段判据可以被单测直接钉住（见 tests/projectIntro.test.ts）。
 * 🔴 示范项目故意把《作品信息》的「正式简介」留空（`seedData`），只填一句话简介 ——
 *    两个都填的话，首页会显示 200 字正式简介示例，盖掉那句招牌「废脉？我吞的就是天！」。
 */

/** 《作品信息》页签 id（改名只改显示名，存储键始终是 positioning） */
export const INTRO_TAB_ID = 'positioning'

/** 表单字段名（字段别名只改显示与 AI 理解，**不改存储键**，所以按原名读是安全的） */
export const INTRO_FIELD_FORMAL = '正式简介'
export const INTRO_FIELD_ONE_LINE = '一句话简介'

/** 表单值的默认类型是 string；兼容历史里可能出现的非字符串脏值 */
function textAt(form: Record<string, unknown>, key: string): string {
  const v = form[key]
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 取某个字段的文本：先精确命中存储键，再按「键名包含」兜一层
 * （模板接管的页签可能给键加前后缀，例如「简介与物料·正式简介」）。
 */
function fieldText(form: Record<string, unknown>, name: string): string {
  const exact = textAt(form, name)
  if (exact) return exact
  for (const [k, v] of Object.entries(form)) {
    if (!k.includes(name)) continue
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * 从《作品信息》表单里挑简介：**正式简介优先，其次一句话简介**；两者都没填 ⇒ ''。
 * 只含空白的值一律当没填（作者清空后不该继续显示旧句子）。
 */
export function pickIntroFromForm(form: Record<string, unknown> | null | undefined): string {
  if (!form) return ''
  return fieldText(form, INTRO_FIELD_FORMAL) || fieldText(form, INTRO_FIELD_ONE_LINE)
}

/**
 * 首页/搜索用的最终文案：表单优先，其次项目记录上的旧 `intro`。
 * 返回值已 trim；空串表示「作者没填」——由调用方决定兜底提示怎么写。
 */
export function resolveProjectIntro(
  form: Record<string, unknown> | null | undefined,
  fallback: string | null | undefined,
): string {
  return pickIntroFromForm(form) || (fallback ?? '').trim()
}

/** 一句话简介的字数上限（见《作品信息》字段说明「50字以内浓缩全书」）—— 仅供界面提示，不截断 */
export const ONE_LINE_INTRO_MAX = 50
