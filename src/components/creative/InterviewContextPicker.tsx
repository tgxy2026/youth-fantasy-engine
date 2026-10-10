/**
 * 对话引导 · 「带哪些设定一起聊」的选择面板（2026-10-03）
 *
 * 🔴 为什么要它：对话引导原先**完全不带**母级设定（作者无感知），而一次性全灌又会把
 *    作者的脑子一次掏空。折中＝列成清单让作者**自己勾**。
 * 配套：`InterviewChat` 的 `context` prop（提示词里那段「既有设定（回答要与它一致）」）。
 */
import { Loader2 } from 'lucide-react'

export interface ContextChoice {
  key: string
  label: string
  /** 这一项带过去的是什么 —— 让作者知道自己在勾什么 */
  hint: string
}

export default function InterviewContextPicker({
  choices,
  picked,
  onToggle,
  onAll,
  onNone,
  busy,
  disabled,
}: {
  choices: ContextChoice[]
  picked: string[]
  onToggle: (key: string) => void
  onAll: () => void
  onNone: () => void
  /** 正在按勾选重建上下文（读库要一下，作者看得见在转） */
  busy?: boolean
  /** 当前页签没有兄弟条目可带时（此时 choices 只剩母级那几项） */
  disabled?: boolean
}) {
  if (choices.length === 0) {
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2 text-11 text-ink-500">
        这一页没有可参照的既有设定 —— 对话将只依据你当场说的内容展开。
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-11 text-ink-300 font-medium">带哪些既有设定一起聊</span>
        {busy && <Loader2 size={11} className="text-amber animate-spin" />}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onAll}
            className="text-10 text-ink-400 hover:text-ink-200 transition-colors"
            title="把列出的几项全部带进这次对话"
          >
            全选
          </button>
          <span className="text-ink-700">|</span>
          <button
            type="button"
            onClick={onNone}
            className="text-10 text-ink-400 hover:text-ink-200 transition-colors"
            title="不带任何既有设定（AI 只会照你当场说的写）"
          >
            清空
          </button>
        </span>
      </div>
      <div className="space-y-1">
        {choices.map(c => {
          const on = picked.includes(c.key)
          return (
            <label
              key={c.key}
              className={`flex items-start gap-2 px-1.5 py-1 rounded cursor-pointer select-none transition-colors ${disabled ? 'opacity-60' : 'hover:bg-ink-800/60'}`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={() => onToggle(c.key)}
                className="accent-amber mt-0.5"
              />
              <span className="min-w-0">
                <span className="text-12 text-ink-200">{c.label}</span>
                <span className="block text-10 text-ink-500 truncate" title={c.hint}>{c.hint}</span>
              </span>
            </label>
          )
        })}
      </div>
      <p className="mt-1.5 text-10 text-ink-500 leading-relaxed">
        勾上的内容会作为「既有设定」交给 AI，要求它的提问与补出来的内容与之一致。
        一次带太多会互相稀释、也白耗额度，建议只勾这次真用得上的。
      </p>
    </div>
  )
}
