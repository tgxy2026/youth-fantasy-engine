/**
 * 创作参考选择器（3.6.0 · C 包首期）
 *
 * 🔴 三条界面纪律（与 `lib/creative/reference.ts` 的口径一致）：
 *  1. **默认不勾选**：进面板不预选任何卡；作者勾了才会随本次请求发送。
 *  2. **过期不可选**：`stale` 卡只展示原因，勾选框禁用 —— 它可能指的是旧正文。
 *  3. **发送量可核**：底部实时显示 `将发送 N 张（约 X 字）`，被剔除的卡也要说清楚原因。
 */
import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Modal } from '@/components/dialogs/Modal'
import { getCurrentProjectId } from '@/lib/db/core'
import { loadArtefacts } from '@/lib/artefacts/store'
import {
  REFERENCE_STALE_HINT, buildReferenceBlock, describeReferenceBlock, dimensionLabelOf,
  referenceCardsOf, type ReferenceCard,
} from '@/lib/creative/reference'
import {
  REFERENCE_SENT_NOTE, REFERENCE_STAGE_LABEL, loadReferenceSends, type ReferenceSendRecord,
} from '@/lib/creative/referenceLog'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function ReferencePicker({ selected, onChange, disabled }: {
  selected: readonly string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [cards, setCards] = useState<ReferenceCard[] | null>(null)
  const [err, setErr] = useState('')
  /** 3.6.0 · C：最近几次「实际发出去的参考文字」（发送前预览 ≠ 真正发出） */
  const [sends, setSends] = useState<ReferenceSendRecord[]>([])
  const [sendErr, setSendErr] = useState('')

  useEffect(() => {
    let cancelled = false
    const pid = getCurrentProjectId()
    void loadArtefacts(pid).then(r => {
      if (cancelled) return
      setCards(referenceCardsOf(r.store))
      setErr(r.error ?? '')
    })
    void loadReferenceSends(pid).then(r => {
      if (cancelled) return
      setSends(r.list)
      setSendErr(r.error ?? '')
    })
    return () => { cancelled = true }
  }, [])

  const preview = useMemo(
    () => buildReferenceBlock(cards ?? [], selected),
    [cards, selected],
  )

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]
    onChange(next)
  }

  return (
    <>
      <Button variant="toggle" selected={selected.length > 0} disabled={disabled}
        onClick={() => setOpen(true)} className="rounded-lg"
        title="从「作品分析」保存的成果里挑几条写法参考带进本章提示词；默认不勾选">
        <BookOpen size={12} className="mr-1" />
        创作参考：{selected.length ? `已选 ${selected.length} 张` : '未选'}
      </Button>

      {open && (
        <Modal open onClose={() => setOpen(false)} title="创作参考（只影响本次请求）"
          icon={<BookOpen size={16} />} width={720} maxHeight="80vh"
          footer={<>
            <span className="text-10 text-ink-500">{describeReferenceBlock(preview)}</span>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>完成</Button>
          </>}>
          <div className="space-y-2.5">
            <p className="text-11 text-ink-400 leading-relaxed">
              参考来自「作品分析」保存的成果（默认都是<b className="text-ink-300">草稿</b>，未审也带「未审」标记）。
              它们只是<b className="text-ink-300">写法参考</b>：发送时会明确告诉模型「非本项目原文、不要照搬情节与人名、不是设定」。
              <span className="block mt-1 text-ink-500">
                作者灵感、结构模板、知识库各有自己的入口，不会混进这份参考里 —— 这里只放「从别处作品学到的写法」。
              </span>
            </p>
            {err !== '' && <div role="alert" className="text-11 text-amber">成果读取失败：{err}（本次将不带参考）</div>}
            {cards === null && (
              <div className="flex items-center gap-2 py-6 justify-center text-ink-400">
                <Loader2 size={16} className="animate-spin text-amber" /><span className="text-12">读取中…</span>
              </div>
            )}
            {cards !== null && cards.length === 0 && (
              <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-6 text-center text-12 text-ink-500">
                还没有可用的创作参考。
                <div className="text-11 mt-1">先到「一键拆书 → 作品分析（只分析）」跑一轮，点「保存为成果」后就会出现在这里。</div>
              </div>
            )}
            {cards !== null && cards.length > 0 && (
              <ul className="space-y-1.5">
                {cards.map(c => {
                  const on = selected.includes(c.artefactId)
                  return (
                    <li key={c.artefactId}
                      className={`rounded-lg border px-3 py-2 text-11 ${
                        on ? 'border-amber/40 bg-amber/10' : 'border-ink-700/60 bg-ink-900/40'}`}>
                      <label className={`flex items-start gap-2 ${c.stale ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                        <input type="checkbox" checked={on} disabled={c.stale}
                          onChange={() => toggle(c.artefactId)} className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-ink-100 font-medium">{c.title}</span>
                            <span className="text-10 text-ink-500">{dimensionLabelOf(c.dimension || '')}</span>
                            <span className={`text-10 ${c.claim === 'observed' && c.evidenceVerified ? 'text-success' : 'text-amber'}`}>
                              {c.claim === 'observed' && c.evidenceVerified ? '有依据' : '推测'}
                            </span>
                            {!c.kept && <span className="text-10 text-ink-500">未审</span>}
                            {c.stale && <span className="text-10 text-amber" title={REFERENCE_STALE_HINT}>已过期（不可选）</span>}
                          </span>
                          <span className="mt-0.5 block text-ink-300 whitespace-pre-wrap">{c.content.slice(0, 200)}</span>
                          <span className="mt-0.5 block text-10 text-ink-500">来源：{c.sourceLabel}</span>
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}

            {/* 3.6.0 · C：发送记录 —— 预览是"打算发什么"，这里才是"实际发出什么" */}
            <details className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
              <summary className="text-11 text-ink-300 cursor-pointer">
                最近发送记录（{sends.length}）· 实际注入的文字
              </summary>
              <p className="mt-1 text-10 text-ink-500">{REFERENCE_SENT_NOTE}</p>
              {sendErr !== '' && <p className="text-10 text-amber">{sendErr}</p>}
              {sends.length === 0 ? (
                <p className="mt-1 text-10 text-ink-600">还没有发送过创作参考。</p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {sends.slice(0, 3).map(r => (
                    <li key={r.id} className="text-11 leading-relaxed">
                      <div className="flex flex-wrap items-center gap-x-2 text-10 text-ink-400">
                        <span>{fmtTime(r.at)}</span>
                        <span>{REFERENCE_STAGE_LABEL[r.stage]}</span>
                        <span>{r.usedIds.length} 张 · {r.chars} 字</span>
                        <span>{r.channel === 'acp' ? 'Agent 通道' : r.channel === 'api' ? 'API 模型' : '通道未记录'}</span>
                        {r.dropped.length > 0 && <span className="text-amber">剔除 {r.dropped.length} 张</span>}
                      </div>
                      <details className="mt-0.5">
                        <summary className="text-10 text-ink-500 cursor-pointer">看实际发送的文字</summary>
                        <pre className="mt-1 whitespace-pre-wrap text-10 text-ink-400 leading-relaxed">{r.text}</pre>
                      </details>
                    </li>
                  ))}
                  {sends.length > 3 && <li className="text-10 text-ink-600">另有 {sends.length - 3} 次更早的发送记录</li>}
                </ul>
              )}
            </details>
          </div>
        </Modal>
      )}
    </>
  )
}
