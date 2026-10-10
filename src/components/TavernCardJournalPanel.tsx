/**
 * 角色卡片 · **「Ta 的日记」**（2026-09-19 D4-4，从 `TavernCard.tsx` 拆出）。
 *
 * 🔴 与记忆的**根本区别：日记不进 AI 上下文**。所以它可以写细、可以让人读，
 *   而记忆必须压成干巴巴的条目。界面上必须把这点讲清，否则作者会以为「日记也喂给 AI」而不敢写长。
 *   另一处容易混的：记忆第六栏「最近日记」才是给 AI 看的（每轮进上下文、只能一行一事）。
 *
 * 🔴 **只读**（日记是 Ta 的，不给改）、**只有删除一个操作**、删掉不可恢复 —— 所以每条删除
 *   与清空都走弹窗确认；弹窗文案要把「不参与上下文、删了不会让 Ta 失忆」与
 *   「想留就先自己复制」一起写清。
 *
 * ⚠️ props 名与原局部变量**同名** ⇒ 内部 JSX 逐字未改（缩进保留原样，16 空格）。
 */
import { type Dispatch, type SetStateAction } from 'react'
import { Button } from './Button'
import { JOURNAL_KEEP, type CharJournal, type CharJournalEntry } from '../lib/tavern/types'

interface Props {
  /** 这本日记（没有日记时为 null） */
  journal: CharJournal | null
  /** 条目列表是否展开 */
  showJournal: boolean
  setShowJournal: Dispatch<SetStateAction<boolean>>
  /** 清空整本（不可撤销，内部会先弹窗确认） */
  clearJournal: () => Promise<void>
  /** 删单条（不可撤销，内部会先弹窗确认） */
  dropJournal: (entry: CharJournalEntry) => Promise<void>
}

export default function TavernCardJournalPanel({
  journal, showJournal, setShowJournal, clearJournal, dropJournal,
}: Props) {
  return (
    <>
                {/* 日记：每场对话结束时写的一条回顾（老大 2026-09-16 定）
                    🔴 与记忆的根本区别：日记**不进 AI 上下文**。所以它可以写细、
                       可以让人读，而记忆必须压成干巴巴的条目。界面上必须把这点讲清，
                       否则作者会以为「日记也喂给 AI」而不敢写长。 */}
                <section className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-13 font-semibold text-amber/90">Ta的日记</h3>
                      <p className="mt-0.5 text-11 text-ink-500 leading-relaxed">
                        每次点「结束本轮对话」时，由 Ta 以<span className="text-ink-400">第一人称</span>写一段 ——
                        记这一场发生了什么，以及 Ta 自己的感受。
                      </p>
                      <p className="mt-1 text-10 text-ink-600 leading-relaxed">
                        🔒 <span className="text-ink-500">只读</span>（日记是 Ta 的，不给改）；
                        它<span className="text-ink-400">从来不参与 AI 上下文</span>，随便翻、随便删都不会影响 Ta 的记忆。
                        只有「删除」一个操作 —— 删掉不可恢复。
                      </p>
                      <p className="mt-1 text-10 text-ink-600 leading-relaxed">
                        注意别和记忆里那一栏搞混：记忆的「六、最近日记」是给 AI 看的，每轮都进上下文、只能一行一事；
                        这里是给「你」看的回顾，写得越细越好。
                      </p>
                      {!!journal?.entries.length && (
                        <p className="mt-1 text-10 text-ink-600">
                          共 {journal.entries.length} 条
                          {journal.entries.length >= JOURNAL_KEEP
                            ? `（已到上限 ${JOURNAL_KEEP} 条：再写新的会滚掉最老的一条）`
                            : `（最多留 ${JOURNAL_KEEP} 条，超出滚掉最老的）`}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setShowJournal(v => !v)}>
                        {showJournal ? '收起' : '展开'}
                      </Button>
                      {!!journal?.entries.length && (
                        <Button variant="danger" size="sm" onClick={() => void clearJournal()}
                          title="删掉这本日记的全部条目（不可撤销，会先弹窗确认）">
                          清空日记
                        </Button>
                      )}
                    </div>
                  </div>

                  {!journal?.entries.length ? (
                    <p className="mt-2 text-11 text-ink-500">
                      还没有日记。去「自由对话」聊一场，点「结束本轮对话」就会记下第一段。
                    </p>
                  ) : !showJournal ? (
                    <p className="mt-2 text-11 text-ink-400">
                      共 {journal.entries.length} 条 ·
                      最近一次 {new Date(journal.entries[0].at).toLocaleString('zh-CN')} ·
                      「{journal.entries[0].sessionTitle}」
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-2.5">
                      {journal.entries.map(e => (
                        <li key={e.id} className="rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 text-10 text-ink-500">
                              <span>{new Date(e.at).toLocaleString('zh-CN')}</span>
                              {e.sessionTitle && <span className="ml-1.5 text-ink-400">「{e.sessionTitle}」</span>}
                              {e.cast.length > 0 && <span className="ml-1.5">在场：{e.cast.join('、')}</span>}
                            </div>
                            <Button
                              variant="secondary" size="xs" className="shrink-0"
                              title="删掉这一条（不可恢复，会先弹窗确认）"
                              onClick={() => void dropJournal(e)}
                            >
                              删除
                            </Button>
                          </div>
                          <p className="mt-1 text-12 text-ink-200 whitespace-pre-wrap leading-relaxed">{e.text}</p>
                          <p className="mt-1 text-10 text-ink-600">（Ta 的第一人称回顾 · 只读）</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
    </>
  )
}
