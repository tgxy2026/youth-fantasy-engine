import { useEffect } from 'react'
import { showToast } from '@/components/dialogs/dialogs'
import { consumeTaskNotice, useAiTaskNotice } from '@/lib/ai/aiTaskCenter'

/**
 * 任务完成提示的**全站出口**（3.5.6）。
 *
 * 【为什么需要它】完成提示原本由侧栏的 `TaskIndicator` 订阅并 toast —— 那个组件常驻侧栏，
 * 所以不管作者在哪个页签都能收到。3.5.6 把任务列表拆成独立页签后，页签没打开时就没人订阅了，
 * 作者会漏掉「任务完成」。故在 App 顶层挂一个**不渲染任何 UI** 的桥，只负责认领提示并弹 toast。
 *
 * 认领是**一次性**的（`consumeTaskNotice` 返回 false 表示已被别处认领），
 * 所以这里与页签内的订阅同时存在也不会重复弹。
 */
export default function TaskNoticeBridge() {
  const notice = useAiTaskNotice()
  useEffect(() => {
    if (!notice || !consumeTaskNotice(notice.id)) return
    showToast(notice.text, notice.kind)
  }, [notice])
  return null
}
