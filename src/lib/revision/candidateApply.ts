/**
 * 3.2.0 · W3 候选应用编排（条件提交 + 严格写盘 + 崩溃恢复）
 *
 * 方案 §9.2 / §16.2 的口径，一句话概括：
 *   **写完并回读一致，才准发布「已应用」；中途断了，先核对再决定补回执还是重写。**
 *
 * 为什么要有这一层（而不是让 UI 直接调 `prepareApplyCandidate`）：
 *   `revisionCommit` 只做「状态机 + 意图/回执的构造」，**不做写盘**，也不碰存储。
 *   如果每个调用方（改写、检查应用、导入）各自写一遍「读 → 校验 → 写 → 回读 → 回执」，
 *   必然出现"某处忘了回读"这种半吊子实现 —— 那时界面上会显示"已应用"，而磁盘上根本没落。
 *   所以这里把顺序固定成**一个不可拆的函数**：顺序错了，测试就会红。
 *
 * 🔴 三条不可协商的规则：
 *   ① **条件提交**：正文/细纲摘要与候选基准不符 ⇒ 直接拒绝（`stale`），绝不覆盖作者的编辑；
 *   ② **严格写盘**：写入值必须与回读值摘要一致，否则报失败并保留 intent（不写回执）；
 *   ③ **崩溃可恢复**：`applying` 状态的候选再次进来时，按"当前正文到底是改前还是改后"决定
 *      「补回执」还是「重新写」，绝不重复写一遍正文。
 *
 * ⚠️ 依赖全部注入（读/写/回读/持久化/摘要）：本模块不 import db，便于用内存假件把
 *    "写一半崩了""回读不一致"这些真实故障在单测里精确复现。
 */
import type { RevisionJob } from './jobTypes'
import type { RevisionCandidate } from './revisionCandidate'
import type { RevisionSubmitReceipt } from './jobTypes'
import {
  prepareApplyCandidate, completeApplyCandidate, createSubmitReceipt,
} from './revisionCommit'
import { invalidateSiblings } from './revisionCandidate'
import { strictWrite } from './faultInjection'
import { diffStats, type RevisionDiffStats } from './revisionDiff'
import { hashOf } from '@/lib/semantic/chunk'

export interface CandidateApplyDeps {
  /** 读磁盘上的当前正文 */
  readBody: () => Promise<string>
  /** 写正文；返回值必须是**实际写下去的文本**（用于与回读值比对） */
  writeBody: (text: string) => Promise<string>
  /** 回读正文（模拟"另开一次读"，不是复用内存里的变量） */
  readBack: () => Promise<string | undefined>
  /** 持久化候选（把 status / intent / receipt 写下去 —— 崩溃恢复的唯一依据） */
  persist: (c: RevisionCandidate) => Promise<void>
  /** 摘要函数（缺省 `hashOf`；测试可换成简单实现） */
  digest?: (text: string) => string
  /** 读细纲摘要（给了才做细纲的条件提交） */
  readOutlineDigest?: () => Promise<string | undefined>
  /** 同一落点的其他候选（应用成功后要标为过期，避免旧候选再覆盖） */
  siblings?: RevisionCandidate[]
}

export type ApplyFailureCode =
  | 'state'               // 候选状态不允许应用
  | 'stale'               // 基准已变（正文/细纲被改过）
  | 'write-failed'        // 写盘本身失败 / 回读拿不到
  | 'readback-mismatch'   // 回读内容与写入值不一致
  | 'needs-reconcile'     // 崩溃后状态对不上（既不是改前也不是改后）

export interface ApplySuccess {
  ok: true
  candidate: RevisionCandidate
  receipt: RevisionSubmitReceipt
  diff: RevisionDiffStats
  /**
   * 是否走了「崩溃恢复」分支：
   *  · true  ＝ 上次已经把正文写下去了，这次只补回执（**没有再写一次**）
   */
  resumed: boolean
  /** 应用成功后需要标为过期的同落点候选（调用方负责持久化） */
  invalidated: RevisionCandidate[]
}

export interface ApplyFailure {
  ok: false
  code: ApplyFailureCode
  detail: string
  /** 失败后的候选（可能已带 intent，调用方必须持久化它，崩溃核对靠它） */
  candidate: RevisionCandidate
}

