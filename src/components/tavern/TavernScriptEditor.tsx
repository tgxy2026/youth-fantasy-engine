/**
 * 酒馆 · 故事剧本 —— 中栏（故事设定 / 剧本六栏 / 空态）
 *
 * 【为什么单独拆出来（3.0 · G4 · §11.1 L5）】
 * `TavernScript.tsx` 原 846 行；左栏已在 W3-3 拆成 `TavernScriptTree`，本步拆**中栏**。
 * 中栏是「**纯受控**」面板：自己不持状态、不碰存储，所有改动都回调给父级合并
 * —— 故 props 面最窄（实测 7 项）、风险低；右栏（AI 起草 / 注入情况 / 注入预览）
 * 与父级耦合更紧（props 面 24），按 §11.1 L5「别为拆而拆」，留待后续按需再动。
 */
import type { Dispatch, SetStateAction } from 'react'
import { Button } from '@/components/common/Button'
import AutoTextarea from '@/components/common/AutoTextarea'
import NumberField from '@/components/common/NumberField'
import EntryStatePicker from '@/components/sheets/EntryStatePicker'
import TavernScriptFields from '@/components/tavern/TavernScriptFields'
import { uid } from '@/lib/app/id'
import { emptyWorldEntry, entryStateOf } from '@/lib/tavern/worldBook'
import { STORY_NAME_MAX } from '@/lib/tavern/story'
import type { ScriptDraftFields } from '@/lib/tavern/script'
import type { TavernScript, TavernStory } from '@/lib/tavern/types'

/** 中间面板当前在编辑谁：故事 / 剧本 / 谁都没选 */
export type EditingKind = 'story' | 'script' | null

export interface TavernScriptEditorProps {
  kind: EditingKind
  story: TavernStory | null
  setStory: Dispatch<SetStateAction<TavernStory | null>>
  setStoryDirty: Dispatch<SetStateAction<boolean>>
  /** 剧本六栏草稿（父级从 `cur` 派生） */
  fields: ScriptDraftFields
  /** 当前选中的剧本（仅用于判定「剧本分支」是否成立） */
  cur: TavernScript | null
  setCur: Dispatch<SetStateAction<TavernScript | null>>
  setScriptDirty: Dispatch<SetStateAction<boolean>>
}

