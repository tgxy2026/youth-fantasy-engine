/**
 * 「作品题材要不要告诉 AI」——**项目级开关**（3.0 · 社区反馈）。
 *
 * ## 起因
 * 2.7.1 起 `Project.genre`（四字题材包名）会经 `aiContext` 无条件注入成
 * 「类型：东方修真」—— 当初这么做的理由写在 `schemaTemplates/packs.ts` 顶部：
 * 「值即包名 ⇒ 注入天然可读、不用额外映射」。也就是说它从一开始**只是元数据**，
 * 并没有配任何"请按此题材风格写作"的指令。
 *
 * 但社区作者的实际观感是：**选的题材会在不知不觉里影响 AI 生成的内容**
 * （模型看到「类型：都市异能」就按该题材套路发挥）。而最初的定位是
 * 「题材只管开书定位组各页签的字段名与示例」，它本不该进提示词。
 *
 * ## 处置（主人拍板：四项一起做）
 * ① **默认不再注入** —— 题材回归纯 schema 开关（这是本模块 `DEFAULT = false` 的由来）；
 * ② 想让 AI 知道题材的作者，**显式打开这个开关**（项目级，随项目走）；
 * ③ 更推荐的路子是填《作品信息》页的「类型赛道」字段 —— 那是作者自己写的题材描述
 *    （如「东方玄幻·升级流」），比四字包名更具体，且一直随设定资料正常发出；
 * ④ 披露：由 `aiDataSources.AI_OVERVIEW_NOTE` 在各 AI 功能的问号气泡里统一说明
 *    「作品概览里有什么、题材默认不在其中」。
 *
 * 🔴 **为什么是项目级而不是全局**：题材本身就是项目属性（每本书一个），
 *    "要不要告诉 AI" 自然也是每本书各自的决定。走 `db.getSetting/setSetting`
 *    （自带 `<pid>::` 前缀），随项目导出 / 云同步搬运，换机器不丢。
 *
 * 🔴 **默认值改了会不会伤到老项目**：会改变行为 —— 升级后 AI 不再看到「类型：」那一行。
 *    这正是本次要的效果（回到最初设计）；作者想要旧行为，打开开关即可（一处开关，全局生效）。
 */
import * as db from '@/lib/db'
import { normalizeGenrePack } from '@/lib/schemaTemplates/index'

/** `settingsKV` 里的键（`getSetting/setSetting` 会自动加 `<pid>::` 前缀，这里不要再拼） */
const K_GENRE_TO_AI = 'genreToAI'

/** 出厂默认：**不**把题材告诉 AI（题材只管字段名 —— 回到最初设计） */
export const DEFAULT_GENRE_TO_AI = false

/**
 * 读开关。
 *
 * 🔴 读不出来 / 脏值一律退回**默认（关）** —— 与「额度读不出就回退出厂值」同一条纪律：
 *    一项偏好读失败，不该让 AI 功能整个挂掉，也不该默许把作者没点头的内容发出去。
 */
export async function getGenreToAI(): Promise<boolean> {
  try {
    const v = await db.getSetting<unknown>(K_GENRE_TO_AI, DEFAULT_GENRE_TO_AI)
    return v === true
  } catch {
    return DEFAULT_GENRE_TO_AI
  }
}

export async function setGenreToAI(v: boolean): Promise<void> {
  await db.setSetting(K_GENRE_TO_AI, v === true)
}

/**
 * 按**指定项目**读开关（项目管理页「编辑项目」用）。
 *
 * 🔴 那边改的往往不是当前打开的项目，`db.getSetting` 会写到 `currentProjectId` 上
 *    ⇒ 必须走 pid 版（理由见 `db/meta.ts` 的 `getSettingFor`）。
 */
export async function getGenreToAIFor(pid: string): Promise<boolean> {
  try {
    const v = await db.getSettingFor<unknown>(pid, K_GENRE_TO_AI, DEFAULT_GENRE_TO_AI)
    return v === true
  } catch {
    return DEFAULT_GENRE_TO_AI
  }
}

/** 按指定项目写开关（与上面成对；`pid` 为空表示当前项目） */
export async function setGenreToAIFor(pid: string, v: boolean): Promise<void> {
  await (pid ? db.setSettingFor(pid, K_GENRE_TO_AI, v === true) : setGenreToAI(v))
}

/**
 * 纯函数：题材那一行的文本。**空串代表"这一行不输出"**（调用方直接 filter 掉）。
 *
 * 判据与 `aiContext` 里的旧行为逐字一致：
 *   · 开关没开 → 空串（本次改造唯一的行为差异就在这里）；
 *   · 题材为空 → 空串（改造前也是这个行为，靠 `proj.genre ? …` 短路）；
 *   · 否则 → `类型：<归位后的包名>`（老数据里的自由文本经 `normalizeGenrePack` 归位）。
 */
export function genreLineOf(genre: unknown, enabled: boolean): string {
  if (!enabled) return ''
  const raw = String(genre ?? '').trim()
  if (!raw) return ''
  return `类型：${normalizeGenrePack(raw)}`
}

/** `aiContext` 用这个：读开关 + 构造一步到位（异常已在 `getGenreToAI` 内兜住） */
export async function genreLineForAI(genre: unknown): Promise<string> {
  return genreLineOf(genre, await getGenreToAI())
}
