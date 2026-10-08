// ============ 2.9.1 · 体检台账与缓存（lib/checkLog.ts） ============
//
// 覆盖：① 跑一次引擎会落一条台账；② 同一数据版本内第二次调用命中缓存（**不**新增台账）；
//      ③ 趋势查询；④ 换项目后台账按项目隔离；⑤ humanAgo 文案；⑥ 清空台账；
//      ⑦ 投稿前自检落库（2.9.2：不做缓存、按章 scope、notable 计 warn）。
//
// 🔴 「缓存生效」的判据刻意选的是「第二次没有新增台账记录」——
//    缓存是内部实现，直接断言它拿不到把手；而「没多记一条」是它唯一可观测的外部效果。
import * as db from '../src/lib/db'
import { continuityLogged, foreshadowLogged, manuscriptLogged, trendOf, clearCheckLog, humanAgo } from '../src/lib/checkLog'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const mkCh = (id: string, volId: string, order: number, title: string) => {
  return { id, projectId: 'p1', volumeId: volId, order, title, content: '', summary: '', status: '构思', wordCount: 0, createdAt: 0, updatedAt: 0 }
}

__resetMockStores()
;(async () => {
  const pid = 'p1'
  // ⚠️ updatedAt 必须非 0 —— checkLog 拿不到版本号时会**跳过缓存**（防止 0===0 让缓存永不失效）
  await memoryOps.put('projects', { id: pid, name: '台账场', createdAt: 0, updatedAt: 12345 })
  db.setCurrentProject(pid)
  await memoryOps.put('volumes', { id: 'v1', projectId: pid, order: 0, title: '卷一', description: '', createdAt: 0 })
  await memoryOps.put('chapters', mkCh('c1', 'v1', 0, '第1章'))
  // 造一条必然被报出的数据：章节台账里引用了不存在的伏笔编号
  // ⚠️ 两个都容易写错，一起记在这里：
  //   · tabId 必须是**卷台账**（`chapter-vol-<卷id>`）—— `getAllChapterLedgerRows()` 按这个前缀过滤，
  //     「章节总表」只是只读汇总视图，往它里面 put 行是没人读的；
  //   · 行 id 必须形如 `ch-<章节id>` —— continuityCheck 靠这个前缀认「这行对应哪一章」。
  await memoryOps.put('tableRows', { id: 'ch-c1', projectId: pid, tabId: 'chapter-vol-v1', order: 0, data: { '章节标题': '第1章', '埋设伏笔编号': 'F9999' } })

  // ---------- ① 首次跑：引擎真跑 + 落一条台账 ----------
  const first = await continuityLogged()
  const log1 = await db.getSetting<unknown[]>('checkLog', [])
  ok('① 首次体检后台账记录 1 条', log1.length === 1, `len=${log1.length}`)
  ok('① 体检本身返回了结果（引用不存在的伏笔编号 ⇒ 伏笔编号孤儿）',
    Array.isArray(first) && first.some(i => i.title.includes('伏笔编号孤儿')), `n=${first.length}`)

  // ---------- ② 同版本内复用缓存 ----------
  await continuityLogged()
  const log2 = await db.getSetting<unknown[]>('checkLog', [])
  ok('② 同一数据版本内第二次调用命中缓存（不新增台账）', log2.length === 1, `len=${log2.length}`)

  // ---------- ③ 趋势查询 ----------
  const t1 = await trendOf('continuity')
  ok('③ 趋势查询返回最近一次快照且 prev 为 null（只有一条）',
    !!t1 && t1.cur.total === first.length && t1.prev === null, JSON.stringify(t1))

  // 伏笔引擎也走同一条链（另一个 engine 键，独立落账）
  const f = await foreshadowLogged()
  ok('③ 伏笔看板同样跑通并落账', !!f && Array.isArray(f.board) && Array.isArray(f.issues))
  const tF = await trendOf('foreshadow')
  ok('③ 伏笔趋势独立于连续性趋势', !!tF && tF.engine === 'foreshadow')
  const t1b = await trendOf('continuity')
  ok('③ 记伏笔台账不影响连续性的趋势', !!t1b && t1b.cur.total === first.length)

  // ---------- ④ 换项目：缓存清空 + 台账按项目隔离 ----------
  db.setCurrentProject('p2')
  await memoryOps.put('projects', { id: 'p2', name: '另一本', createdAt: 0, updatedAt: 999 })
  const logP2 = await db.getSetting<unknown[]>('checkLog', [])
  ok('④ 台账按项目隔离（换项目后为空）', logP2.length === 0, `len=${logP2.length}`)
  const tP2 = await trendOf('continuity')
  ok('④ 换项目后无趋势可查', tP2 === null)

  // ---------- ⑤ humanAgo ----------
  ok('⑤ humanAgo：刚刚', humanAgo(Date.now() - 5_000) === '刚刚')
  ok('⑤ humanAgo：分钟', humanAgo(Date.now() - 300_000) === '5 分钟前')
  ok('⑤ humanAgo：小时', humanAgo(Date.now() - 7_200_000) === '2 小时前')
  ok('⑤ humanAgo：天', humanAgo(Date.now() - 172_800_000) === '2 天前')

  // ---------- ⑥ 清空台账 ----------
  db.setCurrentProject(pid)
  await clearCheckLog()
  const log3 = await db.getSetting<unknown[]>('checkLog', [])
  ok('⑥ 清空台账后为空', log3.length === 0, `len=${log3.length}`)
  ok('⑥ 清空后再次体检可重新落账', await (async () => {
    await continuityLogged()
    return (await db.getSetting<unknown[]>('checkLog', [])).length === 1
  })())

  // ---------- ⑦ 投稿前自检落库（2.9.2）----------
  // 🔴 与上面两个 engine 的三点差异，逐条钉住：
  //    ① **不做缓存**（纯统计算得快）⇒ 同 scope 连跑两次应记 **2** 条；
  //    ② `notable` 计 `warn`、其余计 `info`（只为让趋势行有增减可算，不代表「有问题」）；
  //    ③ `scope` 用**章节 id** ⇒ 不同章的趋势互不影响。
  type Snap = { engine: string; scope: string; total: number; warn: number; info: number }
  await clearCheckLog()
  const obs = [
    { key: 'sentence', label: '句长离散度', value: '0.42', hint: '常见 0.3~0.6', notable: false, note: '分布均匀' },
    { key: 'para', label: '段落长度', value: '9.9', hint: '常见 2~6', notable: true, note: '段落偏长' },
  ]
  await manuscriptLogged('c1', obs)
  await manuscriptLogged('c1', obs)
  const logM = await db.getSetting<Snap[]>('checkLog', [])
  ok('⑦ 投稿前自检同 scope 连跑两次记 2 条（不做缓存）', logM.length === 2, `len=${logM.length}`)
  ok('⑦ engine 与 scope（章节 id）正确', logM[0]?.engine === 'manuscript' && logM[0]?.scope === 'c1', JSON.stringify(logM[0]))
  ok('⑦ notable 计 warn、其余计 info', logM[0]?.warn === 1 && logM[0]?.info === 1 && logM[0]?.total === 2,
    JSON.stringify(logM[0]))

  await manuscriptLogged('c2', obs.slice(0, 1))
  const tM1 = await trendOf('manuscript', 'c1')
  const tM2 = await trendOf('manuscript', 'c2')
  ok('⑦ 趋势按章隔离：c1 有上一条、c2 没有', !!tM1 && tM1.prev !== null && !!tM2 && tM2.prev === null,
    `c1prev=${!!tM1?.prev} c2prev=${!!tM2?.prev}`)
  ok('⑦ c2 的趋势只含自己那一条（total=1，未被 c1 串味）', !!tM2 && tM2.cur.total === 1 && tM2.cur.scope === 'c2',
    JSON.stringify(tM2?.cur))
  ok('⑦ 同一 engine 不同 scope 不互相覆盖（c1 仍有 2 条）',
    (await db.getSetting<Snap[]>('checkLog', [])).filter(s => s.engine === 'manuscript' && s.scope === 'c1').length === 2)

  console.log(`\n===== 结果：${pass} PASS / ${fail} FAIL =====`)
  await Promise.resolve()
  process.exit(fail ? 1 : 0)
})()
