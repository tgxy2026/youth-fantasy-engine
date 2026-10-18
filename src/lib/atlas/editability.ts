/**
 * 图鉴字段的**可编辑性**判定（3.1.3 · 详情就地编辑）。
 *
 * 单独成文件而不是塞进 `AtlasDetail.tsx`：这是纯判定、要在单测里直接跑，
 * 放组件里就得连带加载 React / 对话框 / 图标，测试成本无谓地高。
 */
import type { ResolvedAtlasField } from './types'

/**
 * 详情里**能就地改**的字段。
 *
 * 放开的是"纯文字 + 有固定候选的下拉 + 自定义六类型"；
 * 下面这些一律留在表格里改，因为它们不是"填个值"那么简单：
 *   · `编号` —— 按规则自动生成、还带唯一性校验，随手改只会造脏编号；
 *   · `tableRef`（上级 / 地理位置）、`character` / `characters` —— 选项来自别的表或角色卡，
 *     需要带搜索与新建的专用控件；
 *   · `date` / `calendar` —— 结构化日期与多历法数值体系，改错会让时间轴排序失真。
 */
export function atlasDetailEditable(field: ResolvedAtlasField): boolean {
  if (field.source === 'custom') return true
  if (field.key === '编号') return false
  const t = field.builtinType ?? 'text'
  if (t === 'text' || t === 'textarea') return true
  // select 取不到候选（如「历法」列，选项来自项目配置）⇒ 不在这里硬开一个空下拉
  if (t === 'select') return (field.options?.length ?? 0) > 0
  return false
}
