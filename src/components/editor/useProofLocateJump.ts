// ============ 编辑器消费「定位原文」请求（3.3.1 · P7） ============
//
// 职责：收到请求 → 校验章节与位置 → 把正文 textarea 滚到命中处并选中 → 让作者直接改。
//
// 🔴 四条边界（规划 §7.3）：
//   ① **只读**：全程不调用任何替换/写入函数，不改正文、不触发保存、不把结果标成已修复；
//   ② **不跨章**：请求里的章节与当前活动章不一致就拒绝（结果不属于这一章，跳过去只会误导）；
//   ③ **不盲信下标**：用消费端的 `ta.value` + 引文重新走一遍唯一定位判据，正文被改过就如实失败；
//   ④ **不抢焦点到别处**：只把焦点交给正文（作者点「定位原文」的意图就是去改字），
//      并在工具弹窗被迫收起时留一个「返回校对结果」入口，结果列表与会话都不丢。
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { showToast } from '@/components/dialogs/dialogs'
import { locateFailureText, locateQuote } from '@/lib/editor/proofLocate'
import { measureCaretTop, scrollTopForOffset } from '@/components/editor/useEditorOpenOffset'
import { subscribeProofLocate, type ProofLocateRequest, type ProofLocateReturnPrompt } from '@/components/editor/proofLocateChannel'

export interface ProofLocateJumpArgs {
  /** 当前活动章节 ID；为空（未选章）时不接受定位 */
  chapterId: string | null
  taRef: RefObject<HTMLTextAreaElement>
  /** 定位成功后同步编辑器的选区状态（`selRef` / 伴写光标），与手工点击同口径 */
  onLocated?: (range: { start: number; end: number }) => void
}

export interface ProofLocateJump {
  /** 非空 = 正文顶部应显示「已定位第 N 条 · 返回校对结果」 */
  prompt: ProofLocateReturnPrompt | null
  dismiss: () => void
}

export function useProofLocateJump({ chapterId, taRef, onLocated }: ProofLocateJumpArgs): ProofLocateJump {
  const [prompt, setPrompt] = useState<ProofLocateReturnPrompt | null>(null)
  /** 订阅只建一次，所以回调里要读最新值 —— 用 ref 而不是把参数塞进依赖数组 */
  const live = useRef({ chapterId, onLocated })
  useEffect(() => { live.current = { chapterId, onLocated } }, [chapterId, onLocated])

  // 切章后旧的返回提示必须失效：它指的是上一章的位置，点回去只会跳到别处
  useEffect(() => { setPrompt(null) }, [chapterId])

  useEffect(() => {
    const handler = (request: ProofLocateRequest): boolean => {
      const { chapterId: currentChapter, onLocated: notify } = live.current
      if (!currentChapter || request.chapterId !== currentChapter) return false
      const ta = taRef.current
      if (!ta || !ta.isConnected) return false
      const located = locateQuote(ta.value, { quote: request.quote, at: request.start })
      if (!located.ok) {
        showToast(locateFailureText(located.reason), 'error')
        return true
      }
      ta.focus({ preventScroll: true })
      ta.setSelectionRange(located.start, located.end, 'forward')
      // 行高读实际样式、纵向位置用镜像实测：正中软换行与 80%～160% 缩放都不会偏
      const lineHeight = Number.parseFloat(getComputedStyle(ta).lineHeight)
      ta.scrollTop = scrollTopForOffset(
        ta.value, located.start, lineHeight, ta.clientHeight, ta.scrollHeight, measureCaretTop(ta, located.start),
      )
      notify?.({ start: located.start, end: located.end })
      if (request.source === 'tool') {
        // 工具弹窗已为这次定位收起 ⇒ 必须留返回入口，否则作者回不到结果列表
        setPrompt({
          chapterId: request.chapterId, source: request.source, issueKey: request.issueKey,
          index: request.index, total: request.total, quote: located.quote, scope: request.scope,
        })
      } else {
        // 诊室面板本来就开在旁边、结果仍在，不额外加返回条；只说明跳到了第几条
        //（面板浮在右上角，目标行可能正好被压住 —— 如实提示可以先收起面板）
        setPrompt(null)
        showToast(`已定位到正文第 ${request.index} 条校对结果，可直接修改；若被面板遮住，可先收起颉文姬面板`, 'info')
      }
      return true
    }
    return subscribeProofLocate(handler)
  }, [taRef])

  const dismiss = useCallback(() => setPrompt(null), [])
  return { prompt, dismiss }
}
