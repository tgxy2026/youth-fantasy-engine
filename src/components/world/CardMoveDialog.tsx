/**
 * 「移动角色到其他页签」弹窗（3.1.3）。
 *
 * 【为什么要有这个弹窗，而不是列表右键直接搬】
 * 三张角色卡的字段集不同，移动**一定**涉及三件事：谁能带走、谁会消失、目标哪些栏会空着。
 * 这三件事必须让作者在按下按钮**之前**看见 —— 尤其「主要 → NPC」会一次性丢五六项深层设定，
 * 那是写了几十分钟的内容。所以：
 *   · 目标页签按「信息量」标出来（字段数、会丢几项）；
 *   · 会丢内容时**必须勾选知情**才能按下红色确认键（按钮本身也叫「仍要移动」）；
 *   · 不丢内容时（往信息更多的页签走）直接确认即可。
 *
 * 🔴 预览与实际落库都必须走 `planCardMove()` 同一份计算 —— 见 `lib/world/cardMove.ts` 头注。
 */
import { AlertTriangle, ArrowRight, Check, Info, Layers } from 'lucide-react'
import type { CardRecord, TabDef } from '@/lib/types'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { planCardMove } from '@/lib/world/cardMove'
import { useMemo, useState } from 'react'

interface Props {
  /** 当前卡（含未保存的草稿 —— 移动会把草稿一起带走，不要求作者先保存） */
  rec: CardRecord
  from: TabDef
  targets: TabDef[]
  onClose: () => void
  /** 由调用方落库；抛错则弹窗保持打开（作者可重试） */
  onConfirm: (to: TabDef) => Promise<void>
}

