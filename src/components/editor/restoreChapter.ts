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
import { captureOwnedOperation, type OwnedOperation } from '@/lib/storage/ownedOperation'
import { persistAfterRestore } from '@/lib/db/core'

const defaultDependencies = {
  capture: captureOwnedOperation,
  getSnapshots: db.getSnapshots,
  createSnapshot: db.createSnapshot,
  patchChapter: db.patchChapter,
  persist: persistAfterRestore,
}
export type RestoreDependencies = typeof defaultDependencies

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
  syncChapterMaster: (ch: Chapter, no: number, owner?: OwnedOperation) => Promise<unknown>
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
  deps: RestoreDependencies = defaultDependencies,
): Promise<RestoreResult> {
  const target = hooks.chapters.current.find(c => c.id === chapterId)
  // 先断一次让后续类型收窄；真正的判断在 checkRestoreTarget（顺序与文案统一在那里）
  if (!target) return { ok: false, message: '要恢复的章节已不在项目中，本次未做任何修改。' }
  hooks.setSaving(true)
  let writeStarted = false
  try {
    const owner = deps.capture(target.projectId)
    owner.assertCurrent()
    const snaps = await deps.getSnapshots(chapterId)
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
    const saved = await deps.createSnapshot(
      { ...target, content: currentText, wordCount: countWords(currentText) },
      'manual-restore',
      owner,
    )
    const verified = (await deps.getSnapshots(chapterId)).find(s => s.id === saved.id)
    if (!verified) return { ok: false, message: '恢复前留档没有写成功，已停止恢复；正文保持原样。' }
    if (verified.content !== currentText) {
      return { ok: false, message: '恢复前留档读回的内容与当前草稿不一致，已停止恢复；正文保持原样。' }
    }
    owner.assertCurrent()
    if (!await deps.persist([{ store: 'snapshots', value: verified }])) {
      return { ok: false, message: '恢复前留档未确认写入本机，已停止恢复；草稿仍在。' }
    }

    // ② 落库：成功之前一律不碰界面
    const wc = countWords(content)
    const written = await hooks.enqueueSave(chapterId, async () => {
      owner.assertCurrent()
      if (hooks.active.current?.id !== chapterId || hooks.draft.current !== currentText) {
        throw new Error('章节或草稿已变化，请重新检查后再恢复')
      }
      clearTimeout(hooks.autosaveTimer.current)
      writeStarted = true
      const row = await deps.patchChapter(chapterId, { content, wordCount: wc }, owner)
      if (!row) throw new Error('目标章节已不存在')
      owner.assertCurrent()
      if (!await deps.persist([{ store: 'chapters', value: row }])) throw new Error('正文未确认写入本机')
      owner.assertCurrent()
      const { no } = hooks.locate(row)
      await hooks.syncChapterMaster(row, no, owner)
      return row
    })

    // ③ 界面：用回执
    owner.assertCurrent()
    if (hooks.active.current?.id !== chapterId || hooks.draft.current !== currentText) {
      return { ok: false, message: '恢复写入期间章节或草稿已变化；新草稿仍在，请检查原章节与时光机，并确认是否需要手动保存草稿。' }
    }
    hooks.applySaved(written, content)
    return { ok: true, message: '已恢复到所选版本；恢复前的当前内容已存入时光机（来源：恢复前留档）。' }
  } catch (e) {
    return { ok: false, message: writeStarted
      ? `恢复未能完整确认：${e instanceof Error ? e.message : String(e)}。正文可能已写入，请检查章节和时光机；当前草稿未被替换，请确认是否需要手动保存。`
      : restoreFailureMessage(e) }
  } finally {
    hooks.setSaving(false)
  }
}
