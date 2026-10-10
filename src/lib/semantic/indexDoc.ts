// ============ 语义检索 · 单来源索引（纯编排，**不依赖 `lib/db`**）============
//
// 🔴 为什么单独成文件，而不是留在 `indexer.ts` 里：
//    `indexer.ts` 要读项目资料（章节 / 表格 / 角色卡），必然 `import '../db'`；
//    而**知识库（#017）**需要在「对 db 零依赖」的前提下复用同一套
//    「切块 → 嵌入 → 落库」编排 —— 否则 `db/projects.ts` 的 `deleteProject`
//    → `knowledgeBase` → `db` 就成了一个环。
//    所以把这段**只吃参数**的编排单独放这里，两处共用一份实现（绝不各写一份）。
//
// 与 `rebuildIndex` 共用同一套切块 / 建行逻辑，只是范围收窄到一条来源。
// 🔴 内部先 `removeByRef` 再 `putVectors`：正文被改短时旧的长块不会被留成孤儿
//    （孤儿 = 召回得到**已经删掉的内容**，那是真 bug，见 `rebuildIndex` 的同类说明）。

import { chunkChapter, hashOf, toVectorBuffer } from '@/lib/semantic/chunk'
import { embedTexts, type EmbedConfig } from '@/lib/semantic/embed'
import { makeVecRow, putVectors, removeByRef, type VecKind, type VecRow } from '@/lib/semantic/store'

/** 一个「来源」：一章正文 / 一条设定行 / 一张角色卡 / 一篇参考资料 */
export interface IndexDoc {
  kind: VecKind
  refId: string
  /** 展示用标题（UI 里说"正在索引哪一条"） */
  title: string
  text: string
  /** 来源行被标为 S 级（绝密）—— 角色视角召回时整条剔除 */
  secret: boolean
}

/**
 * 重写**一条来源**的全部块。
 *
 * 🔴 `text` 为空（正文被清空 / 文档被清空）⇒ 把旧块一并删掉，
 *    否则会一直召回那段已经不存在的文字。
 */
export async function indexOneDoc(
  doc: IndexDoc,
  projectId: string,
  cfg: EmbedConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; chunks: number; error?: string }> {
  const chunks = chunkChapter(doc.text)
  if (chunks.length === 0) {
    // 正文被清空 ⇒ 把旧块一并清掉，否则会一直召回那段不存在的文字
    try { await removeByRef(projectId, doc.refId) } catch { /* 清理失败不影响调用方 */ }
    return { ok: true, chunks: 0 }
  }
  let r
  try {
    r = await embedTexts(chunks.map(c => c.text), cfg, signal)
  } catch (e) {
    return { ok: false, chunks: 0, error: e instanceof Error ? e.message : String(e) }
  }
  if (!r.ok || !r.vectors) return { ok: false, chunks: 0, error: r.error ?? '嵌入失败' }

  const rows: VecRow[] = []
  for (let i = 0; i < chunks.length; i++) {
    const vec = r.vectors[i]
    if (!vec || vec.length === 0) continue
    rows.push(makeVecRow({
      projectId,
      kind: doc.kind,
      refId: doc.refId,
      chunkIdx: chunks[i].idx,
      text: chunks[i].text,
      title: doc.title,
      hash: hashOf(chunks[i].text),
      vec: toVectorBuffer(vec),
      dim: vec.length,
      model: cfg.model.trim(),
      secret: doc.secret,
    }))
  }
  await removeByRef(projectId, doc.refId)
  await putVectors(rows)
  return { ok: true, chunks: rows.length }
}
