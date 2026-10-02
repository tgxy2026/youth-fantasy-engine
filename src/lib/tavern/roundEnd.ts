/**
 * 酒馆模式 · 「结束本轮对话」编排（老大 2026-09-16 定，反馈 #3 的落脚点）
 *
 * 【为什么把实时整理换成收尾触发】
 * 原做法：每累计若干条未整理的消息，就在**下一轮发言后**静默跑一次总结。
 * 本地 27B 跑一次要几十秒，全压在那轮对话之后 —— 表现就是「说完一句卡半天」，
 * 且聊得越久触发越密（反馈 #3 原话：需要兼顾记忆整理的效率和实时对话的体验）。
 *
 * 现做法：**聊天过程中一次都不整理**，由作者点「结束本轮对话」一次性收尾：
 *   ① 逐位角色整理记忆，顺带产出**本场日记**（第一人称，写进日记库，不进上下文）
 *   ② 算一遍本场数值
 *   ③ 审查设定要不要改（只列建议，不自动改卡）
 *   ④ 会话标记 endedAt → 归档只读
 *
 * 【为什么不拆成三个按钮让人自己点】收尾是一次性的、有先后（先记 → 再算数值 →
 * 最后拿这些结果审查设定）。拆开只会让人漏点某一项，得到一个「记得不全」的角色。
 *
 * 本文件只做编排；单次能力在 summarize.ts / revise.ts，落库在 store.ts。
 *
 * 【事务边界：①②③ 全跑完才落「会话之外」的持久状态】
 *   ① 记忆 + 日记：段内「全算完才写」，任一角色失败 ⇒ 一条不落、直接抛（界面按「整场失败」处理）。
 *   ② 本场数值 + ②b 回写主角色卡：②b 只**算**，真正的 `saveFreeChar` 推迟到 ③ 之后（见函数末尾「事务提交点」）。
 *   ③ 设定审查：只产建议，不落卡。
 *   🔴 ②b 延后落卡的原因：主角色卡 vars 是**跨会话持久累积**的。若在 ② 就写、而 ③ 被作者中止，
 *      卡片已被改但会话没归档 → 重试时 ② 拿同一段对话再抽一次、备注再叠一层 ⇒ **数值重复累加**（不可逆）。
 *      延后之后，①②③ 任一中止 ⇒ 一条不落 ⇒ 重试从零重算，干净。
 */
import * as store from './store'
import { messagesAfterWatermark } from './memory'
import { summarizeRound, summarizeMemory, extractSessionVars } from './summarize'
import { proposeCardRevisions, type CardRevision } from './revise'
import { recordVarChanges, turnSeqOf, emptyVars, manualPinnedKeys } from './vars'
import type { SummaryLimits } from './summarize'
import { renderFreeCharacter } from './engine'
// isCancelled 从 '../ai' 取（与 revise.ts 同源）：它不是「酒馆专属」概念，别从 ./provider 绕
import { isCancelled } from '../ai'
import type { ChatFn } from './provider'
import type {
  FreeSession, FreeCharacter, FreeMemory, TavernMessage,
  TavernVars, VarChange, CharJournalEntry, VarKey, CharVars,
} from './types'

/** 收尾经历的阶段（界面据此显示进度） */
export type RoundEndStage = 'memory' | 'vars' | 'revise' | 'done'

export type RoundEndProgress = {
  stage: RoundEndStage
  /** 正在处理第几位角色（1 起） */
  cur: number
  total: number
  /** 当前角色名 */
  name?: string
}

