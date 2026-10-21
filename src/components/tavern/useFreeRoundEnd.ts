/**
 * 自由对话（酒馆模式）的**收尾**（从 `useTavernFreeModel.tsx` 拆出来的，2026-09-19）。
 *
 * 定位：作者点「结束本轮对话」之后跑的那一整套一次性任务 —— 逐角色总结记忆 + 写本场日记
 *   + 结算本场数值 + 审查要不要改设定，跑完把会话归档为只读。
 *
 * 🔴 搬动时逐条保住的红线：
 *   · **收尾可中止**（六维审计 P2-7）：`runRoundEnd` 全程下传 `signal`，中止 ≠ 失败
 *     （判据 = `isCancelled`），中止时**一条都不落库**、水位线也不推进；
 *   · **取锁必须在 try 之外**（审计 P1-3）：`finally` 里无条件 release，取锁失败说明锁在
 *     别人手里，那时候 release 会删掉别人的锁，防并发形同虚设；
 *   · 有步骤没成必须**如实说**（审计 P0-1）：记忆 / 数值 / 设定审查失败原先被静默吞掉，
 *     界面照样只报「本轮已结束」，作者以为收尾是完整的 → `warnings[]` 原样显示；
 *   · 卸载本地模型排在**最后**（#11）：到那一步已无任何模型调用，中途卸会让后续收尾
 *     先等一次重新加载；卸载失败只提示，**绝不**把这一轮收尾判成失败；
 *   · 设定建议默认**一条都不勾**（审计 P2）：会动角色卡的根本，必须逐条裁决。
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react'

import { showToast, confirmDialog } from '@/components/dialogs/dialogs'
import { useTavernReady } from '@/components/tavern/useTavernReady'
import * as store from '@/lib/tavern/store'
// ⚠️ W2-5a 起不再需要 `isCancelled`：任务的「中止 vs 失败」由**任务中心**按 `signal.aborted`
//    判定（见 aiTaskCenter 的 startTask catch），notify 收到的 status 已经是 aborted/failed。
import { unloadOllamaModel } from '@/lib/ai'
import { resolveTavernProvider } from '@/lib/tavern/provider'
import { nextWatermark, watermarkAfterRoundEnd, acquireSummaryLock, assertSummaryLock, releaseSummaryLock } from '@/lib/tavern/memory'
import { primaryAiCharId } from '@/lib/tavern/primaryChar'
import { DEFAULT_TAVERN_SETTINGS, memoryLimitsOf, type TavernSettings } from '@/lib/tavern/settings'
import { runRoundEnd, pendingMessages, type RoundEndProgress, type RoundEndResult } from '@/lib/tavern/roundEnd'
// 🔴 3.0 · W2-5a（§11.1 L1）：收尾的长任务状态交给模块级任务中心（切页签不丢）
import { useTaskRunner } from '@/lib/ai/aiTaskCenter'
// 3.2.0 · WQ6：一次性收尾也要有请求预算（逐角色记忆 + 数值 + 设定审查，次数随角色数增长）
import { createAttemptBudget } from '@/lib/ai/requestLedger'
import type { CardRevision } from '@/lib/tavern/revise'
import type { FreeCharacter, FreeSession, FreeMemory, VarKey } from '@/lib/tavern/types'

/** 入参一律来自 `useTavernFreeModel` 的同一次渲染作用域 */
type FreeRoundEndDeps = {
  session: FreeSession | null
  setSession: Dispatch<SetStateAction<FreeSession | null>>
  setMems: Dispatch<SetStateAction<Record<string, FreeMemory | null>>>
  castCards: FreeCharacter[]
  summaryProviderId: string
  lim: ReturnType<typeof memoryLimitsOf>
  varKeys: VarKey[]
  tavernSettings: TavernSettings | null
  nameOf: (id: string) => string
  refreshSessions: () => Promise<void>
  /** 收尾里若读出设定建议，直接摊开给作者裁决 —— 这几个 setter 来自 useFreeRevise */
  setReviseOpen: Dispatch<SetStateAction<boolean>>
  setProposals: Dispatch<SetStateAction<CardRevision[]>>
  setPicked: Dispatch<SetStateAction<Set<string>>>
  setReviseError: Dispatch<SetStateAction<string>>
}

