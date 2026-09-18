/**
 * 酒馆模式 · 设定更新裁决弹窗（2026-09-14，老大要求）
 *
 * AI 从对话里读出「角色设定可能该改了」，把每一条摊在作者面前，**逐条裁决**。
 *
 * 【为什么是"列出来"而不是"自动改"】
 * 记忆记错了只影响一段回忆；设定改错了，之后**每一轮**对话都从错的人设出发，
 * 而且表现只是"最近有点怪"，很难反推到是卡改错了。所以设定这一侧**只建议、不自动写**。
 *
 * 【为什么每条都要给「来源原句」】
 * 作者裁决时真正需要的是"凭什么这么说"。没有原句，他只能凭记忆猜 —— 那就等于让他去读一遍对话，
 * 这个功能也就白做了。
 */
import { foldVh } from '../lib/theme'
import { Modal } from './Modal'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import type { CardRevision } from '../lib/tavern/revise'

export default function TavernRevisionDialog({
  open, loading, applying, proposals, picked, error, onToggle, onToggleAll, onApply, onRetry, onClose,
}: {
  open: boolean
  loading: boolean
  applying: boolean
  proposals: CardRevision[]
  /** 检查失败的原因（模型不可用 / 超时…）。⚠️ 有它时不能显示「没有需要改设定」——
   *  那会把「没查成」说成「不用改」，作者会以为自己这段对话真的没问题。 */
  error?: string
  picked: Set<string>
  onToggle: (id: string) => void
  onToggleAll: (next: boolean) => void
  onApply: () => void
  onRetry: () => void
  onClose: () => void
}) {
  const allPicked = proposals.length > 0 && picked.size === proposals.length
  // 按角色分组 —— 关系是双向的，一次分手会同时出现在两张卡上，分组后一眼能看出「两边都动了」
  const byChar = new Map<string, CardRevision[]>()
  for (const p of proposals) {
    const arr = byChar.get(p.charName) ?? []
    arr.push(p)
    byChar.set(p.charName, arr)
  }

  return (
    <Modal open={open} onClose={onClose} title="更新设定" width="2xl">
      <p className="text-11 text-ink-400 leading-relaxed">
        下面是从这段对话里读出的「角色设定可能该改了」。采纳之前不会动任何角色卡 ——
        你可以逐条勾选，也可以整条跳过。记忆（Ta 记得什么）与设定（Ta 是谁）是分开的：
        前者归记忆整理（自由对话点「结束本轮对话」、剧情推演点「整理本场记忆」时更新），这里改的是角色卡本身。
      </p>

      {error && !loading ? (
        <div className="mt-4 rounded-md border border-red-400/30 bg-red-400/5 p-4">
          <p className="text-12 text-red-400">检查失败</p>
          <p className="mt-1 break-all text-11 text-ink-300 leading-relaxed">{error}</p>
          <p className="mt-1.5 text-11 text-ink-500 leading-relaxed">
            常见原因：没配模型、模型服务没开、或超时。修好后点「重新检查」即可 —— 对话与角色卡都没动。
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" size="sm" onClick={onRetry}>重新检查</Button>
            <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
          </div>
        </div>
      ) : loading ? (
        <div className="mt-4">
          <LoadingState text="正在读这一段对话…" />
          <p className="mt-2 text-11 text-ink-500 text-center">
            会逐个角色过一遍（关系变化通常要在两张卡上都改）。
          </p>
        </div>
      ) : proposals.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed border-ink-700 bg-ink-850/20 p-4 text-center">
          <p className="text-12 text-ink-300">这一段对话没有需要改设定</p>
          <p className="mt-1.5 text-11 text-ink-500 leading-relaxed">
            这是正常结果 —— 大多数日常对话都不会改变「Ta 是谁」。<br />
            若刚发生了关系转折（分手、表白、决裂），可以点下面的「重新检查」再跑一次。
          </p>
          <div className="mt-3 flex justify-center gap-2">
            <Button variant="secondary" size="sm" onClick={onRetry}>重新检查</Button>
            <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="secondary" size="xs"
              onClick={() => onToggleAll(!allPicked)}
            >
              {allPicked ? '全不选' : '全选'}
            </Button>
            <span className="text-11 text-ink-500">
              共 {proposals.length} 处建议 · 已选 {picked.size} 处
            </span>
          </div>

          <div className="mt-2 space-y-3 overflow-y-auto pr-0.5"
style={{ maxHeight: foldVh('52vh') }}>
            {[...byChar].map(([charName, list]) => (
              <div key={charName}>
                <div className="text-11 text-amber/80">{charName}</div>
                <div className="mt-1.5 space-y-2">
                  {list.map(p => {
                    const on = picked.has(p.id)
                    return (
                      <label
                        key={p.id}
                        className={`block cursor-pointer rounded-md border p-2.5 ${on ? 'border-amber/40 bg-amber/5' : 'border-ink-800 bg-ink-900/40'}`}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-0.5 shrink-0 accent-amber"
                            checked={on}
                            onChange={() => onToggle(p.id)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-12 text-ink-100">{p.fieldLabel}</span>
                              <span className="rounded border border-ink-700 px-1 py-0.5 text-10 text-ink-500">
                                {p.field}
                              </span>
                            </div>

                            <div className="mt-1.5 space-y-1">
                              <div className="rounded border border-ink-800 bg-ink-900/50 p-1.5">
                                <div className="text-10 text-ink-600">现在</div>
                                <div className="mt-0.5 max-h-20 overflow-y-auto whitespace-pre-wrap text-11 text-ink-400 leading-relaxed">
                                  {p.before || '（现为空）'}
                                </div>
                              </div>
                              <div className="rounded border border-amber/25 bg-amber/5 p-1.5">
                                <div className="text-10 text-amber/70">改成</div>
                                <div className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap text-11 text-ink-200 leading-relaxed">
                                  {p.after}
                                </div>
                              </div>
                            </div>

                            {p.narrative && (
                              <p className="mt-1.5 rounded border border-amber/30 bg-amber/5 px-1.5 py-1 text-10 text-amber/90 leading-relaxed">
                                ⚠️ 这条里混进了对话原文（「{p.narrative.length > 26 ? p.narrative.slice(0, 26) + '…' : p.narrative}」）。
                                设定只留「现在算什么关系、Ta 成了谁」，「发生过什么」归记忆 —— 建议先把那段删掉再采纳。
                              </p>
                            )}

                            <p className="mt-1.5 text-10 text-ink-500 leading-relaxed">
                              理由：{p.reason}
                            </p>
                            {p.quote && (
                              <p className="mt-0.5 text-10 text-ink-600 leading-relaxed">
                                来源：「{p.quote}」
                              </p>
                            )}
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between gap-2 border-t border-ink-800 pt-3">
            <p className="text-10 text-ink-600 leading-relaxed">
              采纳是整段替换该字段（不会追加），角色卡的其它部分原样保留。
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="secondary" size="md" disabled={applying} onClick={onRetry}>重新检查</Button>
              <Button variant="secondary" size="md" disabled={applying} onClick={onClose}>取消</Button>
              <Button variant="primary" size="md" disabled={applying || picked.size === 0} onClick={onApply}>
                {applying ? '写入中…' : `采纳选中的 ${picked.size} 处`}
              </Button>
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}
