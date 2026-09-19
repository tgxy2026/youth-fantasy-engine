// 素材资料：内置只读写作参考库。
// 设计目标：按「分类(category) → 板块(block) → 数据」三级组织，
// 后续新增通用写作参考（如世界观模板、情节套路等）只需往 MATERIAL_CATEGORIES 追加一个 category，
// 组件已按 block.kind 通用渲染，无需改动 UI 代码。
// 所有内容均为只读，用户不可编辑。

export type BlockKind =
  | 'charGrid' // 性格类型卡片网格（含性别筛选 / 搜索）
  | 'list' // 编号 / 普通列表
  | 'combo' // 混搭组合：A × B = 结果
  | 'table' // 表格（表头 + 行）
  | 'tagGroups' // 标签分组云
  | 'attrs' // 萌属性：名 + 说明
  | 'roles' // 故事功能角色列表
  | 'groupedList' // 分组列表（如 补充类型 女 / 男）
  | 'toolbox' // 工具箱：多小节
  | 'mixed' // 复合页签：内部含多个子区块（各自保留原生 kind 渲染），用于折叠同主题子页签

export interface CharDim {
  label: string
  value: string
}

export interface CharType {
  id: string
  name: string
  gender: '女' | '男'
  tagline: string // 一句话标签（如 端庄·分寸感）
  fit: string[] // 适配定位（徽章）
  dims: CharDim[] // 8 维（核心气质 … 避雷；适配定位已单列 fit）
}

export interface ComboItem {
  a: string
  b: string
  result: string
}

export interface RoleItem {
  name: string
  desc: string
}

export interface TagGroup {
  group: string
  tags: string[]
}

export interface AttrItem {
  name: string
  desc: string
}

export interface ToolboxSection {
  title: string
  formula?: string
  example?: string
  items?: { label?: string; text: string }[]
}

/** 分组列表（groupedList）的 data 形状。只在本文件用（经 `Block` 联合对外可见）→ 不 export */
interface GroupedListData {
  groups: { title: string; items: { name: string; text: string }[] }[]
}

/** 表格（table）的 data 形状。同上 → 不 export */
interface TableBlockData {
  head: string[]
  rows: string[][]
}

/**
 * 板块：**按 `kind` 判别**的联合 —— 每种 kind 对应一种 `data` 形状。
 *
 * 🔴 为什么不用 `data: any`：读端本来就靠 `switch (block.kind)` 分派，写成联合后 TS
 *    **自动窄化**，`MaterialLibrary` 里那 10 处 `block.data as XxxType` 可以全部删掉 ——
 *    少一层人工断言，就少一处「断言与 kind 对不上」的可能（2026-09-20 收窄）。
 * ⚠️ 新增 kind 时：先加一支联合成员，再补 `MaterialLibrary` 的 case（漏了会编译不过）。
 */
export type Block =
  | { id: string; title: string; kind: 'charGrid'; data: CharType[] }
  | { id: string; title: string; kind: 'list'; data: string[] }
  | { id: string; title: string; kind: 'combo'; data: ComboItem[] }
  | { id: string; title: string; kind: 'table'; data: TableBlockData }
  | { id: string; title: string; kind: 'tagGroups'; data: TagGroup[] }
  | { id: string; title: string; kind: 'attrs'; data: AttrItem[] }
  | { id: string; title: string; kind: 'roles'; data: RoleItem[] }
  | { id: string; title: string; kind: 'groupedList'; data: GroupedListData }
  | { id: string; title: string; kind: 'toolbox'; data: ToolboxSection[] }
  /** 复合页签：内部含多个子区块，各自保留原生 kind 渲染 */
  | { id: string; title: string; kind: 'mixed'; data: Block[] }

export interface MaterialCategory {
  id: string
  name: string
  blocks: Block[]
}



// ============ 内容库（已拆至 ../data/materialData）============
// 5715 行数据搬走后，本文件**只剩类型定义**。
// 2026-09-19（2.3.0）：那个数据文件又从 `src/lib/` 搬到了 `src/data/`。
//
// 🔴 2026-09-17 审计：原先这里有一行「再导出 MATERIAL_CATEGORIES」的兼容写法，
//    它让「类型模块」反向依赖「数据模块」，与 materialData 回头的类型导入构成循环，
//    还会把 5725 行的数据常量拽进任何只想拿类型的模块。消费方已改为两边直连，故删除。
//    新代码请记住：**类型从本文件取，数据从 ../data/materialData 取**（别再从这里透出数据）。
//
// ⚠️ 写注释时别出现「from '路径'」这种字样 —— 项目的依赖扫描器是**文本级**的，
//    会把注释里的路径当成真实 import，凭空报出假循环（2026-09-17 就踩了一次）。
