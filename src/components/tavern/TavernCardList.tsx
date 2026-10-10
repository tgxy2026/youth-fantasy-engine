import { useMemo, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/common/Button'
import SelectRow from '@/components/common/SelectRow'
import Avatar from '@/components/common/Avatar'
import { useMasterQuery } from '@/components/common/MasterDetail'
import { cardStoryId, type TavernCharIndexItem, type TavernStoryIndexItem } from '@/lib/tavern/types'
import { storyDisplayName } from '@/lib/tavern/story'

/**
 * 角色卡片页的**左栏**（2026-09-19 从 TavernCard.tsx 抽出，原 741~938 行）。
 *
 * 抽它的理由：这一块是完整的一个关注点（分组树 + 建卡/AI 入口 + 导入导出入口），
 * 而 `groups` / `toggleStory` / `charRow` **只被它使用** —— 留在父组件里就是纯粹的噪声。
 * 搬完之后父组件少 190 行，卡面表单那一大块也更容易读。
 *
 * ⚠️ `openIds`（哪些故事展开着）**故意留在父组件**：父级还有一个 effect 会在故事增删后
 *    收敛它（清理已不存在的 id），状态归属不能跟着 JSX 一起搬走。
 */

/** 不属于任何故事的角色卡（通常是故事被删了）→ 「未归属」抽屉的伪分组 id */
export const FREE_GROUP = '__free__'

interface Props {
  /** 全部角色卡的索引项 */
  list: TavernCharIndexItem[]
  /** 全部故事（用于分组；不在索引里的故事不会出现） */
  stories: TavernStoryIndexItem[]
  /** 当前打开的那张卡（用于高亮 + AI 入口的可用性） */
  draft: { id: string } | null
  /** 展开着的故事 id 集合 */
  openIds: string[]
  setOpenIds: Dispatch<SetStateAction<string[]>>
  onOpenCard: (id: string) => void
  onNewCard: () => void
  onAiDraft: () => void
  onInterview: () => void
  onImportNovel: () => void
  fileRef: RefObject<HTMLInputElement>
  onExportCard: () => void
  onExportAll: () => void
  onImportCards: (files: File[]) => void
}

export default function TavernCardList({
  list, stories, draft, openIds, setOpenIds,
  onOpenCard, onNewCard, onAiDraft, onInterview, onImportNovel,
  fileRef, onExportCard, onExportAll, onImportCards,
}: Props) {
  /**
   * 角色卡按故事分组（老大 2026-09-16 定：树状结构，卡归属于故事）。
   *
   * 🔴 **`unbound` 是必须的兜底分组**：删故事时角色卡**不删，只解除归属** ——
   *    这些卡要有地方落脚，且必须能在编辑时重新归类到别的故事下。
   *    顺带把「索引里挂着已不存在故事的孤儿卡」也收进来，否则那批卡会凭空消失在列表里。
   */
  const groups = useMemo(() => {
    const byStory = new Map<string, TavernCharIndexItem[]>()
    const free: TavernCharIndexItem[] = []
    for (const c of list) {
      const sid = cardStoryId(c)
      if (!sid) { free.push(c); continue }
      const arr = byStory.get(sid) ?? []
      arr.push(c)
      byStory.set(sid, arr)
    }
    const knownIds = new Set(stories.map(s => s.id))
    const known = stories.map(s => ({ id: s.id, name: s.name, chars: byStory.get(s.id) ?? [] }))
    const orphan: TavernCharIndexItem[] = []
    for (const [sid, arr] of byStory) if (!knownIds.has(sid)) orphan.push(...arr)
    return { known, unbound: [...free, ...orphan] }
  }, [list, stories])

  const toggleStory = (id: string) =>
    setOpenIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))

  // 搜索：卡一多才需要；命中后展示其所属故事（不必先展开），所以按卡过滤、再重算分组
  const [query, setQuery] = useMasterQuery()
  const matchedIds = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return new Set(list.filter(c => (c.name || '').toLowerCase().includes(q)).map(c => c.id))
  }, [list, query])
  const shown = useMemo(
    () => (matchedIds ? list.filter(c => matchedIds.has(c.id)) : list),
    [list, matchedIds],
  )
  const displayGroups = useMemo(() => {
    if (!matchedIds) return groups
    // 过滤后仍按故事分组，但全部展开（用户来搜就是为了看结果）
    const byStory = new Map<string, TavernCharIndexItem[]>()
    const free: TavernCharIndexItem[] = []
    for (const c of shown) {
      const sid = cardStoryId(c)
      if (!sid) { free.push(c); continue }
      const arr = byStory.get(sid) ?? []
      arr.push(c)
      byStory.set(sid, arr)
    }
    const knownIds = new Set(stories.map(s => s.id))
    const known = stories
      .map(s => ({ id: s.id, name: s.name, chars: byStory.get(s.id) ?? [] }))
      .filter(g => g.chars.length > 0)
    const orphan: TavernCharIndexItem[] = []
    for (const [sid, arr] of byStory) if (!knownIds.has(sid)) orphan.push(...arr)
    return { known, unbound: [...free, ...orphan] }
  }, [matchedIds, shown, groups, stories])

  /** 左栏的一张卡（不管挂在哪个分组下，长相一致 —— 免得作者以为两种卡不一样） */
  const charRow = (c: TavernCharIndexItem) => (
    <li key={c.id}>
        <SelectRow
          type="button"
          selected={draft?.id === c.id}
          variant="outline"
          onClick={() => void onOpenCard(c.id)}
          className="items-center gap-2 rounded-md px-2 py-1.5"
        >
          <Avatar src={c.avatar} name={c.name} size={24} />
          <span className="min-w-0 flex-1 truncate text-12 text-ink-100">{c.name || '未命名角色'}</span>
        </SelectRow>
    </li>
  )

  return (
    <aside className="w-56 shrink-0 flex flex-col min-h-0">
      {/* 固定头：按钮 + 搜索，不参与滚动 */}
      <div className="shrink-0 space-y-2">
      {/* 同栏其余按钮都是 sm（2026-09-19 六维审计 P2-15）：面板主操作取 sm 基线，别单独高一档 */}
      <Button variant="primary" size="sm" className="w-full" onClick={onNewCard}>新建角色卡</Button>

      {/* 两个 AI 入口：想清楚了用一句话起草，只有个感觉就用对话引导 */}
      <div className="flex gap-1.5">
        <Button
          variant="secondary" size="sm" className="flex-1"
          disabled={!draft} onClick={onAiDraft}
          title="一句话（或粘一段素材）→ AI 按四章模板填写"
        >
          AI 起草
        </Button>
        <Button
          variant="secondary" size="sm" className="flex-1"
          disabled={!draft} onClick={onInterview}
          title="AI 按模板提纲一轮一轮地问，边聊边把这张卡塑出来"
        >
          对话引导
        </Button>
      </div>

      {/* 搜索（A+C 的 C 项）：卡多时按名定位；命中后自动展开其所属故事 */}
      <div className="relative">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜角色卡名…"
          className="w-full !pl-7 text-12"
        />
        <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-500 pointer-events-none" />
      </div>
      </div>

      {/* 独立滚动区（A+C）：卡一多时本栏自己滚，不带动右侧编辑区 */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain -mr-1 pr-1 mt-2">
      {list.length === 0 ? (
        <p className="text-11 text-ink-500 leading-relaxed px-1 pt-1">
          还没有角色卡。点上面「新建」开始 —— 新建时要先选这张卡属于哪个故事。
        </p>
      ) : (
        <div className="space-y-1">
          {displayGroups.known.map(g => {
            const open = matchedIds ? true : openIds.includes(g.id)
            return (
              <div key={g.id}>
                <button
                  type="button"
                  onClick={() => toggleStory(g.id)}
                  className="w-full flex items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-ink-800/60 transition-colors"
                  title={open ? '收起这个故事下的角色卡' : '展开这个故事下的角色卡'}
                >
                  <span className={`text-10 text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
                  <span className="min-w-0 flex-1 truncate text-12 font-medium text-ink-200">{storyDisplayName(g)}</span>
                  <span className="text-10 text-ink-500 shrink-0">{g.chars.length}</span>
                </button>
                {open && (
                  <ul className="ml-2 pl-1.5 border-l border-ink-700 space-y-0.5 mt-0.5">
                    {g.chars.length
                      ? g.chars.map(charRow)
                      : <li className="px-2 py-1 text-11 text-ink-600">这个故事下还没有角色卡</li>}
                  </ul>
                )}
              </div>
            )
          })}

          {/* 未归属（自由状态）：删故事留下的卡都在这儿，等着被重新归类 —— 不能让它凭空没地方去 */}
          {displayGroups.unbound.length > 0 && (() => {
            const open = matchedIds ? true : openIds.includes(FREE_GROUP)
            return (
              <div>
                <button
                  type="button"
                  onClick={() => toggleStory(FREE_GROUP)}
                  className="w-full flex items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-ink-800/60 transition-colors"
                  title="不属于任何故事的角色卡（通常是故事被删了）—— 打开卡片可以在「归属故事」里重新归类"
                >
                  <span className={`text-10 text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
                  <span className="min-w-0 flex-1 truncate text-12 font-medium text-amber/80">未归属</span>
                  <span className="text-10 text-ink-500 shrink-0">{displayGroups.unbound.length}</span>
                </button>
                {open && (
                  <ul className="ml-2 pl-1.5 border-l border-amber/25 space-y-0.5 mt-0.5">
                    {displayGroups.unbound.map(charRow)}
                  </ul>
                )}
              </div>
            )
          })()}
          {matchedIds && shown.length === 0 && (
            <p className="text-11 text-ink-500 leading-relaxed px-1 pt-2">没有匹配的角色卡</p>
          )}
        </div>
      )}
      </div>

      {/* 固定尾：导入导出，不参与滚动 */}
      <div className="shrink-0 pt-2 border-t border-ink-700 space-y-1.5 mt-2">
        <Button variant="secondary" size="sm" className="w-full" onClick={onImportNovel}>
          从小说角色导入
        </Button>
        <div className="flex gap-1.5">
          <Button
            variant="secondary" size="sm" className="flex-1"
            onClick={() => fileRef.current?.click()}
            title="支持单卡文件、整批文件（一个文件里多张卡），也可以一次选中多个文件"
          >
            导入 JSON
          </Button>
          <Button variant="secondary" size="sm" className="flex-1" disabled={!draft} onClick={onExportCard}>
            导出 JSON
          </Button>
        </div>
        <Button
          variant="secondary" size="sm" className="w-full"
          disabled={list.length === 0}
          onClick={onExportAll}
          title="把全部角色卡打包成一个文件（整批备份 / 分享给同好），与「导入 JSON」的批量入口对称"
        >
          导出全部（{list.length} 张）
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          multiple
          className="hidden"
          onChange={e => {
            const picked = Array.from(e.target.files ?? [])
            if (picked.length) onImportCards(picked)
            e.target.value = '' // 允许连续导入同一批文件
          }}
        />
        <p className="text-10 text-ink-600 leading-relaxed px-1">
          「从小说角色导入」是 AI 转换，结果只是草稿，必须审。
        </p>
      </div>
    </aside>
  )
}
