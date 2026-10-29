/**
 * 世界观 · 力量体系「母子结构」的**子级存储层**（C10 · 2.4.2）
 *
 * 母级**不在这里** —— 它就是原来那份 `formData`（走 `db.getFormData(tabId)` / `saveFormData`），
 * 位置、键、渲染口径全都没变。本文件只管**子级**：子项的增删改 + 「活跃 / 已完结」状态。
 *
 * 🔴 三条纪律：
 *   ① 子项一律存在 `cardRecords` 的 **`<tabId>-sub`** 下（见 `worldSets.subTabIdOf`），
 *      这个 tabId 不在 `TABS` 里 ⇒ 不会被当成页签渲染、不会被全书级设定汇总捞到。
 *   ② 写入用 `ops.put` / 删除用 `ops.del`（与 `db/tabs.ts` 的卡片写入同构）——
 *      **删除必须走 `ops.del`**，云盘同步的墓碑机制挂在那条路径上（漏了就「删了会复活」）。
 *   ③ **删子项必须同时从活跃列表里摘掉它**（否则 AI 段落里会冒出一行空的子世界标题）。
 */
import type { CardRecord } from '@/lib/types'
import { activeKeyOf, pruneActiveIds, subTabIdOf, toggleActiveId } from '@/lib/world/worldSets'
import { currentProjectId, ops, touchProject } from '@/lib/db/core'
import { getSetting, setSetting } from '@/lib/db/meta'

/** 该母级页签下的全部子项（按 order 排） */
export async function getSubSets(tabId: string): Promise<CardRecord[]> {
  const all = await ops.getAll<CardRecord>('cardRecords')
  return all
    .filter(r => r.projectId === currentProjectId && r.tabId === subTabIdOf(tabId))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/** 新建或更新一个子项（tabId 由本函数统一写，避免调用方传错落到别的表下） */
export async function saveSubSet(tabId: string, rec: CardRecord): Promise<void> {
  await saveSubSetFor(currentProjectId, tabId, rec)
}

/**
 * 按**指定项目 id** 存子项（3.2.2 · 审计 C3 同族）。
 *
 * 🔴 为什么必须补：`WorldSetSheet` 卸载时会补存草稿，而 `exitProject()` 先把全局
 *    `currentProjectId` 清成 `''` —— 走上面那个版本会把子世界写进**无项目归属**的记录，
 *    重开原书时那一层改动消失（与表单草稿同一个病根）。
 *    凡"要动的不是当前项目 / 时机可能在切换之后"一律用带 `For` 的版本。
 */
export async function saveSubSetFor(pid: string, tabId: string, rec: CardRecord): Promise<void> {
  // ⚠️ 不在这里对空 pid 早退：`saveSubSet` 历史上允许空 pid（worldPack 收集等纯逻辑场景就传 ''），
  //    凭空加一道静默跳过会改掉既有契约。需要"空就不写"的调用方（组件卸载补存）自己在调用处判。
  const store = ops
  await store.put('cardRecords', { ...rec, projectId: pid, tabId: subTabIdOf(tabId) })
  touchProject(pid, store)
}

/**
 * 删除一个子项 + 同步清活跃列表。
 * 先删数据、再收拾活跃列表：中途失败最多留下一个「活跃列表里有、库里没有」的 id，
 * 而读取路径（`splitActive`）本来就会忽略这种 id ✅ 反过来先清列表再删数据则可能删失败后
 * 子项还在但仍处于活跃 → 那才会真的多喂一段。
 */
export async function deleteSubSet(tabId: string, id: string): Promise<void> {
  await ops.del('cardRecords', id)
  const ids = await getActiveSubIds(tabId)
  const rest = await getSubSets(tabId)
  await setSetting(activeKeyOf(tabId), pruneActiveIds(ids, rest.map(r => r.id)))
  touchProject(currentProjectId)
}

/**
 * 活跃子项 id 列表。
 * 这里只做形状防御（不是数组 / 混进非字符串就当空），**不做"是否还存在"的净化** ——
 * 那一层统一由 `splitActive` 在读的时候做（一处净化点，避免两边行为不一致）。
 */
export async function getActiveSubIds(tabId: string): Promise<string[]> {
  const v = await getSetting<string[]>(activeKeyOf(tabId), [])
  return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []
}

/** 开 / 关某一个子项（幂等） */
export async function setSubActive(tabId: string, id: string, on: boolean): Promise<void> {
  const ids = await getActiveSubIds(tabId)
  await setSetting(activeKeyOf(tabId), toggleActiveId(ids, id, on))
  touchProject(currentProjectId)
}
