/**
 * 酒馆模式 · 临时导演指令条 + 输出后处理命中提示（路线图 B2 / B3，老大 2026-09-14 接受）
 *
 * 【为什么两页共用一个组件】指令条本身是同一套交互（设置 / 编辑 / 清除 / 倒计时显示），
 * 两页各写一份必然慢慢漂移 —— 这是本项目反复踩过的坑（正文渲染、在场调度都因此抽过共享件）。
 *
 * 【两件事为什么放一起】都贴着输入框、都是「跟这一轮生成有关」的即时反馈：
 *   · 上面一行：这一场有没有临时导演指令、还剩几轮；
 *   · 下面一行：上一轮生成时后处理规则改了什么（改了几处、哪条正则写坏了）。
 * 分成两个组件反而会让输入区上方堆出一串小条。
 */
import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import AutoTextarea from './AutoTextarea'
import type { TavernDirectorNote } from '../lib/tavern/types'
import type { PostApplied } from '../lib/tavern/postRules'

export default function TavernDirectorNoteBar({
  note, postApplied, postErrors, disabled, onSave, onClear,
}: {
  note?: TavernDirectorNote
  /** B3：上一轮实际命中的规则（开关关掉时引擎会返回空数组） */
  postApplied: PostApplied[]
  /** B3：正则写错被跳过的规则名（有它就该去面板上改） */
  postErrors: string[]
  disabled?: boolean
  onSave: (n: TavernDirectorNote) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [depth, setDepth] = useState(4)
  const [turns, setTurns] = useState(3)

  // 每次打开都从当前值重建草稿（关掉即丢弃，不留上次没提交的草稿）
  useEffect(() => {
    if (!open) return
    setText(note?.text ?? '')
    setDepth(note?.depth ?? 4)
    setTurns(note?.turnsLeft ?? 3)
  }, [open, note])

  const active = !!note?.text?.trim()

  return (
    <div className="mb-2 space-y-1">
      <div className="flex items-center gap-2 text-[11px]">
        {active ? (
          <>
            <span className="shrink-0 rounded border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-amber">
              导演指令 · 还剩 {note?.turnsLeft ?? 0} 轮
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-300" title={note?.text}>
              {note?.text}
            </span>
            <Button variant="secondary" size="xs" disabled={disabled} onClick={() => setOpen(true)} className="shrink-0"
            >编辑</Button>
            <Button variant="danger" size="xs" disabled={disabled} onClick={onClear} className="shrink-0"
            >清除</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="xs" disabled={disabled} onClick={() => setOpen(true)} className="shrink-0"
            >＋ 导演指令</Button>
            <span className="min-w-0 flex-1 truncate text-ink-600">
              临时给接下来几轮加一条指令（如「这场戏节奏放慢」「让洛汐先开口」）—— 不改角色卡，用完自动失效
            </span>
          </>
        )}
      </div>

      {(postApplied.length > 0 || postErrors.length > 0) && (
        <div className="text-[10.5px] leading-relaxed">
          {postApplied.length > 0 && (
            <span className="text-ink-500">
              已按规则修正：{postApplied.map(a => `${a.name}${a.count > 1 ? ` ×${a.count}` : ''}`).join('、')}
            </span>
          )}
          {postApplied.length > 0 && postErrors.length > 0 && <span className="text-ink-600"> · </span>}
          {postErrors.length > 0 && (
            <span className="text-amber">
              ⚠️ 规则正则无效、已跳过：{postErrors.join('、')}（去控制面板 · 输出后处理里改）
            </span>
          )}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="临时导演指令" width="lg">
        <p className="text-[11.5px] text-ink-400 leading-relaxed">
          这条指令会按**深度**插进对话历史（越靠近生成点影响越大），只影响接下来设定的轮数。
          它走协议的元指令通道，模型照做后继续演，**不会**被当成角色说过的话记进记忆。
        </p>

        <div className="mt-3">
          <div className="text-[11.5px] text-ink-200">指令内容</div>
          <AutoTextarea
            className="mt-1 bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-ink-100 outline-none focus:border-amber/50"
            textClass="text-[12.5px]"
            minRows={3}
            maxHeight={160}
            placeholder="例：这一段节奏放慢，多写几句环境；让洛汐先开口，别急着把话说透。"
            value={text}
            onChange={setText}
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div className="text-[11.5px] text-ink-200">插在第几条之前</div>
            <input
              type="number" min={1} max={40} value={depth}
              onChange={e => setDepth(Math.max(1, Number(e.target.value) || 1))}
              className="mt-1 w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[12px] text-ink-100 outline-none focus:border-amber/50"
            />
            <p className="mt-1 text-[10.5px] text-ink-500 leading-relaxed">
              倒数第几条。1 = 紧贴生成点；默认 4 —— 贴死末尾会盖过你刚说的那句。
            </p>
          </div>
          <div>
            <div className="text-[11.5px] text-ink-200">生效轮数</div>
            <input
              type="number" min={1} max={50} value={turns}
              onChange={e => setTurns(Math.max(1, Number(e.target.value) || 1))}
              className="mt-1 w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[12px] text-ink-100 outline-none focus:border-amber/50"
            />
            <p className="mt-1 text-[10.5px] text-ink-500 leading-relaxed">
              每成功生成一轮减 1，扣到 0 自动清除。取消或失败不扣。
            </p>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-ink-800 pt-3">
          {active && (
            <Button variant="secondary" size="md" onClick={() => { onClear(); setOpen(false) }}>清除指令</Button>
          )}
          <Button variant="secondary" size="md" onClick={() => setOpen(false)}>取消</Button>
          <Button
            variant="primary" size="md"
            disabled={!text.trim()}
            onClick={() => { onSave({ text: text.trim(), depth, turnsLeft: turns }); setOpen(false) }}
          >
            应用
          </Button>
        </div>
      </Modal>
    </div>
  )
}
