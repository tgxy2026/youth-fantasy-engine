/**
 * 「整章改写」的落库层 —— 把一个改写结果写回某一章。
 *
 * 为什么单独一层：改写会**覆盖作者的正文**，是破坏性操作，安全边界必须集中在一处、
 * 写得明明白白，不与界面逻辑混在一起。三条边界：
 *   1. **只动三个字段**（content / wordCount / updatedAt）：标题、状态、卷属、序号一律不碰
 *      —— 改写是"改文字"，不是"挪动章节"。
 *   2. **写前显式存快照**：`db.saveChapter` 自己也会按阈值存（>5 分钟 或 字数差 >200），
 *      但"5 分钟内连改两次、且两次字数都接近"恰好两条都不满足，旧稿就永久丢了。
 *      这里显式再存一份，界面提示指向「时光机 · 本章版本历史」。
 *   3. **同步章节台账**：不同步的话「章节总表」与项目字数会停在旧值上。
 */
import { chapterSeqMap, flattenChapters } from '@/lib/outline/chapterSeq'
import { syncChapterMaster } from '@/lib/outline/chapterMaster'
import * as db from '@/lib/db'
import { countWords } from '@/lib/editor/textStats'
import type { ChapterRewriteAction } from '@/lib/ai/aiTasks'
import type { Chapter, Volume } from '@/lib/types'
import { withAiAssist, type AiSourceKind } from '@/lib/ai/aiAssist'
import { chapterFingerprint } from '@/lib/ai/aiRunLedger'
import { analyzeFutureImpact } from '@/lib/outline/futureImpact'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'

/**
 * 本次改写的**期望字数** —— 异常判定的基准。
 *   · 润色：就是原文长度（润色的定义是"字数与原文相当 ±10%"）；
 *   · 扩写 / 精简 / 续写 / 改写：面板上填的目标字数（没填才退回原文长度）。
 *
 * 🔴 为什么要区分（2026-09-19 修）：原实现一律以"原文的 35%"为下限，对**精简**是结构性误判 ——
 *    原文 3800 字压到目标 1200 字只占原文 31.6%，**必定**被判"结果明显偏短"并锁住「替换该章正文」，
 *    作者明明要求的就是这个字数，却怎么也替换不了。反过来对**扩写**又漏判（原文 2000 / 目标 6000，
 *    只返回 1500 属严重缩水，但占原文 75% → 不报异常）。
 */
export function expectedRewriteWords(
  action: ChapterRewriteAction, fromWords: number, targetWords?: number,
): number {
  if (action === 'polish') return fromWords
  return targetWords && targetWords > 0 ? targetWords : fromWords
}

/**
 * 改写结果是否"可疑"（差距过大，必须锁住替换）。
 *
 * 下限 60% 期望：模型抽风 / 被截断（实测偶发只吐 1 个字）时保住作者正文；
 * 上限 3 倍期望：精简动作却越改越长、润色却膨胀数倍，同样不是作者要的东西。
 * 原文 ≤600 字的短章不套用 —— 短章的正常波动也会碰到这两条线，锁了反而碍事。
 */
export function isSuspectRewrite(fromWords: number, outWords: number, expect: number): boolean {
  if (fromWords <= 600) return false
  return outWords < expect * 0.6 || outWords > expect * 3
}

export interface RewriteCandidate {
  chapter: Chapter
  /** 全局叙事序号（0 = 不计入序号，如序章 / 番外） */
  no: number
}

/**
 * 列出可改写的章节（按真实叙事顺序）。
 * 界面拿它渲染选章下拉；`no` 用来显示「第N章」。
 */
export async function listRewriteCandidates(): Promise<RewriteCandidate[]> {
  const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  const seq = chapterSeqMap(vols, chs)
  return flattenChapters(vols, chs).map(chapter => ({ chapter, no: seq.get(chapter.id) ?? 0 }))
}

/**
 * 按卷分组的候选 —— 供界面的「卷 → 章」树用。
 * 空卷不出现在结果里（树里列一个点开是空的卷没有意义）。
 */
export interface RewriteCandidateGroup {
  volume: Volume
  items: RewriteCandidate[]
}