export type ApplyOutcome = ApplySuccess | ApplyFailure

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function applyCandidate(
  job: RevisionJob,
  candidate: RevisionCandidate,
  deps: CandidateApplyDeps,
): Promise<ApplyOutcome> {
  const digest = deps.digest ?? hashOf

  // ── 0. 只接受可应用状态；`applying` 走崩溃恢复分支 ──
  if (candidate.status !== 'pending' && candidate.status !== 'applying') {
    return { ok: false, code: 'state', detail: `候选状态不可应用：${candidate.status}`, candidate }
  }

  const currentBody = await deps.readBody().catch(() => '')
  const currentOutline = deps.readOutlineDigest ? await deps.readOutlineDigest().catch(() => undefined) : undefined
  const currentDigest = digest(currentBody)

  // ── 1. 崩溃恢复：上次停在 applying ──
  if (candidate.status === 'applying') {
    const intent = candidate.intent
    if (!intent) {
      return {
        ok: false, code: 'needs-reconcile',
        detail: '候选停在「应用中」但没有提交意图，无法判断上次写没写 —— 需人工核对',
        candidate,
      }
    }
    const afterDigest = digest(candidate.text)
    // ① 磁盘已是"改后" ⇒ 写成功了，只是回执没落下 ⇒ 补回执（幂等，不再写）
    if (currentDigest === afterDigest) {
      const done = completeApplyCandidate(candidate, currentDigest, currentOutline)
      if (!done.ok || !done.candidate || !done.receipt) {
        return { ok: false, code: 'needs-reconcile', detail: done.error ?? '补回执失败', candidate }
      }
      try {
        await deps.persist(done.candidate)
      } catch (e) {
        return { ok: false, code: 'needs-reconcile', detail: `正文已是候选内容，但应用回执未保存：${errText(e)}`, candidate }
      }
      return {
        ok: true,
        candidate: done.candidate,
        receipt: done.receipt,
        diff: diffStats(candidate.beforeText, candidate.text),
        resumed: true,
        invalidated: invalidateSiblings(deps.siblings ?? [], done.candidate.id),
      }
    }
    // ② 磁盘仍是"改前" ⇒ 写没发生，继续走一次正常写入
    if (currentDigest === intent.beforeBodyDigest) {
      return await doWrite(job, { ...candidate, status: 'pending', intent: undefined }, deps, digest, currentOutline)
    }
    // ③ 两边都不是 ⇒ 作者在崩溃后又改过正文，不能猜
    return {
      ok: false, code: 'needs-reconcile',
      detail: '正文既不是候选的改前内容、也不是改后内容（可能期间被编辑过）—— 需人工核对',
      candidate,
    }
  }

  // ── 2. 正常路径 ──
  return doWrite(job, candidate, deps, digest, currentOutline)
}

/** 真正的「校验 → 记意图 → 写 → 回读 → 记回执」顺序（唯一一处，别在别处复制） */
async function doWrite(
  job: RevisionJob,
  candidate: RevisionCandidate,
  deps: CandidateApplyDeps,
  digest: (t: string) => string,
  currentOutline: string | undefined,
): Promise<ApplyOutcome> {
  const currentBody = await deps.readBody().catch(() => '')
  const currentDigest = digest(currentBody)

  // ① 条件提交（prepareApplyCandidate 内部也会校验，这里先判一次是为了给出**精确原因码**）
  const prepared = prepareApplyCandidate(job, candidate, currentDigest, currentOutline)
  if (!prepared.ok || !prepared.candidate || !prepared.intent) {
    const detail = prepared.error ?? '提交前置校验未通过'
    const stale = /已变化|需重新核对/.test(detail)
    return { ok: false, code: stale ? 'stale' : 'state', detail, candidate }
  }

  // ② 先把 intent 落盘 —— 崩溃后能靠它判断"写到哪了"
  try {
    await deps.persist(prepared.candidate)
  } catch (e) {
    // 没有可靠的 intent，崩溃后就无法核对这次替换；此时正文必须保持原样。
    return { ok: false, code: 'write-failed', detail: `提交意图未保存，尚未替换正文：${errText(e)}`, candidate }
  }

  // ③ 严格写盘：写入值必须与回读值一致（否则等于没写成）
  const expect = candidate.text
  const written = await strictWrite<string>(
    async () => deps.writeBody(expect),
    async () => deps.readBack(),
    (w, r) => digest(w) === digest(r),
  ).catch(e => ({ ok: false as const, error: errText(e), shouldRetry: true }))

  if (!written.ok) {
    const mismatch = /不一致/.test(written.error ?? '')
    return {
      ok: false,
      code: mismatch ? 'readback-mismatch' : 'write-failed',
      // 🔴 保留 intent（候选仍是 applying）：崩溃核对要靠它；这里**不写回执**
      detail: written.error ?? '写盘失败',
      candidate: prepared.candidate,
    }
  }

  // ④ 写成功了才发回执
  const afterBody = await deps.readBack().catch(() => undefined)
  const afterDigest = digest(afterBody ?? '')
  const done = completeApplyCandidate(prepared.candidate, afterDigest, currentOutline)
  if (!done.ok || !done.candidate || !done.receipt) {
    // 极端情形：写成功但回执构造失败 ⇒ 如实报"需核对"，下次进来会走"补回执"分支
    return { ok: false, code: 'needs-reconcile', detail: done.error ?? '回执构造失败', candidate: prepared.candidate }
  }
  try {
    await deps.persist(done.candidate)
  } catch (e) {
    // 正文已写，仍返回带 intent 的 applying 状态；重试走补回执分支，不重写正文。
    return { ok: false, code: 'needs-reconcile', detail: `正文已写入，但应用回执未保存：${errText(e)}`, candidate: prepared.candidate }
  }
  return {
    ok: true,
    candidate: done.candidate,
    receipt: done.receipt,
    diff: diffStats(candidate.beforeText, expect),
    resumed: false,
    invalidated: invalidateSiblings(deps.siblings ?? [], done.candidate.id),
  }
}

/**
 * 记一份**失败回执**（写失败时用）。
 *
 * 🔴 为什么需要：方案要求"失败原因及每次降级留在同一逻辑调用的尝试记录里"。
 *    只在内存里 throw 掉，作者事后看到的就只是一句"失败了"，不知道当时写没写进去。
 */
export function failureReceipt(
  candidate: RevisionCandidate,
  reason: string,
): RevisionSubmitReceipt | null {
  if (!candidate.intent) return null
  return createSubmitReceipt(candidate.intent, '', undefined, false, reason)
}
