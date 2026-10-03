/**
 * schema 门面（2026-10-03 瘦身）：TABS 数组体已按原顺序切到 `schemaTabs/part1..3`，
 * 字段构造器与共享声明在 `schemaShared.ts`。本文件只做三件事：
 *   ① 拼装 TABS、② 显式再导出共享符号（外部一律 `from './schema'`，不许各去深层路径）、③ 其余顶层工具。
 *
 * 🔴 外部从本模块导入的符号有 20 个，**再导出只准增不准减** —— 少一个就是一片编译红。
 * 🔴 段文件不许回头 import 本文件（会成循环依赖）。
 */
import { c, cH } from './schemaShared'
import type { TabDef } from './types'
import {
  SABC, SABC_DESC, SABC_LABELS, CARD_TABLE_REF_FIELDS, CHAPTER_LEDGER_COLUMNS, getVolumeLedgerTabId, isVolumeLedgerTab, getVolumeIdFromLedgerTab, setVolumeTabs, getVolumeTabs, refreshVolumeTabs,
} from './schemaShared'
import { TABS_PART1 } from './schemaTabs/part1'
import { TABS_PART2 } from './schemaTabs/part2'
import { TABS_PART3 } from './schemaTabs/part3'
import type { GenrePack } from './schemaTemplates'

/** 🔴 门面纪律：显式再导出，**禁用 `export *`**（会把内部实现一起暴露出去） */
export {
  SABC, SABC_DESC, SABC_LABELS, CARD_TABLE_REF_FIELDS, CHAPTER_LEDGER_COLUMNS, getVolumeLedgerTabId, isVolumeLedgerTab, getVolumeIdFromLedgerTab, setVolumeTabs, getVolumeTabs, refreshVolumeTabs,
}

/** 全部页签。顺序即侧栏顺序；三段拼接次序不可调换。 */
export const TABS: TabDef[] = [...TABS_PART1, ...TABS_PART2, ...TABS_PART3]


// 编辑器页签（特殊，由 App 直接路由）
/**
 * 补 `type` / `description` 是为了让它**真的是一个 `TabDef`** —— 原先调用点要靠 `as any` 才能
 * 把它并进 `TABS` 的数组里，那等于把「缺了两个必填字段」这件事藏了起来。
 * `description` 留空：侧栏与各列表只用 `name`（GuidePage 另用 `EDITOR_DESC`），不会漏出空白。
 */
export const EDITOR_TAB: TabDef = {
  id: 'editor', name: '正文编辑', group: '正文写作', type: 'editor', description: '',
}

// 🔴 侧栏分组顺序＝本数组顺序。2026-10-02：把「酒馆模式」从「灵感工具」之后挪到
//    「大纲规划」与「创作管理」之间 —— 酒馆模式是「拿已成型的设定与大纲去推演」，
//    紧挨创作管理更符合使用动线（先定大纲 → 再推演/写作）。
export const GROUPS = ['工作面板', '正文写作', '灵感工具', '开书定位', '角色管理', '世界构建', '大纲规划', '酒馆模式', '创作管理', '运营维护']

/**
 * 《地图》数据表 —— **不是页签**，因此不在 TABS 里。
 *
 * 它的定位是纯数据：给地图编辑页提供地图清单，并让《地理风物》的「所属地图」引用列
 * （`cr('所属地图', 'geomaps', '名称')`）能解析出目标表。
 *
 * 地图的增删改**全部在地图编辑页左侧列表完成** —— 若把这张表塞进 TABS，
 * 世界构建组下就会同时出现「地图」与「地图编辑」两个页签，作者必然困惑「到底该在哪管地图」
 * （历史上真的这样出现过一次）。
 *
 * ⚠️ 引用列的下拉取数走 `TableRefSelect` 的 `db.getTableRows(refTabId)`，**不依赖本定义**；
 *    但 dataHealth 的悬空引用校验是从 TABS 遍历出目标表的，故那边显式并入本表（见 dataHealth.ts）。
 */
