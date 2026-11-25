/**
 * 图鉴字段的**可编辑性**判定（3.1.3 · 详情就地编辑；3.7.1 · 开放纯跨表与角色单选）。
 *
 * 单独成文件而不是塞进 `AtlasDetail.tsx`：这是纯判定、要在单测里直接跑，
 * 放组件里就得连带加载 React / 对话框 / 图标，测试成本无谓地高。
 */
import type { ResolvedAtlasField } from './types'

/**
 * 详情里**能就地改**的字段。
 *
 * 放开的是「纯文字 + 有固定候选的下拉 + 角色单选 + 纯跨表关联 + 自定义六类型」；
 * 下面这些一律留在表格里改，因为它们牵动编号规则、树形父子结构或地图画布校验：
 *   · `编号` —— 按规则自动生成、还带唯一性校验，随手改只会造脏编号；
 *   · 自引用父级（`上级` / `层级归属`，`refTab === tabId`）—— 牵动表格上下级树与地图父子嵌套；
 *   · 地图绑定（`所属地图`，`refTab === 'geomaps'`）—— 与《地图编辑》画布及隐藏涂格强绑定；
 *   · `characters`（角色多选）与 `date` / `calendar` —— 结构化日期与多历法数值体系，改错会让时间轴排序失真。
 */
export function atlasDetailEditable(field: ResolvedAtlasField, tabId?: string): boolean {
  if (field.source === 'custom') return true
  if (field.key === '编号') return false
  const t = field.builtinType ?? 'text'
  if (t === 'text' || t === 'textarea') return true
  // select 取不到候选（如「历法」列，选项来自项目配置）⇒ 不在这里硬开一个空下拉
  if (t === 'select') return (field.options?.length ?? 0) > 0
  // 3.7.1：角色单选（如物品资源的「当前持有者」）复用 CharacterSelect
  if (t === 'character') return true
  // 3.7.1：纯跨表关联（如国家势力「地理位置」、地理风物「势力归属」）复用 TableRefSelect；
  // 自引用父级（上级 / 层级归属：refTab === tabId）与地图画布绑定（所属地图：refTab === 'geomaps'）
  // 仍留在表格侧（防成环、树形结构与地图无飞地校验）。
  if (t === 'tableRef') {
    if (!field.refTab || !field.refCol) return false
    if (tabId && field.refTab === tabId) return false
    if (field.refTab === 'geomaps') return false
    if (!tabId && (field.key === '上级' || field.key === '层级归属')) return false
    return true
  }
  return false
}
