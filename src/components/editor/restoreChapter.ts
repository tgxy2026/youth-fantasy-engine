/**
 * 时光机恢复 · **执行体**（3.4.0 · C；从 `useNovelEditorModel` 抽出）
 *
 * 顺序固定：**校验 → 留档（读回核实）→ 落库 → 才改界面**。
 * 任何一步失败都停在那一步，正文与草稿保持恢复前的样子，并把原因交回界面。
 *
 * 🔴 两条不能改的细节：
 *   ① 留档存的是**编辑器里的当前草稿**（`draft.current`），不是可能滞后的 `chapter.content` ——
 *      否则"恢复前的真实内容"根本没留住，作者点错了也回不来；
 *   ② 界面更新用**落库回执**（`written`）的正文/字数/时间，不自己拼一个与库里不一致的版本。
 *
 * 抽出来的理由：`useNovelEditorModel` 已达单文件 1200 行硬上限（structureGates ①），
 * 而这段逻辑本身就是"一次有副作用的事务"，独立成模块反而更好测、更好读。
 */
import type { MutableRefObject } from 'react'
import * as db from '@/lib/db'
import { countWords } from '@/lib/editor/textStats'
import type { Chapter } from '@/lib/types'
import { checkRestoreTarget, restoreFailureMessage } from '@/lib/editor/snapshotRestore'

export interface RestoreChapterHooks {
  /** 现读，不能用渲染闭包（可能过期） */
  chapters: MutableRefObject<Chapter[]>
  /** 当前打开的章（现读 ref） */
  active: MutableRefObject<Chapter | null>
  /** 编辑器草稿（含尚未落库的输入） */
  draft: MutableRefObject<string>
  /** 挂起的 2 秒自动保存：恢复前必须取消，否则旧稿会在恢复后写回 */
  autosaveTimer: MutableRefObject<ReturnType<typeof setTimeout> | undefined>
  /** 同章串行保存队列 */
  enqueueSave: <T>(id: string, fn: () => Promise<T>) => Promise<T>
  locate: (ch: Chapter) => { volTitle: string; no: number }
  syncChapterMaster: (ch: Chapter, no: number) => Promise<unknown>
  /** 落库成功后才调用：把回执写回界面与草稿 */
  applySaved: (row: Chapter, text: string) => void
  setSaving: (v: boolean) => void
}

export type RestoreResult = { ok: boolean; message: string }

export async function restoreChapter(
  hooks: RestoreChapterHooks,
  chapterId: string,
  snapshotId: string,
  content: string,
): Promise<RestoreResult> {
  const target = hooks.chapters.current.find(c => c.id === chapterId)
  // 先断一次让后续类型收窄；真正的判断在 checkRestoreTarget（顺序与文案统一在那里）
  if (!target) return { ok: false, message: '要恢复的章节已不在项目中，本次未做任何修改。' }
  hooks.setSaving(true)
  try {
    const snaps = await db.getSnapshots(chapterId)
    const check = checkRestoreTarget({
      chapterId,
      activeChapterId: hooks.active.current?.id ?? null,
      chapterExists: true,
      snapshot: snaps.find(s => s.id === snapshotId) ?? null,
      expectedContent: content,
    })
    if (!check.ok) return { ok: false, message: check.message }

    // ① 留档 = 当前草稿；写完读回核实，才算留住了
    const currentText = hooks.draft.current
    const saved = await db.createSnapshot(
      { ...target, content: currentText, wordCount: countWords(currentText) },
      'manual-restore',
    )
    const verified = (await db.getSnapshots(chapterId)).find(s => s.id === saved.id)
    if (!verified) return { ok: false, message: '恢复前留档没有写成功，已停止恢复；正文保持原样。' }
    if (verified.content !== currentText) {
      return { ok: false, message: '恢复前留档读回的内容与当前草稿不一致，已停止恢复；正文保持原样。' }
    }

    // ② 落库：成功之前一律不碰界面
    clearTimeout(hooks.autosaveTimer.current)
    const wc = countWords(content)
    const written = await hooks.enqueueSave(chapterId, async () => {
      const cur = hooks.chapters.current.find(c => c.id === chapterId) ?? target
      const merged = await db.patchChapter(chapterId, { content, wordCount: wc })
      const row = merged ?? { ...cur, content, wordCount: wc, updatedAt: Date.now() }
      const { no } = hooks.locate(row)
      await hooks.syncChapterMaster(row, no)
      return row
    })

    // ③ 界面：用回执
    hooks.applySaved(written, content)
    return { ok: true, message: '已恢复到所选版本；恢复前的当前内容已存入时光机（来源：恢复前留档）。' }
  } catch (e) {
    return { ok: false, message: restoreFailureMessage(e) }
  } finally {
    hooks.setSaving(false)
  }
}