export const GEO_MAPS_TAB: TabDef = {
  id: 'geomaps', name: '地图', group: '世界构建', type: 'table',
  description: '手绘地图的清单（内部数据表：不出现在侧栏，增删改都在「地图编辑」页左侧列表里完成）。每张地图是一块独立画布：有自己的坐标系与格子档位，互不干扰。自 2.4.1（B8）起支持两种底图模式：格子（默认，用涂格画）/ 图片（直接上传一张自定义地图）。《地理风物》里每条地点通过「所属地图」归属到某张图上，在地图编辑里按图切换显示。',
  columns: [
    c('编号'), c('名称'),
    c('每格公里', ['1', '10']),
    c('说明'),
    // 🔴 B8（2.4.1）：底图模式与底图数据 —— **两列都 `cH` 隐藏**（内部数据，作者在「地图编辑」里操作，不手填）。
    //    与 `geography` 的 `cH('地图格子')` 是同一套路数。
    //    ⚠️ 「底图模式」是**封闭枚举**（A 约定：封闭枚举禁随意增删改）—— 只允许这两个值，
    //       缺省/空值一律按「格子」处理（老地图没有这一列 ⇒ 天然是格子模式，无需迁移）。
    cH('底图模式', ['格子', '图片']),
    // 「底图」存的是**已压缩的 dataURL**（lib/mapImage.ts 处理：长边 ≤1600、WebP q0.88、≤800KB）。
    // 地图张数少，体积可接受；⚠️ 别把原图直接塞进来。
    cH('底图'),
  ],
  displayCol: '名称',
  subtitleCol: '每格公里',
  codeRule: '编号规则：MAP + 4 位序号（MAP0001、MAP0002…，MAP=Map 地图）。新增行自动编号（从 0001 起，优先补最小的空号）；同表前缀统一、按数值排序；删除后的编号会空出，新增条目自动补上最小的空号（如删了 0003 号，再新增会得到 0003）；删除前有引用检查提示。',
  tips: [
    '每张地图是一块独立画布：格子互不影响，同一张图上才有「子范围必须完全画在父范围之内」的约束，跨图不校验。',
    '「说明」会在地图编辑页右侧显示（非编辑状态下），用来记这张图画的是哪片区域、有哪些约定。',
    '「每格公里」决定精细度（1 = 精细，适合城池 / 秘境；10 = 粗略，适合大陆 / 区域）。',
    '「底图模式」有两种（2.4.1 起）：「格子」＝用「绘制地图」涂格画出来（默认，老地图都是这种）；「图片」＝直接上传一张自己画好的地图图片。两种模式互斥 —— 图片模式下不再涂格。',
  ]
}

export function getTab(id: string): TabDef | undefined {
  // 《地图》是独立数据表（不在 TABS 里，见上方 GEO_MAPS_TAB）
  if (id === GEO_MAPS_TAB.id) return GEO_MAPS_TAB
  const t = TABS.find(t => t.id === id)
  if (t) return t
  if (isVolumeLedgerTab(id)) return getVolumeTabs().find(v => v.id === id)
  return undefined
}

// 历史遗留的 lite / minimal 项目类型已废弃移除；页签可见性统一由 tabVisible 按 features 集合判定（见下方）。

/** 设定检索栏使用：三个一级页签各自展开后的子项（按页签 id 引用 TABS） */
export const SETTING_SUBTABS: Record<string, string[]> = {
  '角色管理': ['char-main', 'char-secondary', 'char-npc', 'relations'],
  '世界构建': ['nations', 'geography', 'races', 'items', 'history', 'terms', 'misc-settings'],
  '创作管理': ['foreshadow', 'timeline', 'hookpoints', 'subplots', 'secrets'],
}
/** 哪些页签 ID 的条目要展示成「甲→乙」双人名（人物关系专用） */
export const RELATION_PAIR_TAB_IDS = new Set(['relations'])

