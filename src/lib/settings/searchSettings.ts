/**
 * 联网检索设置（**全局**）—— 读写唯一的入口
 *
 * 【它住在哪】
 * `app.search`（三端共用的 meta 记录）。**不再**挂在酒馆设置里：
 * 联网检索是全局功能 —— 角色卡 / 剧本 / 背景设定起草，以及角色管理 / 表单 / 表格的 AI 补全，
 * 全都按这一份走；而它跟「扮演协议」「上下文预算」这些酒馆专属的东西没有任何关系。
 * 2026-09-15 起界面也从「酒馆 → 控制面板」搬到了「工作面板 → 模型设置」（配模型的地方顺手就选了）。
 *
 * 【老数据怎么办】
 * 老版本存在 `tavern.settings.search`。这里做**一次性迁移**：读不到新键时看旧位置，
 * 有就地搬过来（写进新键），之后就读新键。旧键由 `tavern/settings.ts` 的
 * `upgradeLegacyDefaults` / `saveTavernSettings` 剔掉 —— 不剔的话 mergeDeep 会照抄回来。
 *
 * 🔴 调用点一律走这里，别直接读 meta：将来再搬家只需改这一个文件。
 */
import * as db from '@/lib/db'
import { K_TAVERN_SETTINGS } from '@/lib/tavern/settings'
import { DEFAULT_SEARCH_SETTINGS, type SearchSettings } from '@/lib/ai/webSearch'

/** 全局设置键（meta） */
export const K_APP_SEARCH = 'app.search'

/**
 * 读联网检索设置（读不到就用出厂值 —— 起草/补全永远不该因为读设置失败而整个不可用）
 *
 * 🔴 另见 `loadSearchSettings`：本函数会把「读失败」与「确实没配过」混成同一种出厂值，
 *    对**只读取用**的链路（起草 / 补全 / 市场雷达）无妨，但**设置界面不能用它** ——
 *    拿到出厂值后作者改一项，`saveSearchSettings` 是整条覆盖写，会把真配置静默清空
 *    （3.1.1 第四轮审计）。
 */
export async function getSearchSettings(): Promise<SearchSettings> {
  return (await loadSearchSettings()).settings
}

/**
 * 读设置，并**如实区分**「确实没配过」与「读失败才回落到出厂值」。
 * 界面必须按 `degraded` 禁止写入并提示 —— 否则会静默覆盖掉作者的真配置。
 */
export async function loadSearchSettings(): Promise<{ settings: SearchSettings; degraded: boolean }> {
  try {
    const own = await db.getMeta<Partial<SearchSettings> | null>(K_APP_SEARCH, null)
    if (own && typeof own === 'object') return { settings: { ...DEFAULT_SEARCH_SETTINGS, ...own }, degraded: false }

    // 老位置（一次性迁移）：写回新键，下次直接命中上面那条分支
    const legacy = await db.getMeta<{ search?: Partial<SearchSettings> } | null>(K_TAVERN_SETTINGS, null)
    const old = legacy && typeof legacy === 'object' ? legacy.search : null
    if (old && typeof old === 'object') {
      const moved = { ...DEFAULT_SEARCH_SETTINGS, ...old }
      await db.setMeta(K_APP_SEARCH, moved)
      return { settings: moved, degraded: false }
    }
    return { settings: { ...DEFAULT_SEARCH_SETTINGS }, degraded: false }
  } catch (e) {
    // 🔴 绝不静默：界面拿到出厂值后再改一项 ⇒ 整条覆盖写会把真配置清空
    console.warn('[search] 联网检索设置读取失败，本次按出厂值显示（界面会禁止写入）：', e)
    return { settings: { ...DEFAULT_SEARCH_SETTINGS }, degraded: true }
  }
}

/** 保存（界面每次改动直接落库；条数少、写起来便宜，不做草稿态） */
export async function saveSearchSettings(next: SearchSettings): Promise<SearchSettings> {
  const merged = { ...DEFAULT_SEARCH_SETTINGS, ...next }
  await db.setMeta(K_APP_SEARCH, merged)
  return merged
}