export type RoundEndResult = {
  memories: FreeMemory[]
  /** 本场日记，key = charId（第一人称回顾，写进日记库，**不注入 AI**） */
  journals: Record<string, string>
  /** 算完的本场数值（失败时回传原值） */
  vars?: TavernVars
  varChanges: VarChange[]
  /** 设定变更建议 —— 只产出，由作者在弹窗里逐条裁决 */
  proposals: CardRevision[]
  /**
   * 收尾过程中的**未成功项**：②本场数值 / ③设定审查失败，或某位角色的记忆被判退化而回退。
   * 🔴 界面必须显示出来（2026-09-19 六维审计 P0-1）：原先这些失败被静默吞掉，界面照样报
   *    「本轮已结束 —— N 位角色的记忆已更新」，作者以为收尾是完整的。
   */
  warnings: string[]
  /**
   * 是否**有任何一位角色**的记忆被判「整份退化」而回退了旧档案。
   * 🔴 有它时调用方**不许推进水位线**（2026-09-23 六维审计 P1）：退化意味着这段对话没被总结，
   *    推进水位等于把它永久越过 —— 下次 `messagesAfterWatermark` 拿到空数组，那一段再也不进记忆。
   *    刻意与 `warnings` 分开：warnings 是给人看的文案，措辞随时会改，不能拿来当判据。
   */
  memoryDegraded: boolean
  endedAt: number
}

export type RoundEndArgs = {
  session: FreeSession
  /** 参演角色（含用户扮演的 —— 他的记忆同样要记，只是界面不显他） */
  cards: FreeCharacter[]
  /** 单独指定的整理模型；不传则回退全局活动模型 */
  providerId?: string
  /** 字数约束（控制面板）—— 必须含 hardLimit，否则面板调的「记忆硬上限」永不生效（审计 P1-1） */
  limits?: SummaryLimits
  /** 本场数值的启用键 */
  varKeys: VarKey[]
  /** 当前变量块（算差值的起点） */
  vars: TavernVars | undefined
  /** 单次数值变化幅度上限 */
  maxStep: number
  /** 说话人名字 */
  nameOf: (id?: string) => string
  /** 主角色（session.charIds[0]）id —— 本场数值算完回写它的卡（反馈 #4：状态存卡、跨会话累积） */
  primaryCharId?: string
  /**
   * 注入模型调用（只有测试用）。
   * 三个子步骤（记忆/数值/设定审查）都会拿它替换真实 `chat` —— 不注入的话这条编排链
   * 必须真起一个 provider 才能跑，等于没法测。
   */
  chatFn?: ChatFn
  onProgress?: (p: RoundEndProgress) => void
  signal?: AbortSignal
}

/** 待整理的对话：水位线之后的全部（半途崩过也不会重复整理同一段） */
export function pendingMessages(session: FreeSession): TavernMessage[] {
  return messagesAfterWatermark(session.messages, session.watermark)
}

/**
 * 跑一次完整收尾。
 *
 * 🔴 唯一的硬失败点是①：记忆整理不出来这场就白聊了，直接抛给界面。
 *    ②③ 失败一律吞掉并留空 —— 面板少一块，也不能把已经落库的记忆弄丢。
 */
