/**
 * 3.5.5 · ACP 模式下的语义检索提示。
 *
 * 【为什么单独一个组件】
 * `AIConfigPanel` 是**按连接模式切换整块内容**的：ACP 模式下只渲染 ACP 连接，
 * 模型配置（含 `EmbeddingIndexPanel`）整个不出现。于是「语义召回已降级为关键词匹配」
 * 这条提示原本写在那块里 —— **ACP 用户永远看不到**，而降级恰恰只发生在 ACP 模式。
 *
 * 这里补在 ACP 连接下方，只做「说清楚现状 + 怎么恢复」，不搬索引管理按钮：
 * ACP 下建索引必然失败（发不出嵌入请求），给出按钮只会让人白点。
 */
import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { semanticCapability, type SemanticCapability } from '@/lib/semantic/capability'

export default function AcpSemanticNotice() {
  const [cap, setCap] = useState<SemanticCapability | null>(null)
  useEffect(() => {
    let active = true
    void semanticCapability().then(v => { if (active) setCap(v) }).catch(() => undefined)
    return () => { active = false }
  }, [])

  // 只在「确实降级」时出现。语义可用（理论上 ACP 下不会）与探测失败都不打扰。
  if (!cap || cap.mode !== 'keyword') return null

  return (
    <div className="flex items-start gap-1.5 rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-11 leading-relaxed text-amber">
      <AlertCircle size={12} className="mt-0.5 shrink-0" />
      <span>
        <span className="font-medium">语义检索已降级为本地关键词匹配</span>
        ：ACP 模式下引擎发不出嵌入请求，召回只能命中<strong>用词相近</strong>的片段，换个说法就匹配不到，
        注入段标注的是「匹配度」而不是「相似度」。已有索引仍会被用上；
        要恢复完整召回，切回 API 模式重建一次索引即可。
      </span>
    </div>
  )
}
