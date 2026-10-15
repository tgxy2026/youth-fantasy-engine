/**
 * 角色卡（card 型页签）的**字段级取值定义单一源**（3.1.x）。
 *
 * 【为什么单独一个文件】
 * 下拉型字段（人物状态 / 保密等级）的取值有两个消费方：
 *   ① `CharacterSheet` 渲染行内下拉；
 *   ② `lib/storage/cardIO.ts` 生成导入导出用的虚拟列（options 供 AI 候选值注入与说明文档）。
 * 两处各写一份 → 加档位时必然漏改一处。这不是假设：`SABC` 从四档加 D 档时，
 * 设定检索里就藏着一份副本、漏改了（见 `schemaShared.ts` 的 `SABC` 注释）。
 * 故收敛到本文件，两边都从这里取。
 *
 * ⚠️ 本文件只放「字段的取值集合」；字段本身（名称 / 说明 / 示例）仍在 `schemaTabs/part1.ts`。
 */
import { SABC, SABC_LABELS } from '@/lib/schemaShared'

/**
 * 下拉型字段：`value` = 存储值，`label` = 展示文案。
 *
 * 键是**纯字段名**（不含模块前缀）—— 与 `CharacterSheet` 里 `field.name` 的取值口径一致。
 */
export const CARD_SELECT_FIELDS: Record<string, { value: string; label: string }[]> = {
  '人物状态': [
    { value: '未登场', label: '未登场' },
    { value: '已登场', label: '已登场' },
    { value: '已退场', label: '已退场' },
  ],
  // 保密等级：存储单字母、展示附含义。档位顺序取 SABC（单一源）—— 别在这里重列一遍数组。
  '保密等级': SABC.map(v => ({ value: v, label: SABC_LABELS[v] ?? v })),
}
