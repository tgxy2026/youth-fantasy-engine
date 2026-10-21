/**
 * 中文标点自动配对（3.2.0 · 2026-10-21）
 *
 * 【为什么应用自己要补】原先完全依赖输入法：微信输入法会补右半，**搜狗不补**
 * （实测两名用户反馈）。同一份正文在两台机器上行为不同，作者会以为是软件坏了。
 * 逐字核对过：编辑区自己从来不做配对，`onContentChange` 也只做「记草稿 + 同步光标 + 排自动保存」，
 * 不做字符级规范化 —— 所以这不是被谁吞了，而是压根没人补。这里补上，三家输入法行为就一致了。
 *
 * 【三条边界（改之前先读）】
 *   ① **只认中文左标点**：英文 `"` `'` `(` 一律不碰 —— 那是代码/英文引号，补了会打断正常输入；
 *   ② **后面已经紧跟右标点就不补**：作者是在已有 `”` 前面插入 `“`，再补一个就成了 `“””`；
 *   ③ **只处理「刚好插入 1 个字符」**：粘贴、撤销、替换多字符时 diff 不成立，一律不插手。
 *
 * 🔴 真正的 IME 判断在调用方（`isComposing`）—— 本文件是纯函数，不认识输入法。
 */

/** 左标点 → 右标点。刻意只收中文全角（半角由输入法与浏览器自己管） */
export const CN_PUNCT_PAIRS: Readonly<Record<string, string>> = {
  '“': '”',
  '‘': '’',
  '《': '》',
  '〈': '〉',
  '「': '」',
  '『': '』',
  '（': '）',
  '【': '】',
}

export interface PunctPairPlan {
  /** 补好右标点后的完整正文 */
  value: string
  /** 光标应停的位置（两个标点之间，即插入点原位置） */
  caret: number
}

/**
 * 判断这次输入要不要补右半边标点。
 *
 * @param prev  变更前的正文
 * @param next  变更后的正文（来自 textarea 的当前值）
 * @param caret 变更后的光标位置（`selectionStart`）
 * @returns 需要补时给出新值与光标；不需要补返回 null
 */
export function planPunctPair(prev: string, next: string, caret: number): PunctPairPlan | null {
  // ③ 只认「插入恰好 1 个字符」
  if (next.length !== prev.length + 1) return null
  if (!Number.isFinite(caret) || caret < 1 || caret > next.length) return null
  const ch = next[caret - 1]
  const right = CN_PUNCT_PAIRS[ch]
  if (!right) return null
  // ② 后面已经紧跟右标点 ⇒ 不重复补
  if (next[caret] === right) return null
  return {
    value: next.slice(0, caret) + right + next.slice(caret),
    caret,
  }
}
