/**
 * 章节写入 · 准备记录与结果回执（3.6.0 · E 包）
 *
 * 依据：规划 §16 E「保存回执与幂等恢复」。
 *
 * 这一层解决的是「崩溃窗口」：
 *   · 正文写进库了、但界面以为失败（或反过来）—— 靠**预分配章节 id** 在恢复时核对，
 *     绝不用章名 / 时间 / 正文相似度去猜；
 *   · 「正文已保存、整理失败」—— 靠**分步回执**如实表达，不宣传"整章事务"；
 *   · 摘要失败与作者原本留空 —— 回执里分 `failed` / `empty`，恢复时不再把失败抹成空。
 *
 * 落点：`meta` 的 `chapterWrite::<项目id>`（**本机专属**前缀，见 sensitiveMeta）：
 * 崩溃恢复是「这台机器上一次写入」的事，跟着云同步到别的设备只会留下一份指向别处章节的记录。
 *
 * 🔴 顺序纪律：`prepare` 必须在**首次不可逆写入之前**完成；写失败就**不写正文**
 *    （宁可这一章不落库，也不能留一份无法恢复的半成品）。
 */
import { ops } from '@/lib/db/core'
import type { StoreOps } from '@/lib/storage/storeOps'
import { storageWriteContext } from '@/lib/storage/writeOwner'
import { hashOf } from '@/lib/semantic/chunk'

export const CHAPTER_WRITE_PREFIX = 'chapterWrite::'
export const CHAPTER_WRITE_LIMIT = 40

/** 分步结果：正文之外的四件事各自如实表达 */
export type ChapterStepState = 'ok' | 'failed' | 'empty' | 'skipped' | 'done' | 'partial'

export interface ChapterWriteReceipt {
  /** 正文：committed = 已确认在库；failed = 明确失败；unknown = 崩溃后核对过但当时没能确认 */
  chapter: 'committed' | 'failed' | 'unknown'
  /** 摘要：ok / failed（想过但失败）/ empty（本来就没有）/ skipped（预算跳过） */
  summary: ChapterStepState
  /** 设定补登：done / partial / failed / skipped */
  settings: ChapterStepState
  /** 章节总表同步 */
  master: ChapterStepState
  /**
   * 3.6.0 · E：设定补登的**逐项**落点（名字 / 页签 / 记录 id / 是否合并进已有行，最多 20 条）。
   * 🔴 只存定位，不存设定内容；作者想核对「这条到底进没进表」时能直接对到具体那一行。
   */
  settingsWritten?: { name: string; tabId: string; recordId: string; merged: boolean }[]
  /** 3.6.0 · E：`confirm` 策略下作者的实际选择（提请几条 / 勾了几条）；缺失 ⇒ 没经过勾选 */
  confirm?: { candidates: number; chosen: number }
  at: number
  /** 给人看的补充（失败原因、"崩溃后核对"等） */
  notes?: string[]
}

export interface ChapterWriteRecord {
  /** 操作 id = 预分配的 chapterId（一章一次，天然稳定） */
  id: string
  projectId: string
  chapterId: string
  volumeId: string
  plannedNo: number
  title: string
  /** 正文指纹（不存全文；用于人工核对"是不是这一稿"） */
  contentFingerprint: string
  chars: number
  taskId?: string
  /** 存储域（账号 + storage epoch）—— 换域后旧记录不该被当成这台的未完成写入 */
  storageKey: string
  at: number
  state: 'prepared' | 'committed' | 'abandoned'
  receipt?: ChapterWriteReceipt
  abandonedReason?: string
}

function keyOf(pid: string): string {
  return `${CHAPTER_WRITE_PREFIX}${pid}`
}

async function readAll(pid: string, store: StoreOps): Promise<ChapterWriteRecord[]> {
  if (!pid) return []
  try {
    const rec = await store.get<{ key: string; value?: ChapterWriteRecord[] }>('meta', keyOf(pid))
    const list = rec?.value
    if (!Array.isArray(list)) return []
    return list.filter(r => r && typeof r.id === 'string' && typeof r.chapterId === 'string')
  } catch {
    return []
  }
}

async function writeAll(pid: string, list: ChapterWriteRecord[], store: StoreOps): Promise<void> {
  await store.put('meta', { key: keyOf(pid), value: list.slice(0, CHAPTER_WRITE_LIMIT) })
}

