/**
 * 正文批量导入弹窗的编排判定（3.6.1 · B7 从 `ChapterImportDialog` 抽出）。
 *
 * 【为什么抽这几处】切分与落库本体在 `lib/storage/chapterImport`（已有单测），
 * 组件里剩下的都是「一算错就报错数字 / 按钮点不动」的编排：
 *   ① 底部「已勾选 N 章 · 约 M 字」——勾选状态与字数口径必须和落库完全一致；
 *   ② 「切不出标题」的提示与 notes 去重（同一条话说两遍会让作者以为出两个问题）；
 *   ③ 主按钮能不能点 + 为什么不能点（三句话对应三种原因）；
 *   ④ 落库回执的人话（含「中途中止」「已导入过」两种特殊结局）。
 */
import type { ImportPreview } from '@/lib/storage/chapterImport'
import type { PersistResult } from '@/lib/bookbreak/persist'
import { countWordsLoose } from '@/lib/storage/chapterImport'

/** 已勾选的章数 / 字数（与落库同一口径：只算 include=true 的章） */
export function summarizeImportSelection(preview: ImportPreview | null): { pickedCount: number; pickedWords: number } {
  if (!preview) return { pickedCount: 0, pickedWords: 0 }
  let pickedCount = 0
  let pickedWords = 0
  for (const volume of preview.volumes) {
    for (const chapter of volume.chapters) {
      if (!chapter.include) continue
      pickedCount++
      pickedWords += countWordsLoose(chapter.content)
    }
  }
  return { pickedCount, pickedWords }
}

/**
 * 展示用的 notes：`splitMode === 'chunks'` 时那条「没识别到章节标题」已由上方琥珀提示条接管，
 * 去掉避免同一件事说两遍。
 */
export function importNotesForDisplay(preview: ImportPreview | null): string[] {
  const list = preview?.notes ?? []
  if (preview?.splitMode !== 'chunks') return list
  return list.filter(note => !note.startsWith('没有识别到章节标题'))
}

/**
 * 主按钮闸：能不能点 + 点不动时说什么。
 * 🔴 三句话分别对应三种真实原因（没预览 / 一章没勾 / 正在导入），不能合成一句「请检查输入」。
 * 🔴 `committing` 只影响**能不能点**，不新增提示语：3.6.1 之前导入中悬停看到的仍是
 *    「把勾选的卷章写入正文编辑」，这里逐字保留（加新句子属改用户可见文案）。
 */
export function chapterImportGate(input: { hasPreview: boolean; pickedCount: number; committing: boolean }): {
  canCommit: boolean
  title: string
} {
  if (!input.hasPreview) return { canCommit: false, title: '先读取文件或粘贴原文' }
  if (input.pickedCount === 0) return { canCommit: false, title: '至少勾选一章' }
  return { canCommit: !input.committing, title: '把勾选的卷章写入正文编辑' }
}

/** 落库回执的人话（含「已导入过」与「中途中止」两种特殊结局） */
export function chapterImportResultText(result: PersistResult): string {
  if (result.alreadyImported) {
    return '检测到同名卷与相同章节，这本书似乎已经导入过，已跳过（如需重导请先删除该卷）'
  }
  const volumes = result.volumes.map(v => `《${v.title}》${v.chapters}章`).join('、')
  const head = `导入完成：新建 ${result.volumes.length} 卷 · ${result.chaptersCreated} 章 · ${result.words.toLocaleString('zh-CN')} 字`
  const tail = result.aborted ? '　（中途中止，已导入的部分已保留）' : ''
  return `${head}（${volumes}）${tail}`
}
