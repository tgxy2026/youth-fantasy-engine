/**
 * AI 任务提示词的**公共句段**（2026-10-04 六维审计 P2）。
 *
 * 为什么单独立一个文件：同一句「只输出 JSON 数组…」原先在 `audit` / `suggest` / `organize` /
 * `tableImport` / `proofread` 里各自写一遍 —— 改一处漏一处，早晚漂移。抽到这里后**拼接结果逐字不变**。
 *
 * 🔴 常量只承载**句子本体**：各提示词自己的编号（`3.` / `5.` / `7.` / `- `）留在原地拼 ——
 *    同一条规则在不同提示词里编号本来就不同，硬统一会改掉提示词文本（正是本次重构要避免的）。
 * 🔴 本文件是纯常量：无副作用、无 IO、无 `JSON.parse` ⇒ 不涉及 `structureGates` 的例外登记。
 */

/** 「表格整理 / 表格导入」共用：返回的每个对象，key 必须逐字用【列清单】里的原文 */
export const RULE_TABLE_COLUMN_KEYS =
  '返回一个 JSON 数组，每个元素是一个对象，key 必须严格使用【列清单】中给出的列名原文。'

/** 「表格整理 / 表格导入」共用：收尾只吐 JSON 数组本体 */
export const RULE_JSON_ARRAY_BARE =
  '只输出 JSON 数组本身：不要解释、不要前言后语、不要 markdown 代码块标记。'

/** 「一致性审查 / 敏感词复核 / 随机取名 / 校对」共用：收尾只吐 JSON 数组 */
export const RULE_JSON_ARRAY_ONLY =
  '只输出 JSON 数组，不要解释、不要 markdown 代码块标记。'
