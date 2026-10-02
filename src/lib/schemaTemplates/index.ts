/**
 * schemaTemplates —— 开书定位「世界设定 / 力量体系 / 四个制度页签」的题材模板总出口（2.7.1）。
 *
 * ## 用法（只在 schema.ts 里接一次）
 * `TABS` 里那六个「受题材驱动」的页签，其 `name / description / modules / tips`
 * 一律写成 **getter**，读本模块的 `getActivePack()`：
 *
 * ```ts
 * { id: 'worldbase', get name() { ... }, get modules() { return worldbaseModules(getActivePack()) }, ... }
 * ```
 *
 * 这样全仓 20+ 个消费方（AI 上下文 / 导出 / 设定检索 / 设定汇总 / 表单 / 侧栏…）
 * **零改动**自动跟随题材包 —— 它们读的都是 `tab.modules` / `tab.name`。
 *
 * ## 为什么返回的是**稳定引用**
 * `WORLDBASE_MODULES[pack]` 是模块加载期建好的静态数组，同一次调用返回同一引用 ⇒
 * `useMemo(..., [tab.modules])` 之类的依赖不会次次失效，行为与改造前一致。
 */
import type { FormModule } from '../types'
import { DEFAULT_PACK, type GenrePack } from './packs'
import { WORLDBASE_MODULES } from './worldbase'
import { POWER_MODULES } from './power'
import { INSTITUTION_META, institutionModulesOf } from './institutions'

// 枚举 / 判据 / 别名 / 题材矩阵 / 当前包 —— 全部从 packs 直达，调用方只认这一个入口
export * from './packs'

// ==================== 模块解析 ====================

export function worldbaseModules(pack: GenrePack): FormModule[] {
  return WORLDBASE_MODULES[pack] ?? WORLDBASE_MODULES[DEFAULT_PACK]
}

export function powerModules(pack: GenrePack): FormModule[] {
  return POWER_MODULES[pack] ?? POWER_MODULES[DEFAULT_PACK]
}

/**
 * 四个制度页签的模块（**示例随题材变**，见 institutions.ts 的 EXAMPLES_BY_PACK）。
 * @param pack 当前项目题材；不传则用默认包（东方修真）⇒ 字段定义里那套古史示例。
 */
export function institutionModules(tabId: string, pack?: GenrePack): FormModule[] | undefined {
  return institutionModulesOf(tabId, pack ?? DEFAULT_PACK)
}

/**
 * 按 tabId 解析模块（题材包 → 六页签）。
 *
 * 给**组件**用的显式入口：`TABS` 里那六个页签的 `modules` 是 getter（读模块级 activePack），
 * 而组件若想把「当前包」作为 state 参与 `useMemo` 依赖（切包时精确重算、不靠全局副作用），
 * 就用这个函数显式传包。两条路读的是同一份数据，不会漂移。
 */
export function modulesFor(tabId: string, pack: GenrePack): FormModule[] | undefined {
  if (tabId === 'worldbase') return worldbaseModules(pack)
  if (tabId === 'power') return powerModules(pack)
  // 🔴 2.7.2：制度四页签的**示例也随题材变**（原先是一套古史 defaults 写死）——
  //    desc（问什么）保持中性，只换 example（给什么样式）。见 institutions.ts 的 EXAMPLES_BY_PACK。
  return institutionModulesOf(tabId, pack)
}

export function institutionMeta(tabId: string) {
  return INSTITUTION_META[tabId]
}

// ==================== 页签名 / 说明 / tips（`东方修真` 逐字保留）====================
// 🔴 `东方修真` 的 description / tips 必须与改造前的 schema **一字不差** ——
//    它出现在页头与问号气泡里，任何改写都是「老项目界面被改动」。

