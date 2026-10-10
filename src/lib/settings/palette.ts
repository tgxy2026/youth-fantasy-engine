/**
 * 调色板单一真源（2.8.0 · 台账 #045/#046 · 2026-10-04）
 *
 * 🔴 为什么要有这一个文件：颜色此前散在 9 个模块里各写各的 ——
 *   · 改一个语义色要翻 N 个文件，漏一处就出现「同一含义两处不同色」；
 *   · `relationColors.ts` 的注释里已经记着一次真实事故：人物关系图 / 势力关系图**各自**维护
 *     内置色板，导致同一「敌对」在两张图里颜色不同（视觉语言不统一）。
 *
 * 现在图谱（节点 / 边）/ 地图图层 / 情节画布 / 结构节拍 / 写作目标的**全部调色板收口到这里**。
 * 其它模块一律 `import` 取值，不得再写裸色值 —— 由 `tests/structureGates.test.ts` 规则⑨ 守住。
 *
 * ⚠️ 三处**允许**保留裸色值（它们不是在"用色"，而是在"描述一套主题/文档"，详见规则⑨注释）：
 *   · `components/CustomThemeDialog.tsx`（自定义主题预设）
 *   · `lib/theme.ts`（内置主题注册表 + 预览色块）
 *   · `lib/tavern/exportDoc.ts`（导出文档自带的内联 CSS，必须自洽、不随 App 主题）
 *
 * ⚠️ 本模块是**纯常量**：不 import 任何东西（尤其不 import db / React / DOM），
 *    故可被 lib 与 components 任意引用，也能在 Node 单测里直接读。
 * ⚠️ 所有值均为 2.8.0 迁移前的**原值逐字搬运**（观感零变化）——调整色值请先确认是"改设计"而非"搬家"。
 */

/** 关系类型 · 自定义类型扩展色板（20 色，色相均匀分布；与 ink/amber 主题协调）。两张关系图共用 */
export const REL_EXTRA_PALETTE = [
  '#e8918f', '#8fc8a9', '#8fb4e8', '#e8b36a', '#c894e8',
  '#e894c0', '#8fd0d6', '#a9c48f', '#e8a48f', '#9fb0e8',
  '#d6a06a', '#a89fe8', '#7fc9c0', '#c9b48f', '#e88fb4',
  '#8fd0a9', '#b4a3e8', '#e8c98f', '#8fb8a3', '#d68fa8',
]

/** 人物关系图 · 内置 8 类语义色（自定义类型走 `REL_EXTRA_PALETTE` 哈希 + 撞色兜底） */
export const REL_PRESET_COLORS: Record<string, string> = {
  '亲属': '#f0a4a4',
  '师徒': '#8fd0c4',
  '盟友': '#8fb4e8',
  '敌对': '#e57070',
  '竞争': '#e8b36a',
  'CP感情线': '#e894c0',
  '主仆': '#a9a4f0',
  '恩怨': '#e57070',
}

/** 势力关系图 · 内置 5 类语义色 */
export const FACTION_PRESET_COLORS: Record<string, string> = {
  '同盟': '#34d399',
  '敌对': '#fb7185',
  '贸易': '#fbbf24',
  '从属': '#818cf8',
  '中立': '#94a3b8',
}

/**
 * 分组类别色板（节点色 = 阵营 / 类别）。
 * 🔴 与「关系类型」的边色板是两套语义：节点色说「你属于谁」，边色说「你们什么关系」。
 */
export const GROUP_PALETTE = [
  '#4f8ff7', '#e06c9f', '#3fb98f', '#e8a33d', '#9b7ff0', '#e07a5f',
  '#3fa9c9', '#8fb04a', '#d46a8a', '#6f86e0', '#c9913f', '#5fae9b',
]

/** 无分组（不属于任何阵营）时的中性节点色 */
export const GROUP_NEUTRAL = '#8b8680'

/** 地图叠加图层色（伏笔 / 角色 / 时间线） */
export const MAP_LAYER_COLORS: { foreshadow: string; character: string; timeline: string } = {
  foreshadow: '#f0a4a4',
  character: '#8fd0c4',
  timeline: '#e8b36a',
}

/** 地图空间 / 区域取色失败时的兜底色 */
export const MAP_SPACE_FALLBACK = '#8fb4e8'

/** 情节画布 · 卡片类型语义色 */
export const PLOT_TYPE_COLORS: { foreshadow: string; hook: string; character: string; next: string; beat: string; idea: string } = {
  foreshadow: '#f0a4a4',
  hook: '#e8b36a',
  character: '#8fd0c4',
  next: '#8fb4e8',
  beat: '#b9a7e8',
  idea: '#7fd18b',
}

/** 结构节奏面板 · 节拍色板（半透明叠在暗底上；与情节画布 beat 卡同族的柔和色） */
export const BEAT_COLORS = ['#b9a7e8', '#8fb8e8', '#8fd0b0', '#e0c987', '#e0a5a5', '#a5d5e0', '#c9b0d8', '#b8d0a0']

/** 写作目标 · 「实际累计」曲线色 */
export const GOAL_ACTUAL_COLOR = '#34d399'