export async function runRoundEnd(args: RoundEndArgs): Promise<RoundEndResult> {
  const { session, cards, providerId, limits, varKeys, maxStep, nameOf, chatFn, onProgress, signal } = args
  const pending = pendingMessages(session)
  const total = Math.max(cards.length, 1)

  // ---- ① 记忆 + 本场日记（逐位角色，一次调用两样产出） ----
  //
  // 🔴 **先全部算完，再统一落库**（审计 P0-5）。
  //    旧实现是「算一位写一位」：多角色里整理到第 3 位失败时，前 2 位的记忆与日记**已经进库**，
  //    而水位线与 endedAt 要等整个流程返回才写 —— 于是会话既不归档、水位线也不推进，
  //    作者看到的是「整理失败了」，实际库里已经躺了半截记忆，再点一次「结束」还会得到**重复日记**。
  //    改成「全成或全不成」：① 任何一位失败 → 一条都不落库、直接抛给界面（水位线不动，下次重算）。
  //    配合 `store.appendJournalEntry` 的「同一场只留一条」幂等，重复点「结束」也不会写两遍。
  /**
   * 用户扮演的那位（`session.userCharId`）——**记忆照记，日记不写**（老大 2026-09-16 反馈 #8）。
   *
   * 【为什么砍掉他那一份】日记是「事后一个人回想这一场」的第一人称回顾，而 AI 演的是**别人** ——
   *   让它替「用户扮演的角色」写回顾，写出来必然是视角错乱的（它根本不知道那个人当时心里怎么想）。
   *   老大原话：这块 AI 写不好，干脆只写自己演的那个，用户侧日记直接放弃。
   *
   * 【为什么改走 `summarizeMemory` 而不是"照写再丢掉"】收尾的设计是一次调用产两样（六栏 + 日记）。
   *   若仍走 `summarizeRound`，那 200–600 字的日记会被**真的生成出来再扔掉** ——
   *   本地 27B 上那是实打实的一分多钟白等。走「只出六栏」的通路：记忆一样记，这段时间省掉。
   *   ⚠️ 只对**用户扮演的那一位**生效；AI 扮演的角色照旧写日记（`computed[].journal` 用得上）。
   */
  const warnings: string[] = []
  /** 与 warnings 分开记（见 RoundEndResult.memoryDegraded 的说明） */
  let memoryDegraded = false
  // 🔴🔴 2026-09-22 六维审计 P0：**必须定长**，不能 push ——
  //    下面读记忆失败会 `continue`，push 版会让数组比 `cards` 短，而落库循环按 `cards[i]`
  //    取 `computed[i]` ⇒ **把一个角色的记忆写进另一个角色的档案**（不可逆），末位还越界抛错。
  //    定长赋值（`computed[i] = ...`）后两数组永远等长；`undefined` 项在落库时被跳过。
  const computed: ({ memory: FreeMemory; journal: string } | undefined)[] =
    new Array(cards.length).fill(undefined)
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    onProgress?.({ stage: 'memory', cur: i + 1, total, name: c.name || '未命名角色' })
    // 🔴 读失败**必须**与「还没有记忆」区分（2026-09-20 六维审计 P2）：
    //    `getMemory` 对"没有记忆"返回的是**空记忆对象**（内部 `db.getMeta(key, emptyMemory(...))`），
    //    所以能走到 catch 的只可能是真正的存储读失败。旧写法把失败降级成 null 继续 ——
    //    null 会让下游的 `isMemoryDegraded` 失去比较基准 ⇒ 模型这次输出残缺也会被当正常结果落库
    //    （= 把角色记忆洗成一小段，且不可逆）。宁可不更新这张卡的记忆。
    let prev: FreeMemory | null = null
    try {
      prev = await store.getMemory(c.id)
    } catch {
      // 🔴 2.4.4 六维审计 P1：读失败跳过 ⇒ 本轮记忆结果**不完整**，与「整份退化」同构 ——
      //    必须置 memoryDegraded，否则水位线照常推进、这段对话被永久越过（不可逆失忆）。
      memoryDegraded = true
      warnings.push(`${c.name || '一位角色'}：读取现有记忆失败，本次跳过记忆更新（避免用残缺结果覆盖）`)
      continue
    }
    const shared = {
      charId: c.id,
      charName: c.name,
      prev,
      messages: pending,
      // 带角色背景：不给的话模型会凭对话臆断「Ta 在哪、是谁」，记忆从第一次就开始漂移
      // （实测把「便利店」总结成「咖啡店」）。🔴 用四章全文，理由同冷启动补算。
      charContext: [
        renderFreeCharacter(c),
        c.id === session.userCharId
          ? '（这位角色由**用户自己**扮演：Ta 说的话与做的事是既成事实，直接记进 Ta 的视角；不要写成「某某告诉我」。）'
          : '',
      ].filter(Boolean).join('\n\n'),
      providerId: providerId || undefined,
      limits,
      chatFn,
      signal,
      // 记忆被判「整份退化」时如实上报（档案已回退旧值，见 memory.ts 的 isMemoryDegraded）
      onDegraded: (reason: string) => {
        memoryDegraded = true
        warnings.push(`${c.name || '一位角色'}的记忆：${reason}`)
      },
    }
    const got = c.id === session.userCharId
      ? { memory: await summarizeMemory(shared), journal: '' }
      : await summarizeRound(shared)
    computed[i] = { memory: got.memory, journal: got.journal.trim() }
  }

  // ① 算完先只收集，**不落库** —— 落库推迟到 ③ 之后的统一提交点（见文件头「事务边界」）。
  // 🔴 2026-10-02 六维审计 P0：`store.saveMemory` 的键是 `tavern.free.mem.<charId>`，
  //    **不带 sessionId，是跨会话的全局键** —— 记忆与 ②b 的角色卡一样属于「会话之外的持久状态」。
  //    早先版本在①段末尾就写，③ 中止时会留下「记忆已并入本场、水位线却没推」的状态：
  //    作者重试 ⇒ ① 拿到与上次完全相同的那批消息、而 prev 已是含这批事件的档案
  //    ⇒ 同一段剧情被并进档案**第二次**（日记有 sessionId 幂等兜着，记忆没有 ⇒ 不可逆）。
  const memories: FreeMemory[] = []
  const journals: Record<string, string> = {}
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    const got = computed[i]
    // 读记忆失败的那位：本轮跳过（已计入 warnings），不写、也不记进 memories
    if (!got) continue
    memories.push(got.memory)
    if (got.journal) {
      journals[c.id] = got.journal
    }
  }

  // ---- ② 本场数值 ----
  //
  // 🔴 会话没有 vars 也要算（审计 P1-2）：新会话从不初始化 vars，旧条件里的 `&& args.vars`
  //    让这一步**整段跳过** —— 表现是「本场数值永远是空的，得先手改一次才活」。
  //    这里用 `emptyVars(varKeys)` 兜底，第一场收尾就能把初始值 + 变化写进会话。
  let nextVars = args.vars
  let varChanges: VarChange[] = []
  /**
   * ②b 算出的「待回写主角色卡」载荷 —— **延到 ③ 跑完才落库**。
   * 🔴 2026-10-02 六维审计待办：原先在 ② 阶段就 `saveFreeChar`，而 ③ 设定审查可被中止
   *    （`isCancelled` 向上抛）⇒ 卡片已被改、但会话没归档（endedAt 未写、水位线未推）。
   *    作者重试时 ② 会拿同一段对话再抽一次，备注一层层叠加 ⇒ **数值重复累加**。
   */
  let pendingCardWrite: FreeCharacter | null = null
  // 主角色卡（回写落点）；拿它的当前备注当抽取上下文，并作为回写时的备注基底
  const primary = args.primaryCharId ? cards.find(c => c.id === args.primaryCharId) : undefined
  const primaryNotes = primary?.vars?.notes
  if (varKeys.length > 0 && pending.length > 0) {
    onProgress?.({ stage: 'vars', cur: total, total })
    const base = args.vars ?? emptyVars(varKeys)
    try {
      const ex = await extractSessionVars({
        keys: varKeys,
        values: base.values,
        messages: pending,
        nameOf,
        maxStep,
        // 作者手改过的项只收增量（审计 P2）：否则模型一句「好感 80」就把作者的 20 盖掉了
        pinned: manualPinnedKeys(base),
        // 主角色卡当前备注 → 当上下文（反馈 #4）
        notes: primaryNotes,
        // 剧本写的「这一场的目标」—— 少了它，模型只能凭对话猜该往哪个方向推进（审计 P1-7）
        goal: session.script?.goal,
        providerId: providerId || undefined,
        chatFn,
        signal,
      })
      // 有变化：记 log；没变化：也把初始值落下来，否则面板一直显示「未记录」
      nextVars = ex.changes.length > 0
        ? recordVarChanges({ ...base, values: ex.values }, ex.changes, turnSeqOf(session.messages))
        : base
      varChanges = ex.changes
      // ②b 算出「要回写到主角色卡的那一份」，但**此处不落库**（见文件头「事务边界」说明）。
      //    落卡推迟到 ③ 也跑完之后的统一落库点。
      if (primary && ex.changes.length > 0) {
        pendingCardWrite = {
          ...primary,
          vars: {
            values: ex.values as CharVars['values'],
            notes: { ...(primaryNotes ?? {}), ...(ex.notes ?? {}) },
          },
        }
      }
    } catch (e) {
      // 🔴 中止必须**向上抛**（2026-09-23 六维审计）：原先与「算不出来」合并处理 ⇒ runRoundEnd
      //    照常返回、调用方照常推进水位线并打上 endedAt，会话被归档只读，而作者以为自己已经停下了。
      //    这与界面承诺的「中止时没有写入任何内容」直接冲突（见 useFreeRoundEnd 的 catch）。
      if (isCancelled(e)) throw e
      // 数值算不出来，这一场照样归档 —— 但**必须如实说**（2026-09-19 六维审计 P0-1）
      varChanges = []
      warnings.push('本场数值未算出：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // ---- ③ 设定审查（只产建议，不落卡） ----
  let proposals: CardRevision[] = []
  if (session.messages.length > 0) {
    onProgress?.({ stage: 'revise', cur: total, total })
    try {
      const out: CardRevision[] = []
      for (const c of cards) {
        // 说话人名字：多角色同场时，「谁对谁说了什么」是判断的关键一半
        const rows = await proposeCardRevisions({
          char: c,
          messages: session.messages,
          providerId: providerId || undefined,
          chatFn,
          speakerName: m => cards.find(x => x.id === m.speakerId)?.name ?? '角色',
        })
        out.push(...rows)
      }
      proposals = out
    } catch (e) {
      if (isCancelled(e)) throw e // 同上：中止不吞，交给调用方按「中止」处理
      proposals = []
      warnings.push('设定审查未完成：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // ---- 事务提交点：①②③ 全部跑完，现在才把三笔持久写入真正落库 ----
  //
  // 🔴 为什么必须等到这里（2026-10-02 六维审计）：
  //    ① 的记忆（`tavern.free.mem.<charId>`）、① 的日记（`tavern.free.journal.<charId>`）、
  //    ②b 的主角色卡 vars —— **三者都是跨会话持久累积的**。若在 ①② 阶段就写，
  //    而 ③ 设定审查被作者中止（`isCancelled` 向上抛）⇒ 这些全局键已被并入本场内容，
  //    但会话没归档（endedAt 未写、水位线未推进）。作者重试「结束本轮对话」时，
  //    ① 拿到的是**与上次完全相同的那批消息**、而 prev 已是含这批事件的档案
  //    ⇒ 同一段剧情被并进档案**第二次**（记忆无幂等机制，直接落库、不可逆）。
  //    现在 ①②③ 任一中止 ⇒ 一条都不落 ⇒ 重试从零重算，干净。
  for (const m of memories) await store.saveMemory(m)
  for (const c of cards) {
    const j = journals[c.id]
    if (j) await store.appendJournalEntry(c.id, journalEntry(session, cards, j))
  }
  if (pendingCardWrite) await store.saveFreeChar(pendingCardWrite)

  onProgress?.({ stage: 'done', cur: total, total })
  return { memories, journals, vars: nextVars, varChanges, proposals, warnings, memoryDegraded, endedAt: Date.now() }
}

/** 组装一条日记：记的是「这一场发生了什么」，供作者回头翻，不进任何提示词 */
function journalEntry(session: FreeSession, cards: FreeCharacter[], text: string): CharJournalEntry {
  return {
    id: `jr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    sessionId: session.id,
    sessionTitle: session.title,
    // 在场的人：会话里没名字的角色（例如会话已删卡）就跳过，不留一串 id
    cast: session.charIds
      .map(id => cards.find(c => c.id === id)?.name)
      .filter((n): n is string => !!n),
    text,
  }
}
