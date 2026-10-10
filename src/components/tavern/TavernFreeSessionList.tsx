/**
 * 自由对话 · **左栏会话列表**（从 `TavernFree.tsx` 拆出，2026-09-19）。
 *
 * 按故事分组列出所有会话：全局跨角色，未归属的（故事/卡被删）单独归一堆。
 * 它与「对话区」「右栏状态」并列为自由对话页的三块，原本三块叠在一个 700 行的 return 里。
 *
 * 状态一律来自 `model`（同名解构，JSX 保持原样）；本组件不持有任何状态。
 */
import { showToast } from '@/components/dialogs'
import { Button } from '@/components/Button'
import type { TavernFreeModel } from '@/components/useTavernFreeModel'

export default function TavernFreeSessionList({ model }: { model: TavernFreeModel }) {
  const {
    refreshStories,
    tree,
    toggleStory,
    renderSessionRow,
    chars,
    sessions,
    stories,
    closedStoryIds,
    
    setSetupOpen,
    q,
    setQ,
    
  } = model

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-2 rounded-lg border border-ink-700 bg-ink-850/40 p-3">
      <Button
        variant="primary" size="md" className="w-full"
        onClick={async () => {
          if (stories.length === 0) {
            showToast('还没有故事 —— 先去「故事剧本」建一个（世界观由故事提供）', 'info')
            return
          }
          if (chars.length === 0) { showToast('还没有角色卡 —— 先去「角色卡片」建一张', 'info'); return }
          await refreshStories()
          setSetupOpen(true)
        }}
      >
        ＋ 新建对话
      </Button>
      {sessions.length > 4 && (
        <input
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-11 text-ink-100 outline-none focus:border-amber/50"
          placeholder="筛选（标题 / 角色）"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      )}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {tree.groups.map(g => {
          const closed = closedStoryIds.includes(g.id)
          return (
            <div key={g.id} className="space-y-0.5">
              {/* 故事（父）：只有这一组的对话才画出来；空组留个「还没有对话」的痕迹，
                  否则作者会以为「我在这故事下开的那场不见了」 */}
              <button
                type="button"
                onClick={() => toggleStory(g.id)}
                title={closed ? '展开这个故事的对话' : '收起这个故事的对话'}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-ink-800/60"
              >
                <span className={`shrink-0 text-10 ${closed ? 'text-ink-600' : 'text-amber/80'}`}>
                  {closed ? '▸' : '▾'}
                </span>
                <span className="min-w-0 flex-1 truncate text-11 text-ink-300">{g.name}</span>
                <span className="shrink-0 text-10 text-ink-600">{g.rows.length}</span>
              </button>
              {!closed && (
                <div className="ml-3 space-y-1 border-l border-ink-700 pl-1.5">
                  {g.rows.map(s => renderSessionRow(s))}
                  {g.rows.length === 0 && (
                    <p className="px-1 py-1 text-10 text-ink-600">还没有对话</p>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* 未归属：故事被删 / 卡被删之后推不出归属的对话，放这儿等着作者处理 */}
        {tree.orphan.length > 0 && (
          <div className="space-y-0.5">
            <button
              type="button"
              onClick={() => toggleStory('__orphan__')}
              title={closedStoryIds.includes('__orphan__') ? '展开' : '收起'}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-ink-800/60"
            >
              <span className={`shrink-0 text-10 ${closedStoryIds.includes('__orphan__') ? 'text-ink-600' : 'text-amber/80'}`}>
                {closedStoryIds.includes('__orphan__') ? '▸' : '▾'}
              </span>
              <span className="min-w-0 flex-1 truncate text-11 text-ink-300">未归属</span>
              <span className="shrink-0 text-10 text-ink-600">{tree.orphan.length}</span>
            </button>
            {!closedStoryIds.includes('__orphan__') && (
              <div className="ml-3 space-y-1 border-l border-ink-700 pl-1.5">
                {tree.orphan.map(s => renderSessionRow(s))}
              </div>
            )}
          </div>
        )}

        {tree.total === 0 && (
          <p className="px-1 py-2 text-11 leading-relaxed text-ink-500">
            {sessions.length === 0
              ? '还没有对话 —— 点上面「新建对话」开一场（要先有故事）。'
              : '没有匹配的对话。'}
          </p>
        )}
      </div>
      <div className="shrink-0 border-t border-ink-700 pt-2 text-10 text-ink-500">共 {sessions.length} 场</div>
    </aside>
  )
}
