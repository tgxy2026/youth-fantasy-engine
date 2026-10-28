/**
 * 键盘重排工厂（UX12，**刻意不是 hook**）：Alt+↑/↓ 在**同卷内**移动章节、在**真卷之间**移动分卷。
 *
 * 为什么要有它：正文编辑的章节树此前**只能拖拽**——键盘用户与读屏用户根本排不了序。
 * 拖拽本身保留（它是快路径），这里补一条等价路径，且走**同一套**重排函数与落库流程：
 *   · 章：`reorderChapters`（只在自己卷内的可见顺序里换位）→ 逐章 `saveChapter` → 重排正文序号
 *   · 卷：`reorderVolumes`（自由卷恒排最前，不参与）→ 逐卷 `saveVolume` → 重排正文序号
 * 到边界时**不写库、不提示"已保存"**（避免"按了没反应但说保存了"的假反馈）。
 * 🔴 为什么不做成 hook：模型里每多一个 hook 都会改变渲染时序，实测加 `useCallback` 版本后
 *    「同页切回原章的位置复原」会稳定变红（editor-view ④）。这里只返回一个普通函数，零 hook。
 */
import type { Chapter, Volume } from '@/lib/types'
import * as db from '@/lib/db'
import { reorderChapters, reorderVolumes, resyncChapterMasterNumbers } from '@/components/editor/novelEditorHelpers'
import { isFreeVolume, realVolumes } from '@/lib/outline/freeVolume'
import { keyboardNeighbor } from '@/lib/editor/chapterReorder'
import { showToast } from '@/components/dialogs/dialogs'

export interface KeyboardReorderArgs {
  volumes: Volume[]
  chapters: Chapter[]
  setVolumes: (next: Volume[]) => void
  setChapters: (next: Chapter[]) => void
  /** 与拖拽、正文保存同一条落库路径（内部会做 AI 索引/字数统计等副作用） */
  saveChapter: (ch: Chapter) => Promise<void>
}

export function createEditorKeyboardReorder(args: KeyboardReorderArgs) {
  const moveByKeyboard = async (kind: 'vol' | 'ch', id: string, dir: -1 | 1) => {
    const { volumes, chapters } = args
    try {
      if (kind === 'vol') {
        const reals = realVolumes(volumes)
        const target = keyboardNeighbor(reals, id, dir)
        if (!target) return                       // 已是首个/末个真卷：什么都不做，也不报"已保存"
        // 🔴 自由卷不参与卷序重排（它的 order 是哨兵值），保持恒排最前
        const next = [...volumes.filter(v => isFreeVolume(v)), ...reorderVolumes(reals, id, target.id, target.pos)]
        const dirty = next.some(v => v.order !== (volumes.find(x => x.id === v.id)?.order ?? -1))
        args.setVolumes(next)
        if (dirty) {
          await Promise.all(next.map(v => db.saveVolume(v)))
          await resyncChapterMasterNumbers(next, chapters)
        }
      } else {
        const ch = chapters.find(c => c.id === id)
        if (!ch) return
        const inVolume = chapters.filter(c => c.volumeId === ch.volumeId)
        const target = keyboardNeighbor(inVolume, id, dir)
        if (!target) return                       // 本卷第一/最后一章
        const reordered = reorderChapters(inVolume, id, target.id, target.pos)
        const next = chapters.map(c => reordered.find(x => x.id === c.id) ?? c)
        const changed = next.filter(c => {
          const before = chapters.find(x => x.id === c.id)
          return !!before && (before.order !== c.order || before.volumeId !== c.volumeId)
        })
        args.setChapters(next)
        if (changed.length) {
          await Promise.all(changed.map(c => args.saveChapter(c)))
          await resyncChapterMasterNumbers(volumes, next)
        }
      }
      showToast('排序已保存', 'success')
    } catch (error) {
      console.error('键盘重排失败', error)
      showToast('排序失败：' + (error instanceof Error ? error.message : String(error)), 'error')
    }
  }

  return { moveByKeyboard }
}
