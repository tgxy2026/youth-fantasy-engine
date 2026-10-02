/**
 * 题材包（GenrePack）——开书定位「世界设定 / 力量体系」模板化的开关（2.7.1）。
 *
 * ## 为什么要有它
 * 改造前，`worldbase` / `power` 两个页签的字段是**一套东方修真模板**：
 * 写都市现实 / 历史古代的作者打开「力量体系」，看到的全是「境界 / 灵根 / 寿元」——
 * 对不上表。本模块把「按作品题材切换模板」收敛成**一个封闭枚举 + 若干纯函数**。
 *
 * ## 三条设计纪律
 * ① **值即包名**（中文四字）。之所以不做 id→显示名映射：`Project.genre` 会经
 *    `aiContext` 直接注入成「类型：东方修真」，值可读 ⇒ **天然可读、不用额外映射**。
 *    代价：**包名一旦发布就冻结**，改名必须走 `PACK_ALIASES` 别名表（老数据靠它归位）。
 * ② **本文件不 import 任何数据模块**（字段内容在 worldbase.ts / power.ts / institutions.ts）——
 *    保持「枚举与判据」和「模板内容」分离，也让 schema.ts 能单向依赖它而不成环。
 * ③ `东方修真` 是**默认包**，且它的模块内容与改造前的 schema **逐字一致** ⇒
 *    老项目 / 示范项目零破坏（这是本次改造的第一目标）。
 */

/** 十个题材包（🔴 封闭集合，**发布后冻结**；改名走 PACK_ALIASES） */
export const GENRE_PACKS = [
  '东方修真', '西方奇幻', '都市异能', '都市现实', '历史古代',
  '科幻末世', '武侠江湖', '悬疑灵异', '游戏竞技', '女频言情',
] as const

export type GenrePack = (typeof GENRE_PACKS)[number]

/** 默认包：老项目 / 未设置 / 无法识别时一律落这里（＝改造前的现状） */
export const DEFAULT_PACK: GenrePack = '东方修真'

export function isGenrePack(v: unknown): v is GenrePack {
  return typeof v === 'string' && (GENRE_PACKS as readonly string[]).includes(v)
}

/**
 * 别名归位表：老数据 / 作者手填的自由文本 → 题材包。
 *
 * 🔴 为什么必须有它：`Project.genre` 在 2.7.0 之前是**自由文本**（作品定位页签里的
 *    「类型赛道」也是自由文本，且两者互不同步）。历史数据里躺着 '东方玄幻' / '仙侠' /
 *    '都市修仙' 这类值 —— 没有别名表，它们会全部落到默认包，作者的题材选择形同丢失。
 */
export const PACK_ALIASES: Record<string, GenrePack> = {
  // 东方修真
  东方玄幻: '东方修真', 玄幻: '东方修真', 修真: '东方修真', 仙侠: '东方修真',
  东方仙侠: '东方修真', 修仙: '东方修真', 仙侠修真: '东方修真',
  // 西方奇幻
  奇幻: '西方奇幻', 异界大陆: '西方奇幻', 剑与魔法: '西方奇幻', 西方玄幻: '西方奇幻', 魔法: '西方奇幻',
  // 都市异能
  都市修仙: '都市异能', 异术超能: '都市异能', 高武: '都市异能', 都市脑洞: '都市异能',
  异能: '都市异能', 超能: '都市异能',
  // 都市现实
  都市: '都市现实', 现实: '都市现实', 职场: '都市现实', 都市日常: '都市现实',
  都市生活: '都市现实', 乡村生活: '都市现实',
  // 历史古代
  历史: '历史古代', 穿越历史: '历史古代', 架空历史: '历史古代', 历史军事: '历史古代', 古代: '历史古代',
  // 科幻末世
  科幻: '科幻末世', 末世: '科幻末世', 星际: '科幻末世', 科幻末世: '科幻末世', 废土: '科幻末世',
  // 武侠江湖
  武侠: '武侠江湖', 江湖: '武侠江湖', 传统武侠: '武侠江湖',
  // 悬疑灵异
  悬疑: '悬疑灵异', 灵异: '悬疑灵异', 悬疑推理: '悬疑灵异', 恐怖: '悬疑灵异', 惊悚: '悬疑灵异',
  // 游戏竞技
  游戏: '游戏竞技', 电竞: '游戏竞技', 体育: '游戏竞技', 竞技: '游戏竞技',
  // 女频言情
  言情: '女频言情', 古言: '女频言情', 女频: '女频言情', 古代情缘: '女频言情',
  总裁豪门: '女频言情', 宫闱宅斗: '女频言情', 宫斗宅斗: '女频言情', 现代言情: '女频言情', 甜宠: '女频言情',
}

/**
 * 把任意来源的题材值归一到题材包。
 * 规则：精确包名 → 别名表 → 模糊包含（'东方玄幻·升级流' 这类复合描述）→ 默认包。
 */
export function normalizeGenrePack(v: unknown): GenrePack {
  if (isGenrePack(v)) return v
  const s = String(v ?? '').trim()
  if (!s) return DEFAULT_PACK
  const exact = PACK_ALIASES[s]
  if (exact) return exact
  // 模糊：作者手填常带后缀（'东方玄幻·升级流' / '都市异能+系统'）⇒ 取包含判据
  for (const [alias, pack] of Object.entries(PACK_ALIASES)) {
    if (s.includes(alias)) return pack
  }
  for (const pack of GENRE_PACKS) {
    if (s.includes(pack)) return pack
  }
  return DEFAULT_PACK
}

/** 显示用短标签（当前＝包名，保留函数是为了将来要加缩写时只改这一处） */
export function packLabel(pack: GenrePack): string {
  return pack
}

