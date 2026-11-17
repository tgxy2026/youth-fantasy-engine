/**
 * 创作参考 · 发送记录（3.6.0 · C 收尾）
 *
 * 依据：规划 §16 C ——「选择后展示**实际入上下文**的参考文字、用途、裁剪和模型接收方；
 * 作者撤销后下次请求不带入，已发出的请求无法撤回」。
 *
 * 🔴 为什么必须单独记录：发送前的预览只代表"打算发什么"。真正拼进提示词的是
 *    `buildReferenceBlock()` 的输出（可能有裁剪、可能因过期剔除），只有把它**在发送那一刻**
 *    存下来，作者才能核对"到底发了哪几句"。这也是"参考不自动注入"能被验证的唯一证据。
 *
 * 落点：`settingsKV` 的 `<projectId>::referenceSends`，滚动最近 50 条（随项目包与备份走）。
 * 🔴 只存**实际注入的那段文字**（≤ 约 2600 字）+ 元信息，不存原文、不存提示词全文。
 */
import { uid } from '@/lib/app/id'
import { getSettingFor, setSettingFor } from '@/lib/db/meta'

export const REFERENCE_LOG_KEY = 'referenceSends'
export const REFERENCE_LOG_LIMIT = 50

export type ReferenceSendStage = 'bible' | 'outline' | 'draft'

export interface ReferenceSendRecord {
  id: string
  at: number
  /** 用在哪一阶段（设定奠基 / 大纲规划 / 逐章正文） */
  stage: ReferenceSendStage
  /** 本次任务 id（若能拿到） */
  taskId?: string
  /** 实际用到的成果 id（按发送顺序） */
  usedIds: string[]
  /** 被剔除的卡与原因（过期 / 超预算 / 已不在） */
  dropped: { id: string; reason: string }[]
  /** 实际注入的文字（就是这一段） */
  text: string
  chars: number
  /** 这次请求走的通道（ACP / API）；拿不准就 unknown，不猜 */
  channel: 'acp' | 'api' | 'unknown'
}

function isRecord(v: unknown): v is ReferenceSendRecord {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.at === 'number'
    && typeof o.text === 'string' && Array.isArray(o.usedIds)
    && (o.stage === 'bible' || o.stage === 'outline' || o.stage === 'draft')
}

export interface LoadedReferenceSends {
  list: ReferenceSendRecord[]
  error?: string
}

export async function loadReferenceSends(projectId: string): Promise<LoadedReferenceSends> {
  if (!projectId) return { list: [] }
  try {
    const raw = await getSettingFor<unknown>(projectId, REFERENCE_LOG_KEY, null)
    if (raw === null || raw === undefined) return { list: [] }
    if (!Array.isArray(raw)) return { list: [], error: '发送记录的结构不合法（不是数组）' }
    return { list: raw.filter(isRecord).sort((a, b) => b.at - a.at) }
  } catch (e) {
    return { list: [], error: `发送记录读取失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 追加一条发送记录（读改写 + 滚动截断）。
 * 🔴 失败**不抛**：记录不该挡住写作；但也不静默 —— 返回 ok:false 由调用方决定是否提示。
 */
export async function appendReferenceSend(
  projectId: string, input: Omit<ReferenceSendRecord, 'id' | 'at'> & { at?: number },
): Promise<{ ok: boolean; reason?: string }> {
  if (!projectId) return { ok: false, reason: '没有项目上下文' }
  if (!input.text.trim()) return { ok: false, reason: '没有实际发送内容' }
  try {
    const cur = await loadReferenceSends(projectId)
    const rec: ReferenceSendRecord = {
      id: uid(),
      at: input.at ?? Date.now(),
      stage: input.stage,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      usedIds: [...input.usedIds],
      dropped: input.dropped.map(d => ({ id: d.id, reason: d.reason })),
      // 兜底截断：单条记录不该超过一次注入的量级（正常 ≤ 2600 字）
      text: input.text.slice(0, 2600),
      chars: input.chars,
      channel: input.channel,
    }
    const next = [rec, ...cur.list].slice(0, REFERENCE_LOG_LIMIT)
    await setSettingFor(projectId, REFERENCE_LOG_KEY, next)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `发送记录写入失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 阶段人话（界面用） */
export const REFERENCE_STAGE_LABEL: Record<ReferenceSendStage, string> = {
  bible: '设定奠基',
  outline: '大纲规划',
  draft: '逐章正文',
}

/** 「已发出无法撤回」的固定说明（界面上必须出现一次） */
export const REFERENCE_SENT_NOTE = '已发出的请求无法撤回 —— 取消勾选只影响后续请求'