/**
 * 「力量体系」里属于**境界 / 数值**的字段名片段 —— AI 补全时一律锁定，不让模型凭空编。
 *
 * 为什么放在 schema（而不是留在某个组件里）：力量体系是升级流的「宪法」，数值一崩后面全崩。
 * C10（母子结构）之后，母级表单与每个子世界表单都会走 AI 补全 ⇒ 判据必须**只有一份**，
 * 否则「母级锁了、子级没锁」这种漏洞没人看得出来（表现是某个副本的等级表被 AI 编乱）。
 *
 * 🔴 2.7.1 起它是**兜底判据**：题材模板化后新题材的数值字段未必含这些字（如「段位」「品级与阶序」），
 *    故字段可**显式声明** `kind: 'numeric'`（见 types.FormField）。最终判据是
 *    `f.kind === 'numeric' || POWER_NUMERIC_HINTS.some(h => f.name.includes(h))`（见 components/FormSheet.tsx）。
 *    `东方修真` 包未逐字加 kind ⇒ 仍由本表兜住，行为与改造前一致。
 */
export const POWER_NUMERIC_HINTS = [
  '境界', '等级', '战力', '寿元', '量化', '成本', '年龄', '人口', '金字塔',
  '时长', '年份', '倍率', '数量', '上限', '百分比', '价格',
]

/**
 * 「力量体系」字段是否属于**数值类**（AI 补全时锁定）—— 单一判据（2.7.1）。
 *
 * 两条判据并存：字段**显式声明** `kind: 'numeric'`（新题材模板用）优先，
 * 字段名关键字（`POWER_NUMERIC_HINTS`）作兜底（`东方修真` 等历史模板靠它）。
 * 🔴 只此一处实现 —— 母级表单（FormSheet）与母子面板（WorldSetSheet）共用，
 *    否则「母级锁了、子级没锁」这类漏洞没人看得出来。
 */
export function isNumericPowerField(field: { name: string; kind?: 'numeric' }): boolean {
  return field.kind === 'numeric' || POWER_NUMERIC_HINTS.some(h => field.name.includes(h))
}

// ==================== 自定义项目：功能分类与依赖（v1.9.1） ====================
export type ProjectType = 'full' | 'custom'

/**
 * 可见性上下文：完整项目全功能可见；自定义项目携带启用的功能集合（features 为已启用 tab id 列表）。
 *
 * `pack`（2.7.1）：当前项目的**题材包**，供 `tabVisible` 判定四个制度页签的显隐。
 * 可选 —— 未传即按默认包（`东方修真`），于是老的调用点 / 测试不需要改。
 */
export interface VisCtx {
  type: ProjectType
  features: string[]
  pack?: GenrePack
}

/** 编辑器页签（正文编辑）id */
export const EDITOR_ID = 'editor'

/** 功能档位：locked=必选不可取消；default=默认勾选但用户可取消；optional=自由勾选 */
export type FeatureTier = 'locked' | 'default' | 'optional'

