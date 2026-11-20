// ============ 网页版「有新版本，刷新以应用」 ============
//
// 【为什么网页版需要它】桌面/便携是离线应用，用户主动"检查更新"即可；
// 网页版更常见的坏情况是**页面在标签页里挂了好几天**，后台已经发了两版，
// 用户还在用旧 JS —— 此时界面上的更新弹窗（查 Release）帮不上忙：
// 它提示的是"桌面版有新包"，而网页版真正要做的只是**刷新**。
//
// 【判断依据是什么】自建清单 `version.json` 里的 `webBuildId`。
// 🔴 为什么不用线上 `/BUILD_ID`（规划初稿的假设）：`server/deploy.sh` 在打包**前**生成它、
//    远端部署脚本又会把它 `mv` 出 dist（`server/scripts/deploy.sh:71`）——它**不是公开端点**，
//    线上 `curl /BUILD_ID` 是 404（2026-11-21 实测）。清单里的 `webBuildId` 才是给客户端读的。
//
// 【口径】三条，避免变成"烦人弹窗"：
//   ① 只有**确实换版**才提示（两个 id 都非空且不同）；
//   ② 取不到就**静默**（断网 / 清单没部署 / 字段缺失 —— 一律不提示，绝不拿空值当"有新版本"）；
//   ③ 同一天点过"今天不再提示"就不再提示（存 uiPrefs，按**本地日期**算，不用 UTC）。
import { readStringPref, writeStringPref } from '@/lib/settings/uiPrefs'
import { fetchVersionManifest } from '@/lib/app/versionCheck'

/** "今天不再提示"的记录键（存的是本地日期 `YYYY-MM-DD`） */
const KEY_DISMISSED = 'update-web-dismissed-on'

/**
 * 本地日期键（`YYYY-MM-DD`）。
 *
 * 🔴 不用 `toISOString().slice(0,10)`：那是 **UTC** 日期，东八区晚 8 点后写进去的是"明天"，
 *    于是"今天不再提示"会变成"明天也不再提示"（或者反过来当天点了没用）。
 *    免打扰是给人看的，必须按人所在时区算。
 */
export function localDateKey(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * 要不要弹"有新版本，刷新以应用"。
 *
 * @param currentBuildId 本页面启动时记下的 webBuildId（不是构建号，是清单里的那个）
 * @param latestBuildId  刚取到的最新 webBuildId
 * @param dismissedOn    上次点"今天不再提示"的本地日期（没有则 null）
 * @param today          可注入，便于单测跨日场景
 */
export function shouldPrompt(
  currentBuildId: string,
  latestBuildId: string,
  dismissedOn: string | null,
  today: string = localDateKey(),
): boolean {
  const cur = (currentBuildId || '').trim()
  const next = (latestBuildId || '').trim()
  // 口径②：任一侧为空 = 无从比较 ⇒ 静默
  if (!cur || !next) return false
  // 口径①：同一个构建，没什么可刷新的
  if (cur === next) return false
  // 口径③：今天已经说过"别烦我"
  if (dismissedOn && dismissedOn === today) return false
  return true
}

/** 上次点"今天不再提示"的日期（没有/读不到 → null） */
export function readDismissedOn(): string | null {
  const v = readStringPref(KEY_DISMISSED)
  return v && v.trim() ? v.trim() : null
}

/** 记下"今天不再提示"（按本地日期） */
export function dismissForToday(today: string = localDateKey()): void {
  writeStringPref(KEY_DISMISSED, today)
}

/**
 * 取线上最新 webBuildId。取不到（断网 / 清单缺失 / 字段为空）→ 空串。
 * **永不抛** —— 这条链路只在后台静默跑，不该因为网络抖动在控制台留未捕获异常。
 */
export async function fetchLatestWebBuildId(): Promise<string> {
  try {
    const m = await fetchVersionManifest()
    return (m?.webBuildId ?? '').trim()
  } catch {
    return ''
  }
}
