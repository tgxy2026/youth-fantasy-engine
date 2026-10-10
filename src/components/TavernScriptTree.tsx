/**
 * 酒馆模式 · 故事剧本 · **左栏树**（故事 → 剧本）
 *
 * 3.0 · W3-3 · §11.1 L5：从 `TavernScript.tsx`（906 行）抽出的**第一块**。
 *
 * 抽取依据是 `dep-cost.mjs` 的量化（先量化再下刀，沿用前几轮拆 TavernCard / NovelEditor 的做法）：
 *   本块 props 面**最窄** —— 9 个（3 份只读数据 stories / scripts / openIds ＋ 3 个态 story / cur / kind
 *   ＋ 3 个回调），且高度内聚：**只读列表、只发回调**，不碰任何写操作或业务规则。
 *
 * 🔴 为什么不一次拆完：§11.1 L5 明确要求「与 #11 跑团对酒馆页的扩展一起规划 —— 别先拆完再改」。
 *    量化结果里**右栏（AI 起草 / 故事信息）props 面最宽（24 个）**，而它正是跑团扩展会动的地方
 *    （推演 / AI KP 都长在那里）⇒ 中栏与右栏一律留到 **W4-3** 与跑团一起做，避免白拆一次。
 */
import type { TavernScript, TavernScriptIndexItem, TavernStory, TavernStoryIndexItem } from '@/lib/tavern/types'

export default function TavernScriptTree({
  stories, scripts, openIds, story, cur, kind, onToggleOpen, onOpenStory, onOpenScript,
}: {
  stories: TavernStoryIndexItem[]
  scripts: TavernScriptIndexItem[]
  /** 已展开的故事 id */
  openIds: string[]
  /** 当前打开的故事（高亮用） */
  story: TavernStory | null
  /** 当前打开的剧本（高亮用） */
  cur: TavernScript | null
  /** 中间面板正在编辑谁 —— 决定高亮落在故事行还是剧本行 */
  kind: 'story' | 'script' | null
  onToggleOpen: (id: string) => void
  onOpenStory: (id: string) => void
  onOpenScript: (id: string) => void
}) {
  return (
    <aside className="w-56 shrink-0 overflow-y-auto">
      {stories.length === 0 ? (
        <p className="rounded-lg border border-dashed border-ink-700 p-3 text-center text-11 text-ink-500">
          还没有故事。点上面「新建故事」，先把这个世界写下来 —— 这是使用自由对话的第一步。
        </p>
      ) : (
        <ul className="space-y-1.5">
          {stories.map(st => {
            const under = scripts.filter(s => s.storyId === st.id)
            const isOpen = openIds.includes(st.id)
            return (
              <li key={st.id}>
                <div className="flex items-stretch gap-1">
                  <button
                    type="button"
                    onClick={() => onToggleOpen(st.id)}
                    title={isOpen ? '收起剧本' : '展开剧本'}
                    className="shrink-0 rounded-md border border-ink-700 bg-ink-850/30 px-1.5 text-11 text-ink-400 hover:border-ink-600"
                  >
                    {isOpen ? '▾' : '▸'}
                  </button>
                  <button
                    type="button" onClick={() => onOpenStory(st.id)}
                    title={st.settingBrief || '（还没写世界设定）'}
                    className={`min-w-0 flex-1 rounded-md border px-2.5 py-2 text-left transition-colors ${st.id === story?.id && kind === 'story'
                      ? 'border-amber/50 bg-amber/15'
                      : 'border-ink-700 bg-ink-850/30 hover:border-ink-600'}`}
                  >
                    <div className={`truncate text-12 ${st.id === story?.id && kind === 'story' ? 'text-amber' : 'text-ink-200'}`}>
                      {st.name}
                    </div>
                    <div className="mt-0.5 truncate text-10 text-ink-500">
                      {st.settingBrief || '（还没写世界设定）'}
                    </div>
                  </button>
                </div>

                {isOpen && (
                  <ul className="mt-1 ml-4 space-y-1 border-l border-ink-700 pl-2">
                    {under.length === 0 ? (
                      <li className="py-1 text-10 text-ink-600">（还没有剧本）</li>
                    ) : under.map(sc => (
                      <li key={sc.id}>
                        <button
                          type="button" onClick={() => onOpenScript(sc.id)}
                          title={sc.goalBrief || '（还没写目标）'}
                          className={`w-full rounded-md border px-2 py-1.5 text-left transition-colors ${sc.id === cur?.id && kind === 'script'
                            ? 'border-amber/50 bg-amber/15'
                            : 'border-ink-700 bg-ink-850/20 hover:border-ink-600'}`}
                        >
                          <div className={`truncate text-12 ${sc.id === cur?.id && kind === 'script' ? 'text-amber' : 'text-ink-200'}`}>
                            {sc.name}
                          </div>
                          <div className="truncate text-10 text-ink-500">{sc.goalBrief || '（还没写目标）'}</div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-2 text-10 leading-relaxed text-ink-600">
        {stories.length} 个故事 · {scripts.length} 份剧本 · 跨项目共用（换本书也还在）
      </p>
    </aside>
  )
}