/** 锁定项：必选、弹窗置灰不可取消的内置大模块（编辑器 + 工作面板 + 正文写作 + 灵感工具三个大模块下的子模块）。全局基础设施（备份与恢复 / 全文检索 / 设定检索）始终常开，不进入功能清单。default 项默认勾选但可取消（如运营维护下的「关于打赏」）。其余内容模块未列出者皆视为 optional。 */
export const FEATURE_TIER: Record<string, FeatureTier> = {
  // 锁定项（必选，弹窗置灰不可取消）
  [EDITOR_ID]: 'locked',
  dashboard: 'locked',
  // 模型设置（2026-09-19）：没有它连模型都接不上，与「使用指南」同级锁定
  'model-settings': 'locked',
  guide: 'locked',
  'inspire-tools': 'locked',
  'material-library': 'locked',
  'check-tools': 'locked',
  // 默认勾选（可取消）
  about: 'default',
  // 创作轨迹（2026-09-21 · 2.4.0 A4）：**显式标 default**（与 about 同档），
  // 而不是留给 getTier() 兜底的 optional。理由：它是 2.4「可信」目标的唯一载体、
  // 也是对外主卖点之一（"创作过程可存证"），默认不带等于把卖点藏起来 ——
  // 作者看不到它，就不知道软件能帮他自证创作过程。可取消，不影响只想安心码字的人。
  trajectory: 'default',
  // 拆书 / 创意写作（2026-09-19 起）：**显式标为 optional，不默认勾选**。
  // 理由：两者都是"往项目里写大量数据"的重流程，新用户进来第一眼用不上；
  // 默认勾着会让每个新项目都背上两个重量级入口。需要的人在「自定义项目」里勾上即可，
  // 两个页面顶部也都加了醒目提示（引导"先新建空项目再跑"）。
  // 显式写出来而不是省略不写：省略虽然按 `getTier()` 的兜底也是 optional，但
  // 读 schema 的人会以为是"忘了登记"，而这个档位是**有意为之的产品决定**。
  bookbreak: 'optional',
  'creative-writing': 'optional',
  // 其他设定（2026-09-20）：世界构建的兜底页 —— 同样**显式标 optional、不默认勾选**。
  // 它不是每个项目都需要的功能，也不带任何依赖（不动 STRONG_DEPS / ANY_DEPS）。
  // 写出来而不是省略，是为了让读 schema 的人知道这是有意为之，不是"忘了登记"。
  'misc-settings': 'optional',
  // 制度页签（2026-10-02 · 2.7.1 建）：政治 / 经济基础 / 宗教信仰 / 司法制度 —— 显式标 optional。
  // 🔴 2.7.2 起**完整项目一律显示**（题材矩阵已删），本表只决定「自定义项目里能否被勾选」。
  //    显式登记的理由同 misc-settings：不写虽然也走 getTier() 兜底 optional，但读的人会以为是忘了登记。
  //    它们是**并列结构**（`PARALLEL_SET_TABS`，多条平铺：一条＝一个政权 / 邦国 / 教派）。
  politics: 'optional',
  economy: 'optional',
  belief: 'optional',
  justice: 'optional',
  // 酒馆模式（2026-09-15）：整体改为**不默认勾选**（落到 optional）。
  // 原先 5 项设 default，会让每个自定义项目默认开着一整套角色扮演功能，多数作者用不上。
  // 它们的联动关系改由下方 STRONG_DEPS / ANY_DEPS 负责。
}

/** 强关联依赖：勾选 B 必须连带勾选 A（A 被锁定，直到再无 B 依赖它） */
export const STRONG_DEPS: Record<string, string[]> = {
  'geography-map': ['geography'],
  'faction-rels': ['nations'],
  relations: ['char-main'],
  secrets: ['char-main'],
  // —— 酒馆模式（2026-09-15）——
  // 语义：勾 B 必须连带 A。组内互绑＝双向声明，resolveFeatures 的闭包会把整组拉齐。
  // ① 启用任一酒馆功能 → 控制面板（没有它连模型都接不上）
  // ② 背景设定 / 剧情推演 / 推演报告 —— 同进同出
  // ③ 自由对话 / 角色卡片 / 剧本编辑 —— 同进同出
  'tavern-world': ['tavern-control', 'tavern-plot', 'tavern-report'],
  'tavern-plot': ['tavern-control', 'tavern-world', 'tavern-report'],
  'tavern-report': ['tavern-control', 'tavern-world', 'tavern-plot'],
  'tavern-free': ['tavern-control', 'tavern-card', 'tavern-script'],
  'tavern-card': ['tavern-control', 'tavern-free', 'tavern-script'],
  'tavern-script': ['tavern-control', 'tavern-free', 'tavern-card'],
}

