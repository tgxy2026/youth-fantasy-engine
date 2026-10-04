// ============ 中文分词（**单一真源**）============
//
// 「CJK 拆成 单字 + 相邻二元；拉丁 / 数字按词」——全项目**只有这一份**实现。
//
// 🔴 为什么单独成文件、而不是留在 `search.ts` 里：
//    `search.ts` 要读库（`import './db'`），而「知识库」（`lib/knowledgeBase.ts`）
//    的关键词降级召回也要分词，却必须对 db **零依赖** —— 否则
//    `db/projects.ts` 的 `deleteProject` → `knowledgeBase` → `search` → `db` 就是环。
//    把纯函数抽到这里之后，三方（全文检索 / 语义召回粗筛 / 知识库降级）共用同一口径。
//
// 🔴 口径必须一致的理由：语义召回在算余弦**之前**要先用关键词把候选缩到几百条
//    （否则全库逐条点积，大库下每次召回都是毫秒级起步的开销）。那一步若与全文检索
//    用了不同分词，就会出现**「搜得到但召回不到」**这类最难查的不一致。

/**
 * 分词：CJK 拆成 单字 + 相邻二元；拉丁 / 数字按词。
 *
 * 二元是为中文补的：单字召回率高但噪声大（「的」「了」到处都是），
 * 加上相邻二元之后，「剑修」这种词才能被当成一个整体参与打分。
 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const lower = text.toLowerCase()
  const tokens: string[] = []
  const latin = lower.match(/[a-z0-9]+/g)
  if (latin) for (const w of latin) tokens.push(w)
  const cjkRuns = lower.match(/[㐀-䶿ㆠ-㏿一-鿿豈-﫿]+/g)
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length; i++) {
        tokens.push(run[i]) // 单字
        if (i + 1 < run.length) tokens.push(run[i] + run[i + 1]) // 二元
      }
    }
  }
  return tokens
}
