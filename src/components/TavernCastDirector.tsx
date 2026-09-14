/**
 * 酒馆模式 · 在场调度（路线图第 4 批 A6）
 *
 * 一个角色「说不说话」和「多爱说话」是场次级的设置，剧情推演与自由对话**都要有**，
 * 所以做成一个共用弹窗 —— 两处各写一份必然漂移（本项目反复踩过的坑）。
 *
 * 三件事：
 *   · 健谈度 0–100 → 写进提示词的「发言分量」（档名与说明取自 types.ts 的 TALK_BANDS，
 *     与提示词**共用同一份**文案，界面说的就是模型看的）；
 *   · 静音 = 在场但不发言（不删记忆、不删设定，别人可以提到 Ta）；
 *   · 点名（可选，自由模式用）：指定下一位由谁接话。
 *
 * 🔴 硬约束：**至少要留一个会说话的角色**。全静音会出现「AI 无角色可演」的怪状态 ——
 *   那不是用户想要的，只是他点顺手了。这里直接拦住并说明，不靠用户自己发现。
 */
import { Modal } from './Modal'
import { Button } from './Button'
import { showToast } from './dialogs'
import { TALK_BANDS, talkBandOf, DEFAULT_TALKATIVITY } from '../lib/tavern/types'

export type DirectorRow = {
  id: string
  name: string
  /** 角色定位标记：你演 / AI 演 / 在场 */
  tag: string
  /** 是否由 AI 演（用户演的角色不参与「发言分量」与点名） */
  speakable: boolean
}

export default function TavernCastDirector({
  open, rows, muted, talkativity, nextId, showNext, note,
  onToggleMute, onSetTalkativity, onPickNext, onClose,
}: {
  open: boolean
  rows: DirectorRow[]
  muted: string[]
  talkativity: Record<string, number>
  nextId?: string
  /** 是否显示「下一位」点名（只有自由模式有多角色轮转的指定） */
  showNext?: boolean
  note?: string
  onToggleMute: (id: string, next: boolean) => void
  onSetTalkativity: (id: string, v: number) => void
  onPickNext?: (id: string) => void
  onClose: () => void
}) {
  const speakable = rows.filter(r => r.speakable)
  const speakers = speakable.filter(r => !muted.includes(r.id))

  const toggle = (id: string, next: boolean) => {
    // 拦在最后一步：全静音 = 没人能开口，只会让下一轮生成出一段奇怪的东西
    if (next && speakers.length === 1 && speakers[0]?.id === id) {
      showToast('至少要留一个会说话的角色 —— 想换人说话，可以先取消别人的静音', 'info')
      return
    }
    onToggleMute(id, next)
  }

  return (
    <Modal open={open} onClose={onClose} title="在场调度" width="lg">
      <p className="text-[11.5px] text-ink-400 leading-relaxed">
        这里是**这一场**的临时安排：谁不开口、谁话多。不会改动角色卡，也不会删掉记忆 ——
        静音的人依然算在场（提示词里会写明「Ta 在、但这一句不是 Ta 说的」），只是这一轮不发言。
      </p>

      {/* 角色多时列表自己滚，别把弹窗顶出屏幕 */}
      <div className="mt-3 max-h-[50vh] space-y-2 overflow-y-auto pr-0.5">
        {rows.map(r => {
          const isMutedNow = muted.includes(r.id)
          const val = talkativity[r.id] ?? DEFAULT_TALKATIVITY
          const band = talkBandOf(val)
          const disabled = !r.speakable
          return (
            <div
              key={r.id}
              className={`rounded-md border p-2.5 ${isMutedNow || disabled
                ? 'border-ink-800 bg-ink-900/40'
                : 'border-ink-700 bg-ink-850/40'}`}
            >
              <div className="flex items-center gap-2">
                <span className={`min-w-0 flex-1 truncate text-[12.5px] ${isMutedNow || disabled ? 'text-ink-500' : 'text-ink-100'}`}>
                  {r.name}
                </span>
                <span className="shrink-0 rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-ink-500">{r.tag}</span>
                {r.speakable && (
                  <>
                    {showNext && (
                      <button
                        type="button"
                        onClick={() => onPickNext?.(r.id)}
                        disabled={isMutedNow}
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10.5px] disabled:opacity-40 ${nextId === r.id
                          ? 'border-amber/50 bg-amber/15 text-amber'
                          : 'border-ink-700 text-ink-400 hover:text-amber'}`}
                        title="指定下一句由 Ta 接话（再点一次取消）"
                      >
                        {nextId === r.id ? '下一位 ✓' : '下一位'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => toggle(r.id, !isMutedNow)}
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10.5px] ${isMutedNow
                        ? 'border-ink-600 text-ink-400 hover:text-amber'
                        : 'border-ink-700 text-ink-400 hover:text-amber'}`}
                      title={isMutedNow ? '取消静音（恢复发言）' : '静音：这一场不开口，但仍在场'}
                    >
                      {isMutedNow ? '已静音' : '静音'}
                    </button>
                  </>
                )}
              </div>

              {r.speakable && !isMutedNow && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 text-[10.5px] text-ink-500">健谈度</span>
                  <select
                    value={String(val)}
                    onChange={e => onSetTalkativity(r.id, Number(e.target.value))}
                    className="shrink-0 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-100 outline-none focus:border-amber/50"
                  >
                    {TALK_BANDS.map(b => (
                      <option key={b.name} value={String(midOf(b.min, b.max))}>{b.name}</option>
                    ))}
                  </select>
                  <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink-500" title={band.line}>
                    {band.line}
                  </span>
                </div>
              )}

              {r.speakable && isMutedNow && (
                <p className="mt-1.5 text-[10.5px] text-ink-600 leading-relaxed">
                  在场但不发言 —— 这一场不开口，Ta 的角色卡与记忆也不占上下文。
                  （想让 Ta 对场面有反应，就别静音。）
                </p>
              )}
            </div>
          )
        })}
      </div>

      {note && <p className="mt-3 text-[10.5px] text-ink-600 leading-relaxed">{note}</p>}

      <div className="mt-4 flex justify-end">
        <Button variant="secondary" size="md" onClick={onClose}>完成</Button>
      </div>
    </Modal>
  )
}

/** 档位的代表值（取中点，落到该档区间内） */
function midOf(min: number, max: number): number {
  if (min === 0 && max === 19) return 10
  if (max === 100) return 90
  return Math.round((min + max) / 2)
}
