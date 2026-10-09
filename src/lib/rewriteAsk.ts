/**
 * 「选区改稿」的要求与拼装（2.9.2 · ②）—— **零依赖纯函数层**。
 *
 * 为什么单独成一个文件：`aiTasks/jieWenJi.ts` 顶部 import 了 `./ai`（传输层），
 * 测试若直接 import 它，会把 aiCore / db 那一整条链拉进 Node 测试环境。
 * 本项目的既有惯例就是「解析与位置换算放本地纯函数层，tests 只 import 那边」
 * （见 `lib/paceAnalysis.ts` 的头部说明），这里照同一套路。
 */

/**
 * 「选区改稿」的完整要求。
 *
 * 为什么从「一个字符串」升成对象：原先只能传动作词，作者没法说明**具体倾向**
 * （「润色哪些方面」「语气从什么改成什么」）。现在动作与额外要求**并存**——
 * 动作背后的纪律是安全网（扩写不得凭空造专名、精简不丢设定交代），
 * 作者不写那句就丢掉，可能造出设定表与后文都不知道的专名。
 */
export interface RewriteAsk {
  /**
   * 要执行的要求。
   * · 编辑区传 5 个动作之一（润色 / 扩写 / 精简 / 改语气 / 换视角）
   * · `autoContinue` 传「修正以下审读问题…」这类**自由文本**（按篇幅分工，共用同一入口）
   */
  instruction: string
  /** 作者自定义的**具体倾向**（可空）—— 有值时紧跟动作之后，作为对它的细化 */
  detail?: string
  /** 期望字数（可空）—— **只写进提示词**，不做本地补写循环（拍板 2026-10-09） */
  targetWords?: number
}

/**
 * 把「修改要求」拼成 prompt 里那一段。
 *
 * 三段结构：动作（始终有）→ 作者的额外要求（有才加）→ 目标字数（有才加）。
 * 🔴 空值**不产生空行**：`detail` 只有空白、`targetWords` 为 0/负数/NaN 时整行不出现 ——
 *    否则提示词里会多出「· 作者的额外要求：」这种空壳行，白占预算还会误导模型。
 */
export function buildRewriteAsk(ask: RewriteAsk, passageChars: number): string {
  const lines: string[] = [ask.instruction.trim() || '润色']
  const detail = ask.detail?.trim()
  if (detail) lines.push(`· 作者的额外要求（优先照做，但不得放宽上面的动作纪律）：${detail}`)
  const n = ask.targetWords
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    lines.push(`· 目标字数：约 ${Math.round(n)} 字${passageChars > 0 ? `（选中段落现约 ${passageChars} 字）` : ''}`)
  }
  return lines.join('\n')
}
