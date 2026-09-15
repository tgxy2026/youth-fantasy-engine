/**
 * 酒馆模式 · 故事（自由对话专用）
 *
 * 【解决什么】
 * 原先「世界设定」写在每张角色卡的第1章里 —— N 张卡就是 N 份复制，改一处要改 N 处，
 * 还常常互相打架。于是把「这个世界什么样」整层抽出来，起名「故事」，与剧本构成父子结构。
 *
 * 【分工（老大 2026-09-16 定）】
 *   故事 → 这个世界的基本设定（规则 / 地理 / 势力 / 常识）
 *   剧本 → 这一个场景发生什么事（六栏）
 *   一个故事下可以有多份剧本；故事与故事之间并列。
 *
 * 【为什么数据是全局的】
 * 🔴 **全局（`db.getMeta`，跨项目）** —— 与角色卡、剧本同性质：是「玩法模板」，不绑某一本书。
 *    换项目照样用。
 *
 * 【铁律】索引与分条成对读写（同 store.ts / script.ts）：只写一边就会出现
 *        「列表里有、点开是空的」的幽灵条目。
 */
import * as db from '../db'
import { uid } from '../id'
import type { TavernStory, TavernStoryIndexItem } from './types'

// 全局 meta 键（无项目前缀）
const G = {
  index: 'tavern.storyIndex',
  one: (id: string) => `tavern.story.${id}`,
} as const

export function emptyStory(): TavernStory {
  return { id: '', name: '', setting: '', draftedAt: 0, createdAt: 0, updatedAt: 0 }
}

/** 名称缺省时给个占位（列表里空名字最难找） */
export function storyDisplayName(s: Pick<TavernStory, 'name'>): string {
  return s.name.trim() || '（未命名故事）'
}

/** 取首行当列表摘要；全空返回空串（让界面自己决定写什么占位） */
function briefOf(text: string, max = 40): string {
  const line = (text ?? '').trim().split(/\r?\n/)[0] ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

// ==================== 读写（全局） ====================

export async function listStories(): Promise<TavernStoryIndexItem[]> {
  const list = await db.getMeta<TavernStoryIndexItem[]>(G.index, [])
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getStory(id: string): Promise<TavernStory | null> {
  return db.getMeta<TavernStory | null>(G.one(id), null)
}

export async function saveStory(s: TavernStory): Promise<TavernStory> {
  const now = Date.now()
  const next: TavernStory = {
    ...s,
    id: s.id || uid(),
    createdAt: s.createdAt || now,
    updatedAt: now,
  }
  await db.setMeta(G.one(next.id), next)
  const idx = await db.getMeta<TavernStoryIndexItem[]>(G.index, [])
  const item: TavernStoryIndexItem = {
    id: next.id,
    name: storyDisplayName(next),
    settingBrief: briefOf(next.setting),
    updatedAt: next.updatedAt,
  }
  const i = idx.findIndex(x => x.id === next.id)
  if (i >= 0) idx[i] = item
  else idx.push(item)
  await db.setMeta(G.index, idx)
  return next
}

export async function createStory(init: Partial<TavernStory> = {}): Promise<TavernStory> {
  return saveStory({ ...emptyStory(), ...init })
}

/**
 * 删除故事。
 *
 * 🔴 **其下的剧本一并删** —— 剧本是挂在故事下的子节点，留着就成了没人管的孤儿节点；
 *    会话里存的是剧本**快照**，所以老会话照样能跑，不受影响。
 * 🔴 **角色卡一张都不删**，只**解除归属**（`storyId=''`）→ 这些卡退成「自由状态」，
 *    落在角色卡列表的「未归属」分组里，随时能在编辑时重新挂到别的故事下。
 *    与「删地图不删地点」同一原则：卡连着记忆与日记，删了就是不可逆丢数据。
 *
 * @returns 被解绑的角色卡张数（给界面提示用：「已把 N 张卡移出故事」）
 */
export async function deleteStory(id: string): Promise<{ reboundChars: number }> {
  // 动态 import：script.ts 将来可能反向引用 story.ts（树状查询），先绕开循环依赖的可能
  const { listScripts, deleteScript } = await import('./script')
  const scripts = await listScripts()
  for (const s of scripts) {
    if (s.storyId === id) await deleteScript(s.id)
  }

  // 卡：解绑不删。store.ts 不会反向依赖 story.ts，但保持动态 import 的一致写法更省心。
  const { rebindCharsStory } = await import('./store')
  const reboundChars = await rebindCharsStory(id, '')

  const idx = await db.getMeta<TavernStoryIndexItem[]>(G.index, [])
  await db.setMeta(G.index, idx.filter(x => x.id !== id))
  await db.setMeta(G.one(id), null)
  return { reboundChars }
}
