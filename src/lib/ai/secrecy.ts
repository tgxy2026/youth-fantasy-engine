/**
 * 「保密等级」的三种用法（3.1.3 从 `aiContext.ts` 抽出：那里贴着 1200 行结构闸）。
 *
 * 同一个字段承担三件事，**必须分开放、分开测**，否则改一处容易忘另一处：
 *   ① 谁看得到 —— S 级在角色视角（剧情推演 / 扮演）整行剔除；D 级谁也不给
 *   ② 谁先占预算 —— S 最先带入 → A → B → C 超预算时最先让位
 *   ③ 谁根本不进 —— D 级（终结 / 弃用）连「另有 N 条未列出」的计数都不算它
 *
 * 🔴 存储口径两种都要认（表格行用裸列名、卡片 / 表单用复合键），见 `secrecyOf`。
 *    只认一种的话，角色卡的等级会被读成"未填" ⇒ 全部中性 ⇒ 排序**静默失效**，
 *    而且光测表格看不出来（必须卡片型也测）。
 */

const SECRECY_RANK: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 99 }
const DEFAULT_RANK = 2

/** D 档 = 终结 / 弃用（**任何视角**都不进 AI） */
const PRUNED_LEVEL = 'D'

/** S 档 = 绝密 / 剧透（仅**角色视角**剔除，见 isSecretRow） */
const SECRET_LEVEL = 'S'

/**
 * 取一条记录的保密等级原文（大写；读不到给空串）。
 *
 * 🔴 两种存储口径都要认（2026-09-17 实测踩过）：
 *   · 表格行：**裸列名**键 —— data['保密等级']
 *   · 卡片 / 表单：**复合键** —— data['一、基础信息::保密等级']
 */
export function secrecyOf(data: Record<string, string> | undefined): string {
  if (!data) return ''
  let raw = data['保密等级']
  if (raw === undefined) {
    for (const [k, v] of Object.entries(data)) {
      if (k.endsWith('::保密等级')) { raw = v; break }
    }
  }
  return String(raw ?? '').trim().toUpperCase()
}

/**
 * 🔴 **D 级（终结 / 弃用）：任何情况下都不进 AI。**
 *
 * 不是"排在最后"，是压根不带 —— 它的定义就是「已经用完或不再使用的数据」，
 * 再喂给模型只会拿过时的结论污染新判断（旧版设定、已废弃的路线、退场的人物）。
 * 凡是"把项目数据交给模型"的入口都要过这一道：
 *   ① 内容装配（renderTable / renderCards 先剔除行，连「另有 N 条未列出」的计数都不算它）；
 *   ② 姓名清单（`loadCharacterNames` —— 它喂给 AI 整理当候选值）；
 *   ③ 判重清单（`organizeRows` 的 existingKeys）。
 *
 * 与角色视角**无关**：作者侧同样排除（这才是"任何情况下"的含义）。
 * `rankOf` 给 D 一个大数只是第二道保险 —— 万一某处漏了过滤，它也会排到最后被预算先丢掉。
 */
export function isPrunedForAI(data: Record<string, string> | undefined): boolean {
  return secrecyOf(data) === PRUNED_LEVEL
}

/**
 * 🔴 **S 级（绝密 / 剧透）：角色视角下不进 AI。**
 *
 * 与 D 级的区别：D 是「任何视角、任何功能都不给」（作者侧也排除）；S 只对**角色视角**
 * （酒馆沉浸档的剧情推演 / 扮演）生效 —— 作者 / 导演视角照常带上（那是他自己的底牌）。
 */
export function isSecretRow(data: Record<string, string> | undefined): boolean {
  return secrecyOf(data) === SECRET_LEVEL
}

/**
 * 取一条记录的预算优先级（读不到等级时给中性档）。
 * 🔴 未填 / 未知值一律按中性（= B 档）。**绝不能当 C** —— 否则历史数据会因为当年没标等级
 *    而被排到最后优先丢弃，等于用一个新功能把老项目的数据静默降级。
 */
export function rankOf(data: Record<string, string> | undefined): number {
  return SECRECY_RANK[secrecyOf(data)] ?? DEFAULT_RANK
}

/**
 * 按预算优先级排序，且**严格稳定**（同等级保持录入顺序）。
 *
 * 🔴 稳定性是硬要求，不是修饰：本地模型的 prompt prefix cache 依赖前缀逐字一致；
 *   同级顺序若随排序抖动，每次请求都要重算 prefill —— 就成了"改了个好事反而更慢"。
 *   故显式带原下标做 tiebreaker，不依赖引擎 sort 的稳定性承诺。
 */
export function sortBySecrecy<T extends { data?: Record<string, string> }>(rows: T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rankOf(a.r.data) - rankOf(b.r.data) || a.i - b.i)
    .map(x => x.r)
}
