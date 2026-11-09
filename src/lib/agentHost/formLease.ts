/** 页面内表单操作协调。跨窗口/云端写入仍需存储层原子版本控制。 */
type Slot = { editors: number; saves: number; agent: Promise<void> | null; release?: () => void }
const slots = new Map<string, Slot>()
const keyOf = (projectId: string, tabId: string) => JSON.stringify([projectId, tabId])
/** 表格与表单使用不同命名空间，避免页签名碰撞。 */
export const tableLeaseKey = (tabId: string) => `table::${tabId}`
export const cardLeaseKey = (tabId: string) => `card::${tabId}`
/** 情节画布不是页签表格：用独立命名空间，避免与同名页签碰撞。 */
export const canvasLeaseKey = 'canvas::plot'
function slotOf(projectId: string, tabId: string): Slot {
  const key = keyOf(projectId, tabId)
  let slot = slots.get(key)
  if (!slot) { slot = { editors: 0, saves: 0, agent: null }; slots.set(key, slot) }
  return slot
}
function cleanup(projectId: string, tabId: string, slot: Slot) {
  if (!slot.editors && !slot.saves && !slot.agent) slots.delete(keyOf(projectId, tabId))
}

/** 编辑页面挂载时登记，Agent 不修改已经打开的表单。 */
export function registerFormEditor(projectId: string, tabId: string): () => void {
  const slot = slotOf(projectId, tabId)
  slot.editors++
  let closed = false
  return () => { if (!closed) { closed = true; slot.editors--; cleanup(projectId, tabId, slot) } }
}

/** 临时内联编辑不能等待时，Agent 正在写入则不打开旧数据编辑器。 */
export function tryRegisterFormEditor(projectId: string, tabId: string): (() => void) | null {
  const slot = slotOf(projectId, tabId)
  if (slot.agent || slot.saves) return null
  return registerFormEditor(projectId, tabId)
}

/** 页面加载时先等正在执行的 Agent 写入。 */
export async function waitForAgentForm(projectId: string, tabId: string): Promise<void> {
  await slots.get(keyOf(projectId, tabId))?.agent
}

/** 普通表单保存也参与协调，防止卸载时延迟保存覆盖 Agent 的修改。 */
export async function withFormSave<T>(projectId: string, tabId: string, save: () => Promise<T>): Promise<T> {
  const slot = slotOf(projectId, tabId)
  if (slot.agent) throw new Error('Agent 正在修改该表单，请稍后重试并核对当前内容。')
  slot.saves++
  try { return await save() }
  finally { slot.saves--; cleanup(projectId, tabId, slot) }
}

/** 页面是否正在编辑或保存该表（批量覆盖前预检用；不占用 Agent 租约）。 */
export function isFormLeaseBusy(projectId: string, tabId: string): boolean {
  const slot = slots.get(keyOf(projectId, tabId))
  return !!slot && (slot.editors > 0 || slot.saves > 0 || !!slot.agent)
}

/** 不等待作者的编辑或保存；忙时直接拒绝。 */
export function acquireAgentForm(projectId: string, tabId: string): (() => void) | null {
  const slot = slotOf(projectId, tabId)
  if (slot.agent || slot.editors || slot.saves) return null
  slot.agent = new Promise<void>(resolve => { slot.release = resolve })
  let released = false
  return () => {
    if (released) return
    released = true
    const resolve = slot.release
    slot.release = undefined
    slot.agent = null
    resolve?.()
    cleanup(projectId, tabId, slot)
  }
}
