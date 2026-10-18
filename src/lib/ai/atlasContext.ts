/**
 * 图鉴页签的 **AI 读取字段清单**（3.1.3 · 方案 §7.1 第 3 条入口）。
 *
 * 为什么单独一个文件：`aiContext.ts` 已贴着 1200 行硬上限（结构闸 ①），
 * 把"加载字段配置 + 解析"塞进去必然爆线；抽出来也让这条链路可被单独复用。
 *
 * 🔴 三条口径：
 *   1. **按 `aiReadable` 过滤** —— 作者关掉「允许 AI 参考」的字段不能进提示词；
 *   2. **忽略类别适用范围**（`ignoreAppliesTo`）—— AI 看到的是整张表的字段结构，
 *      不该因为某个字段"只适用魔兽"就让模型以为这张表没有它；
 *   3. 归档字段不参与（`resolveAtlasFields` 内部已排除）。
 */
import type { TabDef } from '@/lib/types'
import type { ResolvedAtlasField } from '@/lib/atlas/types'
import { resolveAtlasFields } from '@/lib/atlas/schema'
import { loadAtlasSchema } from '@/lib/atlas/persistence'
import * as db from '@/lib/db'

/**
 * 读当前项目的图鉴字段（含自定义字段），失败时返回 `null`。
 * `null` 的语义是「按原 `tab.columns` 走」—— 单段读取失败不该让整份上下文崩掉。
 */
export async function loadAtlasFieldsForAI(tab: TabDef): Promise<ResolvedAtlasField[] | null> {
  try {
    const cfg = (await loadAtlasSchema(db.getCurrentProjectId(), tab.id as 'races' | 'items')).config
    return resolveAtlasFields(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true })
  } catch {
    return null
  }
}
