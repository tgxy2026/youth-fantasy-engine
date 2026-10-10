/**
 * 角色卡片 · **卡面的「基本」区块**（2026-09-19 D4-4，从 `TavernCard.tsx` 拆出）。
 *
 * 内容：头像（右侧挂着复制 / 删除 / 保存三个动作）+ 角色名 + 归属故事 + 本卡数值状态 + 同名提示。
 *
 * 【归属故事是这块的核心】世界观由故事层提供，卡里只写角色自己 —— 没归属的卡在对话时
 *   拿不到「这个世界什么样」，也**不会出现在「新建对话」的角色列表里**（角色按故事过滤）。
 *   所以要显式说清「自由状态」的代价，而不是留一个空下拉（审计 P1-4）。
 *
 * 【本卡数值状态的输入框为什么是 defaultValue + onBlur】这几项每轮会被模型改写，
 *   受控输入在生成途中会跟着跳；改成非受控 + 失焦提交，作者打字时不会被抢。
 *   ⚠️ `key` 里带着当前值（`val-${key}-${val}`），所以外部改写后仍会重挂载取到新值。
 *
 * 【同名提示】同名不等于同一人：记忆按角色 id 存，各存各的。这里只是提前告诉作者，
 *   免得看到两张同名的卡就以为新卡抢走了老卡的记忆；顺带把两张卡的稳定短码（`charTag`）摆出来。
 *
 * ⚠️ props 名与原局部变量**同名** ⇒ 内部 JSX 逐字未改（缩进保留原样，16 空格）。
 *    别为了好看去重排缩进 —— 「逐行区间核对」靠它证明一个字没改。
 */
import { type Dispatch, type SetStateAction, type ReactNode } from 'react'
import Avatar from './Avatar'
import AvatarPicker from './AvatarPicker'
import { storyDisplayName } from '../lib/tavern/story'
import {
  cardStoryId, charTag, VAR_DEFS,
  type CharVars, type FreeCharacter, type TavernCharIndexItem, type TavernStoryIndexItem,
} from '../lib/tavern/types'

interface Props {
  /** 当前正在编辑的卡（父级已收窄为非空 —— 没选中卡时这一整块不挂载） */
  draft: FreeCharacter
  /** 单字段改写（自动置脏） */
  up: <K extends keyof FreeCharacter>(k: K, v: FreeCharacter[K]) => void
  setDirty: Dispatch<SetStateAction<boolean>>
  /** 全部故事（「归属故事」下拉的数据源） */
  stories: TavernStoryIndexItem[]
  /** 改归属（只改内存 + 置脏，保存仍然要作者点「保存」） */
  changeStory: (storyId: string) => Promise<void>
  /** 与当前卡同名的其它卡（只提示，不影响任何存储行为） */
  sameNameOthers: TavernCharIndexItem[]
  /** 「复制为新卡 / 删除 / 保存」那三个按钮 —— 与编辑区底部是**同一份 JSX**，由父级算好传进来 */
  actionButtons: ReactNode
}