/** 本期全部记录（新→旧） */
export async function loadChapterWrites(pid: string, store: StoreOps = ops): Promise<ChapterWriteRecord[]> {
  const list = await readAll(pid, store)
  return [...list].sort((a, b) => b.at - a.at)
}

/** 还没收尾的记录（崩溃/中断留下的） */
export async function loadPendingChapterWrites(pid: string, store: StoreOps = ops): Promise<ChapterWriteRecord[]> {
  return (await loadChapterWrites(pid, store)).filter(r => r.state === 'prepared')
}

export interface PrepareInput {
  projectId: string
  chapterId: string
  volumeId: string
  plannedNo: number
  title: string
  content: string
  taskId?: string
}

/**
 * 首次不可逆写入前保存「准备记录」。
 * 🔴 失败**抛错**：调用方必须停下这一章（不能在没有恢复凭据的情况下写正文）。
 */
export async function prepareChapterWrite(input: PrepareInput, store: StoreOps = ops): Promise<ChapterWriteRecord> {
  if (!input.projectId || !input.chapterId) throw new Error('准备记录缺少项目或章节 id')
  const rec: ChapterWriteRecord = {
    id: input.chapterId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    volumeId: input.volumeId,
    plannedNo: input.plannedNo,
    title: input.title,
    contentFingerprint: hashOf(input.content),
    chars: input.content.length,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    storageKey: storageWriteContext(),
    at: Date.now(),
    state: 'prepared',
  }
  const list = await readAll(input.projectId, store)
  // 同 id 覆盖（重试同一章时不该攒出两条）
  const next = [rec, ...list.filter(r => r.id !== rec.id)]
  await writeAll(input.projectId, next, store)
  return rec
}

/** 正文确认写入后，把分步回执一起落下来 */
export async function commitChapterWrite(
  pid: string, opId: string, receipt: ChapterWriteReceipt, store: StoreOps = ops,
): Promise<boolean> {
  const list = await readAll(pid, store)
  const idx = list.findIndex(r => r.id === opId)
  if (idx < 0) return false
  const next = list.slice()
  next[idx] = { ...list[idx], state: 'committed', receipt }
  await writeAll(pid, next, store)
  return true
}

/** 明确没写进去（或写失败）—— 留下原因，便于界面如实说明 */
export async function abandonChapterWrite(
  pid: string, opId: string, reason: string, store: StoreOps = ops,
): Promise<boolean> {
  const list = await readAll(pid, store)
  const idx = list.findIndex(r => r.id === opId)
  if (idx < 0) return false
  const next = list.slice()
  next[idx] = { ...list[idx], state: 'abandoned', abandonedReason: reason.slice(0, 200) }
  await writeAll(pid, next, store)
  return true
}

export interface RecoverResult {
  checked: number
  /** 核对到章节已在库：标 committed（**不重放**） */
  committed: number
  /** 章节不在库：标 abandoned（可让作者重试，重试会用同一 id） */
  abandoned: number
  /** 读库失败 / 存储域已变：保持 prepared，交给人工 */
  unresolved: number
  notes: string[]
}

/**
 * 崩溃后核对（幂等，可重复调用）。
 *
 * 🔴 判据只有一条：**预分配 chapterId 是否在库里**。
 *    不用章名、不用时间、不用"正文长得像"——那些都会在插章/改名后猜错。
 * 🔴 存储域变了（换账号/换后端）⇒ 不判、不清，保持 prepared 并留 note。
 */
