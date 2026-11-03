/**
 * 章节规划板 · **往返状态**（3.4.0 · A）
 *
 * 【只做一件事：把「作者离开规划板时的视图」原样带回来】
 * 规划板挂在写作面板里，点卡片进正文 = 整页卸载；回来时组件重新挂载，
 * 卷 / 状态 / 关键词 / 展开的索引、显示数量与滚动位置全部回到默认值 ——
 * 作者明明只是去看一眼某一章，回来却要重新筛一遍。这在本项目里是**发现性**问题，不是数据问题。
 *
 * 🔴 三条边界（与规划 §四「数据与兼容约束」同口径）：
 *   ① **只存本机界面偏好**（localStorage，走 `uiPrefs`），不进项目数据、不同步、不导出；
 *      换台机器重新筛一次即可，不该把视图状态混进项目 JSON。
 *   ② **按项目隔离**：键里带 `projectId`；切项目绝不会拿上一个项目的筛选去套新项目。
 *   ③ **读到脏数据一律降级到默认值**：卷被删了、状态枚举改过名、显示数量被手改成 NaN，
 *      都不能让规划板崩或显示空列表 —— 宁可回到「全部」。
 *
 * 纯函数（`restoreBoardState` / `limitCovering` / `locateBoardAnchor`）与读写分离，
 * 单测直接跑，不把 React / db 拖进依赖图。
 */
import { readStringPref, writeStringPref } from '@/lib/settings/uiPrefs'

/** 规划板状态筛选项（与 `WritingWorkflow` 的下拉、`Chapter['status']` 同口径） */
export const BOARD_STATUSES = ['构思', '细纲', '草稿', '修改', '完稿', '已发布'] as const
export type BoardStatus = (typeof BOARD_STATUSES)[number] | 'all'

/** 两种视图：正文摘要 / 细纲卡 */
export const BOARD_VIEWS = ['chapters', 'outlines'] as const
export type BoardView = (typeof BOARD_VIEWS)[number]

/** 首屏与「继续显示」的步长（现有行为，不能改：改了小项目也会多渲染） */
export const BOARD_PAGE = 60

/**
 * 显示数量上限。
 *
 * 🔴 只是**防御脏数据**（例如存档里写了 10^9 会把整本书一次性塞进 DOM）；
 *    正常使用下「继续显示」可以一路点到全量，这里不替作者设业务上限。
 */
export const BOARD_MAX_LIMIT = 6000

export interface ChapterBoardState {
  version: 1
  /** 规划板是否展开 */
  open: boolean
  view: BoardView
  query: string
  status: BoardStatus
  /** `'all'` 或卷 id */
  volumeId: string
  chapterLimit: number
  outlineLimit: number
  /** 页面滚动容器（main）里的位置 */
  scrollTop: number
  /** 上次从规划板点进去的章节 —— 回来时用来判断「目标还在不在」 */
  anchorId: string | null
  savedAt: number
}

export interface BoardScope {
  volumeIds: readonly string[]
  /** 细纲页签是否可见（项目功能模块可能没开） */
  outlinesAvailable: boolean
}

/** 恢复结果：状态 + 需要如实告诉作者的降级原因 */
export interface BoardRestore {
  state: ChapterBoardState
  notices: string[]
}

export function defaultBoardState(): ChapterBoardState {
  return {
    version: 1,
    open: false,
    view: 'chapters',
    query: '',
    status: 'all',
    volumeId: 'all',
    chapterLimit: BOARD_PAGE,
    outlineLimit: BOARD_PAGE,
    scrollTop: 0,
    anchorId: null,
    savedAt: 0,
  }
}

/** 显示数量：取整到步长、夹在 [BOARD_PAGE, BOARD_MAX_LIMIT]（脏值 → 步长） */
export function normalizeLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : BOARD_PAGE
  const stepped = Math.ceil(n / BOARD_PAGE) * BOARD_PAGE
  return Math.min(BOARD_MAX_LIMIT, Math.max(BOARD_PAGE, stepped))
}

/**
 * 锚点章节在当前筛选结果里的位置 → 需要把显示数量抬到多少才能渲染到它。
 *
 * 规划要求「锚点超出初始范围时先加载，再定位」：不能为了回到原位直接一次性渲染整本书，
 * 也不能因为渲染不到就默默停在第 60 条。
 */
