import * as db from './db'
import type { Chapter } from './types'
import { todayKey } from './date'

/**
 * 保存章节时自动同步到该卷的「章节台账」表（按卷建表：tabId = chapter-vol-<volumeId>）。
 * 只覆盖自动字段，保留手填的出场人物/伏笔等；所属卷由表本身表达，不再写入。
 *
 * 从 NovelEditor 抽出为共享函数，供「AI 一键续写」等新模块复用，避免重复实现。
 */
export async function syncChapterMaster(
  ch: Chapter, chapterNo: number, narrativeIndex?: number,
) {
  // 台账行的 order 用真实叙事位次（含不计入序号的章），这样整表行序始终等于故事顺序，
  // 情节推演本等直接按 row.order 展示的地方才不会错乱（1.9.2）。
  const rowOrder = narrativeIndex ?? chapterNo
  const tabId = `chapter-vol-${ch.volumeId}`
  const rid = `ch-${ch.id}`
  // 章节若曾属其它卷，清理旧卷台账里的孤儿行（一次全表扫描）
  await db.purgeLedgerRowEverywhere(ch.id, ch.volumeId)
  const rows = await db.getTableRows(tabId)
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
    await db.saveTableRow({ ...existing, data: { ...existing.data, ...auto }, order: rowOrder })
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
    })
  }
}
