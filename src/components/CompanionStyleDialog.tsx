import { useEffect, useState } from 'react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import AutoTextarea from '@/components/AutoTextarea'
import { StyleProfilePicker } from '@/components/StyleProfilePicker'
import {
  STYLE_GROUPS, STYLE_DIM_BY_ID, conflictsOf, activeConflicts, isDiluted,
  STYLE_DILUTE_AT, dimLabels, type StyleGroup,
} from '@/lib/companionStyle'

export interface CompanionStyleValue {
  /** 勾选的维度 id */
  dims: string[]
  /** 作者一句话自定义（默认空白） */
  note: string
}

/**
 * 伴写「文风补充」设置窗（2.6.4）。
 *
 * 三块：A/B/C 三组多维多选 → 冲突提示 → 一句话自定义（默认空白，可编辑）。
 * 存下来是**本机全局**记忆：换项目不重置，作者自己按新书调（老大 2026-10-02 定）。
 *
 * 🔴 两条界面纪律（别改）：
 *   · 互斥项**只提示不禁用** —— 有人就是想要「整体白描、关键处铺陈」，硬拦住他没法表达；
 *   · 提示文案用「」，不用 markdown 星号 —— 这些文本在若干处是纯文本渲染的。
 */
export function CompanionStyleDialog({ open, value, onSave, onClose, ownerTab = 'editor' }: {
  open: boolean
  value: CompanionStyleValue
  onSave: (v: CompanionStyleValue) => void
  onClose: () => void
  /** 发起「提炼文风档」任务的页签 id（默认 `editor` —— 本窗基本是从正文编辑器打开的） */
  ownerTab?: string
}) {
  const [dims, setDims] = useState<string[]>(value.dims)
  const [note, setNote] = useState(value.note)

  // 每次打开都从外部（localStorage）重新取值：弹窗不是受控的持久态，
  // 否则「打开→改一半→取消→再打开」会看到上一次没保存的残留。
  useEffect(() => {
    if (!open) return
    setDims(value.dims)
    setNote(value.note)
  }, [open, value.dims, value.note])

  const toggle = (id: string) => {
    setDims(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

  const conflicts = activeConflicts(dims)
  const diluted = isDiluted(dims)
  const dirty = dims.join(',') !== value.dims.join(',') || note !== value.note

  return (
    <>
    <Modal open={open} onClose={onClose} title="伴写文风补充" width="md">
      <div className="space-y-3">
        <p className="text-ink-400 text-12 leading-relaxed">
          勾选本次想让 AI 帮你补的方面 —— 伴写会往这些方向落笔。没勾的方面保持前文既有写法，不会刻意加戏。
        </p>

        {/* 文风档（#015）：与下面的「本次侧重」互不覆盖 —— 一条管「作者一贯什么味道」，一条管「这次往哪偏」 */}
        <StyleProfilePicker ownerTab={ownerTab} hint="按你提炼的文风落笔；与下面的侧重互不覆盖" />

        {STYLE_GROUPS.map((g: StyleGroup) => (
          <div key={g.id} className="space-y-1.5">
            <div className="flex items-baseline gap-1.5">
              <span className="text-ink-200 text-12 shrink-0">{g.label}</span>
              <span className="text-ink-500 text-10 truncate">{g.desc}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map(it => {
                const on = dims.includes(it.id)
                // 互斥提示：勾中它、且与它互斥的那项也已勾选 → 边框转琥珀并给出理由
                const clash = on ? conflictsOf(dims, it.id) : []
                return (
                  <Button key={it.id} variant="toggle" size="xs" selected={on}
                    onClick={() => toggle(it.id)}
                    className={clash.length ? 'ring-1 ring-amber/60' : ''}
                    title={clash.length
                      ? `与「${dimLabels(clash)}」互斥 —— 两者会互相抵消，确认要同时保留吗？`
                      : it.hint}>
                    {it.label}
                  </Button>
                )
              })}
            </div>
          </div>
        ))}

        {/* 冲突汇总：只在真的同时勾了互斥对时出现（互斥只提示，不禁用） */}
        {conflicts.length > 0 && (
          <div className="text-11 text-amber/90 bg-amber/10 border border-amber/30 rounded px-2 py-1.5 leading-relaxed">
            已同时勾选：{conflicts.map(([a, b], i) => (
              <span key={i}>「{STYLE_DIM_BY_ID[a]?.label}」与「{STYLE_DIM_BY_ID[b]?.label}」{i < conflicts.length - 1 ? '、' : ''}</span>
            ))}—— 它们会互相抵消，一般留一个更准。确实想要「整体一项、关键处另一项」也可以都留着。
          </div>
        )}

        {/* 稀释提示：伴写一次只续一两句话，侧重太多等于没选 */}
        {diluted && (
          <div className="text-11 text-ink-400 bg-ink-800/60 border border-ink-700 rounded px-2 py-1.5 leading-relaxed">
            已选 {dims.length} 项，超过 {STYLE_DILUTE_AT} 项后各方面会互相稀释 —— 一次只续一两句话，建议只留最想补的 1~{STYLE_DILUTE_AT} 项。
          </div>
        )}

        <div className="space-y-1 pt-1 border-t border-ink-700">
          <div className="flex items-baseline gap-1.5">
            <span className="text-ink-200 text-12 shrink-0">一句话补充</span>
            <span className="text-ink-500 text-10">可编辑，默认空白；填了就生效，与上面冲突时以你的原话为准</span>
          </div>
          <AutoTextarea
            value={note}
            onChange={setNote}
            minHeight={56}
            maxHeight={140}
            placeholder="例如：冷硬白描，少心理活动，多用短对白"
            className="!px-3 !py-2 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 focus:border-amber/40 outline-none placeholder:text-ink-600 w-full"
          />
        </div>

        <div className="text-ink-500 text-10 leading-relaxed">
          本机记忆，换章不重置、换项目也不重置 —— 换书后请自己按新书调一次。
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-ink-700">
          <Button variant="secondary" size="sm" onClick={() => { setDims([]); setNote('') }}
            disabled={!dims.length && !note}>
            清空
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
            <Button variant="primary" size="sm" disabled={!dirty} onClick={() => onSave({ dims, note })}>
              保存
            </Button>
          </div>
        </div>
      </div>
    </Modal>
    </>
  )
}
