/**
 * 3.2.0 · W3 候选的**生产入口**（"谁真正创建候选"的唯一一处）
 *
 * 🔴 为什么补这个文件：候选的存储、应用内核、审阅界面三块都在，却**没有任何地方创建一个候选** ——
 *    `listProjectCandidates` 生产上只被面板读、`saveCandidate` 只被"保存状态变更"调用，
 *    于是「创作轨迹 → 候选审阅」永远是空的，而空态文案写着"跑一次整章改写后，产出的稿子会先放在这里"。
 *    那是**承诺了没交付**。本文件把整章改写的产出登记成候选，兑现那句承诺。
 *
 * 三条口径（改之前先读）：
 *   ① **`jobId = rewrite:<chapterId>`**：`runApplyCandidate` 取同 job 的其它候选当 siblings 标 `stale`，
 *      而 `invalidateSiblings` **不按章过滤**。若所有章共用一个 jobId，应用 A 章那份会顺手把 B 章
 *      还在等的候选全标成过期 —— 那等于替作者丢弃了他没看过的稿子。按章分 job 才是对的。
 *   ② **存不下不阻断改写**：配额满 / 超过 256 KiB 时只记一句日志并回 `ok:false`。
 *      候选是"多一份保障"，不能因为它存不下就让作者已经拿到的改写结果消失。
 *   ③ **状态转移走状态机**（`transitionCandidate`），不硬写 `status`：
 *      `pending → applied` 不是合法转移，直接改字段等于绕过契约，日后状态图一改就会留下脏数据。
 */
import { loadCandidate, listJobCandidates, saveCandidate } from './candidateStore'
import { invalidateSiblings, transitionCandidate, type RevisionCandidate } from './revisionCandidate'

/** 同章作用域的 job id（见文件头 ①；这两个函数必须成对使用，别在别处另拼） */
export function rewriteJobIdOf(chapterId: string): string {
  return `rewrite:${chapterId}`
}

export interface RecordRewriteCandidateInput {
  projectId: string
  chapterId: string
  /** 改写产出的正文 */
  text: string
  /** 产出时的原文（应用前要拿它比对"你期间改过没有"） */
  beforeText: string
  /** 列表里那一行摘要（作者靠它认出这是哪一稿） */
  summary: string
  /** 产出时间；不传取当前时间 */
  createdAt?: number
}

export interface RecordRewriteCandidateResult {
  ok: boolean
  /** 存成时的候选 id —— 调用方拿它去标「已应用」 */
  candidateId?: string
  /** 存不成的原因（作者可见，别吞掉） */
  detail?: string
}

/**
 * 把一份改写产出登记成**待审阅候选**。
 *
 * 🔴 只登记、不落正文：正文要不要换由作者在「候选审阅」或原界面点。
 */
export async function recordRewriteCandidate(
  input: RecordRewriteCandidateInput,
): Promise<RecordRewriteCandidateResult> {
  const now = input.createdAt ?? Date.now()
  const candidate: RevisionCandidate = {
    id: `rc-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    jobId: rewriteJobIdOf(input.chapterId),
    projectId: input.projectId,
    chapterId: input.chapterId,
    status: 'pending',
    text: input.text,
    beforeText: input.beforeText,
    summary: input.summary,
    // 真实字节数由 saveCandidate 按载荷重算，这里只给个初值（别拿 length 当中文字数）
    bytes: 0,
    createdAt: now,
    updatedAt: now,
    generation: 1,
  }
  const r = await saveCandidate(candidate)
  if (!r.ok) {
    console.warn(`[candidateIntake] 候选没存成（改写结果不受影响）：${r.code} ${r.detail}`)
    return { ok: false, detail: r.detail }
  }
  return { ok: true, candidateId: candidate.id }
}

/**
 * 候选的正文已经由**别的路径**写进章节 ⇒ 把这份候选标成「已应用」。
 * 🔴 用途：创意写作页的「替换该章正文」不走 `applyCandidate`（它有自己的
 *    `baseFingerprint` 保护），所以那条路应用成功后必须回来改候选状态 ——
 *    否则「候选审阅」里会一直挂着一份已经生效的稿子，作者点第二次就把同一段正文
 *    覆盖第二遍（还会覆盖掉他这期间的新编辑）。
 *
 * 同章其它还等着的候选一并标 `stale`：它们的基准已经不成立了。
 */
export async function markCandidateApplied(candidateId: string): Promise<boolean> {
  const cur = await loadCandidate(candidateId)
  if (!cur || cur.status === 'applied' || cur.status === 'discarded') return false

  // pending → applying → applied（走状态机，不硬改 status）
  const step1 = transitionCandidate(cur, 'applying')
  if (!step1.ok || !step1.candidate) return false
  const step2 = transitionCandidate(step1.candidate, 'applied')
  if (!step2.ok || !step2.candidate) return false
  const saved = await saveCandidate(step2.candidate)
  if (!saved.ok) return false

  // 同章其它候选：不是作者放弃的，是基准被这次应用改了 ⇒ stale（不是 discarded）
  const siblings = (await listJobCandidates(cur.jobId).catch(() => []))
    .filter(c => c.id !== candidateId)
  for (const c of invalidateSiblings(siblings, candidateId)) {
    await saveCandidate(c).catch(() => undefined)
  }
  return true
}

/**
 * 作者在**别处**明确说"不要这次结果" ⇒ 把候选标成「已放弃」。
 *
 * 🔴 为什么必须联动：`discardRewrite()` 只清内存里那张结果卡。若不标候选，
 *    「候选审阅」里还挂着他刚否掉的稿子 —— 隔天他可能又点一次「应用」，
 *    把一份自己已经决定不要的改写写进正文。
 */
export async function markCandidateDiscarded(candidateId: string, reason: string): Promise<boolean> {
  const cur = await loadCandidate(candidateId)
  if (!cur || cur.status === 'applied' || cur.status === 'discarded') return false
  // 🔴 `applying → discarded` 不在合法转移表里。但这里不是"应用失败了"，是作者叫停 ——
  //    先退回 pending 再走放弃，别为省一步去硬改 status（那会让状态机形同虚设）。
  const from = cur.status === 'applying' ? { ...cur, status: 'pending' as const } : cur
  const out = transitionCandidate(from, 'discarded')
  if (!out.ok || !out.candidate) return false
  const saved = await saveCandidate({ ...out.candidate, discardedReason: reason })
  return saved.ok
}
