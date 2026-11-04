/**
 * 轻量强调标记：把纯文本里的 `**强调**` 拆成片段。
 *
 * 【为什么需要】
 *   帮助中心 / 帮助气泡是 `whitespace-pre-wrap` **纯文本**渲染，而帮助文案长期按 markdown
 *   习惯写成 `**Ctrl + Shift + F9**` ⇒ 作者在界面上看到的是裸星号（2026-11-04 六维审计 §8 命中）。
 *   这里只认**成对**的 `**`，不解析其它 markdown（不引入渲染库、不吃 HTML、不做链接）。
 *
 * 【判据】
 *   · 落单的 `**` 原样保留 —— 宁可显示星号，也不能吞掉半句；
 *   · 空的强调段（如 `****`）按原文输出，不产生空的高亮；
 *   · 不改动换行与空格：分段只切星号，文本内容逐字保留。
 */
export interface EmphasisPart {
  text: string
  strong: boolean
}

const plain = (text: string): EmphasisPart[] => [{ text, strong: false }]

export function splitEmphasis(text: string): EmphasisPart[] {
  if (!text.includes('**')) return plain(text)
  const parts = text.split('**')
  // 偶数段 = 星号没配对（`a ** b` / `**a`），原样输出
  if (parts.length % 2 === 0) return plain(text)
  // 配对了但强调段为空（如 `****`）：当成没写，别把四个星号吃成空白
  for (let i = 1; i < parts.length; i += 2) if (parts[i] === '') return plain(text)
  return parts.map((t, i) => ({ text: t, strong: i % 2 === 1 }))
}