export default function TavernScriptEditor({
  kind, story, setStory, setStoryDirty, fields, cur, setCur, setScriptDirty,
}: TavernScriptEditorProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pr-1">
      {kind === 'story' && story ? (
        <div className="space-y-3">
          <div>
            <div className="text-12 text-ink-200">故事名称</div>
            <input
              value={story.name}
              maxLength={STORY_NAME_MAX}
              onChange={e => { setStory({ ...story, name: e.target.value }); setStoryDirty(true) }}
              placeholder="例：云州江湖"
              className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850/60 px-2.5 py-1.5 text-12 text-ink-100 placeholder:text-ink-600 focus:border-amber/50 focus:outline-none"
            />
            <p className="mt-1 text-10 text-ink-600">
              只用于列表展示，不进上下文。最多 {STORY_NAME_MAX} 字
              {story.name.length >= STORY_NAME_MAX && <span className="ml-1 text-amber/80">已到上限</span>}
            </p>
          </div>
          <div>
            <div className="text-12 text-ink-200">世界设定</div>
            <p className="mt-0.5 text-10 leading-relaxed text-ink-500">
              这个世界的基本设定：规则、地理、势力、常识。角色卡不再重复写它 —— 卡片里只留「角色与设定的关系」。
            </p>
            <div className="mt-1">
              <AutoTextarea
                value={story.setting}
                onChange={v => { setStory({ ...story, setting: v }); setStoryDirty(true) }}
                minRows={14}
                maxHeight={460}
                placeholder={'例：\n云州多山，灵脉自北向南枯竭已有百年。\n修行者分三派：守脉、夺脉、弃脉。\n凡人不知灵脉之事，只说山上的人都不下山。'}
              />
            </div>

            {/* 世界书（W3）：把整段设定拆成词条 —— 每条自己的触发词，提到才带上 */}
            <div className="mt-3 rounded-lg border border-ink-700 bg-ink-850/30 p-3">
              <div className="flex items-center justify-between">
                <div className="text-12 text-ink-200">世界书词条（{(story.entries ?? []).length}）</div>
                <Button variant="secondary" size="xs"
                  onClick={() => {
                    setStory({
                      ...story,
                      entries: [...(story.entries ?? []), { ...emptyWorldEntry(), id: uid() }],
                    })
                    setStoryDirty(true)
                  }}
                >
                  ＋ 加词条
                </Button>
              </div>
              <p className="mt-0.5 mb-2 text-10 text-ink-500 leading-relaxed">
                把上面那段拆成若干词条：每条留自己的触发词，只有提到它时才带上这一条。
                <span className="text-ink-600">没有词条时，上面整段设定按「总是注入」处理。</span>
              </p>

              {(story.entries ?? []).length === 0 ? (
                <p className="rounded border border-dashed border-ink-700 p-2.5 text-center text-11 text-ink-500">
                  还没有词条 —— 上面整段设定会一直带上。想省额度就拆成词条。
                </p>
              ) : (
                <div className="space-y-2">
                  {(story.entries ?? []).map((e, i) => (
                    <div key={e.id} className="rounded-md border border-ink-700 bg-ink-900/40 p-2.5">
                      <div className="flex items-center gap-2">
                        <input
                          value={e.title}
                          onChange={ev => {
                            const v = ev.target.value
                            setStory(prev => prev ? {
                              ...prev,
                              entries: (prev.entries ?? []).map(x => x.id === e.id ? { ...x, title: v } : x),
                            } : prev)
                            setStoryDirty(true)
                          }}
                          placeholder="词条名（如「守脉三派」）"
                          className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/50"
                        />
                        <Button variant="danger" size="xs" title="删掉这一条" className="shrink-0"
                          onClick={() => {
                            setStory(prev => prev ? {
                              ...prev,
                              entries: (prev.entries ?? []).filter(x => x.id !== e.id),
                            } : prev)
                            setStoryDirty(true)
                          }}
                        >
                          删除
                        </Button>
                      </div>
                      <div className="mt-1.5">
                        <AutoTextarea
                          value={e.body}
                          onChange={v => {
                            setStory(prev => prev ? {
                              ...prev,
                              entries: (prev.entries ?? []).map(x => x.id === e.id ? { ...x, body: v } : x),
                            } : prev)
                            setStoryDirty(true)
                          }}
                          minRows={2}
                          maxHeight={200}
                          placeholder={`第 ${i + 1} 条内容…`}
                        />
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <input
                          value={e.keys.join('，')}
                          onChange={ev => {
                            const keys = ev.target.value.split(/[,，\n]/).map(x => x.trim()).filter(Boolean)
                            setStory(prev => prev ? {
                              ...prev,
                              entries: (prev.entries ?? []).map(x => x.id === e.id ? { ...x, keys } : x),
                            } : prev)
                            setStoryDirty(true)
                          }}
                          placeholder="触发词（留空 = 总是带上）"
                          className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-11 text-ink-100 outline-none focus:border-amber/50"
                        />
                        <label className="flex shrink-0 items-center gap-1 text-10 text-ink-400" title="命中后还要过这道随机闸：1 = 必中，0.5 = 一半概率">
                          <span>概率</span>
                          {/* 🔴 走 NumberField（2026-10-10 六维审计）：原来的受控 `type=number` 在输入「0.」这种中间态时
                              Number('0.') === 0 ⇒ 父值被同步成 0、输入框回写成「0」，**小数点根本打不出来** ——
                              概率只能填 0 或 1，引擎侧 prob 语义形同虚设。NumberField 有本地文本态，编辑期不被外部值回写。 */}
                          <NumberField
                            value={e.prob}
                            onChange={v => {
                              const prob = typeof v === 'number' ? v : 1
                              setStory(prev => prev ? {
                                ...prev,
                                entries: (prev.entries ?? []).map(x => x.id === e.id ? { ...x, prob } : x),
                              } : prev)
                              setStoryDirty(true)
                            }}
                            min={0} max={1} step={0.1} precision={2}
                            className="w-14 rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-11 text-ink-100 outline-none focus:border-amber/50"
                          />
                        </label>
                      </div>
                      {/* 四色灯（2026-10-05）：显式设过就以它为准，没设过按老语义推断 */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <EntryStatePicker
                          value={e.state}
                          inferred={entryStateOf(e)}
                          size="sm"
                          onChange={next => {
                            setStory(prev => prev ? {
                              ...prev,
                              entries: (prev.entries ?? []).map(x => x.id === e.id ? { ...x, state: next } : x),
                            } : prev)
                            setStoryDirty(true)
                          }}
                        />
                        <span className="text-10 text-ink-600">
                          {entryStateOf(e) === 'on' ? '每轮都带' : e.keys.length ? `自带 ${e.keys.length} 个触发词` : '按触发词命中'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : kind === 'script' && cur ? (
        <TavernScriptFields
          value={fields}
          onChange={patch => {
            setCur(prev => (prev ? { ...prev, ...patch } : prev))
            setScriptDirty(true)
          }}
        />
      ) : (
        <div className="rounded-lg border border-dashed border-ink-700 p-6 text-center text-12 text-ink-500">
          左边选一个故事看它的设定，或展开它选一份剧本。
          <p className="mt-2 text-11 leading-relaxed text-ink-600">
            故事管「世界」，剧本管「这一场」。人物的身世与性格放角色卡 —— 三处别互相抄。
          </p>
        </div>
      )}
    </div>
  )
}