/**
 * 「至少需要一个」依赖（2026-09-15）：勾了 key 却连一个候选都没启用时，自动补上候选里的第一个。
 *
 * 与 STRONG_DEPS 的区别：那是「被依赖项必须全都有」，这是「有一个就够」。
 * 现实动机：剧情推演要有项目资料可喂 —— 一个设定功能都没开的话，那场戏只能凭空编。
 */
export const ANY_DEPS: Record<string, string[]> = {
  // 候选按「对推演的有用程度」排序：先角色（没人就没戏），再章节 / 大纲（定叙事锚点），最后世界观
  'tavern-plot': ['char-main', 'chapter-outline', 'volume-outline', 'chapter-master', 'worldbase', 'master', 'positioning'],
}

export function tierOf(id: string): FeatureTier {
  return FEATURE_TIER[id] ?? 'optional'
}

export const LOCKED_IDS: string[] = Object.keys(FEATURE_TIER).filter(id => FEATURE_TIER[id] === 'locked')
export const DEFAULT_IDS: string[] = Object.keys(FEATURE_TIER).filter(id => FEATURE_TIER[id] === 'default')

/** 自定义项目：给定用户勾选的可选项集合，解析出最终启用的功能全集（含锁定项 + 被依赖强制带入项） */
export function resolveFeatures(selected: Set<string>): string[] {
  const out = new Set<string>([...LOCKED_IDS, ...selected])
  let changed = true
  while (changed) {
    changed = false
    for (const id of [...out]) {
      for (const dep of STRONG_DEPS[id] ?? []) {
        if (!out.has(dep)) { out.add(dep); changed = true }
      }
    }
    // 「至少一个」依赖：启用者存在、候选全空 → 补首选（保证有资料可喂）
    for (const [id, cands] of Object.entries(ANY_DEPS)) {
      if (!out.has(id) || cands.length === 0) continue
      if (cands.some(c => out.has(c))) continue
      out.add(cands[0])
      changed = true
    }
  }
  return [...out]
}

/** 在已启用集合基础上，算出哪些功能因依赖被强制锁定（不可由用户取消） */
export function forcedByDeps(enabled: Set<string>): Set<string> {
  const forced = new Set<string>()
  for (const id of enabled) {
    for (const dep of STRONG_DEPS[id] ?? []) forced.add(dep)
  }
  // 「至少一个」依赖：只在**只剩一个**候选时锁住它 ——
  // 取消它会被立刻补回，锁住比让勾选框自己弹回来体面；还有别的候选则不锁，允许自由切换资料源。
  for (const [id, cands] of Object.entries(ANY_DEPS)) {
    if (!enabled.has(id)) continue
    const hits = cands.filter(c => enabled.has(c))
    if (hits.length === 1) forced.add(hits[0])
  }
  return forced
}

/** 判断某功能（页签 / 编辑器）在指定可见性上下文下是否可见（启用） */
export function tabVisible(tabId: string, ctx: VisCtx): boolean {
  // 卷台账（chapter-vol-*）跟随「章节总表」的可见性：自定义项目里启用了章节总表即显示各卷子表
  if (isVolumeLedgerTab(tabId)) tabId = 'chapter-master'
  // 🔴 完整项目：**全部页签一律显示**（2.7.2 主人定案）。
  //    原先这里叠了一层题材矩阵（`packShowsTab`）—— 按题材把「政治 / 经济 / 宗教 / 司法」
  //    藏起来，导致同一套开书定位在不同题材下少几页、作者还得去《世界设定》页里手动补开。
  //    现在题材**只影响各页签里的字段名与说明文案**，不再决定「有没有这一页」，
  //    所以完整项目直接放行（老项目同享此规则，无需迁移）。
  if (ctx.type === 'full') return true
  // 自定义项目按启用功能集合过滤：**用户在「功能模块」弹窗里勾什么就显示什么**。
  return ctx.features.includes(tabId)
}
