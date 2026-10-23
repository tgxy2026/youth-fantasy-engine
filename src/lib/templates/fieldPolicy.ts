/**
 * 3.2.0 · WT0-3：字段在**语义通道**里的读写准入
 *
 * 为什么单独一个文件：`EffectiveField.permissions` 里的 `aiRead` / `aiWrite` 是
 * **新动态填写（模板字段级 AI 填写）** 的开关，语义写回是另一条通道 ——
 * 它服务的是**旧执行器**（拆书 / 补登 / 章后整理），这些执行器今天就在写内置字段。
 *
 * 🔴 两套口径不能混：
 *   · 内置字段（`source==='builtin'`）—— `aiWrite` 恒为 false（这不代表不可写），
 *     写回走原保存器，故语义通道**允许写**；是否真的能写仍受归档/类别/类型/候选项约束。
 *   · 自定义字段（`cf_*`）—— 必须作者在图鉴里显式放开 `aiWritable`，
 *     否则「模型自己找了个栏位把内容塞进去」，作者完全不知情。
 */
import type { EffectiveField } from './types'

/**
 * 语义读取是否允许（按字段的 AI 读取权限）。
 *
 * 🔴 3.2.2：**读取闸只许走这里**（`semanticView` 已改）。以下几处仍直接读
 *    `f.permissions.aiRead` 是**刻意**的，别顺手替换：
 *    · `templates/render.ts` —— 构造字段投影（`aiReadable` / `aiWritable` 都取裸值），
 *      它不是闸，替换一个不替换另一个会造成不对称；
 *    · `templates/defAdapter.ts` —— `key → 原始值` 的适配器，返回裸值是它的职责；
 *    · `templates/consumers.ts`（两处）—— 规则表要在**裸值之上再叠** `meaningStatus !== 'pending'`，
 *      且必须**保留规则本身**（召回闸靠"规则存在但不可读"判旧块失效）；
 *    · `templates/migrate.ts` —— 迁移指纹里记裸值，口径变了会误判"模板变过"。
 */
export function canSemanticRead(f: EffectiveField): boolean {
  return f.permissions.aiRead
}

/** 语义写回是否允许（内置走原执行器通道；自定义需作者显式放开） */
export function canSemanticWrite(f: EffectiveField): boolean {
  return f.source === 'builtin' || f.permissions.aiWrite
}

/** 不允许写时的原因（给拒绝文案用；允许则返回 null） */
export function writeDeniedReason(f: EffectiveField): string | null {
  if (canSemanticWrite(f)) return null
  return `字段「${f.label}」是自定义字段且未开放 AI 写入`
}
