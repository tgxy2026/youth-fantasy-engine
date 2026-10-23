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
 * 🔴 3.2.2（2026-10-23 读者反馈修复）：判据从「prev/next 长度差」改成「这次输入事件自带的 `data`」。
 *
 *    为什么必须换：原先靠 `next.length === prev.length + 1` 判"刚好插入一个字符"，而在**输入法组合态**下
 *    这个前提是错的 —— 组合期间 `input` 事件里的 value 是**未提交的预览串**，我们一旦在这时补右标点并移动光标，
 *    输入法随后提交自己的字时会插到我们移动后的光标处，出现 `““”`，再按一下变成 `“““”`（越打越多）。
 *    实测事件序列：`input(composing=true, value="“")` → 我们补成 `“”` 并居光标 → `beforeinput(composing=false)`
 *    → 输入法把 `“` 插到光标处 ⇒ `““”`。
 *
 *    新判据只认「本次输入事件的数据恰好是 1 个中文左标点」：
 *      · 普通键盘输入 ⇒ `data` 就是那个字符；
 *      · 输入法上屏 ⇒ 提交时那个 `input` 事件的 `data` 也是提交的字符（实测 `data="“"`）；
 *      · 粘贴 / 撤销 / 多字提交 ⇒ `data` 为 null 或长度 > 1 ⇒ 不插手。
 *
 * @param value 当前正文（textarea 的 `value`）
 * @param caret 当前光标（`selectionStart`）
 * @param data  输入事件的 `data`（`InputEvent.data`）
 * @returns 需要补时给出新值与光标；不需要补返回 null
 */
export function planPunctPair(
  value: string,
  caret: number,
  data: string | null | undefined,
): PunctPairPlan | null {
  // ③ 只认「恰好输入 1 个字符」（粘贴、撤销、多字上屏一律不插手）
  if (!data || data.length !== 1) return null
  const right = CN_PUNCT_PAIRS[data]
  if (!right) return null
  if (!Number.isFinite(caret) || caret < 1 || caret > value.length) return null
  // 输入的那个字符必须正好在光标前 —— 否则说明这不是"刚打进正文"的那一下
  if (value[caret - 1] !== data) return null
  return closeOrStepOver(value, caret, data, right)
}

/**
 * 光标后已经紧跟右标点时的处置（两条入口共用，保证口径只有一处）。
 *
 * 🔴 3.2.2（2026-10-23 读者反馈）：**在"自己刚造出来的那对引号"中间再按一次引号键 ⇒ 跳出去**，
 *    而不是再塞一个左引号。原先"后面有右标点就不补"会让第二下留下一个孤零零的左引号，
 *    连按三次就成了 `“““”` —— 读者说的"再按一下出很多引号"就是它。
 *    （判据刻意收得很窄：只有当**光标前一个字符也是同一个左引号**时才跳，
 *     所以"回头给已有 `”` 补一个开引号"这种正当写法不受影响。）
 */
function closeOrStepOver(value: string, caret: number, left: string, right: string): PunctPairPlan | null {
  if (value[caret] !== right) {
    // ② 正常补右半边（插在光标处，光标不动 ⇒ 落在两个标点之间）
    return { value: value.slice(0, caret) + right + value.slice(caret), caret }
  }
  // 已经在这对引号中间又按了一次 ⇒ 跳出去：删掉刚插入的左引号，光标移到右引号之后
  if (caret >= 2 && value[caret - 2] === left) {
    return { value: value.slice(0, caret - 1) + value.slice(caret), caret }
  }
  // 后面已有右标点、但不是在"自己的那对"里（例如作者回头补开引号）⇒ 保持不动
  return null
}

/**
 * 组合态**结束之后**补右标点（按光标位置判断，不需要事件 `data`）。
 *
 * 为什么还要这一条：输入法上屏的行为并不统一 ——
 *   · 有的会在 `compositionend` 之后再发一个 `input`（`isComposing=false`、`data` 是提交的字符）⇒ 上面那条能命中；
 *   · 有的**只把字留在组合里**，不额外发提交事件（实测 CDP 模拟与部分输入法都是这样）⇒ 上面那条永远不命中。
 * 所以组合结束时再按"光标前是不是中文左标点"补一次。两条路径**结果相同**（都只多补一个右标点），
 * 谁都命中都不会重复：右标点已经在光标后时直接返回 null。
 *
 * @param value 组合结束后的正文
 * @param caret 组合结束后的光标
 */
export function planPunctPairAtCaret(value: string, caret: number): PunctPairPlan | null {
  if (!Number.isFinite(caret) || caret < 1 || caret > value.length) return null
  const left = value[caret - 1]
  const right = CN_PUNCT_PAIRS[left]
  if (!right) return null
  return closeOrStepOver(value, caret, left, right)
}