export async function recoverChapterWrites(
  pid: string,
  exists: (chapterId: string) => Promise<boolean>,
  store: StoreOps = ops,
): Promise<RecoverResult> {
  const out: RecoverResult = { checked: 0, committed: 0, abandoned: 0, unresolved: 0, notes: [] }
  if (!pid) return out
  const list = await readAll(pid, store)
  const now = Date.now()
  const current = storageWriteContext()
  let changed = false
  const next = list.slice()
  for (let i = 0; i < next.length; i++) {
    const rec = next[i]
    if (rec.state !== 'prepared') continue
    out.checked++
    if (rec.storageKey !== current) {
      out.unresolved++
      out.notes.push(`${rec.title}：存储域已变化，无法核对，保留记录待人工处理`)
      continue
    }
    let found = false
    try {
      found = await exists(rec.chapterId)
    } catch (e) {
      out.unresolved++
      out.notes.push(`${rec.title}：核对失败（${e instanceof Error ? e.message : String(e)}），保留记录`)
      continue
    }
    if (found) {
      next[i] = {
        ...rec, state: 'committed',
        receipt: {
          chapter: 'committed', summary: 'skipped', settings: 'skipped', master: 'skipped',
          at: now, notes: ['崩溃后按预分配章节 id 核对到正文已在库（不再重放）'],
        },
      }
      out.committed++
      changed = true
    } else {
      next[i] = { ...rec, state: 'abandoned', abandonedReason: '崩溃/中断时正文未落库；可按同一章 id 重新生成' }
      out.abandoned++
      changed = true
    }
  }
  if (changed) await writeAll(pid, next, store)
  return out
}

/** 回执的人话（界面/日志共用；只在非全绿时提醒，避免每章多一行噪音） */
export function receiptIssues(receipt: ChapterWriteReceipt): string[] {
  const out: string[] = []
  if (receipt.chapter !== 'committed') out.push('正文未确认写入')
  if (receipt.summary === 'failed') out.push('摘要生成失败（已按空摘要保存）')
  if (receipt.summary === 'skipped') out.push('摘要因预算跳过')
  if (receipt.settings === 'partial') out.push('设定整理部分完成')
  if (receipt.settings === 'failed') out.push('设定整理未完成')
  if (receipt.master === 'failed') out.push('章节总表未同步')
  return out
}

/**
 * 章节视图用的分步状态（3.6.0 · E）。
 *
 * 只收**已提交但没全绿**的记录：正文确认在库、摘要或设定没做完 —— 那正是作者需要
 * 在章节列表里一眼看到「这章还欠整理」的情况。全绿的不标（列表上不该满屏绿点）。
 *
 * 🔴 读失败返回 `error` + 空表，**不伪装成"都正常"**：界面据此显示「状态读取失败」，
 *    而不是安静地什么都不显示（那样作者会以为一切已收尾）。
 */
export async function chapterWriteIssues(
  pid: string, store: StoreOps = ops,
): Promise<{ map: Map<string, string[]>; writtenCount: Map<string, number>; error?: string }> {
  const map = new Map<string, string[]>()
  /** 该章这一轮设定补登**实际写入**了几条（逐项落点在回执里，这里只给数） */
  const writtenCount = new Map<string, number>()
  if (!pid) return { map, writtenCount }
  try {
    const list = await loadChapterWrites(pid, store)
    /**
     * **每章只取最新一条已提交记录**。
     *
     * 记录 id 就是 chapterId（`prepareChapterWrite` 里同 id 覆盖），所以正常情况下每章只有一条；
     * 这里仍按 `receipt.at` 取最大，是为了防两种情形：老版本留下的重复记录、以及将来若改成
     * 「一次写入一条历史」时不至于把旧的不完美状态永久挂在章节上。
     * 🔴 不依赖数组顺序：同一毫秒内连续提交时顺序不可靠，比时间戳才确定。
     */
    const latest = new Map<string, ChapterWriteRecord>()
    for (const rec of list) {
      if (rec.state !== 'committed' || !rec.receipt) continue
      const stamp = rec.receipt.at || rec.at
      const prev = latest.get(rec.chapterId)
      if (!prev || stamp >= (prev.receipt?.at || prev.at)) latest.set(rec.chapterId, rec)
    }
    for (const [chapterId, rec] of latest) {
      const issues = rec.receipt ? receiptIssues(rec.receipt) : []
      if (issues.length) map.set(chapterId, issues)
      const n = rec.receipt?.settingsWritten?.length ?? 0
      if (n) writtenCount.set(chapterId, n)
    }
    return { map, writtenCount }
  } catch (e) {
    return { map, writtenCount, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 一句分步结果（规划要求 UI 明确"正文已保存 / 整理待恢复"，不宣传整章事务） */
export function describeReceipt(receipt: ChapterWriteReceipt): string {
  const issues = receiptIssues(receipt)
  return issues.length ? `正文已保存；${issues.join('；')}` : '正文、摘要、设定、总表均已确认'
}
