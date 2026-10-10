// ============ 轻量 markdown → 块数组（更新说明专用）============
//
// 为什么自己写而不是引三方库：更新说明只需要 Gitee Release body 里那几种语法
// （`##` / `###` / `-` 列表 / `>` 引用 / `**加粗**` / 段落 / 链接），引一个 markdown 库
// 要为这几十行付出依赖体积与 XSS 面。
//
// 🔴🔴 **安全红线**：Gitee 返回的内容等价于**外部输入**，本模块只输出**纯文本块**，
//     由调用方用 React 文本节点渲染，**任何情况都不 `dangerouslySetInnerHTML`**。
//     所有 HTML 标签字符（`script` / `img onerror` 之类）到此为止都只是普通字符。

export type MdBlock =
  | { type: 'h2' | 'h3'; text: string }
  | { type: 'li'; text: string; level: number }
  | { type: 'quote'; text: string }
  | { type: 'p'; text: string }

/** 去掉行内的 markdown 标记，只留可读文本（**加粗**、`代码`、[文字](链接) → 文字） */
export function stripInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // 图片：整段丢弃（弹窗里不渲染外链图）
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')         // 链接：只留文字
    .replace(/\*\*([^*]+)\*\*/g, '$1')               // 加粗
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')         // 斜体
    .replace(/`([^`]+)`/g, '$1')                     // 行内代码
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 剥掉行内**强调标记**（`**粗体**` / `__粗体__` / `*斜体*` / `` `代码` ``）与行首 `#`，
 * **空白与换行一个都不动**。
 *
 * 与 `stripInline` 的区别：后者面向**渲染**（压缩空白、丢链接、丢图片），
 * 本函数面向**逐字比对** —— 模型常给「逐字照抄」的引文/行自行加上强调标记，
 * 直接拿去 `indexOf` / 全等比较必然定位失败，而这类失败在审计链路里是**静默丢弃条目**。
 * 先剥一次再比即可命中；因为不动空白，定位口径（字符下标）不受影响。
 *
 * ⚠️ 单星号斜体要求内容首字符非空白、且两侧不是 `\w`（同 `rewrite.stripInlineMarkdown`）：
 *    否则 `a * b * c` 这种把星号当运算符写的句子会被误伤。
 */
export function stripEmphasis(text: string): string {
  return String(text ?? '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')                       // 行首标题符
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')                        // **粗体**
    .replace(/__([^_\n]+)__/g, '$1')                            // __粗体__
    .replace(/(?<![\w*])\*(\S[^*\n]*?)\*(?![\w*])/g, '$1')      // *斜体*
    .replace(/`([^`\n]+)`/g, '$1')                              // `行内代码`
}

/**
 * 把 markdown 文本切成块数组（够用即止，不追求完整 CommonMark）。
 * 空行分段；`---` 分割线忽略；连续普通行合并为一段。
 */
export function parseMarkdownBlocks(md: string): MdBlock[] {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  const out: MdBlock[] = []
  let paragraph: string[] = []

  const flush = () => {
    if (paragraph.length === 0) return
    out.push({ type: 'p', text: stripInline(paragraph.join(' ')) })
    paragraph = []
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { flush(); continue }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flush(); continue }   // 分割线

    const h3 = line.match(/^###\s+(.*)$/)
    if (h3) { flush(); out.push({ type: 'h3', text: stripInline(h3[1]) }); continue }
    const h2 = line.match(/^##\s+(.*)$/)
    if (h2) { flush(); out.push({ type: 'h2', text: stripInline(h2[1]) }); continue }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) { flush(); out.push({ type: 'quote', text: stripInline(quote[1]) }); continue }
    const li = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (li) {
      flush()
      const level = Math.min(2, Math.floor((li[1] ?? '').length / 2))
      out.push({ type: 'li', text: stripInline(li[2]), level })
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
  return out.filter(b => b.text.length > 0)
}
