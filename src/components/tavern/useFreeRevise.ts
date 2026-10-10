/**
 * 自由对话（酒馆模式）的**设定更新**（从 `useTavernFreeModel.tsx` 拆出来的，2026-09-19）。
 *
 * 定位：AI 读这一场对话 → 列出「角色设定可能该改了」，由作者**逐条裁决**（默认一条不勾）。
 *   对在场每个角色分别审查 —— 关系是**双向**的（用户演的阿岩提分手，阿岩与小满两张卡的
 *   「2.4 关系」都该改），只查 AI 演的那一方会漏掉一半。
 *
 * 🔴 这里**只产出建议、不落库**；采纳走 `applyPicked` → store.applyCardRevisions。
 *   采纳后必须**重读在场角色**，下一轮组装才用得上新设定。
 *
 * 与收尾的关系：`useFreeRoundEnd` 跑完若读出建议，会调这里导出的 setter 直接摊开面板
 *   （都到这一步了，再让作者点一次按钮纯属多余）。方向是**单向**的：收尾 → 设定更新，不成环。
 */
import { useCallback, useState } from 'react'

import { showToast } from '@/components/dialogs/dialogs'
import * as store from '@/lib/tavern/store'
import { proposeCardRevisions, type CardRevision } from '@/lib/tavern/revise'
import type { FreeCharacter, FreeSession, TavernMessage } from '@/lib/tavern/types'

/** 入参一律来自 `useTavernFreeModel` 的同一次渲染作用域 */
type FreeReviseDeps = {
  session: FreeSession | null
  /** 采纳设定后要重读在场角色（卡 + 记忆），所以把载入函数传进来 */
  loadSessionContext: (s: FreeSession) => Promise<void>
  summaryProviderId: string
}

export function useFreeRevise({ session, loadSessionContext, summaryProviderId }: FreeReviseDeps) {
  const [reviseOpen, setReviseOpen] = useState(false)
  const [revising, setRevising] = useState(false)
  const [applyingRev, setApplyingRev] = useState(false)
  const [proposals, setProposals] = useState<CardRevision[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  /** 设查失败的原因（与「没有需要改设定」必须分开显示） */
  const [reviseError, setReviseError] = useState('')
  /**
   * 设定更新：对**在场每个角色**分别审查一遍。
   *
   * 为什么每个都要跑：关系是**双向**的（用户演的阿岩提分手，阿岩与小满两张卡的「2.4 关系」都该改），
   * 只查 AI 演的那一方会漏掉一半。
   * 这里只产出建议、**不落库**；采纳由 applyPicked 交给 store。
   */
  const openRevise = useCallback(async (s: FreeSession) => {
    const cards = (await Promise.all(s.charIds.map(async id => store.getFreeChar(id))))
      .filter((c): c is FreeCharacter => !!c)
    setReviseOpen(true)
    if (cards.length === 0) { setProposals([]); return }
    setRevising(true)
    setProposals([])
    setPicked(new Set())
    setReviseError('')
    try {
      // 说话人名字：多角色同场时，「谁对谁说了什么」是判断的关键一半
      const speakerName = (m: TavernMessage) => cards.find(c => c.id === m.speakerId)?.name ?? '角色'
      const out: CardRevision[] = []
      for (const c of cards) {
        const rows = await proposeCardRevisions({
          char: c,
          messages: s.messages,
          providerId: summaryProviderId || undefined,
          speakerName,
        })
        out.push(...rows)
      }
      setProposals(out)
      setPicked(new Set(out.map(r => r.id)))
      showToast(out.length
        ? `读出 ${out.length} 处可能的设定变更，请逐条裁决`
        : `这段对话没有需要改的设定（共查了 ${cards.length} 张卡）`,
        'info')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setReviseError(msg)
      showToast(`检查失败：${msg}`, 'error')
    } finally {
      setRevising(false)
    }
  }, [summaryProviderId])

  /** 采纳选中的设定变更。写卡后**重读在场角色** —— 下一轮组装就用新设定 */
  const applyPicked = useCallback(async () => {
    const items = proposals
      .filter(p => picked.has(p.id))
      .map(p => ({ charId: p.charId, field: p.field, after: p.after }))
    if (items.length === 0) return
    setApplyingRev(true)
    try {
      const n = await store.applyCardRevisions(items)
      if (session) await loadSessionContext(session)
      showToast(`已更新 ${n} 处设定 —— 下一轮对话即按新设定演`)
      setReviseOpen(false)
      setProposals([])
      setPicked(new Set())
      setReviseError('')
    } catch (e) {
      showToast(`写入失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setApplyingRev(false)
    }
  }, [proposals, picked, session, loadSessionContext])

  return {
    reviseOpen, setReviseOpen, revising, applyingRev, reviseError,
    proposals, setProposals, picked, setPicked, setReviseError,
    openRevise, applyPicked,
  }
}
