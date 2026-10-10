/**
 * 酒馆 · **自由对话的语义召回**（T2，2026-10-05）
 *
 * 【要解决的问题】自由对话是长会话玩法：聊得久了，早期消息会因为上下文预算被裁掉，
 *   Ta 就"忘了"前面说过的事。剧情模式早已有 `buildProjectContext` 里的语义召回兜着，
 *   自由模式**没有**（它全局、无 `focusChapterId`、不走项目上下文）。
 *
 * 【只接一条线，不重写检索】底层 `semantic/*` 全部复用：
 *   · 切块 / 嵌入 / 落库的唯一实现 ＝ `semantic/indexDoc.ts` 的 `indexOneDoc`；
 *   · 召回算法 ＝ `semantic/recall.ts` 的 `recallRelevant`；
 *   · 渲染 ＝ `semantic/inject.ts` 的 `renderRecallHits`。
 *   本文件只回答两件它答不了的事：**查询文本从哪来**、**索引挂在哪个分区**。
 *
 * 🔴🔴 **分区**：自由对话是**全局数据**（`db.getMeta`，不随项目走），而向量行按 `projectId` 分区。
 *   若拿当前项目 id 当分区，换本书就召回不到了（同一场对话的索引留在上一本的分区里）；
 *   故用一个**固定哨兵分区** `TAVERN_VEC_PROJECT`。副作用正好是想要的：
 *   删项目时的 `clearProjectVectors(pid)` 不会碰它（自由对话本就不该随项目被删）。
 *
 * 🔴 **只召回本场**：所有会话共用一个分区 ⇒ 必须用 `allowRefIds` 把范围收成 `[sessionId]`，
 *   否则会把别场戏的内容召回进来（仙侠角色读到赛博对话，跨世界观串味）。
 */

import { indexOneDoc, type IndexDoc } from '@/lib/semantic/indexDoc'
import { removeByRef } from '@/lib/semantic/store'
import { recallRelevant } from '@/lib/semantic/recall'
import { renderRecallHits } from '@/lib/semantic/inject'
import { resolveEmbedConfig } from '@/lib/semantic/settings'
import { isUsableMessage, keywordHaystackMessages } from '@/lib/tavern/world'
import { getTavernSettings } from '@/lib/tavern/settings'
import type { FreeSession, TavernMessage } from '@/lib/tavern/types'

/**
 * 自由对话的向量分区（哨兵值）。
 * ⚠️ 它**不是**项目 id，别拿 `db.getCurrentProjectId()` 去替 —— 见文件头说明。
 */
export const TAVERN_VEC_PROJECT = '__tavern__'

/** 查询文本取最近几条消息（与 `keywordHaystackMessages` 同一取材口径） */
const QUERY_TAKE = 8
/**
 * 少于这么多条消息就不建索引 —— 短对话整段都在窗口里，召回纯属白烧额度。
 * ⚠️ 与「距上次索引新增多少条才重建」是两回事，别合并成一个数。
 */
export const INDEX_MIN_MESSAGES = 12
/** 距上次索引**至少新增**这么多条消息才重建 —— 防「每说一句就嵌一次」 */
export const INDEX_MIN_NEW = 8
/** 最近多少条算「还在上下文里」——命中的块若落在这里就剔掉（召回它纯属重复占预算） */
const RECENT_IN_CONTEXT = 12

/** 每场会话最近一次索引的指纹（**内存即可**：重启后重算一次也无害，不落库） */
const lastIndexedCount = new Map<string, number>()

/** 仅供单测重置 */
export function __resetTavernIndexMemo(): void {
  lastIndexedCount.clear()
}

/**
 * 会话 → 可索引文本（**纯函数**）。
 * 🔴 只取会进上下文的消息（`isUsableMessage`）：作者**隐藏**的段落不该被索引 ——
 *   否则召回会把他刻意摘掉的内容又捞回来，等于隐藏无效。
 */
export function freeSessionIndexText(s: FreeSession): string {
  return (s.messages ?? [])
    .filter(isUsableMessage)
    // 🔴 长度过滤要作用在**正文**上，不是「用户：xxx」整串上 ——
    //    按整串判的话「用户：嗯」这种 4 字串会被当成"够长"，短语气词就混进索引了。
    .filter(m => (m.content ?? '').trim().length > 2)
    .map(m => `${m.role === 'user' ? '用户' : '角色'}：${m.content.trim()}`)
    .join('\n')
}

/** 查询文本：最近几条**会进上下文**的消息拼起来（拿不出就返回空串，调用方直接跳过） */
export function freeRecallQuery(messages: readonly TavernMessage[], take = QUERY_TAKE): string {
  return keywordHaystackMessages(messages, take).map(t => (t ?? '').trim()).filter(Boolean).join('\n')
}

/**
 * 「会话保存后自动更新本场索引」（**默认关**，与全书语义检索同一口径）。
 *
 * 🔴 **永不抛、不阻塞对话** —— 索引坏了绝不该让作者聊不下去（同 `autoIndexChapter` 的纪律）。
 * 🔴 **节流**：整场会话是一个来源（一块块重写），所以每次重建都会把整段重新嵌入一遍。
 *    没有节流的话，长会话每说一句就重嵌一次，代价是 O(n²)。两个数：
 *    `INDEX_MIN_MESSAGES`（太短不建）+ `INDEX_MIN_NEW`（新增不够不重建）。
 *
 * ⚠️ 与 `autoIndexChapter` 的守卫**故意不同**的一处：那边有「索引已建过才自动动手」
 *    （防误开开关白烧额度，前提是作者先点过「建立索引」）。
 *    自由模式**没有那个按钮**，若照搬这条守卫就永远不会建 —— 故改由上面两个阈值兜底。
 */