export async function listRewriteTree(): Promise<RewriteCandidateGroup[]> {
  const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  const seq = chapterSeqMap(vols, chs)
  const byVol = new Map<string, RewriteCandidate[]>()
  for (const c of flattenChapters(vols, chs)) {
    const item: RewriteCandidate = { chapter: c, no: seq.get(c.id) ?? 0 }
    const list = byVol.get(c.volumeId)
    if (list) list.push(item)
    else byVol.set(c.volumeId, [item])
  }
  return [...vols]
    .sort((a, b) => a.order - b.order)
    .map(v => ({ volume: v, items: byVol.get(v.id) ?? [] }))
    .filter(g => g.items.length > 0)
}

/**
 * 把改写结果写回该章。
 * @returns 新字数
 * @throws 章节不存在 / 内容为空时抛错（调用方负责提示作者）
 */
export async function applyChapterRewrite(
  chapterId: string,
  text: string,
  /**
   * 🔴 B3：这条路径**不止一个调用方** —— 手动「整章改写」用它（= `rewritten`），
   * 而**创意写作**也从无到有产出正文后调它（= `generated`）。
   * 写死成 `rewritten` 会让创意写作的产量被记成"改写"，占比分类就错了。
   * 故由调用方声明来源，默认仍是 `rewritten`（绝大多数调用是改写）。
   */
  kind: AiSourceKind = 'rewritten',
  /**
   * 3.0 · W1-1 版本保护（§10.3 #1）：**产出这份候选时**该章的指纹。
   * 传入则采纳前校验 —— 这一章若在生成之后被改动过，**拒绝覆盖**（防「旧候选盖掉作者编辑」）。
   * 不传 = 只做历史行为（兼容其他调用点）。
   */
  opts?: { expectedFingerprint?: string; owner?: OwnedOperation },
): Promise<{ words: number }> {
  const owner = opts?.owner
  owner?.assertCurrent()
  const body = (text ?? '').trim()
  if (!body) throw new Error('改写结果为空，没有可写入的内容')
  const chs = await db.getAllChapters(owner)
  const ch = chs.find(c => c.id === chapterId)
  if (!ch) throw new Error('这一章已经不在项目里了')
  // 🔴 3.0 · W1-1 版本保护：候选产出后正文若被改动 ⇒ **拒绝静默覆盖**。
  //    不自动丢弃、不自动重跑（沿用 isSuspectRewrite 的克制口径）—— 由作者决定重生成还是放弃。
  if (opts?.expectedFingerprint && chapterFingerprint(ch) !== opts.expectedFingerprint) {
    throw new Error('这一章在你产出改写结果之后又被改动过 —— 直接替换会覆盖你的编辑，请重新生成改写结果。')
  }
  // 🔴 先留旧稿，再覆盖（顺序不能反：反了就丢原文）
  // 标成 AI 来源：裁剪时优先牺牲定时快照，保住这一版（2.4.0 · A3）
  await db.createSnapshot(ch, 'ai-rewrite', owner)
  const words = countWords(body)
  // 🔴 B3（2.4.1）：记账 —— 本章正文由 AI 整章改写而来，把**本次产出字数**累加进 aiAssist。
  //    `withAiAssist` 是纯函数（返回新对象），不改 `ch` 本身；口径是"过程量"，见 lib/aiAssist.ts 文件头。
  const next: Chapter = withAiAssist(
    { ...ch, content: body, wordCount: words, updatedAt: Date.now() },
    kind,
    words,
  )
  const [vols, all] = await Promise.all([db.getAllVolumes(owner), db.getAllChapters(owner)])
  await db.saveChapter(next, owner)
  const seq = chapterSeqMap(vols, all).get(next.id) ?? 0
  await syncChapterMaster(next, seq, undefined, owner)
  // 🔴 3.0 · W2-1 未来演化边界（§10.3 #3）：**已写历史被改动** ⇒ 章纲里「本章之后」的
  //    未来计划标记「待重审」。
  //    · 只在 `rewritten`（回改已写章）时打标 —— `generated` 是「创意写作产出新章」，
  //      那是**按计划推进**（把某个未来章变成已写章），不该反过来说后续计划失效。
  //    · 只标记、绝不改章纲内容；失败静默（提醒失败绝不能连累改写落库）。
  if (kind === 'rewritten' && seq > 0) await analyzeFutureImpact(seq, '正文改写', undefined, owner).catch(() => {})
  owner?.assertCurrent()
  return { words }
}