export function useFreeRoundEnd({
  session, setSession, setMems, castCards, summaryProviderId, lim, varKeys, tavernSettings, nameOf, refreshSessions,
  setReviseOpen, setProposals, setPicked, setReviseError,
}: FreeRoundEndDeps) {
  // 🔴 2026-09-22 六维审计 F1：收尾靠 AI 整理记忆，未配模型时给出明确指引。
  //    判据走**酒馆自己的 provider 链**，且**用收尾真正会用的那个模型**：
  //    收尾请求传的是 `summaryProviderId || undefined`（总结模型 → 面板默认 → 全局活动模型），
  //    所以这里也用 summaryProviderId 当会话级 ref —— 判据与真实调用链严格同源。
  //    🔴🔴 绝不能用全局那个就绪 Hook：会把「全局留空、只在面板指定模型」的有效配置误禁。
  const tavernReady = useTavernReady(summaryProviderId || undefined, tavernSettings?.common.defaultProviderId)
  const aiReadyNow = tavernReady.ready
  /**
   * 🔴 3.0 · W2-5a（§11.1 L1）：收尾的长任务状态**从组件 state 搬进任务中心**。
   *
   * 原先 `ending` / `endStage` / `endCtlRef` / `endResult` 全在组件内，而**切页签＝卸载组件** ——
   * 切走后收尾还在后台跑（本地 27B 要逐角色总结 + 算数值 + 审设定，好几分钟），
   * 界面却**看不到进度、更点不到「中止」**（`endCtlRef` 一并蒸发）。
   *
   * 任务中心是**模块级 store**：切走不丢；`useTaskRunner.result` 直接读 `task.result`，
   * 切回来结果就是现成的（见 aiTaskCenter「结果回填的时机」）。
   * ⚠️ 中止**只能**由作者点「停止」触发（`endT.stop()`）—— 切页签绝不中止。
   */
  const endT = useTaskRunner<RoundEndResult, RoundEndProgress>({
    ownerTab: 'tavern-free',
    kind: 'round-end',
    title: '结束本轮对话（整理记忆）',
    // 会写酒馆会话（水位线 / 归档戳 / 数值）＋ 各角色卡的记忆 —— 与其它写酒馆的任务互斥提醒
    writes: ['tavern'],
  })
  // ---------- 结束本轮对话（一次性收尾：记忆 + 日记 + 数值 + 设定） ----------
  /**
   * 让本地 Ollama 把这一场用过的模型吐出去（#11，收尾跑完后才调）。
   *
   * 【为什么聊天模型也要卸】老大遇到的正是「清空了记忆与日记，模型扮演的角色还是有记忆」——
   *   真正带着上一场上下文的是**生成回复那个模型**，它按 keep_alive 挂在显存里。
   *   总结模型如果与它不是同一个，也一并卸掉（两个都占显存）。
   *   同一个模型只卸一次（按 类型|地址|模型名 去重），免得白跑一次 HTTP。
   *
   * 非本机 Ollama（云端 / 局域网另一台机器）会被 `unloadOllamaModel` 静默跳过，
   * 这里如实提示一句「没有可卸载的本地模型」，免得作者以为开关坏了。
   */
  const unloadLocalModels = useCallback(async () => {
    const refs: { providerId?: string }[] = []
    if (session?.model?.providerId) refs.push({ providerId: session.model.providerId })
    if (summaryProviderId) refs.push({ providerId: summaryProviderId })
    const seen = new Set<string>()
    let done = 0
    for (const ref of refs) {
      try {
        const { provider } = await resolveTavernProvider(ref)
        const key = `${provider.type}|${provider.baseUrl}|${provider.model}`
        if (seen.has(key)) continue
        seen.add(key)
        if (await unloadOllamaModel(provider)) done++
      } catch {
        // 单个解析或卸载失败不影响另一个；下面统一提示
      }
    }
    if (done > 0) showToast('已让本地模型退出显存（下一场开场会慢一点：要重新加载）', 'info')
    else showToast('没有可卸载的本地模型（云端模型不需要卸载，或本机 Ollama 未响应）', 'info')
  }, [session, summaryProviderId])

  /**
   * 以前这里是「每轮说完一句就静默整理一次记忆」。本地模型跑一次要几十秒，
   * 全都压在那句之后 —— 作者的表现就是「说完卡半天」，聊越久越卡（反馈 #3）。
   *
   * 现在改成：**聊天过程中一次都不整理**，作者点「结束本轮对话」才走完这一整套。
   * 代价是本轮的对话要结束时才进长期记忆 —— 换来的是对话过程再不会被打断。
   */
  const endRound = useCallback(async () => {
    const s = session
    if (!s || endT.running) return
    if (s.endedAt) { showToast('本轮已经结束了', 'info'); return }

    const pending = pendingMessages(s)
    if (pending.length === 0 && s.messages.length === 0) {
      showToast('这个对话还是空的', 'info')
      return
    }
    // 🔴 2026-09-22 六维审计 F1：收尾要靠 AI 整理记忆，未配模型时先拦下 ——
    //    否则会走完整套确认弹窗、跑到模型层才失败，作者白等一场（且收尾失败不推进水位线）。
    if (!aiReadyNow) {
      showToast('还没配置可用的模型 —— 收尾要用它整理记忆，请先到「模型设置」里配好', 'info')
      return
    }

    const ok = await confirmDialog({
      title: '结束本轮对话',
      message: [
        `现在就让 AI 整理这一场（${s.messages.length} 条），然后把它归档。`,
        '',
        '整理内容包括：各角色的记忆、Ta 的第一人称日记、本场数值，以及要不要改设定的建议。',
        '结束后这一场会变成只读，想继续就新开一场。',
      ].join('\n'),
      danger: false,
    })
    if (!ok) return

    // 🔴 3.0 · W2-5a：收尾交给任务中心跑 —— 切页签不丢进度、也不丢「中止」的把手。
    //    结果 / 进度 / 中止一律从 `endT` 取（见上面的状态说明）。
    endT.run(async ctx => {
    // 🔴 取锁必须在 try **之外**（审计 P1-3）：旧写法把取锁放在 try 里，
    //    而 `finally` 无条件 releaseSummaryLock() —— 取锁失败（说明锁在**别人**手里）时
    //    也会执行 finally，把别人的锁删掉，防并发形同虚设。
    //    （TavernPlot 的 runPlotSummary 本来就是正确写法，这里对齐。）
    //    ⚠️ W2-5a 后取不到锁改为 **throw**（任务中心如实记 failed 并弹提示）——
    //    原先只 toast 一句，作者切走就再也看不到。
    const lockToken = acquireSummaryLock(Date.now(), lim.lockTtlMs)
    if (!lockToken) throw new Error('另一个窗口正在收尾')
    // 3.2.0 · WQ6：**每场收尾一份**预算，正常花销 = 逐角色记忆 1 + 数值 1 + 逐角色设定审查 1
    //   ＝ 2×角色数 + 1；再留 1 次余量，超过就是失控（例如某个子步骤开始循环重试）。
    const budget = createAttemptBudget({
      label: '结束本轮对话',
      max: Math.max(3, castCards.length * 2 + 2),
    })
    try {
      const res = await runRoundEnd({
        session: s,
        cards: castCards,
        providerId: summaryProviderId || undefined,
        // 反馈 #4：本场数值算完回写主角色卡（持久、跨会话累积）
        primaryCharId: primaryAiCharId(s),
        // hardLimit 必须传：不传就永远走内置 3000，面板调的「记忆硬上限」是死的（审计 P1-1）
        limits: { longTermLimit: lim.longTermLimit, diaryDays: lim.diaryDays, hardLimit: lim.hardLimit },
        varKeys,
        vars: s.vars,
        maxStep: (tavernSettings ?? DEFAULT_TAVERN_SETTINGS).vars.maxStep,
        nameOf: (id?: string) => nameOf(id ?? ''),
        onProgress: ctx.progress,
        signal: ctx.signal,
        assertLock: () => assertSummaryLock(lockToken),
        budget,
      })

      // 水位线推进到最后一条 + 写回数值 + 打上归档戳
      // 🔴 退化则保留旧水位（决策收在 memory.watermarkAfterRoundEnd，两处调用方共用）
      const updated: FreeSession = {
        ...s,
        watermark: watermarkAfterRoundEnd(s.watermark, nextWatermark(s), res.memoryDegraded),
        vars: res.vars,
        endedAt: res.endedAt,
        updatedAt: Date.now(),
      }
      assertSummaryLock(lockToken)
      await store.saveFreeSession(updated)
      setSession(cur => (cur && cur.id === updated.id ? updated : cur))
      setMems(prev => ({ ...prev, ...Object.fromEntries(res.memories.map(m => [m.charId, m])) }))

      // 🔴 完成提示改由**任务中心 store** 发（见下面 run 的 notify）——
      //    作者很可能已经切到别的页签，面板此刻根本没挂载，它自己 toast 等于没人 toast。
      //    有步骤没成必须如实说的纪律（审计 P0-1）移到 notify 的文案里照旧保留。

      // 有设定建议就顺手摊开给作者裁决 —— 都到这一步了，让他再点一次按钮纯属多余
      // ⚠️ 切页签后本组件已卸载，下面这些 setter 自然失效（无害）；
      //    **数据已落库**（store.saveFreeSession），这正是「切走不丢」的语义。
      if (res.proposals.length > 0) {
        setProposals(res.proposals)
        // 🔴 默认**一条都不勾**（审计 P2）：设定改动会动角色卡的根本，老大 2026-09-16 的原话是
        //    「由于会涉及到角色卡的根本性变化，所以需要用户确认修改内容」。
        //    默认全勾等于给了一句「一键全采纳」，与「逐条裁决」的初衷相反。
        setPicked(new Set())
        setReviseError('')
        setReviseOpen(true)
      }
      await refreshSessions()

      // 🔴 #11：卸载排在这一步**之后**（D4 硬约束）。
      //    到这里的含义是：记忆/日记/数值/设定建议全部产出、会话也已落库、列表也刷过了 ——
      //    后面不再有任何模型调用，此时卸载才是安全的。
      //    中途卸会让后面的收尾步骤先等一次模型重新加载（本地 27B 上几十秒），得不偿失。
      //    失败只提示，**绝不**把这一轮收尾判成失败：卸载是锦上添花的事。
      if ((tavernSettings ?? DEFAULT_TAVERN_SETTINGS).free.unloadAfterRoundEnd) {
        void unloadLocalModels()
      }
      // 🔴 结果作为任务结果落进任务中心（`endT.result` 即它）—— 切页签回来仍是现成的。
      return res
    } finally {
      // 🔴 释放排在 fn 自己的 finally（`startTask` 不提供用户钩子）；与取锁同处一个 fn，配对可靠。
      releaseSummaryLock(lockToken)
    }
    }, (
      // 🔴 `useTaskRunner.run` 的第二个参数**就是 notify 函数本身**（不是 `{ notify }`）。
      // 提示由任务中心发（作者可能已切走）。文案与旧版等价，含「有步骤没成如实说」（审计 P0-1）。
      // 🔴 中止 ≠ 失败：任务中心已把 signal.aborted 的失败归为 `aborted`，
      //    这里照它分派即可（不必再自己正则匹配 message）。
      { status, result, error }: {
        status: 'done' | 'failed' | 'aborted'
        result: RoundEndResult | null
        error: string
      }) => {
        if (status === 'aborted') {
          return { text: '已中止收尾 —— 没有写入任何内容，这一场仍是未结束状态', kind: 'info' as const }
        }
        if (status === 'failed') {
          return { text: `结束失败：${error || '未知原因'}`, kind: 'error' as const }
        }
        const r = result as RoundEndResult | null
        if (!r) return { text: '本轮已结束', kind: 'success' as const }
        const n = Object.keys(r.journals).length
        // 3.2.0 · WQ6：如实报本次调用量（WQ6：预计范围与上限由预算对象给出，这里只报实际花费）
        const spend = r.budget ? `（模型调用 ${r.budget.used}/${r.budget.max} 次）` : ''
        return {
          text: `本轮已结束 —— ${r.memories.length} 位角色的记忆已更新${n ? `，写了 ${n} 条日记` : ''}${spend}`
            + (r.warnings.length ? `\n⚠️ ${r.warnings.join('\n⚠️ ')}` : ''),
          kind: (r.warnings.length ? 'info' : 'success') as 'info' | 'success',
        }
      },
    )
  }, [session, endT, aiReadyNow, castCards, summaryProviderId, lim, varKeys, tavernSettings, nameOf, refreshSessions, unloadLocalModels, setSession, setMems, setReviseOpen, setProposals, setPicked, setReviseError])

  /** 中止收尾（已产出的部分不落库，见 endRound 的 catch 说明）—— 走任务中心的中止通道 */
  const stopEndRound = useCallback(() => { endT.stop() }, [endT])

  return {
    // 🔴 形状与旧版**逐字一致**（消费者零改动）：只是来源从组件 state 换成任务中心。
    ending: endT.running,
    endStage: endT.task?.progress ?? null,
    endResult: endT.result,
    // 「关掉即焚」语义照旧：关弹窗 = 清掉这条已结束的任务记录（运行中无效）
    setEndResult: (r: RoundEndResult | null) => { if (r === null) endT.clear() },
    endRound,
    stopEndRound,
  }
}
