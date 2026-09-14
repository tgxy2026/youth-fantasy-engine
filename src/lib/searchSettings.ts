/**
 * 联网检索设置（全局）—— 给**非酒馆模块**一个干净的入口
 *
 * 【它住在哪】
 * 值仍然存在全局设置那一份里（`tavern.settings.search`，三端共用的 meta 记录），
 * 与控制面板「联网检索」段的保存按钮同生共死 —— 不另开存储就不会出现「面板存了、别处读到旧的」。
 *
 * 【为什么还要多这一层】
 * 2026-09-15 起，角色管理 / 表单 / 表格的「AI 补全」也要能联网取素材。
 * 那些地方直接 `import { getTavernSettings }` 读起来莫名其妙（"角色管理为什么要读酒馆设置？"），
 * 后来人很容易误以为读错了对象而改坏它。这里把「读的是全局设置里的联网检索段」这件事写明白。
 *
 * 🔴 别再在调用点直接读 `tavern.settings`：一旦搜索设置将来搬家（例如独立成一个 app 级设置），
 *    只需改这里一处。
 */
import { getTavernSettings } from './tavern/settings'
import { DEFAULT_SEARCH_SETTINGS, type SearchSettings } from './webSearch'

/** 读联网检索设置（读不到就用出厂值 —— 起草/补全永远不该因为读设置失败而整个不可用） */
export async function getSearchSettings(): Promise<SearchSettings> {
  try {
    const st = await getTavernSettings()
    return { ...DEFAULT_SEARCH_SETTINGS, ...(st?.search ?? {}) }
  } catch {
    return { ...DEFAULT_SEARCH_SETTINGS }
  }
}
