// ============ 3.4.0 · A 规划板往返状态 ============
//
// 规划板挂在写作面板里，点卡片进正文会让整页卸载再挂回来。本用例钉住三件事：
//   ① 往返状态按**项目**隔离，切项目绝不能把上一个项目的筛选套上来；
//   ② 所有降级（卷被删 / 状态改过名 / 细纲页签不可用 / 脏数字）都要**说得出来**，
//      而不是让作者以为「我上次筛的就是全部」；
//   ③ 锚点超出首批 60 条时先抬显示数量，判断锚点三种结局（在 / 被筛掉 / 已删除）不能混。
import { readStringPref } from '../src/lib/settings/uiPrefs'
import fs from 'node:fs'
import path from 'node:path'
import {
  loadBoardState, saveBoardState, restoreBoardState, defaultBoardState,
  normalizeLimit, limitCovering, locateBoardAnchor,
  BOARD_PAGE, BOARD_MAX_LIMIT, type ChapterBoardState,
} from '../src/lib/app/chapterBoardState'

// 最小 localStorage 桩：必须在调用读写函数之前装好（模块顶层不碰 localStorage）
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
}

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const scope = { volumeIds: ['v1', 'v2'], outlinesAvailable: true }

// ---------- ① 默认值与数字清洗 ----------
{
  const d = defaultBoardState()
  ok('默认不展开、正文章节视图、全部状态/分卷、首批 60 条',
    !d.open && d.view === 'chapters' && d.status === 'all' && d.volumeId === 'all'
    && d.chapterLimit === BOARD_PAGE && d.outlineLimit === BOARD_PAGE)

  ok('脏数字 → 回到首批', normalizeLimit(Number.NaN) === BOARD_PAGE && normalizeLimit('120' as unknown as number) === BOARD_PAGE)
  ok('负数 / 0 → 首批（不能负着渲染）', normalizeLimit(-5) === BOARD_PAGE && normalizeLimit(0) === BOARD_PAGE)
  ok('步长向上取整（61 → 120，不多渲染不少渲染）', normalizeLimit(61) === 120 && normalizeLimit(120) === 120)
  ok('超大值夹到上限（防一次塞整本书）', normalizeLimit(10_000_000) === BOARD_MAX_LIMIT)
}

// ---------- ② 锚点：先加载再定位 ----------
{
  ok('锚点在首批内 → 不需要抬显示数量', limitCovering(3, BOARD_PAGE) === BOARD_PAGE)
  ok('锚点在第 61 条 → 抬到 120', limitCovering(60, BOARD_PAGE) === 120)
  ok('锚点在第 500 条 → 抬到 540', limitCovering(499, BOARD_PAGE) === 540)
  ok('已经显示得比锚点更多时不下调（作者点过「继续显示」）', limitCovering(10, 240) === 240)

  ok('在列表里 → found', locateBoardAnchor('c2', ['c1', 'c2']) === 'found')
  ok('不在列表里 → filtered-out（可能只是被筛掉）', locateBoardAnchor('c9', ['c1', 'c2']) === 'filtered-out')
  ok('没有锚点 → missing', locateBoardAnchor(null, ['c1']) === 'missing')
  // 🔴 3.4.0 纵切发现：只看筛选结果会把「已删到回收站」误报成「被筛掉」。
  ok('🔴 章节仍在项目中、只是被筛掉 → filtered-out',
    locateBoardAnchor('c2', ['c1'], ['c1', 'c2', 'c3']) === 'filtered-out')
  ok('🔴 章节已不在项目里（删到回收站）→ missing',
    locateBoardAnchor('c9', ['c1'], ['c1', 'c2', 'c3']) === 'missing')
  ok('不传存在集合时保持旧口径（向后兼容）',
    locateBoardAnchor('c9', ['c1']) === 'filtered-out')
}

