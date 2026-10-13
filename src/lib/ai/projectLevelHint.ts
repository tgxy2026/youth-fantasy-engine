// ============ 项目级提示文本：参考资料召回的降级 query（3.0.3）============
//
// 【它是什么】给 `buildKbBlock` 当 `fallbackQuery` 的一段"这个项目在写什么"的文本。
//
// 🔴 为什么不能只用书名 + 简介（**实测踩出来的教训**）：
//    参考资料召回有**两级降级**：有嵌入模型走语义，没配就走**关键词**（按字面命中打分）。
//    而"书名/简介"与作者挂载的资料**往往字面无交集** —— 本项目示范数据的书名是玄幻爽文、
//    挂的资料讲"艾尔达/符文术"，一个 token 都匹配不上，于是召回返回空，
//    "看起来修好了、其实一句话都没召回来"。
//    ⇒ 必须再拼一层**正在写的书的核心设定**，它才是项目语义的最佳字面代理。
//
// 🔴 只做**截断**、不解析、不额外读库：每页只取前 20 行 × 5 页签，
//    开销远小于一次语义召回的嵌入门槛。
//
// 【依赖方向】只依赖 `db` 与 `schema` 的 `TABS`（都是叶子）——
//    故 `aiContext` 可以自由 import 它而不成环（这也是它独立成模块的原因之一）。
import { TABS } from '@/lib/schema'
import * as db from '@/lib/db'

/** 参与拼装的页签：PRIORITY 里最靠前的五个（开书定位组 + 主角 + 术语） */
const HINT_TAB_IDS = ['positioning', 'worldbase', 'power', 'char-main', 'terms'] as const

/** 每页取前多少行（够覆盖"这一页在讲什么"，又不会把预算吃掉） */
const HINT_LINES_PER_TAB = 20

/**
 * 取「项目级提示」文本；**永不抛**，任何一步失败返回空串。
 * 🔴 失败要静默：它只是召回的降级 query，拿不到最多是召回不到资料，
 *    绝不能让 AI 请求本身失败。
 */
export async function buildProjectLevelHint(): Promise<string> {
  try {
    const pid = db.getCurrentProjectId()
    if (!pid) return ''
    const parts: string[] = []
    for (const id of HINT_TAB_IDS) {
      const tab = TABS.find(t => t.id === id)
      if (!tab) continue
      const body = await tabSectionText(tab).catch(() => '')
      if (!body.trim()) continue
      parts.push(body.trim().split('\n').slice(0, HINT_LINES_PER_TAB).join('\n'))
    }
    return parts.join('\n')
  } catch {
    return ''
  }
}

/**
 * 把一个页签压成一段**粗**文本（供 query 用，不求与注入格式一致）。
 *
 * 🔴 为什么不复用 `aiContext.sectionOf`：那个函数连同 `RenderOpts` 与整套渲染器
 *    （renderForm/renderCards/renderTable…）都在 aiContext 里，搬它等于拆半座楼；
 *    而这里只需要"这个页签大概讲了什么"——按类型各取最直接的字段就够。
 */
async function tabSectionText(tab: (typeof TABS)[number]): Promise<string> {
  if (tab.type === 'form') {
    const data = await db.getFormData(tab.id)
    if (!data) return ''
    return Object.entries(data)
      .filter(([, v]) => v && String(v).trim())
      .slice(0, 12)
      .map(([k, v]) => `${k}：${String(v).trim()}`)
      .join('\n')
  }
  if (tab.type === 'card' || tab.type === 'table') {
    const rows = await db.getTableRows(tab.id).catch(() => [])
    if (!rows || rows.length === 0) return ''
    return rows
      .slice(0, 8)
      .map(r => Object.values(r).filter(Boolean).join(' '))
      .join('\n')
  }
  return ''
}
