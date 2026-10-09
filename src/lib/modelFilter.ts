/**
 * 模型名筛选（2.9.2 · ①）—— 给「获取可用模型」的两个列表（OpenAI 兼容端点 / Ollama）用。
 *
 * 为什么单独放 lib：这是**纯函数**，放这里才好单测。内联进组件就没法验 ——
 * 而中转站的模型清单动辄几百项，筛选逻辑错一位，作者就得在几百项里翻半天。
 *
 * 规则（刻意做得简单，好让作者能预判结果）：
 *   · 关键词按**空白切词**，每一段都要命中（`qwen 32b` ＝ 同时含「qwen」与「32b」）
 *   · **忽略大小写**（各家命名 `Qwen` / `qwen` / `QWEN` 都有）
 *   · 空关键词 ⇒ **原样返回入参**（不复制数组：既省一次分配，也让 React 能靠引用相等跳过重渲染）
 */
export function filterModels(list: readonly string[], keyword: string): readonly string[] {
  const k = keyword.trim().toLowerCase()
  if (!k) return list
  const terms = k.split(/\s+/)
  return list.filter(m => {
    const low = m.toLowerCase()
    return terms.every(t => low.includes(t))
  })
}