// ==================== 模块级的「当前题材包」====================
// 与 schema.getVolumeTabs 的缓存同范式：全局唯一项目在打开时才设定，未设定即默认包。
// 🔴 之所以用模块级可变状态而不是 props 层层透传：TABS 的消费方有 20+ 处
//    （AI 上下文 / 导出 / 设定检索 / 设定汇总 / 表单 / 侧栏…），逐个改签名风险远大于收益。
//    页签对象的 name / modules 走 getter 读这里 ⇒ 所有消费方**零改动**自动跟随题材包。
let _activePack: GenrePack = DEFAULT_PACK

export function getActivePack(): GenrePack { return _activePack }

export function setActivePack(pack: GenrePack): void {
  _activePack = isGenrePack(pack) ? pack : DEFAULT_PACK
}

// ==================== 受题材驱动的页签名单 ====================

/**
 * 受题材包驱动的六个页签（世界总览 / 力量体系 + 四个制度页签）。
 *
 * 🔴 2.7.2：**这里只列「哪几个页签的字段会随题材变」，不再用它决定「显不显示」。**
 *   原先配套的 `PACK_TAB_DEFAULT` 矩阵 + `packShowsTab()`（按题材把页签藏起来）已整体删除 ——
 *   主人定案「完整项目展示所有页签、自定义项目按勾选」，题材**只影响各页签里的字段名与说明**。
 *   保留这个名单是因为：① 遍历「开书定位」组时要用；② 测试要断言「这六个都受题材驱动」。
 */
export const PACK_TAB_IDS = ['worldbase', 'power', 'politics', 'economy', 'belief', 'justice'] as const
export type PackTabId = (typeof PACK_TAB_IDS)[number]

// ==================== 显示名随题材 ====================

/**
 * 「力量体系」在无超自然题材下**语义弱替**（§4.5）：
 * 页签结构、稳定 id（恒为 `power`）、15 个共享字段**全都不动**，只换显示名与模块内容。
 * 🔴 收口后这三个题材里 power **默认隐藏**（可补开）；补开即按此弱替名显示。
 */
const POWER_TAB_NAME: Partial<Record<GenrePack, string>> = {
  都市现实: '能力资源',
  历史古代: '权谋实力',
  女频言情: '关系地位',
}

/** 页签显示名（`东方修真` 与其余题材 = 现状名；仅 `power` 随题材弱替） */
export function tabDisplayName(pack: GenrePack, tabId: string, baseName: string): string {
  if (tabId === 'power') return POWER_TAB_NAME[pack] ?? baseName
  return baseName
}

/**
 * 子项称谓（Q15）：同一个「子项」机制，在历史包下读起来应是「政权」、
 * 武侠包下是「门派」…纯文案层，让「一本世界多份档案」在作者眼里说人话。
 */
const SUB_ITEM_LABELS: Record<string, Partial<Record<GenrePack, string>>> = {
  worldbase: {
    历史古代: '时期', 武侠江湖: '时期', 都市现实: '篇章', 女频言情: '篇章',
    悬疑灵异: '场所', 游戏竞技: '赛季',
  },
  power: {
    历史古代: '势力', 武侠江湖: '门派', 都市现实: '能力线', 女频言情: '关系线',
    悬疑灵异: '流派', 游戏竞技: '赛季',
  },
  politics: {
    历史古代: '政权', 西方奇幻: '王国', 都市现实: '地区', 科幻末世: '势力',
  },
  economy: {
    历史古代: '政权', 都市现实: '行业', 科幻末世: '势力',
  },
  belief: {
    历史古代: '政权', 西方奇幻: '教团', 悬疑灵异: '流派',
  },
  justice: {
    历史古代: '政权',
  },
}

/** 四个制度页签下的子项默认称谓（历史门外的题材较少用，给通用兜底） */
const INSTITUTION_SUB_FALLBACK = '政权'

/**
 * 「新增」按钮的文案分档（2026-10-02 主人定案）。
 *
 * 主人原话：「在开书定位组，除了作品定位以外的其他页签中，其实都有新增子项的功能。
 *   1.『世界设定』保留新增按钮的功能为『新增子世界』；
 *   2.『力量体系』保留新增按钮的功能为『新增子体系』；
 *   3. 其他页签（政治、经济、宗教、司法）均改为『新增』。」
 *
 * ⇒ 制度四页签在 2.7.2 改成**并列结构**后，条目的身份从「某母级下的子项」变成「平铺的一条」，
 *   再叫「新增政权 / 新增地区」会暗示它从属于什么，所以**按钮一律叫「新增」**；
 *   而世界设定 / 力量体系仍是母子结构，条目确实是「子世界 / 子体系」，按钮保留原措辞。
 */
export function addButtonLabel(tabId: string): string {
  if (tabId === 'worldbase') return '新增子世界'
  if (tabId === 'power') return '新增子体系'
  // 制度四页签：并列结构，按钮就叫「新增」（条目总称仍由 subItemLabel 提供，用于列表标题与 AI 段）
  return '新增'
}

/** 子项称谓（tabId → 题材 → 文案）；缺省时按页签给通用兜底 */
export function subItemLabel(tabId: string, pack: GenrePack): string {
  const byTab = SUB_ITEM_LABELS[tabId]
  const hit = byTab?.[pack]
  if (hit) return hit
  if (tabId === 'worldbase') return '子世界'
  if (tabId === 'power') return '子体系'
  if (tabId === 'politics' || tabId === 'economy' || tabId === 'belief' || tabId === 'justice') {
    return INSTITUTION_SUB_FALLBACK
  }
  return '子项'
}
