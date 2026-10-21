/**
 * 3.2.0 · W3 候选应用的生产接线（`candidateApply` 的依赖落在真实存储上）
 *
 * `candidateApply` 刻意**不 import db**（便于单测复现"写一半崩了""回读不一致"），
 * 所以真实环境必须有一处把依赖接上 —— 本文件就是那一处，且**只有这一处**。
 *
 * 🔴 三个关键取舍（改之前先读）：
 *   ① **任务（job）是即时构造的**：当前生产没有「修订任务」的落库入口，
 *      但 `applyCandidate` 需要 `job.baseline` 做条件提交。这里用**候选自带的 `beforeText` 摘要**
 *      当基准 —— 语义正是我们要的："当前正文若已不是这份候选产出时的原文，就不许覆盖"。
 *      基准来源稳定（只来自候选本身），所以崩溃恢复时重建出的 job 与上次一致。
 *   ② **不传 `applyChapterRewrite` 的 `expectedFingerprint`**：那条判据含 `updatedAt`，
 *      作者改了标题等字段就会误拒。W3 的正文摘要判据更精确（正文没变就允许应用）。
 *      覆盖保护**没有变松**——它只是换成了"比对正文内容"，而不是"比整个章节对象"。
 *   ③ **落库只走 `applyChapterRewrite`**：先留快照、只动三字段、同步章节台账，
 *      本模块绝不复制那套逻辑（记忆里这条纪律已经踩过）。
 */
import * as db from '@/lib/db'
import { applyChapterRewrite } from '@/lib/editor/chapterRewrite'
import { checkFactRetention, type FactGuardReport } from '@/lib/ai/factGuard'
import { loadRegistry } from '@/lib/settings/settingLedger'
import { saveCandidate, listJobCandidates } from './candidateStore'
import { applyCandidate, type ApplyOutcome } from './candidateApply'
import type { RevisionCandidate } from './revisionCandidate'
import type { RevisionJob } from './jobTypes'
import { hashOf } from '@/lib/semantic/chunk'

/**
 * 为一份候选构造「校验用任务」。
 *
 * 🔴 不落库：当前没有任务存储的生产入口，落一个假任务反而会污染 W2 的任务列表。
 *    它是**纯函数**（同一候选 ⇒ 同一 job），所以崩溃恢复时重算出的基准与上次一致。
 */
export function jobForCandidate(candidate: RevisionCandidate, chapterId: string): RevisionJob {
  return {
    id: candidate.jobId,
    projectId: candidate.projectId,
    kind: 'chapter-rewrite',
    scope: { chapterId },
    params: {},
    status: 'running',
    stepCount: 1,
    currentStep: 1,
    steps: [],
    baseline: {
      bodyDigest: hashOf(candidate.beforeText ?? ''),
      createdAt: candidate.createdAt,
    },
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  }
}

/** 读某一章的正文（章没了就返回空串，由上层给出明确提示） */
export async function chapterBodyOf(chapterId: string): Promise<string> {
  const all = await db.getAllChapters()
  return all.find(c => c.id === chapterId)?.content ?? ''
}

/**
 * 执行结果 = `applyCandidate` 的原样结果 + 过期候选的实际落库条数。
 * 🔴 用类型别名而不是 interface extends：`ApplyOutcome` 是**联合类型**，interface 没法继承它。
 */
export type RunApplyResult =
  | (Extract<ApplyOutcome, { ok: true }> & { invalidatedSaved: number; facts?: FactGuardReport })
  | (Extract<ApplyOutcome, { ok: false }> & { invalidatedSaved: number })

/**
 * 应用一份候选到某一章。
 *
 * 顺序完全由 `applyCandidate` 决定（校验 → 记意图 → 写 → 回读 → 回执），
 * 这里只负责把每一步接到真实的读/写/存。
 *
 * 3.2.0 · WQ8：应用成功后再跑一次**实体保留自检**（方案 A：只报告不判定）。
 * 🔴 全程不抛：它回答的是"改写后哪些登记实体没再出现"，属于给作者看的参考，
 *    绝不能因为它把已经落库的正文说成有问题；跑不成就没有 `facts` 字段，界面不渲染。
 */
export async function runApplyCandidate(
  candidate: RevisionCandidate,
  /** 章节可显式指定；不传就用候选自带的 `chapterId`（两者都没有 ⇒ 明确报错） */
  opts: { chapterId?: string } = {},
): Promise<RunApplyResult> {
  const chapterId = opts.chapterId ?? candidate.chapterId ?? ''
  if (!chapterId) {
    return {
      ok: false,
      code: 'state',
      detail: '这份候选没有记录归属章节，无法确定要改哪一章 —— 请重新生成改写结果。',
      candidate,
      invalidatedSaved: 0,
    }
  }
  const siblings = (await listJobCandidates(candidate.jobId).catch(() => []))
    .filter(c => c.id !== candidate.id)
  const deps = {
    readBody: () => chapterBodyOf(chapterId),
    writeBody: async (text: string) => {
      await applyChapterRewrite(chapterId, text, 'rewritten')
      return text
    },
    // 🔴 真的**再读一次**（不是复用内存变量）：回读不一致正是要抓的故障
    readBack: () => chapterBodyOf(chapterId),
    persist: (c: RevisionCandidate) => saveCandidate(c).then(() => undefined),
    // 同章其它候选：应用成功后要标 stale（不是 discarded —— 作者没看过它们）
    siblings,
  }
  const job = jobForCandidate(candidate, chapterId)
  const out = await applyCandidate(job, candidate, deps)

  let invalidatedSaved = 0
  let facts: FactGuardReport | undefined
  if (out.ok) {
    for (const c of out.invalidated) {
      const r = await saveCandidate(c).catch(() => null)
      if (r) invalidatedSaved++
    }
    // 实体保留自检（旁路）：正文已落库、回执已写，这里只是给作者多一句参考
    try {
      facts = await checkFactRetention(await loadRegistry(), candidate.beforeText ?? '', candidate.text ?? '')
      if (!facts.summary) facts = undefined
    } catch (e) {
      console.warn('[candidateRunner] 实体保留自检没跑成（正文已落库）：', e)
    }
  } else {
    // 失败也要持久化：候选可能停在 `applying` 并带着 intent —— 崩溃核对全靠它
    await saveCandidate(out.candidate).catch(() => null)
  }
  return { ...out, invalidatedSaved, ...(facts ? { facts } : {}) }
}
