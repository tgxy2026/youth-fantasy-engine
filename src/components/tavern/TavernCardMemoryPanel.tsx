/**
 * 角色卡片 · **「Ta 的记忆」六栏**（2026-09-19 D4-4，从 `TavernCard.tsx` 拆出）。
 *
 * AI 会整理它，但作者必须能**直接改** —— 整理是压缩，压错的地方只有作者知道；
 *   只读的话就只能删卡重来。所以这里是「可编辑 + 保存记忆」，不是只读展示。
 *
 * 【六栏的行为不一样，界面已经写明，改这里时别改坏这句话】
 *   · 长期摘要：会被压缩；
 *   · 关键事实 / 未爆的雷：只增不改（手改时清空等于让 Ta 失忆）；
 *   · 关系状态：每次整理重写；
 *   · 最近日记：只留最近几条（给 AI 看的一行一事，与卡面上的「Ta 的日记」是两套东西）。
 *
 * 🔴 记忆**软上限只提醒、不硬截断**（`softLimit` 来自控制面板「七、自由对话控制」）——
 *   审计 P1-1：这个旋钮以前全库无消费者，面板上写着「超过只在界面上提醒」而提醒从没实现过。
 *
 * ⚠️ props 名与原局部变量**同名** ⇒ 内部 JSX 逐字未改（缩进保留原样，16 空格）。
 */
import { type Dispatch, type SetStateAction } from 'react'
import { Button } from '@/components/common/Button'
import AutoTextarea from '@/components/common/AutoTextarea'
import { MEMORY_SECTIONS, memoryChars, isMemoryEmpty } from '@/lib/tavern/memory'
import { type FreeMemory } from '@/lib/tavern/types'
import { UNSAVED_CHANGES_HINT } from '@/lib/constants'

interface Props {
  /** 六栏记忆（没有记忆时为 null —— 界面自己会走「还没有记忆」分支） */
  mem: FreeMemory | null
  setMem: Dispatch<SetStateAction<FreeMemory | null>>
  /** 手改过但还没点「保存记忆」 */
  memDirty: boolean
  setMemDirty: Dispatch<SetStateAction<boolean>>
  /** 六栏编辑区是否展开 */
  showMem: boolean
  setShowMem: Dispatch<SetStateAction<boolean>>
  /** 记忆软上限（控制面板可调；只提醒，不硬截断） */
  softLimit: number
  savingMem: boolean
  seedingMem: boolean
  /** 依据角色卡生成初版记忆（AI 优先，失败回落离线摘录）—— 只在记忆还空着时露出按钮 */
  genMemory: () => Promise<void>
  saveMem: () => Promise<void>
  /** 清空六栏（不可撤销，内部会先弹窗确认） */
  clearMem: () => Promise<void>
}

export default function TavernCardMemoryPanel({
  mem, setMem, memDirty, setMemDirty, showMem, setShowMem,
  softLimit, savingMem, seedingMem, genMemory, saveMem, clearMem,
}: Props) {
  return (
    <>
                {/* 记忆：AI 会整理，但作者也该能直接改（否则压错了只能删卡重来） */}
                <section className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="flex flex-wrap items-center gap-x-2 text-13 font-semibold text-amber/90">
                        Ta的记忆（可手动编辑）
                        {mem && !isMemoryEmpty(mem) && (
                          <span
                            className={`text-10 font-normal ${memoryChars(mem) > softLimit ? 'text-amber' : 'text-ink-600'}`}
                            title={`记忆软上限 ${softLimit} 字（控制面板 → 七、自由对话控制）：超过只提醒，不会硬截断`}
                          >
                            {memoryChars(mem)} / {softLimit} 字
                            {memoryChars(mem) > softLimit ? ' · 偏长，整理时会先压「长期摘要」' : ''}
                          </span>
                        )}
                      </h3>
                      <p className="mt-0.5 text-11 text-ink-500 leading-relaxed">
                        六栏记忆就在这里。AI 整理时会在此基础上压缩；你也可以直接改，改完点「保存记忆」。
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {memDirty && <span className="text-11 text-amber">{UNSAVED_CHANGES_HINT}</span>}
                      {(!mem || isMemoryEmpty(mem)) && (
                        <Button variant="secondary" size="sm" disabled={seedingMem} onClick={() => void genMemory()}
                          title="依据这张角色卡生成第一版六栏记忆（AI 优先，失败则直接摘录角色卡）">
                          {seedingMem ? '生成中…' : '依据角色卡生成初版记忆'}
                        </Button>
                      )}
                      {showMem && (
                        <Button variant="primary" size="sm" disabled={!memDirty || savingMem} onClick={() => void saveMem()}>
                          {savingMem ? '保存中…' : '保存记忆'}
                        </Button>
                      )}
                      <Button variant="secondary" size="sm" onClick={() => setShowMem(v => !v)}>
                        {showMem ? '收起' : '展开编辑'}
                      </Button>
                      {mem && !isMemoryEmpty(mem) && (
                        <Button variant="danger" size="sm" onClick={() => void clearMem()}
                          title="把六栏记忆全部清空（不可撤销，会先弹窗确认）">
                          清空记忆
                        </Button>
                      )}
                    </div>
                  </div>

                  {!showMem ? (
                    <p className="mt-2 text-11 text-ink-400">
                      当前 {mem ? memoryChars(mem) : 0} 字 ·
                      更新于 {mem ? new Date(mem.updatedAt).toLocaleString('zh-CN') : '（还没有记忆）'}
                    </p>
                  ) : (
                    <>
                      <p className="mt-2 rounded-md border border-amber/25 bg-amber/8 px-2.5 py-2 text-11 text-ink-300 leading-relaxed">
                        ⚠️ 六栏的行为不一样：<span className="text-ink-100">长期摘要</span>会被压缩、
                        <span className="text-ink-100">关键事实</span>与<span className="text-ink-100">未爆的雷</span>只增不改、
                        <span className="text-ink-100">关系状态</span>每次整理重写、
                        <span className="text-ink-100">最近日记</span>只留最近几条（一天一条，也就是最近几天）。
                        手改时别把「只增」的两栏清空 —— 那等于让Ta失忆。
                      </p>
                      <div className="mt-3 space-y-3">
                        {MEMORY_SECTIONS.map(sec => (
                          <div key={sec.key}>
                            <div className="text-11 text-ink-200">{sec.title}</div>
                            <AutoTextarea
                              className="mt-1 bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                              textClass="text-12" minRows={2} maxHeight={360}
                              value={String(mem?.[sec.key] ?? '')}
                              onChange={v => {
                                setMem(m => (m ? { ...m, [sec.key]: v } : m))
                                setMemDirty(true)
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>
    </>
  )
}
