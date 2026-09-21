/**
 * 自由对话（酒馆模式）的**生成链路**（从 `useTavernFreeModel.tsx` 拆出来的，2026-09-19）。
 *
 * 【为什么这么拆】原 hook 1243 行里挤着三块互不相干的子系统：会话生命周期（选会话 / 新建 /
 *   左栏树）/ 生成链路 / 收尾。这一块是「正在生成」那条线 —— 流式状态机 + 三个生成入口
 *   （发送 / 重说 / 润色与自动回复）+ 快捷指令条 + 输入框。
 *
 * 🔴 为什么必须**同块**、不能再往下拆：它们共用 `abortRef` 这根「代次令牌」。
 *   切走会话、或作者按了停止，都把 `abortRef.current` 换掉（`cancelInFlight`）；在途请求回头一看
 *   `abortRef.current !== ctrl` 就知道自己已经过气 —— 只落库、**不接管界面**。
 *   把三个入口分到不同文件，这条判据就跨了文件边界，某次改动里很容易被悄悄改坏。
 *
 * 🔴 搬动时逐条保住的红线：
 *   · 切走会话要**先中止在途生成**再复位流式状态（`cancelInFlight`，六维审计 P1-2）；
 *   · `abortRef.current !== ctrl` 命中时**不回灌界面**，也不把没发出去的文字塞回输入框
 *     （原 bug：上一场的草稿会灌进新会话的输入框）；
 *   · 生成期间输入框**不 disable** —— 作者可以先把下一句打好；重按发送只提示一次
 *     （`streamingHintRef` 节流，反馈 #13），静默拦截会让人以为键盘坏了；
 *   · 数值结算与正文**同一笔落库**（`refreshSessionVars` 的结果直接 saveFreeSession）——
 *     数值跟它所依据的那条回复不能分家；
 *   · 数值同时**回写主角色卡**（`persistCharVars`，反馈 #4：跨会话累积）；
 *   · 归档后的会话是**只读**的：`send` / `reroll` 都要挡在 `endedAt` 前面。
 *
 * 遵守项目约定：提示用 showToast、弹窗用 confirmDialog。
 */
import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import { showToast } from './dialogs'
import { type QuickAction } from './TavernQuickBar'
import * as store from '../lib/tavern/store'
import { runFreeTurn, runFreeAssist, applyPostRulesForPreview, varsEnabledKeys } from '../lib/tavern/engine'
import { isCancelled } from '../lib/ai'
import { refreshSessionVars } from '../lib/tavern/varsRefresh'
import { primaryAiCharId } from '../lib/tavern/primaryChar'
import { DEFAULT_TAVERN_SETTINGS, type TavernSettings } from '../lib/tavern/settings'
import type { PostApplied } from '../lib/tavern/postRules'
import type { FreeCharacter, FreeSession, CharVars } from '../lib/tavern/types'

/** 入参一律来自 `useTavernFreeModel` 的同一次渲染作用域（状态值 + setter / useCallback） */
type FreeTurnDeps = {
  session: FreeSession | null
  setSession: Dispatch<SetStateAction<FreeSession | null>>
  input: string
  setInput: Dispatch<SetStateAction<string>>
  charCard: FreeCharacter | null
  castCards: FreeCharacter[]
  speakNext: string
  setSpeakNext: Dispatch<SetStateAction<string>>
  setCharCard: Dispatch<SetStateAction<FreeCharacter | null>>
  setCastCards: Dispatch<SetStateAction<FreeCharacter[]>>
  setPostNotice: Dispatch<SetStateAction<{ applied: PostApplied[]; errors: string[] }>>
  setGreeting: Dispatch<SetStateAction<string>>
  varKeys: ReturnType<typeof varsEnabledKeys>
  tavernSettings: TavernSettings | null
  summaryProviderId: string
  nameOf: (id: string) => string
  refreshSessions: () => Promise<void>
}