export default function TavernCardBasics({
  draft, up, setDirty, stories, changeStory, sameNameOthers, actionButtons,
}: Props) {
  return (
    <>
                {/* 基本 */}
                <div>
                  {/* 头像（批次 8）：角色卡片、自由对话气泡、状态栏、在场者一览共用同一张图 */}
                  <div className="mb-3">
                    <AvatarPicker
                      src={draft.avatar}
                      name={draft.name}
                      size={64}
                      onChange={v => up('avatar', v)}
                      hint="不设也能用 —— 会话气泡与列表会用名字首字代替。头像随卡片一起存进数据文件。"
                      /* 复制 / 删除 / 保存 提到这儿：与「上传图片」同一行，不用滚到底（反馈 #9） */
                      actions={actionButtons}
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <Avatar src={draft.avatar} name={draft.name} size={36} />
                    <input
                      className="flex-1 bg-ink-900 border border-ink-700 rounded-md px-2.5 py-2 text-15 font-semibold text-ink-50 outline-none focus:border-amber/50"
                      value={draft.name}
                      placeholder="角色名"
                      onChange={e => up('name', e.target.value)}
                    />
                  </div>
                  <p className="mt-1.5 text-11 text-ink-500">
                    角色卡是 AI 的「人设说明书」—— 写得越具体，演得越像。
                  </p>

                  {/* 归属故事（老大 2026-09-16）：世界观交给故事层，卡里只写角色自己 */}
                  <div className="mt-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-12 text-ink-200">归属故事</span>
                      <span className="text-11 text-ink-500">决定对话时用哪一套世界观</span>
                    </div>
                    <select
                      className="mt-1 w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-12 text-ink-100 outline-none focus:border-amber/50"
                      value={cardStoryId(draft)}
                      onChange={e => void changeStory(e.target.value)}
                    >
                      <option value="">（不归属任何故事）</option>
                      {stories.map(s => <option key={s.id} value={s.id}>{storyDisplayName(s)}</option>)}
                    </select>
                    <p className="mt-1 text-11 leading-relaxed">
                      {cardStoryId(draft) ? (
                        <span className="text-ink-500">世界设定由这个故事提供，卡里不用再写一遍。</span>
                      ) : (
                        <span className="text-amber/80">
                          这张卡现在是「自由状态」—— 不属于任何故事，对话时会拿不到世界观。在上面选一个故事就能归类。
                        </span>
                      )}
                    </p>
                  </div>
                  {/* 本卡数值状态（老大 2026-09-16 反馈 #4）：持久、跨会话累积，存角色卡 */}
                  <div className="mt-3 rounded-lg border border-ink-700 bg-ink-900/40 p-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-12 text-ink-200">本卡数值状态</span>
                      <span className="text-11 text-ink-500">持久保存 · 跨会话累积 · 模型每轮读取并改写</span>
                    </div>
                    <p className="mt-1 text-11 leading-relaxed text-ink-500">
                      好感 / 信任 / 精神 / 心情 / 地点：对话里被模型按剧情推进，也随时可手改。
                      每项可附一句备注（模型会读取、数值变化时会一并改写，如「好感 45 → 从陌生到熟悉的朋友」）。
                    </p>
                    <div className="mt-2 space-y-2">
                      {VAR_DEFS.map(def => {
                        const cv = draft.vars
                        const val = cv?.values?.[def.key]
                        const note = cv?.notes?.[def.key] ?? ''
                        const setVal = (raw: string) => {
                          const cur: CharVars = cv ?? { values: {}, notes: {} }
                          const values = { ...cur.values }
                          if (def.kind === 'num') {
                            const n = Number(raw.trim())
                            values[def.key] = raw.trim() === '' || !Number.isFinite(n) ? (def.init as number) : n
                          } else {
                            values[def.key] = raw
                          }
                          up('vars', { values, notes: { ...cur.notes } })
                          setDirty(true)
                        }
                        const setNote = (text: string) => {
                          const cur: CharVars = cv ?? { values: {}, notes: {} }
                          const notes = { ...cur.notes }
                          if (text.trim()) notes[def.key] = text.trim()
                          else delete notes[def.key]
                          up('vars', { values: { ...cur.values }, notes })
                          setDirty(true)
                        }
                        return (
                          <div key={def.key} className="rounded-md border border-ink-700 bg-ink-900/60 p-2">
                            <div className="flex items-center gap-2">
                              <span className="w-12 shrink-0 text-11 text-ink-300">{def.label}</span>
                              <input
                                key={`val-${def.key}-${String(val ?? 'empty')}`}
                                defaultValue={val === undefined || val === '' ? (def.kind === 'num' ? String(def.init) : '') : String(val)}
                                onBlur={e => setVal(e.target.value)}
                                inputMode={def.kind === 'num' ? 'numeric' : undefined}
                                placeholder={def.kind === 'num' ? String(def.init) : '（未填）'}
                                className="w-24 min-w-0 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-11 text-ink-100 outline-none focus:border-amber/50"
                              />
                              {def.kind === 'num' && (
                                <span className="text-10 text-ink-600">{def.min}–{def.max}</span>
                              )}
                            </div>
                            <input
                              key={`note-${def.key}-${note}`}
                              defaultValue={note}
                              onBlur={e => setNote(e.target.value)}
                              placeholder="备注（模型会读取 / 改写，如：从陌生到熟悉的朋友）"
                              className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-11 text-ink-300 outline-none focus:border-amber/40"
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>

                {sameNameOthers.length > 0 && (
                  <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-11 text-ink-300 leading-relaxed">
                    ⚠️ 已有 {sameNameOthers.length} 张卡也叫「{draft.name.trim()}」。
                    <span className="text-ink-100">同名不等于同一个人</span>：记忆、日常状态、聊天记录都各存各的
                    （记忆按角色 id 绑定），新建或复制同名卡不会抢走那一张的记忆。
                    同一场对话里同时出现时，提示词会给它们挂稳定短码区分 —— 这张是
                    <span className="text-amber"> #{charTag(draft.id)}</span>，另一张是
                    <span className="text-amber"> #{charTag(sameNameOthers[0].id)}</span>。
                    想少混淆，建议改名加区别（如「小满（旧版）」）。
                  </div>
                )}
    </>
  )
}