const DF_WORLDBASE_DESC = '世界观顶层档案：世界总览、底层法则、社会文明、成长地图、限制禁忌、剧情钩子。世界观是舞台不是字典，三层填法：底层法则定了不改→社会文明前十章展开→细节随写随补。分两层填：【全书统一（母级）】只有一份、永远发给 AI；下面可建多个【子世界】（副本 / 世界线 / 剧本），各一套完整设定，只有标为「活跃」的才发给 AI。'
const DF_WORLDBASE_TIPS = [
  '底层法则模块定了就不能改；社会文明前十章慢慢展开；细节设定随写随补。',
  '📌 母级（全书统一）永远发给 AI；子世界只有标为「活跃」的才发。写完一个副本记得把它标成已完结 —— 几套设定同时发给模型，最容易让它把两个世界的规则写串。',
  '📝 表单下方的「设定草稿箱」是给你先落档用的：随便写、不限长度、跟着字数长高，它「不会发给 AI」（输入框旁有标注）；想让它变成正式设定，就点里面的「AI 整理到上方字段」。',
]
const DF_POWER_DESC = '升级流网文的"物理法则"：力量来源、境界阶梯、能力门槛、克制关系、金手指接口。等级表是宪法，正文发布后尽量不改。分两层填：【全书统一（母级）】只有一份、永远发给 AI（写统一的等级总纲）；下面可建多个【子体系】（不同世界 / 副本各自的力量规则），只有标为「活跃」的才发给 AI。'
const DF_POWER_TIPS = [
  '等级一旦正文发布尽量不改；定稿前先写三章试水检验数值膨胀。',
  '📌 母级的「等级总表」写全书通用那一套；某个副本另有一套等级时，才需要建子体系。子体系只有标为「活跃」的才发给 AI。',
  '📝 表单下方的「设定草稿箱」是给你先落档用的：随便写、不限长度、跟着字数长高，它「不会发给 AI」；想让它变成正式设定，就点里面的「AI 整理到上方字段」。',
]

/** 世界设定的说明 / tips：东方修真逐字保留，其余题材给中性版 */
export function worldbaseDesc(pack: GenrePack): string {
  if (pack === DEFAULT_PACK) return DF_WORLDBASE_DESC
  return `「${pack}」的世界总览：世界长什么样、社会怎么组织、主角的活动地图怎么层层展开。「总览页只写概括」，制度细节（政治 / 经济 / 信仰 / 司法）与力量规则各有专门页签（按题材显示，未显示的可在本页头部「页签」开启）。分两层填：【全书统一（母级）】只有一份、永远发给 AI；下面可建多个【子世界】（不同时代 / 副本 / 舞台），各自一套完整设定，只有标为「活跃」的才发给 AI。`
}

export function worldbaseTips(pack: GenrePack): string[] {
  if (pack === DEFAULT_PACK) return DF_WORLDBASE_TIPS
  return [
    '这是一张「总览」表：写概括，别写细节 —— 政治 / 经济 / 信仰 / 司法各有专门页签，力量规则见《力量体系》。',
    '📌 母级（全书统一）永远发给 AI；子世界只有标为「活跃」的才发。写完一个舞台记得标成已完结 —— 几套设定同时发给模型，最容易写串。',
    '📝 表单下方的「设定草稿箱」是给你先落档用的：随便写、不限长度、跟着字数长高，它「不会发给 AI」；想让它变成正式设定，就点里面的「AI 整理到上方字段」。',
  ]
}

/** 力量体系的说明 / tips：东方修真逐字保留，其余题材（含弱替包）给中性版 */
export function powerDesc(pack: GenrePack): string {
  if (pack === DEFAULT_PACK) return DF_POWER_DESC
  if (pack === '都市现实' || pack === '历史古代' || pack === '女频言情') {
    return `「${pack}」没有超自然力量，这个页签默认隐藏 —— 在《世界设定》页头部点「页签」可开启，届时显示为「能力资源 / 权谋实力 / 关系地位」，用来记录「人和势力的实力与地位」：能力 / 权谋 / 关系能到什么位置、怎么一步步往上走。开启后页签 id 与字段结构不变，只是内容换了现实向的实力体系。分两层填：【全书统一（母级）】只有一份、永远发给 AI；下面可建多个【子体系】（不同势力 / 阶段各一套），只有标为「活跃」的才发给 AI。`
  }
  return `「${pack}」的力量 / 规则内核：力量来源、等级阶梯、能力门槛、克制关系、与主角的接口。等级表是宪法，正文发布后尽量不改。分两层填：【全书统一（母级）】只有一份、永远发给 AI；下面可建多个【子体系】（不同舞台各自一套），只有标为「活跃」的才发给 AI。`
}

export function powerTips(pack: GenrePack): string[] {
  if (pack === DEFAULT_PACK) return DF_POWER_TIPS
  return [
    '等级 / 阶序一旦正文发布尽量不改；定稿前先写三章试水检验膨胀。',
    '📌 母级写全书通用那一套；某个舞台另有体系时才建子体系，且只有标为「活跃」的才发给 AI。',
    '📝 表单下方的「设定草稿箱」是给你先落档用的：随便写、不限长度、跟着字数长高，它「不会发给 AI」；想让它变成正式设定，就点里面的「AI 整理到上方字段」。',
  ]
}
