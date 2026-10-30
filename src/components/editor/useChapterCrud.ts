// ============ 章节 / 分卷的增删改名（从 useNovelEditorModel 外抽）============
//
// 【为什么抽出来】`useNovelEditorModel.ts` 已经顶到 1200 行硬上限（`structureGates` ① /
//   `editorViewMath` ④ 都会红）。这次加「新建最新章节」时正好越线，按项目规矩**外抽 hook**，
//   而不是把注释删掉凑行数 —— 注释里全是踩过的坑，删一行就可能再踩一次。
//
// 【为什么是这一块】它们的共同点很清楚：都是「改卷 / 章结构，然后 load 一遍 + 通知侧栏」，
//   与正文编辑、AI 伴写、保存链完全无关；拿走之后模型层剩下的才是「编辑器本身」。
//
// 🔴 状态仍然是父组件持有：本 hook 只接 setter，不自己存卷章（否则两处 state 会漂）。
// 🔴 三条口径不许在别处重写：
//    1. 卷 order 只数真卷（`nextVolumeOrder`），自由卷用哨兵值不占号；
//    2. 卷内新章 order = 该卷现有最大 order + 1（`nextOrderInVolume`），不是章节数；
//    3. 「最新章节」的落点要排除自由卷（`latestChapterTarget`），否则会挂到全书最前面。
import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { Chapter, Volume } from '@/lib/types'
import * as db from '@/lib/db'
import { uid } from '@/lib/app/id'
import { showToast } from '@/components/dialogs/dialogs'
import { syncChapterMaster } from '@/lib/outline/chapterMaster'
import { chapterSeqOf } from '@/lib/outline/chapterSeq'
import { ensureFreeVolume, findFreeVolume, nextVolumeOrder } from '@/lib/outline/freeVolume'
import { latestChapterTarget, nextOrderInVolume } from '@/lib/outline/chapterAppend'

export interface ChapterCrudDeps {
  volumes: Volume[]
  chapters: Chapter[]
  /** 带 AI 记账的章节保存（模型层持有） */
  saveChapterWithAi: (ch: Chapter) => Promise<void>
  /** 展开状态持久化 setter（展开新建章所在卷，否则树上找不到新章） */
  setExpandedPersist: (action: Set<string> | ((prev: Set<string>) => Set<string>)) => void
  setChapters: Dispatch<SetStateAction<Chapter[]>>
  setActiveId: Dispatch<SetStateAction<string | null>>
  /** 重新载入卷/章（模型层持有，含 AI 索引与幽灵清理等副作用） */
  load: () => Promise<void>
  locate: (ch: Chapter) => { volTitle: string; no: number }
}

export function useChapterCrud(deps: ChapterCrudDeps) {
  const {
    volumes, chapters, saveChapterWithAi, setExpandedPersist, setChapters, setActiveId, load, locate,
  } = deps

  const doAddVolume = useCallback(async (title: string) => {
    if (!title) return
    // 🔴 order 只数真卷：自由卷不占号，否则「第N卷」的默认名会被它挤偏一位（见 lib/freeVolume.ts）
    const vol: Volume = {
      id: uid(), projectId: db.getCurrentProjectId(), order: nextVolumeOrder(volumes),
      title, description: '', createdAt: Date.now(),
    }
    await db.saveVolume(vol)
    await load()
    window.dispatchEvent(new Event('yfe:volumes-changed')) // 通知章节总表侧栏同步新增
  }, [volumes, load])

  const doAddChapter = useCallback(async (volumeId: string, title: string) => {
    if (!title) return
    // 🔴 order 取「该卷现有最大 order + 1」，不是 `volChs.length`：
    //    删过章之后两者会分叉（卷内 0、2，length=2 ⇒ 新章与既有章撞号，排序开始抖）。
    const ch: Chapter = {
      id: uid(), projectId: db.getCurrentProjectId(), volumeId,
      order: nextOrderInVolume(chapters, volumeId), title, content: '', summary: '',
      status: '构思', wordCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
    }
    await saveChapterWithAi(ch)
    // 目标卷可能是折叠状态下点的「新建章」：展开它，否则 load 后树上找不到新章高亮
    setExpandedPersist(prev => new Set(prev).add(volumeId))
    await load()
    setActiveId(ch.id)
    // 新章登记到对应卷的章节台账。序号取全局派生值。
    // ⚠️ 这里必须现读库：上方 load/setChapters 是异步的，闭包里的 chapters 还不含新章，
    // 用旧 state 算出的序号恒为 0，台账会被误标「不计入序号」（章节号留空、行序错乱）。
    const [lv, lc] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    await syncChapterMaster(ch, chapterSeqOf(lv, lc, ch.id))
  }, [chapters, saveChapterWithAi, setExpandedPersist, load, setActiveId])

  /** 新建「自由章节」：托管卷不存在时自动建（lazy，不预建空卷），随后复用完整链路 */
  const doAddFreeChapter = useCallback(async (title: string) => {
    if (!title) return
    const wasMissing = !findFreeVolume(volumes)
    const vol = await ensureFreeVolume(volumes)
    await doAddChapter(vol.id, title)
    // 托管卷是本次新建的才算「多了一个卷」，要通知章节总表侧栏同步（已存在时不必）
    if (wasMissing) window.dispatchEvent(new Event('yfe:volumes-changed'))
  }, [volumes, doAddChapter])

  /**
   * 新建「最新章节」：挂到**最后一卷的末尾**，正文序号自动接下去。
   *
   * 🔴 与「自由章节」是两条不同意图，不能合并：自由章节不归卷、恒排全书最前、不占正文序号；
   *    最新章节属于正文，要进卷、排在卷末、参与编号。
   */
  const doAddLatestChapter = useCallback(async (title: string) => {
    if (!title) return
    const target = latestChapterTarget(volumes, chapters)
    if (!target) {
      showToast('还没有分卷。请先「新建卷」，或改用「新建自由章节」。', 'error')
      return
    }
    await doAddChapter(target.volumeId, title)
  }, [volumes, chapters, doAddChapter])

  const doRenameVolume = useCallback(async (vol: Volume, title: string) => {
    if (!title || title === vol.title) return
    await db.saveVolume({ ...vol, title })
    await load()
    window.dispatchEvent(new Event('yfe:volumes-changed')) // 通知章节总表侧栏同步改名
  }, [load])

  const doRenameChapter = useCallback(async (ch: Chapter, title: string) => {
    if (!title || title === ch.title) return
    const next = { ...ch, title }
    setChapters(prev => prev.map(x => (x.id === ch.id ? next : x)))
    const { no } = locate(next)
    await Promise.all([saveChapterWithAi(next), syncChapterMaster(next, no)])
  }, [setChapters, locate, saveChapterWithAi])

  return {
    doAddVolume, doAddChapter, doAddFreeChapter, doAddLatestChapter, doRenameVolume, doRenameChapter,
  }
}
