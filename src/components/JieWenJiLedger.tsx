/**
 * 颉文姬 · 补登（本章新增设定实体）面板（C1 · 2.4.2 自 JieWenJi.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useJieWenJiModel（组件只收 m）。
 */
import { Loader2, RefreshCw, ExternalLink, Save } from 'lucide-react'
import { CARD_TABS } from '../lib/settingLedger'
import { TABS } from '../lib/schema'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { Button } from './Button'
import { LEDGER_TYPES, STATUS_META } from './jieWenJiParts'
import type { JieWenJiModel } from './useJieWenJiModel'

export default function JieWenJiLedger({ m }: { m: JieWenJiModel }) {
  const { aiReady, ledger, ledgerPicked, setLedgerPicked, ledgerSaving, runLedger, setLedgerTargetTab, commitLedger, jumpToEntry, content } = m
  return (
          <div className="space-y-2.5">
            <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="text-11 text-ink-300 leading-relaxed">
                  从本章正文抽出有专名的设定实体，与已有设定比对后分三档。
                  <span className="text-ink-500">「是否已登记」由程序按名称与别称精确比对，AI 只负责抽取，不会凭空编造。</span>
                </div>
                <Button onClick={runLedger}
                  disabled={!aiReady || ledger.loading || !content.trim()}
                  title={!aiReady ? AI_DISABLED_HINT : ledger.scannedAt ? '重新扫描本章正文' : '扫描本章正文'} variant="primary" size="md" className="shrink-0 flex items-center rounded">
                  {ledger.loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  {ledger.loading ? '扫描中' : ledger.scannedAt ? '重新扫描' : '扫描本章'}
                </Button>
              </div>
              {!aiReady && <div className="mt-1.5 text-10 text-ink-500">{AI_DISABLED_HINT}</div>}
            </div>

            {ledger.error && <div className="text-11 text-danger px-1">{ledger.error}</div>}

            {!ledger.loading && ledger.scannedAt > 0 && ledger.items.length === 0 && (
              <div className="rounded-lg border border-ink-700 bg-ink-900/30 px-3 py-4 text-center text-11 text-ink-500">
                本章没有抽出设定实体
              </div>
            )}

            {LEDGER_TYPES.map(type => {
              const list = ledger.items.filter(i => i.type === type)
              if (list.length === 0) return null
              return (
                <div key={type}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-11 text-amber font-medium">{type}</span>
                    <span className="text-10 text-ink-500">{list.length} 条</span>
                  </div>
                  <div className="space-y-1">
                    {list.map(it => {
                      const meta = STATUS_META[it.status]
                      return (
                        <div
                          key={it.key}
                          className={`rounded-lg border px-2 py-1.5 ${it.status === 'new' ? 'border-ink-600 bg-ink-900/50' : 'border-ink-700/60 bg-ink-900/20'}`}
                        >
                          <div className="flex items-start gap-1.5">
                            {it.status === 'new' ? (
                              <input
                                type="checkbox"
                                checked={ledgerPicked.has(it.key)}
                                onChange={e => setLedgerPicked(prev => {
                                  const n = new Set(prev)
                                  e.target.checked ? n.add(it.key) : n.delete(it.key)
                                  return n
                                })}
                                className="mt-3px shrink-0 accent-amber cursor-pointer"
                                title="勾选后一键补登"
                              />
                            ) : (
                              <span className="mt-3px w-3 shrink-0" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-12 text-ink-100">{it.name}</span>
                                <span className={`inline-block px-1 py-px rounded text-9 border ${meta.cls}`}>{meta.label}</span>
                                {it.status !== 'new' && it.matchedName && it.matchedName !== it.name && (
                                  <span className="text-10 text-ink-500">→ 已记为「{it.matchedName}」</span>
                                )}
                              </div>

                              {it.desc && <div className="mt-0.5 text-11 text-ink-300 leading-relaxed">{it.desc}</div>}

                              {it.evidence && (
                                <div className="mt-1 text-10 text-ink-500 border-l-2 border-ink-700 pl-1.5 leading-relaxed">
                                  「{it.evidence}」
                                </div>
                              )}

                              {it.type === '人物' && it.status === 'new' && (
                                <div className="mt-1 flex items-center gap-1">
                                  <span className="text-10 text-ink-500">归入</span>
                                  <select
                                    value={it.targetTabId ?? 'char-npc'}
                                    onChange={e => setLedgerTargetTab(it.key, e.target.value)}
                                    className="text-10 px-1 py-px rounded bg-ink-900/60 border border-ink-700 text-ink-100 outline-none focus:border-amber/40"
                                  >
                                    {CARD_TABS.map(t => (
                                      <option key={t} value={t}>{TABS.find(x => x.id === t)?.name ?? t}</option>
                                    ))}
                                  </select>
                                </div>
                              )}

                              {it.status !== 'new' && it.matchedTabId && (
                                <Button variant="bare"
                                  type="button"
                                  onClick={() => jumpToEntry(it.matchedTabId!, it.matchedId)}
                                  className="mt-1 flex items-center gap-0.5 text-11 text-amber/80 hover:text-amber"
                                >
                                  去核对 <ExternalLink size={9} />
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            {ledger.items.length > 0 && (
              <Button onClick={commitLedger}
                disabled={ledgerSaving || ledgerPicked.size === 0} variant="primary" size="md" className="w-full flex items-center justify-center">
                {ledgerSaving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                {ledgerSaving ? '写入中' : `补登选中的 ${ledgerPicked.size} 项`}
              </Button>
            )}
          </div>
  )
}
