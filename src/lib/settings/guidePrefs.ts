// ============ 引导观看状态（3.3.1 · P2） ============
//
// 规划 §3.3 的状态表：无记录 → 自动展示；已完成 / 已跳过 → 不再自动展示；中断 → 不算完成。
// 另外要「关闭自动引导」「重置本页 / 重置全部」，且不能影响业务数据与其他偏好。
//
// 🔴 身份作用域（规划 §3.3 明确要求，不是可选项）：
//   · 桌面 / 便携：本机 profile ⇒ localStorage 持久；
//   · 网页游客：数据本来就在这台浏览器里 ⇒ localStorage（天然是独立空间）；
//   · 网页登录账号（云端 / 账号本地两种模式）：服务端在入口 HTML 里注入
//     `window.__YFE_USER__.id`（见 `server/index.mjs` 的 renderIndex），**模块求值前就已存在**，
//     所以这里按账号给记录加命名空间后落 localStorage —— 同一浏览器换账号互不串，刷新后不再重弹。
//
// 🔴 2026-11-11 修正（3.5.0 用户反馈「网页版进去老是要重新看新手教程」）：
//     原实现按「网页云端没有稳定账号标识」处理，把记录只留在内存（`session`），
//     结果**凡是有云同步资格的网页账号，每刷新一次就把所有页签的引导重看一遍**。
//     标识其实早就有（`__YFE_USER__.id` 自网页账号上线起就注入），故改为持久 + 按账号命名空间。
//     只有「确实拿不到标识」时才退回会话内记录，避免落到共享键上串账号。
import { WEB, WEB_ACCOUNT_LOCAL, WEB_CLOUD } from '@/lib/app/platform'
import { PREF_EVENT, readBoolPref, readSetPref, writeBoolPref, writeSetPref } from '@/lib/settings/uiPrefs'

export const GUIDE_AUTO_KEY = 'guide-auto'
export const GUIDE_DONE_KEY = 'guide-done'
export const GUIDE_SKIPPED_KEY = 'guide-skipped'

export type GuideScope = 'persistent' | 'session'

/** 服务端注入的登录账号标识（未登录 / 读不到 → 空串） */
function webAccountId(): string {
  try {
    const w = (typeof window !== 'undefined' ? window : {}) as { __YFE_USER__?: { id?: string } }
    const id = w.__YFE_USER__?.id
    return id ? String(id) : ''
  } catch {
    return ''
  }
}

/** 是否「网页版的登录账号」（云端模式或账号本地模式，且确实拿到了账号标识） */
function isWebAccount(): boolean {
  if (!WEB) return false
  if (!WEB_CLOUD && !WEB_ACCOUNT_LOCAL) return false
  return webAccountId() !== ''
}

/** 记录能落在哪里；只有「网页登录但拿不到账号标识」才退化成本次会话 */
export function guideStorageScope(): GuideScope {
  if (!WEB) return 'persistent'
  if (WEB_CLOUD || WEB_ACCOUNT_LOCAL) return webAccountId() ? 'persistent' : 'session'
  return 'persistent'
}

/**
 * 实际落盘用的键：网页登录账号追加账号命名空间，其余（桌面 / 便携 / 游客、以及拿不到标识的兜底）
 * 沿用原键 —— 既有用户的「已看过」记录不作废。
 */
function scopedKey(base: string): string {
  if (!isWebAccount()) return base
  return `${base}@${encodeURIComponent(webAccountId())}`
}

/** 一次性迁移标记：把本次改法之前写在共享键里的记录搬进账号命名空间 */
const ACCOUNT_MIGRATED_KEY = 'guide-acct-migrated'
let migrationChecked = false

/**
 * 首次访问时把旧的无命名空间记录搬进当前账号的命名空间。
 *
 * 🔴 为什么需要：3.5.0 之前「网页账号本地模式」（未授予云同步资格的新账号）是直接写共享键的。
 *    改按账号命名空间后，若不做这一步，这批用户会**把所有页签的引导再重看一遍** ——
 *    正是本次要修的那个体感。只在目标命名空间**完全没有记录**时搬，搬完打标记，
 *    不会把别的账号的记录一次次盖过来。
 */
function ensureAccountMigration(): void {
  if (migrationChecked) return
  migrationChecked = true
  if (!isWebAccount()) return
  const marker = scopedKey(ACCOUNT_MIGRATED_KEY)
  if (readBoolPref(marker, false)) return
  const pairs: [string, string][] = [
    [GUIDE_DONE_KEY, GUIDE_DONE_KEY],
    [GUIDE_SKIPPED_KEY, GUIDE_SKIPPED_KEY],
  ]
  for (const [legacy, base] of pairs) {
    const legacyValue = readSetPref(legacy)
    if (!legacyValue) continue
    if (readSetPref(scopedKey(base))) continue
    writeSetPref(scopedKey(base), legacyValue)
  }
  // 「上次把自动引导关掉了」也要跟着搬，否则搬完会突然又开始自动弹
  if (!readBoolPref(GUIDE_AUTO_KEY, true)) writeBoolPref(scopedKey(GUIDE_AUTO_KEY), false)
  writeBoolPref(marker, true)
}

/** 会话内记录（localStorage 不可用 / 拿不到账号标识时的兜底，避免同一次打开反复弹卡片） */
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
  ensureAccountMigration()
  if (guideStorageScope() === 'session') return !session.autoOff
  return readBoolPref(scopedKey(GUIDE_AUTO_KEY), true)
}

export function setGuideAutoEnabled(enabled: boolean): void {
  ensureAccountMigration()
  if (guideStorageScope() === 'session') {
    session.autoOff = !enabled
  } else {
    writeBoolPref(scopedKey(GUIDE_AUTO_KEY), enabled)
  }
  notify()
}

function readSet(kind: 'done' | 'skipped'): Set<string> {
  ensureAccountMigration()
  if (guideStorageScope() === 'session') return new Set(session[kind])
  return new Set(readSetPref(scopedKey(kind === 'done' ? GUIDE_DONE_KEY : GUIDE_SKIPPED_KEY)) ?? [])
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
  writeSetPref(scopedKey(kind === 'done' ? GUIDE_DONE_KEY : GUIDE_SKIPPED_KEY), current)
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
  writeSetPref(scopedKey(kind === 'done' ? GUIDE_DONE_KEY : GUIDE_SKIPPED_KEY), current)
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
  ensureAccountMigration()
  writeSetPref(scopedKey(GUIDE_DONE_KEY), [])
  writeSetPref(scopedKey(GUIDE_SKIPPED_KEY), [])
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
