/**
 * 「对话引导」的会话存档（3.1.3）。
 *
 * ## 为什么需要它
 * 对话引导是本项目里**唯一**一个"聊完即丢"的 AI 对话窗口：作者被问到第 8 个问题
 * （性格缺陷？核心动机？），电话来了切出去 —— 回来点开又从头问第一题，之前答的全要重答。
 * 切页签同理（组件卸载即丢 useState）。
 *
 * ## 形态（极薄一层，与 `editor/freeDraft.ts` 同款写法）
 * ```
 * settingsKV[`${pid}::interview::<scope>`] = InterviewArchive
 * ```
 * · 走 `getSetting / setSetting / delSetting`（**db 门面**）⇒ 自动按项目隔离、随项目备份；
 * · `scope` 由调用方给稳定值（弹窗的 draftScope / 功能名），本文件不解释它的含义；
 * · **只存「上次那一条」**，不做多会话列表（那是 AIAssist 的会话历史，另一件事）。
 *
 * ## 三条读取规则（都在 `loadInterviewArchive` 里）
 * 1. 已填回表单（`applied`）⇒ 丢弃：作者回到表单时不该再看到"要不要继续"；
 * 2. 空会话 / 结构损坏 ⇒ 丢弃：不提示一条点开什么都没有的存档；
 * 3. 超过 7 天 ⇒ 丢弃：半年后突然冒出一段旧对话，比没有更吓人。
 * 三条都**顺手把库里的键删掉**（否则孤儿键会一直躺着，还会被备份带走）。
 *
 * 🔴 存档不是关键数据：读写失败只留痕、不抛 —— 绝不能因为它把对话界面卡死。
 * 🔴 本文件只能 import `@/lib/db` 与类型，不许 import 任何 component。
 */
import { delSetting, getSetting, setSetting } from '@/lib/db'
import type { InterviewState } from '@/lib/creative/interview'

/** 存储键前缀 */
const PREFIX = 'interview::'

/** 存档有效期：7 天（读取时生效，过期的直接清掉） */
export const INTERVIEW_ARCHIVE_TTL_MS = 7 * 24 * 3600 * 1000

export interface InterviewArchive {
  state: InterviewState
  /** 最后一次落盘时间戳（恢复提示里显示「X 分钟前」） */
  updatedAt: number
  /** 是否已填回表单（true ⇒ 下次打开直接丢弃） */
  applied: boolean
  /** 恢复提示用：「上次在聊『主要角色』」 */
  subject: string
}

/**
 * 作用域 → 存储键。`scope` 为空返回 `''`（表示**不存档**）。
 * 🔴 不要在这里拼项目 id —— `getSetting/setSetting` 会拼，自己再拼一次就成了双前缀。
 */
export function interviewKeyOf(scope: string): string {
  const s = String(scope ?? '').trim()
  return s ? `${PREFIX}${s}` : ''
}

/** 结构校验：只认「有 turns 数组的 state」，其余一律当损坏（旧版本 / 手改库 / 半截写入） */
function isUsableArchive(v: unknown): v is InterviewArchive {
  if (!v || typeof v !== 'object') return false
  const a = v as Partial<InterviewArchive>
  const st = a.state
  if (!st || typeof st !== 'object') return false
  if (!Array.isArray(st.turns)) return false
  if (typeof st.done !== 'boolean') return false
  if (!st.filled || typeof st.filled !== 'object') return false
  return typeof a.updatedAt === 'number' && Number.isFinite(a.updatedAt)
}

/** 存档有多久了（恢复提示用）。纯函数，好测：1 分钟内「刚刚」，之后按分钟/小时/天 */
export function archiveAgeLabel(updatedAt: number, now = Date.now()): string {
  const ms = Math.max(0, now - updatedAt)
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/**
 * 读存档。没有 / 不可用一律返回 `null`（并把不可用的那条清掉）。
 *
 * @param now 仅供测试注入（默认 `Date.now()`）
 */
export async function loadInterviewArchive(scope: string, now = Date.now()): Promise<InterviewArchive | null> {
  const key = interviewKeyOf(scope)
  if (!key) return null
  let raw: unknown
  try {
    raw = await getSetting<unknown>(key, null)
  } catch (e) {
    // 读失败 = 这次没有存档（不影响对话本身）
    console.warn('[interviewStore] 读取对话存档失败：', e)
    return null
  }
  if (!isUsableArchive(raw)) {
    // 结构不可用（含"从来没存过"的 null）—— 只有真存过东西才值得删，避免每次打开都打一次删除
    if (raw !== null && raw !== undefined) await clearInterviewArchive(scope)
    return null
  }
  const a = raw
  /**
   * 丢弃条件（三条都要清库，不能只 return null）：
   *   · 已填回表单 —— 作者回到表单时不该再被问"要不要继续"；
   *   · **没有作者的回答** —— 只有 AI 开场白时提示「聊到第 0 轮回答」比不提示更怪，
   *     而且这种会话恢复回去也没有任何信息量；
   *   · 过期 —— 半年后突然冒出旧对话比没有更吓人。
   */
  const answered = a.state.turns.filter(t => t.role === 'user').length
  if (a.applied || answered === 0 || now - a.updatedAt > INTERVIEW_ARCHIVE_TTL_MS) {
    await clearInterviewArchive(scope)
    return null
  }
  return a
}

/**
 * 同一作用域的落盘**串行链**。
 *
 * 🔴 为什么必须要：`runTurn` 是异步的，作者手快连发两轮时，第二次 `setSetting` 可能先于第一次
 *    完成 ⇒ 库里留下的是**旧那一轮**（界面显示 3 轮、重开只剩 2 轮）。串行链让写入按调用顺序排队。
 * 🔴 链上每个节点都必须 catch 掉自己的异常：一处失败不能让后面所有落盘都断掉。
 */
const chains = new Map<string, Promise<unknown>>()

/** 落盘。返回**是否真的存上了**（失败只留痕，不抛） */
export async function saveInterviewArchive(scope: string, a: InterviewArchive): Promise<boolean> {
  const key = interviewKeyOf(scope)
  if (!key) return false
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev
    .catch(() => { /* 上一环失败不影响这一环 */ })
    .then(async () => {
      try {
        await setSetting(key, a)
        return true
      } catch (e) {
        console.warn('[interviewStore] 对话存档写入失败（本次未落库，对话照常）：', e)
        return false
      }
    })
  chains.set(key, next)
  return next
}

/** 删掉存档（填回表单后 / 作者选「重新开始」时调用）。幂等：不存在也算成功 */
export async function clearInterviewArchive(scope: string): Promise<void> {
  const key = interviewKeyOf(scope)
  if (!key) return
  // 清也要排在写入之后：否则一个还没落完的写会把刚删的存档又写回来
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev
    .catch(() => { /* 同上 */ })
    .then(async () => {
      try {
        await delSetting(key)
      } catch (e) {
        console.warn('[interviewStore] 对话存档清理失败：', e)
      }
    })
  chains.set(key, next)
  await next
}
