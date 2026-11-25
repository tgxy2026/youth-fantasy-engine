// ============ 示范项目《吞天神脉》人物小传播种器（3.7.1 · W4）============
import * as db from '@/lib/db'
import { DEMO_CHAR_BIOGRAPHIES } from '@/data/seedCharBiographies'
import {
  buildBioNode, CHAR_BIOGRAPHY_KEY, sortBioNodes, type CharacterBiography,
} from '@/lib/settings/charBiography'

/**
 * 按示范角色 cardId 与章节 id 装配并写入人物小传种子数据。
 * 从 `seedData.ts` 拆出：遵守 `seedData.ts` 行数冻结账本（≤1610 行）。
 */
export async function seedDemoBiographies(
  cardIds: Record<string, string>,
  chapterIds: readonly string[],
): Promise<void> {
  const now = Date.now()
  const out: Record<string, CharacterBiography> = {}
  for (const entry of DEMO_CHAR_BIOGRAPHIES) {
    const cid = cardIds[entry.name]
    if (!cid) continue
    const nodes = entry.nodes.map((n, idx) =>
      buildBioNode({
        id: `seed-bio-${cid}-${idx}`,
        phase: n.phase,
        chapterId: n.phase === 'story' && n.chapterNo > 0 ? chapterIds[n.chapterNo - 1] : undefined,
        chapterNo: n.chapterNo,
        order: n.order,
        storyTime: n.storyTime,
        title: n.title,
        summary: n.summary,
        tag: n.tag,
        source: 'manual',
        evidence: n.evidence,
        now: now + idx,
      }),
    )
    out[cid] = {
      characterId: cid,
      prose: entry.prose,
      nodes: sortBioNodes(nodes),
      lastScannedChapterNo: entry.lastScannedChapterNo,
      updatedAt: now,
    }
  }
  await db.setSetting(CHAR_BIOGRAPHY_KEY, out)
}
