import * as db from '@/lib/db'
import type { Chapter } from '@/lib/types'
import { todayKey } from '@/lib/app/date'
import { OUTLINE_TAB_ID, chapterNoOf, outlineEventKey } from '@/lib/outline/outlineCard'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'

/**
 * 用正文概要回填《章节细纲》卡的「本章一句话事件」。
 *
 * 【为什么有这条链路（老大 2026-09-18 拍板，见 `docs/2.2.0-双功能需求解读与P0落地.md` §5-①）】
 * 「章节细纲」是**计划**，正文是**实际**。写完正文、压出概要之后两者会分叉：作者中途改了走向，
 * 细纲卡还停在开书时的设想 —— 而「创意写作 · 逐章连写」恰恰是**按细纲写**的，
 * 于是拿着过期的计划去写新章。回填把"实际发生了什么"写回细纲卡，让计划跟得上正文。
 *
 * 🔴 三条边界（照做，别放宽）：
 *   1. **只在原本为空时填**。细纲卡是作者亲手写的计划，一键覆盖等于抹掉他的心血；
 *      有内容就跳过，并在返回值里报出来（界面可据此说明"N 张已有内容未动"）。
 *   2. **匹配不上就什么都不做**，尤其**绝不新建细纲卡** —— 给"没写过细纲的章"凭空建一张，
 *      等于把"没有计划"变成"有计划但内容是正文摘要"，反而制造新的不一致。
 *   3. **失败一律吞掉**。回填是附带动作，绝不能因为读不到细纲卡而让「保存章节」失败。
 *
 * @returns 统计（filled 填了几张 / skipped 几张已有内容未动）；摘要为空、拿不到字段键、
 *          或章号为 0（序章/不计入序号）时返回 null
 */
export async function backfillOutlineEvent(
  summary: string, chapterNo: number, title = '', owner?: OwnedOperation,
): Promise<{ filled: number; skipped: number } | null> {
  const text = (summary ?? '').trim()
  const key = outlineEventKey()
  if (!text || !key || chapterNo <= 0) return null
  try {
    const cards = owner ? await db.getCardRecordsFor(owner.projectId, OUTLINE_TAB_ID, owner) : await db.getCardRecords(OUTLINE_TAB_ID)
    // 先按章号匹配（卡名由 outlineCardName 生成，格式唯一）；实在没有才退到标题包含匹配
    const t = (title ?? '').trim()
    const hit = cards.find(c => chapterNoOf(c.name) === chapterNo)
      ?? (t ? cards.find(c => c.name.includes(t)) : undefined)
    if (!hit) return { filled: 0, skipped: 0 }
    if ((hit.data[key] ?? '').trim()) return { filled: 0, skipped: 1 }
    await db.saveCardRecord({ ...hit, data: { ...hit.data, [key]: text } }, owner)
    return { filled: 1, skipped: 0 }
  } catch {
    return null
  }
}

/**
 * 保存章节时自动同步到该卷的「章节台账」表（按卷建表：tabId = chapter-vol-<volumeId>）。
 * 只覆盖自动字段，保留手填的出场人物/伏笔等；所属卷由表本身表达，不再写入。
 *
 * 从 NovelEditor 抽出为共享函数，供「AI 一键续写」等新模块复用，避免重复实现。
 */
export async function syncChapterMaster(
  ch: Chapter, chapterNo: number, narrativeIndex?: number, owner?: OwnedOperation,
) {
  // 台账行的 order 用真实叙事位次（含不计入序号的章），这样整表行序始终等于故事顺序，
  // 情节推演本等直接按 row.order 展示的地方才不会错乱（1.9.2）。
  const rowOrder = narrativeIndex ?? chapterNo
  const tabId = `chapter-vol-${ch.volumeId}`
  const rid = `ch-${ch.id}`
  // 章节若曾属其它卷，清理旧卷台账里的孤儿行（一次全表扫描）
  await db.purgeLedgerRowEverywhere(ch.id, ch.volumeId, owner)
  const rows = owner ? await db.getTableRowsFor(owner.projectId, tabId, owner) : await db.getTableRows(tabId)
  const existing = rows.find(r => r.id === rid)
  const today = todayKey()
  // 1.9.2：序号 0 表示「不计入序号」（序章/番外/后记），台账章节号留空，作者可手填「番外」之类
  const auto: Record<string, string> = {
    '章节号': chapterNo > 0 ? `第${chapterNo}章` : (existing?.data['章节号'] ?? ''),
    '章节标题': ch.title,
    '一句话事件': ch.summary,
    '字数': String(ch.wordCount),
  }
  if (ch.status === '已发布' && existing && !existing.data['发布日期']) {
    auto['发布日期'] = today
  }
  if (existing) {
    await db.saveTableRow({ ...existing, data: { ...existing.data, ...auto }, order: rowOrder }, owner)
  } else {
    await db.saveTableRow({
      id: rid,
      projectId: ch.projectId,
      tabId,
      data: {
        '章节号': '', '章节标题': '', '一句话事件': '',
        '出场人物': '', '埋设伏笔编号': '', '回收伏笔编号': '',
        '细纲状态': '无', '字数': '', '发布日期': '', '备注': '',
        ...auto,
      },
      order: rowOrder,
    }, owner)
  }

  // 「正文 → 章节细纲」那一段勾稽：摘要**变了**才回填。
  // 🔴 加这个判定的理由：saveChapter/syncChapterMaster 是很热的路径（每次点保存都走），
  //    无条件读一遍细纲卡全表不值得；而摘要没变时回填也不会有任何效果。
  // 回填失败不影响台账（backfillOutlineEvent 内部已吞异常）。
  const prevSummary = (existing?.data['一句话事件'] ?? '').trim()
  if ((ch.summary ?? '').trim() && (ch.summary ?? '').trim() !== prevSummary) {
    await backfillOutlineEvent(ch.summary ?? '', chapterNo, ch.title, owner)
  }
  owner?.assertCurrent()
}
