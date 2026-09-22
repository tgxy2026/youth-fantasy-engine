/**
 * 自由对话（酒馆模式）的**收尾**（从 `useTavernFreeModel.tsx` 拆出来的，2026-09-19）。
 *
 * 定位：作者点「结束本轮对话」之后跑的那一整套一次性任务 —— 逐角色总结记忆 + 写本场日记
 *   + 结算本场数值 + 审查要不要改设定，跑完把会话归档为只读。
 *
 * 🔴 搬动时逐条保住的红线：
 *   · **收尾可中止**（六维审计 P2-7）：`runRoundEnd` 全程下传 `signal`，中止 ≠ 失败
 *     （措辞按 /取消|abort/ 区分），中止时**一条都不落库**、水位线也不推进；
 *   · **取锁必须在 try 之外**（审计 P1-3）：`finally` 里无条件 release，取锁失败说明锁在
 *     别人手里，那时候 release 会删掉别人的锁，防并发形同虚设；
 *   · 有步骤没成必须**如实说**（审计 P0-1）：记忆 / 数值 / 设定审查失败原先被静默吞掉，
 *     界面照样只报「本轮已结束」，作者以为收尾是完整的 → `warnings[]` 原样显示；
 *   · 卸载本地模型排在**最后**（#11）：到那一步已无任何模型调用，中途卸会让后续收尾
 *     先等一次重新加载；卸载失败只提示，**绝不**把这一轮收尾判成失败；
 *   · 设定建议默认**一条都不勾**（审计 P2）：会动角色卡的根本，必须逐条裁决。
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import { showToast, confirmDialog } from './dialogs'
import { useTavernReady } from './useTavernReady'
import * as store from '../lib/tavern/store'
import { unloadOllamaModel } from '../lib/ai'
import { resolveTavernProvider } from '../lib/tavern/provider'
import { nextWatermark, acquireSummaryLock, releaseSummaryLock } from '../lib/tavern/memory'
import { primaryAiCharId } from '../lib/tavern/primaryChar'
import { DEFAULT_TAVERN_SETTINGS, memoryLimitsOf, type TavernSettings } from '../lib/tavern/settings'
import { runRoundEnd, pendingMessages, type RoundEndProgress, type RoundEndResult } from '../lib/tavern/roundEnd'
import type { CardRevision } from '../lib/tavern/revise'
import type { FreeCharacter, FreeSession, FreeMemory, VarKey } from '../lib/tavern/types'

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
   * 「结束本轮对话」进行中。
   * 注意与旧的 `summarizing` 不同：那玩意儿是**每轮都在后台跑**，作者看得见它卡；
   * 这个只在作者主动点「结束本轮对话」后才出现，且是一次性的。
   */
  const [ending, setEnding] = useState(false)
  const [endStage, setEndStage] = useState<RoundEndProgress | null>(null)
  /**
   * 收尾的取消把手。
   *
   * 🔴 为什么要它（2026-09-19 六维审计 P2-7）：`runRoundEnd` 的 `signal` 早就声明了、
   *    也一路下传到 `chat()`，但**生产调用从不传** —— 本地 27B 上收尾要逐角色总结 + 算数值 +
   *    审查设定，好几分钟且只能干等。这里把「能中止」补上。
   */
  const endCtlRef = useRef<AbortController | null>(null)
  /** 收尾结果摘要（日记 + 数值变化），弹窗展示后关掉即焚 */
  const [endResult, setEndResult] = useState<RoundEndResult | null>(null)
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
    if (!s || ending) return
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

    setEnding(true)
    setEndStage(null)
    setEndResult(null)
    // 🔴 取锁必须在 try **之外**（审计 P1-3）：旧写法把取锁放在 try 里，
    //    而 `finally` 无条件 releaseSummaryLock() —— 取锁失败（说明锁在**别人**手里）时
    //    也会执行 finally，把别人的锁删掉，防并发形同虚设。
    //    （TavernPlot 的 runPlotSummary 本来就是正确写法，这里对齐。）
    if (!acquireSummaryLock(Date.now(), lim.lockTtlMs)) {
      showToast('另一个窗口正在收尾', 'info')
      setEnding(false)
      return
    }
    const ctl = new AbortController()
    endCtlRef.current = ctl
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
        onProgress: setEndStage,
        signal: ctl.signal,
      })

      // 水位线推进到最后一条 + 写回数值 + 打上归档戳
      const updated: FreeSession = {
        ...s,
        watermark: nextWatermark(s) ?? s.watermark,
        vars: res.vars,
        endedAt: res.endedAt,
        updatedAt: Date.now(),
      }
      await store.saveFreeSession(updated)
      setSession(cur => (cur && cur.id === updated.id ? updated : cur))
      setMems(prev => ({ ...prev, ...Object.fromEntries(res.memories.map(m => [m.charId, m])) }))

      const n = Object.keys(res.journals).length
      // 🔴 有步骤没成必须如实说（2026-09-19 六维审计 P0-1）：原先 ②本场数值 / ③设定审查失败被
      //    静默吞掉，界面照样只报「本轮已结束」，作者以为收尾是完整的。
      showToast(
        `本轮已结束 —— ${res.memories.length} 位角色的记忆已更新${n ? `，写了 ${n} 条日记` : ''}`
        + (res.warnings.length ? `\n⚠️ ${res.warnings.join('\n⚠️ ')}` : ''),
        res.warnings.length ? 'info' : 'success',
        6000,
      )

      setEndResult(res)
      // 有设定建议就顺手摊开给作者裁决 —— 都到这一步了，让他再点一次按钮纯属多余
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
    } catch (e) {
      // 🔴 中止 ≠ 失败（2026-09-19 六维审计 P2-7）：记忆走的是「全算完才统一落库」的设计
      //    （见 runRoundEnd 顶部说明），中止时一条都没写，水位线与 endedAt 也没推进 ——
      //    下次点「结束本轮对话」从零重算即可，不会留下半截记忆。
      const aborted = /取消|abort/i.test(e instanceof Error ? e.message : String(e))
      showToast(
        aborted
          ? '已中止收尾 —— 没有写入任何内容，这一场仍是未结束状态'
          : `结束失败：${e instanceof Error ? e.message : String(e)}`,
        aborted ? 'info' : 'error',
      )
    } finally {
      endCtlRef.current = null
      releaseSummaryLock()
      setEnding(false)
      setEndStage(null)
    }
  }, [session, ending, aiReadyNow, castCards, summaryProviderId, lim, varKeys, tavernSettings, nameOf, refreshSessions, unloadLocalModels, setSession, setMems, setReviseOpen, setProposals, setPicked, setReviseError])

  /** 中止收尾（已产出的部分不落库，见 endRound 的 catch 说明） */
  const stopEndRound = useCallback(() => { endCtlRef.current?.abort() }, [])

  return {
    ending, endStage, endResult, setEndResult, endRound, stopEndRound,
  }
}
