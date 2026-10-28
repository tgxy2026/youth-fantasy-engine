/**
 * 批量重生成章节摘要 —— **逐章计账**的执行体（UX09 · 生成部分失败不再静默）。
 *
 * 【为什么单独成模块】
 *   ① 编辑器模型文件已贴 1200 行红线，这段编排本来就自成一体；
 *   ② 「部分失败怎么算」是纯记账，抽出来才能单测 —— 原实现 `catch {}` 直接跳过，
 *      结果只报 `{done,total}`，完成提示却说「全书…完成（共 total 章）」
 *      ⇒ **失败的书被说成成功**，作者不看章节总表根本发现不了。
 *
 * 【口径（与拆书批次一致）】
 *   · `succeeded` ＝ 摘要**确实写进了章节**（即便随后总表同步失败）；
 *   · `failed`     ＝ 逐条说明：模型没给摘要 / 写章节失败 / 总表没同步，三种都记，不合并；
 *   · 作者主动中止不算失败（那是他自己按的），中止后不再处理剩余章节；
 *   · 失败原因只留**一句**（截断 120 字），绝不把正文塞进提示。
 */
import type { Chapter } from '@/lib/types'

export interface RegenFailure {
  id: string
  title: string
  /** 一句人话原因（已截断，不含正文） */
  reason: string
  /** 摘要是否已写进章节：false ＝ 这一章还是旧摘要；true ＝ 只有总表没同步 */
  summarySaved: boolean
}

export interface RegenOutcome {
  /** 有正文、被纳入本批的章节数 */
  total: number
  /** 真正处理过的章节数（含失败；中止后不再增长） */
  attempted: number
  /** 摘要确实写入成功的章节数 */
  succeeded: number
  failed: RegenFailure[]
  aborted: boolean
}

export interface RegenDeps {
  signal: AbortSignal
  isAborted: () => boolean
  /** 生成摘要（可中止） */
  summarize: (text: string, opts: { signal: AbortSignal }) => Promise<string>
  /** 写入章节摘要（整章写回，沿用既有 saveChapterWithAi） */
  save: (chapter: Chapter) => Promise<void>
  /** 同步章节总表的一句话事件 */
  syncMaster: (chapter: Chapter) => Promise<void>
  /** 每处理完一章回调一次（进度用） */
  onProgress?: (attempted: number, total: number) => void
  /** 每 N 章回调一次（批量提示用，缺省 8） */
  onBatch?: (attempted: number, total: number) => void
  batchEvery?: number
}

const REASON_MAX = 120

/** 把任意抛值压成一句可读原因（截断、去换行、不带正文） */
export function regenFailureReason(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : String(error ?? '')
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  if (!oneLine) return '未知原因'
  return oneLine.length > REASON_MAX ? oneLine.slice(0, REASON_MAX) + '…' : oneLine
}

/** 有正文才纳入本批（空章没有可压缩的内容，跳过不算失败） */
export function regenTargets(chapters: readonly Chapter[]): Chapter[] {
  return chapters.filter(chapter => (chapter.content ?? '').trim().length > 0)
}

export async function runRegenSummaries(chapters: readonly Chapter[], deps: RegenDeps): Promise<RegenOutcome> {
  const targets = regenTargets(chapters)
  const total = targets.length
  const failed: RegenFailure[] = []
  const every = deps.batchEvery && deps.batchEvery > 0 ? deps.batchEvery : 8
  let attempted = 0
  let succeeded = 0
  let aborted = false

  for (const chapter of targets) {
    if (deps.isAborted()) { aborted = true; break }
    attempted += 1
    try {
      const summary = (await deps.summarize(chapter.content ?? '', { signal: deps.signal })).trim()
      if (!summary) {
        // 模型正常返回但内容为空：这不算成功（旧实现会写一条空摘要并记「已完成」）
        failed.push({ id: chapter.id, title: chapter.title, reason: '模型没有返回摘要内容', summarySaved: false })
      } else {
        const next: Chapter = { ...chapter, summary }
        try {
          await deps.save(next)
          succeeded += 1
          try {
            await deps.syncMaster(next)
          } catch (error) {
            // 摘要已经落库了，只是总表那句「一句话事件」没跟上 —— 单独记，别让作者以为摘要没变
            failed.push({ id: chapter.id, title: chapter.title, reason: '摘要已更新，但章节总表未同步：' + regenFailureReason(error), summarySaved: true })
          }
        } catch (error) {
          failed.push({ id: chapter.id, title: chapter.title, reason: '摘要写入章节失败：' + regenFailureReason(error), summarySaved: false })
        }
      }
    } catch (error) {
      if (deps.isAborted()) { aborted = true; break }
      failed.push({ id: chapter.id, title: chapter.title, reason: '生成失败：' + regenFailureReason(error), summarySaved: false })
    }
    deps.onProgress?.(attempted, total)
    if (deps.onBatch && attempted % every === 0) deps.onBatch(attempted, total)
  }

  return { total, attempted, succeeded, failed, aborted }
}

/**
 * 完成提示的**唯一口径**：有失败就绝不写「全部完成」。
 * 返回 `kind` 沿用拆书批次的约定（全绿 success，有失败降级 info，绝不谎报 error/成功二选一）。
 */
export function regenSummaryText(outcome: RegenOutcome): { text: string; kind: 'success' | 'info' } {
  const { total, succeeded, failed, aborted } = outcome
  if (aborted) {
    return {
      text: `批量重生成已中止 —— 已更新 ${succeeded}/${total} 章${failed.length ? `，${failed.length} 章有问题` : ''}；未处理的章节保持原摘要`,
      kind: 'info',
    }
  }
  if (!failed.length) return { text: `全书摘要重生成完成（共 ${succeeded} 章）`, kind: 'success' }
  const missing = failed.filter(item => !item.summarySaved).length
  const unsynced = failed.length - missing
  const parts = [
    missing ? `${missing} 章没生成成功（仍是旧摘要）` : '',
    unsynced ? `${unsynced} 章摘要已更新但总表未同步` : '',
  ].filter(Boolean)
  return { text: `摘要重生成结束：${succeeded}/${total} 章已更新，${parts.join('，')}；详情见正文页提示`, kind: 'info' }
}