/** 值预览：宁可截短也不要撑爆弹窗，作者认得自己写的那几个字 */
function preview(v: string, max = 42): string {
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export default function CardMoveDialog({ rec, from, targets, onClose, onConfirm }: Props) {
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const plans = useMemo(
    () => targets.map(t => ({ tab: t, plan: planCardMove(from, t, rec) })),
    [targets, from, rec],
  )
  const chosen = plans.find(p => p.tab.id === chosenId) ?? null
  const lost = chosen?.plan.lost ?? []
  const needAck = lost.length > 0
  /**
   * 立绘位只挂在「基础信息」模块里（见 CharacterSheet 的 `isBasicMod`）。
   * NPC 卡的模块叫「NPC档案」，没有立绘位 ⇒ 数据搬得过去但界面上看不见。
   * 🔴 这一条必须明说：作者传了两张图，搬完发现"图没了"会以为丢了，实际上搬回来就还在。
   */
  const portraitHidden = !!chosen
    && !!(rec.portrait || rec.portrait2)
    && !(chosen.tab.modules ?? []).some(m => m.name.includes('基础信息'))

  const pick = (id: string) => {
    setChosenId(id)
    setAck(false)
    setErr('')
  }

  const run = async () => {
    if (!chosen || busy) return
    if (needAck && !ack) return
    setBusy(true)
    setErr('')
    try {
      await onConfirm(chosen.tab)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`移动「${rec.name}」到其他角色页签`}
      icon={<Layers size={15} />}
      accent="amber"
      width="xl"
      maxHeight="86vh"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose} disabled={busy}>取消</Button>
          <Button
            variant={needAck ? 'danger' : 'primary'}
            solid
            size="md"
            className="flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!chosen || busy || (needAck && !ack)}
            onClick={() => void run()}
          >
            {busy
              ? '移动中…'
              : !chosen
                ? '先选择目标页签'
                : needAck
                  ? `仍要移动（丢失 ${lost.length} 项）`
                  : `移动到「${chosen.tab.name}」`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-12 text-ink-300 leading-relaxed">
          移动会把这张卡连同立绘一起搬到目标页签，并按<b className="text-ink-100">字段名与字段含义</b>重新对应。
          目标页签没有的栏位，内容会直接消失；目标页签多出来的栏位保持空白。
        </p>

        {/* ── 目标页签 ── */}
        <div className="grid gap-2 sm:grid-cols-2">
          {plans.map(({ tab, plan }) => {
            const active = chosenId === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => pick(tab.id)}
                disabled={busy}
                className={`text-left rounded-xl border px-3 py-2.5 transition-colors ${
                  active
                    ? 'border-amber/50 bg-amber/10'
                    : 'border-ink-700 bg-ink-800/40 hover:border-ink-500'
                } disabled:opacity-60`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`text-13 font-medium ${active ? 'text-amber' : 'text-ink-100'}`}>{tab.name}</span>
                  {active && <Check size={12} className="text-amber" />}
                </div>
                <div className="mt-1 text-10 text-ink-500 tabular-nums">
                  {plan.toFieldCount} 个栏位 · 将带走 {plan.carried.length} 项
                </div>
                <div className={`mt-0.5 text-10 tabular-nums ${plan.lost.length ? 'text-danger' : 'text-ink-500'}`}>
                  {plan.lost.length ? `会丢失 ${plan.lost.length} 项` : plan.richer ? '信息更多，不丢内容' : '不丢内容'}
                </div>
              </button>
            )
          })}
        </div>

        {!chosen ? (
          <div className="rounded-xl border border-dashed border-ink-700 py-8 text-center text-12 text-ink-500">
            先选一个目标页签，这里会列出逐项对照
          </div>
        ) : (
          <>
            {/* ── 概况 ── */}
            <div className="rounded-xl border border-ink-700 bg-ink-800/40 px-3.5 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-11">
              <span className="text-ink-200">
                <b className="text-amber tabular-nums">{chosen.plan.carried.length}</b> 项带过去
              </span>
              <span className="text-ink-400">
                <b className="text-ink-200 tabular-nums">{chosen.plan.blank.length}</b> 项栏位留空
              </span>
              <span className={chosen.plan.lost.length ? 'text-danger' : 'text-ink-400'}>
                <b className="tabular-nums">{chosen.plan.lost.length}</b> 项丢失
              </span>
              <span className="text-ink-500 ml-auto">
                {from.name} {chosen.plan.fromFieldCount} 栏 <ArrowRight size={10} className="inline mx-0.5" />{' '}
                {chosen.tab.name} {chosen.plan.toFieldCount} 栏
              </span>
            </div>

            {/* ── 会丢失（红） ── */}
            {lost.length > 0 && (
              <div className="rounded-xl border border-danger/40 bg-danger/5 p-3">
                <div className="flex items-center gap-1.5 text-12 font-medium text-danger">
                  <AlertTriangle size={13} /> 这 {lost.length} 项在「{chosen.tab.name}」没有对应栏位
                </div>
                <p className="mt-1 text-11 text-ink-300 leading-relaxed">
                  移动后这些内容<b className="text-danger">直接消失、无法撤销</b>。需要保留的话，先复制到别处或改填进目标页签已有的栏位。
                </p>
                <ul className="mt-2 space-y-1">
                  {lost.map(item => (
                    <li key={item.field} className="text-11 leading-relaxed">
                      <span className="text-ink-100">{item.field}</span>
                      <span className="text-ink-500">：{preview(item.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ── 特殊处理说明（合并栏 / 超集栏） ── */}
            {(chosen.plan.notes.length > 0 || portraitHidden) && (
              <div className="rounded-xl border border-amber/25 bg-amber/5 p-3 space-y-1">
                {chosen.plan.notes.map((n, i) => (
                  <div key={i} className="text-11 text-amber/90 leading-relaxed flex items-start gap-1.5">
                    <Info size={11} className="mt-0.5 shrink-0" />
                    <span>{n}</span>
                  </div>
                ))}
                {portraitHidden && (
                  <div className="text-11 text-amber/90 leading-relaxed flex items-start gap-1.5">
                    <Info size={11} className="mt-0.5 shrink-0" />
                    <span>
                      「{chosen.tab.name}」没有立绘位（立绘挂在「基础信息」模块里）—— 图片数据会一起搬过去、不会丢，
                      但在这个页签看不到；搬回带「基础信息」的页签就会重新出现。
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* ── 带过去的（绿） ── */}
            {chosen.plan.carried.length > 0 && (
              <div>
                <h4 className="text-11 font-medium text-ink-300 mb-1.5">会一起带过去</h4>
                <div className="flex flex-wrap gap-1.5">
                  {chosen.plan.carried.map(c => (
                    <span
                      key={`${c.from}->${c.to}`}
                      className="rounded border border-emerald-700/40 bg-emerald-700/10 px-1.5 py-0.5 text-10 text-ink-200"
                    >
                      {c.from === c.to ? c.from : `${c.from} → ${c.to}`}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* ── 目标页签留空的栏位 ── */}
            {chosen.plan.blank.length > 0 && (
              <div>
                <h4 className="text-11 font-medium text-ink-300 mb-1.5">目标页签多出来的栏位（留空，可继续补）</h4>
                <p className="text-10 text-ink-500 leading-relaxed">{chosen.plan.blank.join('、')}</p>
              </div>
            )}

            {/* ── 二次确认 ── */}
            {needAck && (
              <label className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={e => setAck(e.target.checked)}
                  disabled={busy}
                  className="mt-0.5 accent-red-600"
                />
                <span className="text-11 text-ink-200 leading-relaxed">
                  我确认：上面 {lost.length} 项内容会随这次移动消失，且没有撤销。
                </span>
              </label>
            )}
          </>
        )}

        {err && (
          <div className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-11 text-danger leading-relaxed">
            移动失败：{err}
          </div>
        )}
      </div>
    </Modal>
  )
}
