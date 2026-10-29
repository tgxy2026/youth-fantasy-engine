// ============ 引导观看状态（3.3.1 · P2） ============
//
// 规划 §3.3 的状态表：无记录 → 自动展示；已完成 / 已跳过 → 不再自动展示；中断 → 不算完成。
// 另外要「关闭自动引导」「重置本页 / 重置全部」，且不能影响业务数据与其他偏好。
//
// 🔴 身份作用域（规划 §3.3 明确要求，不是可选项）：
//   · 桌面 / 便携：本机 profile ⇒ localStorage 持久；
//   · 网页游客：数据本来就在这台浏览器里 ⇒ localStorage（天然是独立空间）；
//   · 网页云端：本仓库**没有**服务端下发的稳定账号标识（只有 `__YFE_WEB__` / `__YFE_GUEST__`
//     两个平台标志，见 `lib/app/platform.ts`）。按规划「身份未就绪时只存会话内记录，
//     不落到共享账号键」—— 这里落内存，同一浏览器换账号不会互相看到彼此的观看记录。
//     等账号标识接入后再把 `guideStorageScope()` 改成返回 `persistent` 并带账号命名空间。
import { WEB, WEB_CLOUD } from '@/lib/app/platform'
import { PREF_EVENT, readBoolPref, readSetPref, writeBoolPref, writeSetPref } from '@/lib/settings/uiPrefs'

export const GUIDE_AUTO_KEY = 'guide-auto'
export const GUIDE_DONE_KEY = 'guide-done'
export const GUIDE_SKIPPED_KEY = 'guide-skipped'

export type GuideScope = 'persistent' | 'session'

/** 记录能落在哪里；网页云端目前没有稳定账号标识 ⇒ 只存本次会话 */
export function guideStorageScope(): GuideScope {
  if (!WEB) return 'persistent'
  return WEB_CLOUD ? 'session' : 'persistent'
}

/** 会话内记录（网页云端 / localStorage 不可用时的兜底，避免同一次打开反复弹卡片） */
const session = {
  autoOff: false,
  done: new Set<string>(),
  skipped: new Set<string>(),
}

/** 同窗口订阅者：写侧派发 PREF_EVENT，多实例（如两个页签组件）一起刷新 */
export function subscribeGuidePrefs(listener: () => void): () => void {
  window.addEventListener(PREF_EVENT, listener)
  // 跨窗口：localStorage 被别的窗口改写时浏览器会派发 storage（同窗口不派发，故两个都要听）
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(PREF_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

export function isGuideAutoEnabled(): boolean {
  if (guideStorageScope() === 'session') return !session.autoOff
  return readBoolPref(GUIDE_AUTO_KEY, true)
}

export function setGuideAutoEnabled(enabled: boolean): void {
  if (guideStorageScope() === 'session') {
    session.autoOff = !enabled
  } else {
    writeBoolPref(GUIDE_AUTO_KEY, enabled)
  }
  notify()
}

function readSet(kind: 'done' | 'skipped'): Set<string> {
  if (guideStorageScope() === 'session') return new Set(session[kind])
  return new Set(readSetPref(kind === 'done' ? GUIDE_DONE_KEY : GUIDE_SKIPPED_KEY) ?? [])
}

/**
 * 写入一条记录。
 *
 * 🔴 每次都**重新读一遍现存集合再合并**，而不是拿内存里的旧集合整块覆盖 ——
 *    同一项目里可能有多个引导实例（多窗口 / 多页签组件），用旧集合覆盖会把别人刚写进去的
 *    「已完成」抹掉，表现就是「明明看过，下次又弹」。
 */
function addRecord(kind: 'done' | 'skipped', key: string): void {
  if (guideStorageScope() === 'session') {
    session[kind].add(key)
    notify()
    return
  }
  const current = readSet(kind)
  if (current.has(key)) return
  current.add(key)
  writeSetPref(kind === 'done' ? GUIDE_DONE_KEY : GUIDE_SKIPPED_KEY, current)
  notify()
}

function removeRecord(kind: 'done' | 'skipped', key: string): void {
  if (guideStorageScope() === 'session') {
    session[kind].delete(key)
    notify()
    return
  }
  const current = readSet(kind)
  if (!current.delete(key)) return
  writeSetPref(kind === 'done' ? GUIDE_DONE_KEY : GUIDE_SKIPPED_KEY, current)
  notify()
}

/** 已完成（走到最后一步点了「完成」） */
export function markGuideDone(key: string): void { addRecord('done', key) }

/** 已跳过（关闭 / 跳过本页 / Esc）—— 跳过**不等于学会**，只表示别再自动弹 */
export function markGuideSkipped(key: string): void { addRecord('skipped', key) }

/** 看过没：完成或跳过都算「别再自动弹」 */
export function hasGuideRecord(key: string): boolean {
  return readSet('done').has(key) || readSet('skipped').has(key)
}

export function isGuideDone(key: string): boolean {
  return readSet('done').has(key)
}

/** 重置某个页签（「重置本页」）：完成与跳过一起清掉，下次进入会重新自动展示 */
export function resetGuide(key: string): void {
  removeRecord('done', key)
  removeRecord('skipped', key)
}

/** 重置全部引导记录（不影响自动引导开关、缩放、主题等其它偏好） */
export function resetAllGuides(): void {
  if (guideStorageScope() === 'session') {
    session.done.clear()
    session.skipped.clear()
    notify()
    return
  }
  writeSetPref(GUIDE_DONE_KEY, [])
  writeSetPref(GUIDE_SKIPPED_KEY, [])
  notify()
}

/** 当前作用域下的完整记录（设置页与测试用；调用方拿到的是一份拷贝） */
export function readGuideStateSnapshot(): { done: Set<string>; skipped: Set<string> } {
  return { done: readSet('done'), skipped: readSet('skipped') }
}

/** 当前作用域下有多少条记录（设置页显示「已看过 N 个页签」用） */
export function guideRecordCount(): number {
  return new Set([...readSet('done'), ...readSet('skipped')]).size
}

function notify(): void {
  // 同窗口：复用 uiPrefs 的偏好事件；跨窗口靠 storage 事件
  window.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key: 'guide' } }))
}

/** 仅供测试：清空会话内状态，避免用例互相污染 */
export function resetGuideSessionForTest(): void {
  session.autoOff = false
  session.done.clear()
  session.skipped.clear()
}