export function limitCovering(index: number, current: number): number {
  const need = Math.ceil((index + 1) / BOARD_PAGE) * BOARD_PAGE
  return normalizeLimit(Math.max(normalizeLimit(current), need))
}

export type BoardAnchorState = 'found' | 'filtered-out' | 'missing'

/**
 * 锚点章节的三种结局：
 *   · found        —— 在（恢复筛选后的）列表里，可以定位；
 *   · filtered-out —— 章节还在，但当前筛选/显示顺序里看不到（例如状态被改过）；
 *   · missing      —— 章节已不在项目中（删了 / 换了项目）。
 *
 * 🔴 三者必须分开提示：把 filtered-out 说成「已删除」会让作者以为丢了数据。
 */
export function locateBoardAnchor(anchorId: string | null, ids: readonly string[]): BoardAnchorState {
  if (!anchorId) return 'missing'
  return ids.includes(anchorId) ? 'found' : 'filtered-out'
}

/**
 * 校验并降级一份**读出来的**规划板状态。
 *
 * `raw` 来自 localStorage，可能是：旧版本写的、手改坏的、别的项目的卷 id、甚至不是对象。
 * 所有降级都记在 `notices` 里 —— 界面要如实说「卷已经不在，所以改成了全部分卷」，
 * 而不是让作者以为自己上次筛的就是「全部分卷」。
 */
export function restoreBoardState(raw: unknown, scope: BoardScope): BoardRestore {
  const base = defaultBoardState()
  const notices: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: base, notices }
  const rec = raw as Record<string, unknown>

  const open = typeof rec.open === 'boolean' ? rec.open : base.open
  let view: BoardView = BOARD_VIEWS.includes(rec.view as BoardView) ? rec.view as BoardView : base.view
  if (view === 'outlines' && !scope.outlinesAvailable) {
    view = 'chapters'
    if (rec.view === 'outlines') notices.push('当前项目没有启用「章节细纲」，规划板已切回正文章节视图')
  }

  let status: BoardStatus = base.status
  if (rec.status === 'all') status = 'all'
  else if (BOARD_STATUSES.includes(rec.status as (typeof BOARD_STATUSES)[number])) status = rec.status as BoardStatus
  else if (typeof rec.status === 'string' && rec.status !== 'all') notices.push('上次筛选的章节状态已不可用，已改为全部状态')

  let volumeId = typeof rec.volumeId === 'string' && rec.volumeId ? rec.volumeId : 'all'
  if (volumeId !== 'all' && !scope.volumeIds.includes(volumeId)) {
    volumeId = 'all'
    notices.push('上次筛选的分卷已被删除，已改为全部分卷')
  }

  const query = typeof rec.query === 'string' ? rec.query.slice(0, 200) : ''
  const scrollTop = typeof rec.scrollTop === 'number' && Number.isFinite(rec.scrollTop) && rec.scrollTop > 0
    ? Math.min(rec.scrollTop, 2_000_000)
    : 0
  const anchorId = typeof rec.anchorId === 'string' && rec.anchorId ? rec.anchorId : null

  return {
    state: {
      version: 1,
      open,
      view,
      query,
      status,
      volumeId,
      chapterLimit: normalizeLimit(rec.chapterLimit),
      outlineLimit: normalizeLimit(rec.outlineLimit),
      scrollTop,
      anchorId,
      savedAt: typeof rec.savedAt === 'number' && Number.isFinite(rec.savedAt) ? rec.savedAt : 0,
    },
    notices,
  }
}

const KEY_PREFIX = 'chapter-board:'

/** 读原始 JSON（解析失败 → null，不抛） */
export function readBoardStateRaw(projectId: string): unknown {
  const text = readStringPref(`${KEY_PREFIX}${projectId}`)
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** 读 + 校验（一步到位，供组件初始化用） */
export function loadBoardState(projectId: string, scope: BoardScope): BoardRestore {
  return restoreBoardState(readBoardStateRaw(projectId), scope)
}

/**
 * 落盘。写失败（隐私模式 / 配额满）只影响「下次回来还记不记得」，本次会话照常工作，
 * 所以静默返回 —— 与 `uiPrefs` 的既有约定一致。
 */
export function saveBoardState(projectId: string, state: ChapterBoardState): void {
  if (!projectId) return
  writeStringPref(`${KEY_PREFIX}${projectId}`, JSON.stringify({ ...state, version: 1, savedAt: Date.now() }))
}