export function useFreeTurn({
  session, setSession, input, setInput, charCard, castCards, speakNext, setSpeakNext,
  setCharCard, setCastCards, setPostNotice, setGreeting,
  varKeys, tavernSettings, summaryProviderId, nameOf, refreshSessions,
}: FreeTurnDeps) {
  const [streaming, setStreaming] = useState(false)
  /** 润色/自动回复生成中（与 streaming 互斥但同属「正在生成」，期间禁用快捷条与发送） */
  const [assistBusy, setAssistBusy] = useState(false)
  const [assistMode, setAssistMode] = useState<'polish' | 'auto' | null>(null)
  const [streamText, setStreamText] = useState('')
  const [phase, setPhase] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  /**
   * 🔴 审计 2026-09-18（P1-2）：切走会话前**中止在途生成**并复位流式状态。
   *    置空 abortRef 兼作「代次令牌」：在途的 send / reroll / assist 发现自己的 ctrl
   *    已被换掉，就只落库、不接管界面 —— 否则旧回复会把界面拽回旧会话
   *    （左栏高亮按 session?.id 判定，高亮与正文就此不一致），失败路径的 setInput(text)
   *    还会把上一场没发出去的文字灌进新会话的输入框。
   */
  const cancelInFlight = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    setStreamText('')
    setPhase('')
    setAssistBusy(false)
    setAssistMode(null)
  }, [])
  /**
   * 「生成中又按了一次发送」的提示节流（反馈 #13）。
   * 输入框在生成期间**保持可用**（作者可以先把下一句打好），所以 Enter 会真的按下去 ——
   * 若只是静默拦截，作者会以为键盘坏了。一次生成只提示一次，别每按一下弹一个 toast。
   */
  const streamingHintRef = useRef(false)
  // ---------- 本场数值：把状态落回角色卡（定义在 send 之前，避免 useCallback 依赖数组触发 TDZ） ----------
  /** 把一份角色卡状态落库并刷新内存（反馈 #4：状态存卡、跨会话累积）。通用：任何角色 id 都能用。 */
  const persistCharVars = useCallback(async (charId: string, cv: CharVars) => {
    const card = await store.getFreeChar(charId).catch(() => null)
    if (!card) return
    const updated = { ...card, vars: cv }
    await store.saveFreeChar(updated).catch(() => undefined)
    setCharCard(prev => (prev && prev.id === charId ? updated : prev))
    setCastCards(prev => prev.map(c => (c.id === charId ? updated : c)))
  }, [setCharCard, setCastCards])
  // ---------- 对话 ----------
  /** preset = 快捷指令条递过来的一句现成话（走导演指令通道）；不传就用输入框里的 */
  const send = useCallback(async (preset?: string) => {
    const text = (preset ?? input).trim()
    if (!text || !session || !charCard) return
    /**
     * 生成中又按了一次发送（反馈 #13）。
     * 输入框现在**不被 disable**，作者能先把下一句打好 —— 所以 Enter 是真按下去的，
     * 🔴 不能只是静默 return：那会让作者以为键盘失灵。提示一次即可（ref 节流）。
     */
    if (streaming) {
      if (!streamingHintRef.current) {
        streamingHintRef.current = true
        showToast('Ta 还在说 —— 这句说完再接你的下一句', 'info')
      }
      return
    }
    // 🔴 归档后只读：这一场已经整理归档再去改它，记忆与日记就会和正文对不上
    if (session.endedAt) {
      showToast('本轮对话已结束 —— 想接着聊请新开一场', 'info')
      return
    }
    if (!preset) {
      setInput('')
      // 发送后把光标留在（已清空的）输入框里：沉浸聊天时下一句直接打，
      // 不用每轮再抬手点一次框（老大 2026-09-16 反馈 #13）。
      // ⚠️ 必须等 React 把空值渲染进去再聚焦 —— 同步 setState 后立刻 focus 会跟重渲染打架。
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    setStreaming(true)
    setStreamText('')
    setPhase('')
    // 立刻把这句话显示出来 —— 等整轮生成完才现身的话，中间那几十秒界面像没收到你说话。
    // 这里只是**预演**：runFreeTurn 内部会用 withUser 自己重建 messages，
    // 成功后用返回的 session 覆盖，失败则回滚并把文字还回输入框。
    const optimistic: FreeSession = {
      ...session,
      messages: [...session.messages, { id: `pending-${Date.now()}`, role: 'user', content: text, at: Date.now() }],
    }
    setSession(optimistic)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const cast = castCards.length ? castCards : [charCard]
      const res = await runFreeTurn(session, cast, text, {
        onToken: d => setStreamText(prev => prev + d),
        onPhase: p => setPhase(p),
        signal: ctrl.signal,
        speakerId: speakNext || undefined,
      })
      // 🔴 审计 2026-09-18（P1-2）：生成期间切了会话 / 按了停止 → **不回灌界面**。
      //    否则 setSession(res.session) 会把界面拽回旧会话，而左栏高亮按 session?.id 判定，
      //    高亮与正文就此不一致。用 ctrl 当「代次令牌」：openSession / stop 会换掉或清空 abortRef。
      if (abortRef.current !== ctrl) return
      setStreamText('')
      // 反馈 #5：先把这一轮完整回复作为消息立刻显示，文字常驻不闪退；后面的数值结算在后台跑（只更新右栏），不再清空正文导致「文字消失再重现」。
      setSession(res.session)
      /**
       * 每轮刷新本场数值（2026-09-16 老大反馈 #4）。
       * 这一步还要再等一次小调用 —— 先把阶段提示换上，否则正文都出来了界面还卡着，像死机。
       * 刷新结果与正文**同一笔落库**：数值跟它所依据的那条回复不能分家。
       */
      setPhase('正在结算本场数值…')
      const withVars = await refreshSessionVars({
        session: res.session,
        keys: varKeys,
        maxStep: (tavernSettings ?? DEFAULT_TAVERN_SETTINGS).vars.maxStep,
        nameOf: id => nameOf(id ?? ''),
        providerId: summaryProviderId || undefined,
        signal: ctrl.signal,
        // 反馈 #4：抽取时把主角色卡当前备注当上下文；算完把新值＋新备注回写卡（持久、跨会话累积）
        primaryCharId: primaryAiCharId(res.session),
        charVars: charCard?.vars,
        persistCharVars,
      })
      const saved = await store.saveFreeSession(withVars)
      // 🔴 结算期间又切了会话：这一轮**照常落库**（它确实发生在那个会话上），但界面不接管
      if (abortRef.current !== ctrl) { void refreshSessions(); return }
      setSession(saved)
      setPostNotice({ applied: res.postApplied, errors: res.postErrors })
      await refreshSessions()
      if (res.fellBack) showToast('该会话指定的模型不可用，已回退到全局活动模型', 'info')
      // 说完这句就把Ta说的话撤掉：那句话是「很久没来」时才该有的
      setGreeting('')
      setSpeakNext('')
    } catch (e) {
      // 🔴 已切走（或主动停止）：绝不能回滚到旧会话 —— setSession(session) 会把界面拽回去，
      //    setInput(text) 还会把上一场没发出去的文字塞进新会话的输入框（审计 P1-2 原文场景）
      if (abortRef.current !== ctrl) return
      // 回滚：这句话没送出去，把它还回输入框，别让作者白打一遍
      setSession(session)
      setInput(text)
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      // 🔴 代次令牌（2026-09-20 六维审计 P1-5）：切会话后旧请求的收尾**不能**动新会话的状态。
      //    原先 try / catch 两处都有 `abortRef.current !== ctrl` 判断，只有 finally 没有 ——
      //    旧请求在 finally 里把 streaming 置回 false、abortRef 清空 ⇒ 新会话的回复照常落库
      //    却**不显示**（界面以为没在生成），停止键也失效（abortRef 已被清空）。
      //    ⚠️ 正常停止不会卡住：`stop()` 只 abort、不清空 abortRef，所以这里判断为真、照常复位；
      //    切会话走 `cancelInFlight`（它自己会 setStreaming(false)），跳过也不会留下坏状态。
      if (abortRef.current === ctrl) {
        setStreaming(false)
        setPhase('')
        abortRef.current = null
        streamingHintRef.current = false
      }
    }
  }, [input, session, charCard, streaming, refreshSessions, castCards, speakNext, varKeys, tavernSettings, summaryProviderId, nameOf, persistCharVars, setSession, setInput, setSpeakNext, setPostNotice, setGreeting])
  const lastAiId = useMemo(() => store.lastAssistantId(session?.messages ?? []), [session])
  /**
   * 重说：多角色同场时**保持原来的说话人** —— 同一轮换个人接话，观感很怪。
   * speakerId 传给引擎即走「手动指定下一位」那条路（它优先于轮转）。
   */
  const reroll = async () => {
    if (!session || streaming) return
    // 🔴 归档守卫：结束本轮对话之后这一场是**只读**的 —— 重说会真调模型并 store.saveFreeSession()
    //    落库，把归档那一刻的记忆/日记与正文彻底对不上（这正是 send() 那条注释想防的事）。
    if (session.endedAt) {
      showToast('这一场已经结束了（只读归档）—— 想接着聊请新开一场', 'info')
      return
    }
    const target = session.messages.find(m => m.id === lastAiId)
    if (!target) { showToast('还没有可以重说的回复', 'info'); return }
    setStreaming(true)
    setStreamText('')
    setPhase('')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const cast = (castCards.length ? castCards : (charCard ? [charCard] : [])) as FreeCharacter[]
      const res = await runFreeTurn(session, cast, null, {
        onToken: d => setStreamText(prev => prev + d),
        onPhase: p => setPhase(p),
        signal: ctrl.signal,
        speakerId: target.speakerId,
      })
      // 🔴 审计 2026-09-18（P1-2）：生成期间切了会话 / 按了停止 → **不回灌界面**。
      //    否则 setSession(res.session) 会把界面拽回旧会话，而左栏高亮按 session?.id 判定，
      //    高亮与正文就此不一致。用 ctrl 当「代次令牌」：openSession / stop 会换掉或清空 abortRef。
      if (abortRef.current !== ctrl) return
      setStreamText('')
      // 反馈 #5：重说也先把新回复作为消息立刻显示，文字常驻；数值结算在后台跑（只更新右栏）。
      setSession(res.session)
      // 重说同样要刷新数值（反馈 #4）：回复换了，这一轮的关系走向也就跟着换
      setPhase('正在结算本场数值…')
      const withVars = await refreshSessionVars({
        session: res.session,
        keys: varKeys,
        maxStep: (tavernSettings ?? DEFAULT_TAVERN_SETTINGS).vars.maxStep,
        nameOf: id => nameOf(id ?? ''),
        providerId: summaryProviderId || undefined,
        signal: ctrl.signal,
        // 反馈 #4：抽取时把主角色卡当前备注当上下文；算完把新值＋新备注回写卡（持久、跨会话累积）
        primaryCharId: primaryAiCharId(res.session),
        charVars: charCard?.vars,
        persistCharVars,
      })
      const saved = await store.saveFreeSession(withVars)
      // 🔴 结算期间又切了会话：照常落库，但界面不接管（同 send）
      if (abortRef.current !== ctrl) { void refreshSessions(); return }
      setSession(saved)
      setPostNotice({ applied: res.postApplied, errors: res.postErrors })
      await refreshSessions()
      if (!res.reply) showToast('这次没生成出内容，原来那条已保留', 'info')
    } catch (e) {
      if (abortRef.current !== ctrl) return   // 已切走：不报「失败」，也不回滚界面
      showToast(`重说失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      // 🔴 同上（P1-5）：只有还是自己那一代时才复位
      if (abortRef.current === ctrl) {
        setStreaming(false)
        setPhase('')
        abortRef.current = null
      }
    }
  }
  /**
   * 快捷指令条：走协议 R4 的**导演指令**通道（「」= 照做然后继续演）。
   * 🔴 点击**只填进输入框、不直接发送** —— 这些指令几乎都要作者改一处（推进多久），
   *    直接发出去等于替作者作了决定。带 slot 的（推进时间）会把那一段选中，直接改即可。
   */
  // ---------- 润色 / 自动回复（AI 实时生成文本回写输入框，绝不自动发送） ----------
  const assistWrite = useCallback(async (mode: 'polish' | 'auto') => {
    if (streaming || assistBusy || !session) return
    if (session.messages.length === 0) return           // 首轮（无历史）禁用
    if (session.endedAt) return
    if (mode === 'polish' && !input.trim()) {
      showToast('输入框是空的，没有可润色的内容', 'info')
      return
    }
    const original = input
    setAssistBusy(true)
    setAssistMode(mode)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let buf = ''
    let lastFlush = 0
    try {
      const cast = castCards.length ? castCards : (charCard ? [charCard] : [])
      const res = await runFreeAssist(
        session,
        cast,
        mode,
        mode === 'polish' ? original.trim() : '',
        {
          signal: ctrl.signal,
          onToken: (t) => {
            buf += t
            const now = Date.now()
            // 节流 ~120ms 回写预览；预览套**同一套**后处理规则，保证「途中看到 = 最终得到」
            if (now - lastFlush >= 120) { lastFlush = now; setInput(applyPostRulesForPreview(buf, tavernSettings ?? DEFAULT_TAVERN_SETTINGS)) }
          },
        },
      )
      // 🔴 切走之后不能再动输入框：setInput 会把旧会话的润色/续写结果填进**新会话**的框里（同 P1-2）
      if (abortRef.current !== ctrl) return
      setInput(res.text)                          // 最终以完整结果为准（已在 engine 里去空行）
    } catch (e) {
      if (abortRef.current !== ctrl) return
      if (isCancelled(e)) setInput(applyPostRulesForPreview(buf, tavernSettings ?? DEFAULT_TAVERN_SETTINGS)) // 取消：保留已生成部分（同口径后处理）
      else {
        showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
        if (mode === 'polish') setInput(original)        // 润色失败：还原原文
        else setInput('')                               // 自动回复失败：留空
      }
    } finally {
      // 🔴 同上（P1-5）：这是第三个生成入口（快捷指令），同样只在代次未变时复位
      if (abortRef.current === ctrl) {
        setAssistBusy(false)
        setAssistMode(null)
        abortRef.current = null
      }
    }
  }, [streaming, assistBusy, session, input, castCards, charCard, tavernSettings, setInput])

  /** 只要有历史消息（非首轮），润色/自动回复即可用。自由对话中用户用「我的档案」扮演（无角色卡）亦可用 */
  const canAssist = !!session && session.messages.length > 0

  const quickActions: QuickAction[] = [
    { key: 'cont', label: '继续', hint: '让 Ta 接着说', text: '「继续。」' },
    { key: 'env', label: '补环境', hint: '先补一句（ ）里的环境（光、声、气味），再接着说', text: '「先说一句（ ）里的环境（光、声、气味），再继续。」' },
    { key: 'time', label: '推进时间', hint: '把时间往前推 —— 填进输入框后自己改成需要的时长', text: '「把时间往前推进 半小时，然后继续。」', slot: '半小时' },
    { key: 'mind', label: 'Ta 在想什么', hint: '用一个动作或细节透出心里的想法，不直接写心理', text: '「用一个动作或细节写出 Ta 此刻心里在想什么，不要直接写心理。」' },
    { key: 'reroll', label: '重说', hint: '用同一段历史让 Ta 重说这一条（只出一个结果，说话人不变）', run: () => void reroll() },
    {
      key: 'polish',
      label: assistBusy && assistMode === 'polish' ? '润色中…' : '润色',
      hint: 'AI 读取你已写的文本，结合角色卡/剧本/上下文扩写润色，结果覆盖输入框（不自动发送）',
      run: () => void assistWrite('polish'),
      disabled: !canAssist,
    },
    {
      key: 'auto',
      label: assistBusy && assistMode === 'auto' ? '生成中…' : '自动回复',
      hint: 'AI 结合剧本/上下文/角色卡，替你扮演的角色写一句发言填进输入框（不自动发送）',
      run: () => void assistWrite('auto'),
      disabled: !canAssist,
    },
  ]
  /** 输入框 ref：预填后要聚焦并把「该改的那一段」选中 */
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  /**
   * 快捷指令预填：把预制文本填进输入框、聚焦，并把该改的那段选中（不发送）。
   * ⚠️ 选区要等 React 把新值渲染进 textarea 之后再设 —— 同步 setState 后立刻设会选到旧值。
   */
  const fillInput = (text: string, slot?: string) => {
    setInput(text)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const i = slot ? text.indexOf(slot) : -1
      if (i >= 0) el.setSelectionRange(i, i + slot!.length)
      else el.setSelectionRange(text.length, text.length)
    })
  }

  const stop = () => { abortRef.current?.abort() }

  return {
    // 流式状态（页面直接读；setStreamText 是 openSession 切会话后的兜底清屏）
    streaming, streamText, setStreamText, phase, assistBusy,
    // 三个生成入口 + 输入框
    send, stop, reroll, quickActions, fillInput, inputRef, lastAiId,
    // 会话切换要用的流式复位 + 数值回写卡（openSession / createFromDraft / setVar 系列都用）
    cancelInFlight, persistCharVars,
  }
}