/** `autoIndexFreeSession` 的单测注入点（生产不传；与 `AutoIndexDeps` 同一范式） */
export interface AutoIndexFreeDeps {
  /** 读设置（默认走 `getTavernSettings`） */
  loadSettings?: (() => Promise<{ free?: { semanticRecall?: boolean } } | null>) | null
  resolveConfig?: typeof resolveEmbedConfig
  indexOne?: typeof indexOneDoc
  /** 清掉本场索引（回滚变少且不值得重建时用；默认走 `removeByRef`） */
  removeRef?: ((refId: string) => Promise<void>) | null
}

export async function autoIndexFreeSession(
  session: FreeSession | null | undefined,
  deps?: AutoIndexFreeDeps,
): Promise<void> {
  try {
    if (!session?.id) return
    const loadSettings = deps?.loadSettings ?? getTavernSettings
    const st = await loadSettings().catch(() => null)
    if (!st?.free?.semanticRecall) return

    const usable = (session.messages ?? []).filter(isUsableMessage)
    const prev = lastIndexedCount.get(session.id) ?? 0

    // 🔴 消息数**变少** = 作者回滚了检查点（F1）⇒ 索引必须跟着退。
    //    ⚠️ 这一条必须排在下面那条「太少就不建」**之前** —— 否则回滚到不足
    //    INDEX_MIN_MESSAGES 条时会直接 return，旧索引原封不动，召回继续把
    //    「已经退回去、不曾发生」的片段捞回来（比不召回更糟）。
    //    短到不值得重建 ⇒ 清掉旧索引，让本场不再有可召回内容。
    if (prev > 0 && usable.length < prev && usable.length < INDEX_MIN_MESSAGES) {
      await (deps?.removeRef ?? ((id: string) => removeByRef(TAVERN_VEC_PROJECT, id)))(session.id)
        .catch(() => undefined)
      lastIndexedCount.delete(session.id)
      return
    }

    if (usable.length < INDEX_MIN_MESSAGES) return

    // 没变少、且新增不够 ⇒ 跳过（省一次嵌入请求）
    if (prev > 0 && usable.length >= prev && usable.length - prev < INDEX_MIN_NEW) return

    const cfg = await (deps?.resolveConfig ?? resolveEmbedConfig)().catch(() => null)
    if (!cfg) return

    const text = freeSessionIndexText(session)
    if (!text) return

    const doc: IndexDoc = {
      kind: 'tavern',
      refId: session.id,
      title: (session.title || '').trim() || '对话',
      text,
      // 自由对话的消息没有保密等级（那是**设定表**的概念）⇒ 恒 false
      secret: false,
    }
    const r = await (deps?.indexOne ?? indexOneDoc)(doc, TAVERN_VEC_PROJECT, cfg)
    if (r.ok) lastIndexedCount.set(session.id, usable.length)
  } catch (e) {
    console.warn('[tavern] 自动更新本场索引失败（不影响对话）：', e)
  }
}

export interface FreeRecallOptions {
  session: FreeSession
  /** 最多注入几条，默认 5（比全书召回少：这一层是"补记性"，不该压过记忆层） */
  limit?: number
  signal?: AbortSignal
  /** 单测注入点（生产不传） */
  deps?: {
    resolveConfig?: typeof resolveEmbedConfig
    recall?: typeof recallRelevant
  }
}

/** 自由对话召回段的自述句（与全书召回那句区分开：这里是"本场早先说过的话"） */
const FREE_RECALL_HEADER =
  '（下面是从**本场早先的对话**里按语义捞出的片段 —— 它可能已经被预算裁掉，但确实发生过。用它保持前后一致，不要当作新发生的事。）'

/**
 * 构造〖相关对话召回〗段。**永不抛**、拿不到东西返回空串 —— 调用方只管"空就不 push"。
 *
 * 静默跳过的四种情况（都是常态，不是错误）：
 *   ① 没配嵌入模型；② 本场还没建过索引（或索引为空）；③ 查询文本拿不出（消息太少）；
 *   ④ 嵌入或检索失败。
 */
export async function buildFreeRecallBlock(opts: FreeRecallOptions): Promise<string> {
  try {
    const s = opts.session
    if (!s?.id) return ''

    const cfg = await (opts.deps?.resolveConfig ?? resolveEmbedConfig)().catch(() => null)
    if (!cfg) return ''

    const query = freeRecallQuery(s.messages)
    if (!query) return ''

    const hits = await (opts.deps?.recall ?? recallRelevant)(query, {
      projectId: TAVERN_VEC_PROJECT,
      cfg,
      // 只看自由对话这一类（同一分区里只有它，但写明意图更清楚）
      kinds: ['tavern'],
      topK: opts.limit ?? 5,
      // 角色视角：与剧情模式一致（S 级整条剔除；自由消息恒非 S，留着这道闸不影响行为）
      hideSecretRows: true,
      // 🔴 只召回本场 —— 所有会话共用一个分区，不设白名单会跨场串味
      allowRefIds: new Set([s.id]),
      signal: opts.signal,
    })
    if (hits.length === 0) return ''

    // 🔴 剔掉「召回回来了、但其实还在上下文里」的命中：最近这些条本来就在提示中，
    //    再塞一遍既占预算、又会让模型以为那是"另一次的对话"。
    const recent = freeRecallQuery(s.messages, RECENT_IN_CONTEXT)
    const fresh = hits.filter(h => {
      const head = (h.text ?? '').trim().slice(0, 60)
      return head.length > 0 && !recent.includes(head)
    })
    if (fresh.length === 0) return ''

    return renderRecallHits(fresh, FREE_RECALL_HEADER)
  } catch {
    return ''
  }
}
