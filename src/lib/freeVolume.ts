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
//   5. **order 用哨兵值、恒排最后** —— 见下方 `FREE_VOLUME_ORDER` 的说明。
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
 * 自由卷的 order：**哨兵值**，远大于任何真卷（真卷是 0..n-1 的连续小整数）。
 *
 * 为什么不用「最大 order + 1」：那样每当有新的建卷动作（侧栏建卷 / 拆书导入 / 创意写作建卷 /
 * 回收站恢复自动建卷），新卷的 order 就会盖过自由卷，把它挤到中间 —— 它的章节也就跟着插进
 * 正文序列中段，导出顺序、正文序号、上一章/下一章全会乱。而"每次建卷后再把自由卷顶回最后"
 * 是事后补救、漏一处就出 bug（2.6.4 影响面排查时确实漏了 4 处）。
 *
 * 用哨兵值之后：真卷 order 一律从 `nextVolumeOrder()` 取（只数真卷），永远撞不到哨兵，
 * 自由卷天然恒在末位，无需任何事后重排。唯一要守的是**卷拖拽重排必须排除自由卷**
 * （`reorderVolumes` 会把传入的卷重新编成 0..n-1，会把哨兵值冲掉）。
 */
export const FREE_VOLUME_ORDER = 1_000_000

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
export function pushFreeVolumeLast(vols: Volume[]): Volume[] {
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
