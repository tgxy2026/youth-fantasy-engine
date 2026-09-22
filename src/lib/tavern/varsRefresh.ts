/**
 * 酒馆模式 · 本场数值的「每轮刷新」（2026-09-16 老大反馈 #4）
 *
 * 【它解决什么】旧设计里数值只在「结束本轮对话」时算一次 —— 作者聊了一整场，
 * 那五项状态始终停在初始值，直到点结束才突然跳一下，完全体会不到「随对话起伏」。
 * 现在每轮 AI 回复**落库前**跑一次这里，把这一轮真发生的变化算出来写回会话。
 *
 * 【为什么单开一次小调用，而不是让主回复顺手写一行〔数值〕】
 *   主回复要跟 3.5KB 的格式协议抢注意力 —— 实测遵守率极低（真模型探针 6/6 轮不吐，
 *   三次跑分别 1/6、0/6、0/6）。单开一次「只干这一件事」的调用，模型反而做得干净。
 *   代价是每轮多一次模型往返（本地 27B 上延迟明显），老大已知情并拍板（D3）。
 *
 * 【为什么单独一个文件，而不是塞进 engine.ts】
 *   engine 的定位是「跑一轮对话，不落库、不做总结」（见其头注释）；
 *   而 `summarize.ts` 反过来还要用 engine 的 `resolveTavernProvider` ——
 *   把抽取调用塞进 engine 会造出一个 engine ↔ summarize 的**循环依赖**。
 *   放这儿只有单向依赖（→ summarize / vars），谁都不需要反过来 import 它。
 *
 * 🔴 失败一律静默（返回原会话）：数值是锦上添花，绝不能让它的失败把这一轮对话弄没。
 */
import { extractSessionVars } from './summarize'
import { varsOf, recordVarChanges, turnSeqOf, manualPinnedKeys } from './vars'
import type { ChatFn } from './provider'
import type { FreeSession, TavernMessage, VarKey, CharVars } from './types'

export type RefreshVarsArgs = {
  /** 已经带上这一轮新回复的会话（通常在 `runFreeTurn` 返回之后） */
  session: FreeSession
  /** 启用中的数值键（空 = 整块没开，原样返回，一次调用都不发） */
  keys: VarKey[]
  maxStep: number
  nameOf: (id?: string) => string
  /** 抽取用的模型（一般传控制面板的「总结模型」）；不传 = 全局活动模型 */
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
  /** 参与判断的消息（默认取会话最后两条：本轮的用户输入与 AI 回复） */
  messages?: TavernMessage[]
  /**
   * 主角色（charIds[0]）卡上**当前**的持久状态。
   * ① 把它里面的 `notes` 喂给抽取调用当上下文；② 算完之后把新值＋新备注**回写**到这张卡
   *    （见 `persistCharVars`）—— 这是反馈 #4「状态存角色卡、跨会话累积」的落点。
   */
  primaryCharId?: string
  charVars?: CharVars
  /** 把主角色卡的新状态落库（调用方传入，避免这里直接 import store 成环） */
  persistCharVars?: (charId: string, vars: CharVars) => Promise<void> | void
}

/**
 * 算这一轮的数值变化并写回会话。
 *
 * @returns 新的会话（数值已更新）；**没变化 / 没启用 / 算不出来时原样返回原对象** ——
 *          调用方可以据此判断要不要多写一次库（本函数不落库，与 engine 同规矩）。
 */
export async function refreshSessionVars(a: RefreshVarsArgs): Promise<FreeSession> {
  const { session, keys, maxStep, nameOf, providerId, chatFn, signal } = a
  if (keys.length === 0) return session

  /*
   * 只喂**这一轮**（默认最后两条：本轮的用户输入 + 刚生成的那条回复）。
   * 为什么不喂整段历史：① 每轮重算全史纯属浪费；② 同一件事会在后续每一轮被反复记一次，
   * 数值会自己漂走。要紧的是「这一轮里关系/状态动了没有」。
   */
  const tail = (a.messages ?? session.messages).slice(-2)
  if (tail.length === 0) return session

  try {
    const base = varsOf(session, keys)
    const ex = await extractSessionVars({
      keys,
      values: base.values,
      messages: tail,
      nameOf,
      maxStep,
      // 作者手改过的项只收增量：否则模型一句「好感 80」就把作者刚设的值盖掉（审计 P2）
      pinned: manualPinnedKeys(base),
      // 主角色卡当前备注 → 当上下文（反馈 #4：备注是「这个分背后是什么」的旁白）
      notes: a.charVars?.notes,
      // 剧本写的「这一场的目标」——少了它，模型只能凭对话猜该往哪个方向推进
      goal: session.script?.goal,
      providerId,
      chatFn,
      signal,
    })
    if (ex.changes.length === 0) return session
    const nextSession = {
      ...session,
      vars: recordVarChanges({ ...base, values: ex.values }, ex.changes, turnSeqOf(session.messages)),
    }
    // 回写主角色卡（持久、跨会话累积）；备注只在「这一轮变了的项」上更新，没变的沿用旧备注
    if (a.persistCharVars && a.primaryCharId) {
      const cardVars: CharVars = {
        values: ex.values as CharVars['values'],
        notes: { ...(a.charVars?.notes ?? {}), ...(ex.notes ?? {}) },
      }
      await a.persistCharVars(a.primaryCharId, cardVars)
    }
    return nextSession
  } catch (e) {
    // 🔴 2026-09-22 六维审计：**保持「不打断对话」这条设计**（数值是锦上添花，绝不能让它的失败把这一轮弄没），
    //    但补一行留痕 —— 原来完全静默，数值一直不动时无从判断是「这几轮真没变化」还是「每轮都在失败」。
    //    刻意只用 console.warn 不弹 toast：它每轮都跑，弹窗会盖住正在进行的对话。
    //    （同类写法见 `useTavernCardModel.ts` 的角色卡导入失败明细。）
    console.warn('[tavern] 本场数值刷新失败（已跳过，不影响本轮对话）：', e)
    return session
  }
}
