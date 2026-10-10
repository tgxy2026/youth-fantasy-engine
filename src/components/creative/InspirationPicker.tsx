/**
 * 创意写作 · 灵感选取（2.5.2 · A2）
 *
 * 「从灵感夹选灵感注入本章提示词」的入口：按钮显示已选条数，展开后勾选灵感夹条目。
 *
 * 🔴 两条不能破的：
 * · **只读**：灵感夹的增删改只在灵感启发页——这里只 loadBox 读取 + 勾选，绝不写回；
 * · 注入口径在 autoContinue.ts 的灵感段头写死（「供参考、不要求全部体现、细纲优先」），
 *   本组件不管提示词。
 *
 * 勾选结果以**文本数组**回传（不是 id）：灵感条目可能被作者在灵感页删除，
 * 文本形态在开跑时快照仍然有效。
 */
import { useEffect, useState } from 'react'
import { Check, Lightbulb } from 'lucide-react'
import { loadBox, type InspirationItem } from '@/lib/creative/inspirationBox'
import { Button } from '@/components/common/Button'

export default function InspirationPicker({ disabled, selected, onChange }: {
  disabled: boolean
  /** 已选中的灵感文本（= inp.inspirations） */
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [items, setItems] = useState<InspirationItem[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => { void loadBox().then(setItems) }, [])

  const toggle = (text: string) => {
    onChange(selected.includes(text) ? selected.filter(t => t !== text) : [...selected, text])
  }

  return (
    <div>
      <Button variant="toggle" selected={selected.length > 0} disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className="rounded-lg"
        title={items.length === 0
          ? '灵感夹还是空的 —— 去「灵感启发」页记几条，写章时就能带上了'
          : '展开灵感夹条目，勾选的会作为「作者灵感」写进每章提示词（供参考，不要求全部体现）'}>
        <Lightbulb size={12} className="mr-1" />
        作者灵感：{selected.length > 0 ? `已选 ${selected.length} 条` : '未选择'}
      </Button>

      {open && (
        <div className="mt-2 space-y-1.5 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
          {items.length === 0 ? (
            <div className="text-11 text-ink-500">
              灵感夹还是空的 —— 去「灵感启发」页记几条，写章时就能带上了。
            </div>
          ) : (
            items.map((it, idx) => {
              const on = selected.includes(it.text)
              return (
                <button key={it.id} type="button" disabled={disabled}
                  onClick={() => toggle(it.text)}
                  className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                    on ? 'border-amber/40 bg-amber/5' : 'border-ink-700 bg-ink-800/60 hover:border-ink-600'
                  }`}>
                  <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded ${
                    on ? 'bg-amber text-ink-950' : 'border border-ink-600'
                  }`}>
                    {on && <Check size={10} />}
                  </span>
                  <span className={`flex-1 text-11 leading-relaxed break-all ${on ? 'text-ink-100' : 'text-ink-300'}`}>{it.text}</span>
                  <span className="shrink-0 text-10 text-ink-600 tabular-nums">#{idx + 1}</span>
                </button>
              )
            })
          )}
          {selected.length > 0 && (
            <div className="pt-1 text-10 text-ink-500">
              已选灵感会写进每章提示词的「作者灵感」段 —— 供参考，不要求全部体现；与细纲冲突时以细纲为准。
            </div>
          )}
        </div>
      )}
    </div>
  )
}