// ---------- ③ 读档：脏数据一律降级并说明 ----------
{
  const r = restoreBoardState(null, scope)
  ok('没记录 → 默认值，且不提示（这不是"降级"）', r.state.chapterLimit === BOARD_PAGE && r.notices.length === 0)
  ok('数组 / 字符串等非对象 → 默认值', restoreBoardState([1, 2], scope).state.open === false && restoreBoardState('x', scope).state.open === false)

  const deletedVol = restoreBoardState({ open: true, volumeId: 'v-gone', status: '草稿' }, scope)
  ok('🔴 分卷已被删 → 回落全部分卷并说明原因',
    deletedVol.state.volumeId === 'all' && deletedVol.notices.some(n => n.includes('分卷')))
  ok('分卷降级不影响状态筛选', deletedVol.state.status === '草稿')

  const badStatus = restoreBoardState({ status: '完结' }, scope)
  ok('未知状态枚举 → 全部状态并说明', badStatus.state.status === 'all' && badStatus.notices.some(n => n.includes('状态')))

  const noOutline = restoreBoardState({ open: true, view: 'outlines' }, { ...scope, outlinesAvailable: false })
  ok('🔴 细纲页签不可用 → 切回正文章节并说明',
    noOutline.state.view === 'chapters' && noOutline.notices.some(n => n.includes('细纲')))
  ok('细纲可用时保留细纲视图', restoreBoardState({ view: 'outlines' }, scope).state.view === 'outlines')

  const dirty = restoreBoardState({ query: 'x'.repeat(500), chapterLimit: 'abc', scrollTop: -9, anchorId: 42, savedAt: 'now' }, scope)
  ok('超长关键词截到 200 字（别把 localStorage 当正文库）', dirty.state.query.length === 200)
  ok('显示数量脏值 → 首批', dirty.state.chapterLimit === BOARD_PAGE)
  ok('负滚动位置 → 0', dirty.state.scrollTop === 0)
  ok('非字符串锚点 → null', dirty.state.anchorId === null)
  ok('非数字 savedAt → 0', dirty.state.savedAt === 0)
}

// ---------- ④ 落盘：按项目隔离、往返一致 ----------
{
  store.clear()
  const st: ChapterBoardState = {
    ...defaultBoardState(), open: true, view: 'chapters', query: '雷劫', status: '草稿',
    volumeId: 'v2', chapterLimit: 120, outlineLimit: 180, scrollTop: 880, anchorId: 'c9',
  }
  saveBoardState('p1', st)
  const back = loadBoardState('p1', scope)
  ok('往返一致：筛选 / 数量 / 位置 / 锚点都回来了',
    back.state.open && back.state.query === '雷劫' && back.state.status === '草稿'
    && back.state.volumeId === 'v2' && back.state.chapterLimit === 120 && back.state.outlineLimit === 180
    && back.state.scrollTop === 880 && back.state.anchorId === 'c9')
  ok('落盘带 savedAt（便于以后排查"什么时候记的"）', back.state.savedAt > 0)

  ok('🔴 换项目读不到上一个项目的筛选（按项目隔离）',
    loadBoardState('p2', scope).state.query === '' && loadBoardState('p2', scope).state.volumeId === 'all')

  store.set('yfe-ui:chapter-board:p3', '{不是 JSON')
  ok('坏 JSON → 默认值，不抛异常', loadBoardState('p3', scope).state.chapterLimit === BOARD_PAGE)

  ok('空项目 id 不写（避免 key 变成 chapter-board:undefined）', (() => {
    saveBoardState('', st)
    return ![...store.keys()].some(k => k.endsWith('chapter-board:'))
  })())
  ok('写盘键前缀走 uiPrefs 统一命名空间', [...store.keys()].every(k => k.startsWith('yfe-ui:')))
  ok('uiPrefs 能直读出同一份 JSON（读写口径一致）', (readStringPref('chapter-board:p1') ?? '').includes('雷劫'))
}

// ---------- ⑤ 接线核对：规划板真的读写了这份状态 ----------
{
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
  const board = read('src/components/app/WritingWorkflow.tsx')
  ok('初始化读档只做一次（useState 惰性初始化，volumes 变化不重置筛选）',
    board.includes('useState(() => {') && board.includes('loadBoardState(projectId'))
  ok('🔴 点卡片前先把锚点写死，再跳正文', (() => {
    const anchor = board.indexOf('anchorRef.current = id')
    const save = board.indexOf('saveBoardState(projectId', anchor)
    const nav = board.indexOf("onNavigate('editor', id)", save)
    return anchor >= 0 && save > anchor && nav > save
  })())
  ok('滚动位置取自真正的滚动祖先（不是 window）', board.includes('scrollParentOf(rootRef.current)'))
  ok('回来时先抬显示数量再定位', board.includes('limitCovering(at, st.chapterLimit)'))
  ok('锚点被删 / 被筛掉分开提示',
    board.includes('已不在项目中') && board.includes('不在当前筛选结果里'))
  ok('筛选为空时给「清除筛选」出口', board.includes('清除筛选，查看全部章节'))
  ok('卸载时再落一次（切页签/关页前也能记住）', board.includes('saveBoardState(projectId, { ...boardStateRef.current'))

  const dash = read('src/components/app/Dashboard.tsx')
  ok('写作面板读失败有明确提示与重试（不再永远停在加载中）',
    dash.includes('写作面板数据读取失败') && dash.includes('重新读取'))
  ok('刷新失败时说明显示的是旧数据', dash.includes('可能不是最新的'))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
