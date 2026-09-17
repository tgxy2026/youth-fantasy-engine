/**
 * 文本截断 —— **全项目唯一实现**（2026-09-17 审计合并）。
 *
 * 原先这套「超长就切一刀补省略号」的逻辑有三份拷贝：
 *   · `lib/aiContext.ts` 的 `clip()`（带压空白）
 *   · `components/AIAssist.tsx` 的 `truncateTitle()`
 *   · `components/CharacterDistribution.tsx` 里内联的三元表达式
 * 三处阈值不同、行为略有出入，改一次口径得翻三个文件 —— 收敛到这里。
 *
 * ⚠️ 按 UTF-16 码元 `length` 计（与项目其它截断口径一致）。
 *    emoji 名字理论上会被切半个，但调用点都是中文正文与章节标题，可接受；
 *    真要按「字符」数请用 `Array.from`，别偷偷换口径。
 */

/**
 * 超长就截断并补省略号。
 *
 * @param s        原文（允许传 null/undefined，按空串处理）
 * @param n        上限（码元数）
 * @param collapse 为真时先把连续空白压成一个空格、再去首尾 —— 给「要塞进单行 prompt
 *                 的字段值」用，避免作者在设定里敲的换行把提示词排版冲烂
 */
export function clipText(s: string, n: number, collapse = false): string {
  const raw = String(s ?? '')
  const t = collapse ? raw.replace(/\s+/g, ' ').trim() : raw
  return t.length > n ? t.slice(0, n) + '…' : t
}
