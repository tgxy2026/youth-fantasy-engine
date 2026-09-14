/**
 * 起草 / 补全相关的三小块共用件（参考素材输入 / 检索方式提示 / 来源反馈）
 *
 * 【为什么抽出来】
 * 角色卡、剧本、背景设定，以及角色管理 / 表单 / 表格的 AI 补全，都要这三件东西。
 * 各写一份的结果必然是「一处说了本次是联网、另几处忘了说」——
 * 而「告诉作者这次到底用的是哪种模式」是需求点名的要求，不能漏。
 */
import { useEffect, useState } from 'react'
import AutoTextarea from './AutoTextarea'
import { getSearchSettings } from '../lib/searchSettings'
import { searchBlockedReason, SEARCH_MODE_LABEL, type SearchSettings } from '../lib/webSearch'
import type { DraftSource } from '../lib/draftMaterial'

/**
 * 读一次检索设置（起草 / 补全时用）。
 * 页面打开时读一次即可 —— 作者改设置会保存并提示「下一轮生效」，起草时再读也来得及，
 * 但每次起草都读一遍设置会多一次 IDB 往返，没必要。
 */
export function useSearchSettings(): SearchSettings | null {
  const [s, setS] = useState<SearchSettings | null>(null)
  useEffect(() => {
    let alive = true
    getSearchSettings()
      .then(v => { if (alive) setS(v) })
      .catch(() => { if (alive) setS(null) })
    return () => { alive = false }
  }, [])
  return s
}

/** 参考素材输入框（可粘一段百科 / 设定集 / 你自己写的备忘） */
export function RefsField({ value, onChange, minRows = 3 }: {
  value: string
  onChange: (v: string) => void
  minRows?: number
}) {
  return (
    <div>
      <div className="text-[11px] text-ink-400">参考素材（可留空）</div>
      <AutoTextarea
        value={value}
        onChange={onChange}
        minRows={minRows}
        maxHeight={200}
        placeholder="粘一段资料进来（百科摘要、设定集、你写的备忘都行）—— 模型会优先依据它，而不是凭印象编。"
      />
      <p className="mt-1 text-[10.5px] leading-relaxed text-ink-500">
        想写冷门或原创题材时最有用的就是这一栏：模型对知名题材很熟，对冷门设定只会一本正经地编。
      </p>
    </div>
  )
}

/** 起草前提示「这次会用哪种素材来源」（提前告知，别等跑完才发现白跑） */
export function SearchPlanLine({ settings }: { settings: SearchSettings | null }) {
  if (!settings) return null
  const blocked = searchBlockedReason(settings)
  return (
    <p className="text-[10.5px] leading-relaxed text-ink-500">
      素材来源：<span className="text-ink-300">{SEARCH_MODE_LABEL[settings.mode]}</span>
      {blocked && <span className="ml-1 text-amber">⚠️ {blocked}</span>}
    </p>
  )
}

/** 起草**之后**如实报告这次用了什么（含失败原因，绝不静默） */
export function DraftSourceLine({ source }: { source: DraftSource | null }) {
  if (!source) return null
  return (
    <div className={`mt-1.5 rounded border px-2 py-1.5 text-[10.5px] leading-relaxed ${source.error
      ? 'border-amber/40 bg-amber/8 text-amber'
      : 'border-ink-700 bg-ink-900/50 text-ink-400'}`}>
      本次素材来源：<span className="text-ink-200">{source.label}</span>
      {source.used && !source.error && <span className="ml-1">· 已用上外部资料</span>}
      {!source.used && source.mode === 'off' && <span className="ml-1">· 未联网</span>}
      {source.note && <div className="mt-0.5 text-ink-500">{source.note}</div>}
      {source.error && <div className="mt-0.5">⚠️ {source.error}</div>}
    </div>
  )
}
