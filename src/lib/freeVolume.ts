// ============ 「自由章节」与托管它的隐藏分卷 ============
//
// 需求（2.6.4）：作者想直接写一章，却不想先建卷 —— 那些「不想或难以归类到具体卷」的文本
// （灵感片段、人物小传、番外散篇、还没想好归属的章节…）统一交给一个**系统保留分卷**托管。
//
// 🔴 五条硬约束（动这里之前先读）：
//   1. **不预建** —— 没有自由章节的项目不该凭空多一个空卷；首次新建自由章节时才 lazy 创建。
//   2. **不可删除** —— 卷删除在存储层是**级联**的（`db/volumes.ts` 会把卷内章节推进回收站），
//      误删自由卷＝丢正文，所以每处删卷入口都必须拦（只提示、不删）。
//      已知入口两处：`useNovelEditorModel.removeVolume` 与 `Sidebar.removeVolume`（章节总表侧栏）。
//   3. **判定只认 `isFree` 字段、不认标题** —— 作者可以给这个卷随便改名，改名后判定依然有效。
//   4. **计数与统计要排除它** —— 新建卷的默认序号、「N 卷」统计都只数真卷，
//      否则作者看到「第2卷」会变成「第3卷」、卷数凭空多一个。
//   5. **order 用哨兵值、恒排最前（且不占正文序号）** —— 见下方 `FREE_VOLUME_ORDER` 的说明。
//
// 📌 为什么它是「真卷」而不是复用「未分卷章节（orphan）」：
//   orphan 在章节树里压根不渲染（树只 map volumes），且分不清「主动建的散章」与「卷被删后遗留的」。
//   做成真卷后，自由章节能正常登记进卷台账、能被导出、也能**直接拖进任意卷归类**。

import type { Volume } from './types'
import * as db from './db'
import { uid } from './id'

/** 自由卷首次创建时的默认标题（仅用于显示，判定一律走 isFree） */
export const FREE_VOLUME_TITLE = '自由章节'

/**
 * 自由卷的 order：**哨兵值**，远小于任何真卷（真卷是 0..n-1 的连续小整数）。
 *
 * 🔴 口径（2.6.4 起）：自由卷**恒排全书最前** —— 作者把「灵感片段 / 人物小传 / 番外散篇」
 * 这类还没想好归属的文本收在这里，放在正文之前更符合直觉（读起来像"楔子 / 设定区"）。
 * 但它**不占正文序号**：章节号是全局派生的（`chapterSeq.chapterSeqMap`），自由卷内的章节一律
 * 不编号，正片仍从「第1章」起。
 *
 * 为什么用哨兵值而不是「最小 order - 1」：每当有新的建卷动作（侧栏建卷 / 拆书导入 / 创意写作建卷 /
 * 回收站恢复自动建卷），「最小 order - 1」就得重算一遍、漏一处就把自由卷挤到中段。
 *
 * 用哨兵值之后：真卷 order 一律从 `nextVolumeOrder()` 取（只数真卷，恒 ≥ 0），永远撞不到负数
 * 哨兵，自由卷天然恒在首位，无需任何事后重排。唯一要守的是**卷拖拽重排必须排除自由卷**
 * （`reorderVolumes` 会把传入的卷重新编成 0..n-1，会把哨兵值冲掉）。
 */
export const FREE_VOLUME_ORDER = -1_000_000

/** 是否「自由卷」（托管未归类章节的系统保留卷） */
export function isFreeVolume(v?: { isFree?: boolean } | null): boolean {
  return !!v && v.isFree === true
}

/** 排除自由卷后的真卷列表 —— 新建卷计数 / 卷数统计 / 卷重排都该用它 */
export function realVolumes(vols: Volume[]): Volume[] {
  return vols.filter(v => !isFreeVolume(v))
}

/** 建卷默认名的序号：只数真卷 */
export function nextVolumeNo(vols: Volume[]): number {
  return realVolumes(vols).length + 1
}

/**
 * 新卷该用的 order：只数真卷的最大 order + 1。
 * 🔴 不能拿「全部卷的最大 order」当基准 —— 那会取到自由卷的哨兵值，新卷直接排到 100 万位。
 */
export function nextVolumeOrder(vols: Volume[]): number {
  return realVolumes(vols).reduce((m, v) => Math.max(m, v.order ?? 0), -1) + 1
}

/** 在当前清单里找自由卷（不存在返回 undefined —— 未预建是正常的） */
export function findFreeVolume(vols: Volume[]): Volume | undefined {
  return vols.find(v => isFreeVolume(v))
}

/**
 * 安全网：把自由卷的 order 校正回哨兵值（真卷保持不变）。
 * 供「不确定上游有没有动过 order」的入口调用（如卷拖拽重排后）；纯函数，无变化则**原样返回同一引用**，
 * 调用方可用 `out === vols` 判断是否要落库。
 */
export function pushFreeVolumeFirst(vols: Volume[]): Volume[] {
  const free = findFreeVolume(vols)
  if (!free || free.order === FREE_VOLUME_ORDER) return vols
  return vols.map(v => (v.id === free.id ? { ...v, order: FREE_VOLUME_ORDER } : v))
}

/**
 * 确保自由卷存在：已有则直接返回，没有才创建。
 * @param current 已加载的卷清单（省一次读库）；不传则自己读库
 */
export async function ensureFreeVolume(current?: Volume[]): Promise<Volume> {
  const list = current && current.length ? current : await db.getAllVolumes()
  const hit = findFreeVolume(list)
  if (hit) return hit
  const vol: Volume = {
    id: uid(),
    projectId: db.getCurrentProjectId(),
    order: FREE_VOLUME_ORDER,
    title: FREE_VOLUME_TITLE,
    description: '',
    createdAt: Date.now(),
    isFree: true,
  }
  await db.saveVolume(vol)
  return vol
}
