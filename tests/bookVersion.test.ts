// 3.0 · W3-1 作品版本冻结 · 单测
//
// 盯四件事：
//   ① 完成检查（`bookStats`）—— 空章 / 字数 / 卷数 / 最后改动时间的统计口径；
//   ② 作品级指纹（`bookFingerprint`）—— 稳定、顺序无关、改一字即变；
//   ③ 发布闸门（`evaluatePublishGate`）—— blocker / warn 各判据的边界；
//   ④ 🔴 **源码闸** —— 冻结必须复用 backups（不新建快照表）、恢复必须走 restoreBackup + 重建索引、
//      闸门不许硬拦（作者可强制冻结）。
import fs from 'node:fs'
import type { Chapter, Volume } from '../src/lib/types'
import { bookStats, bookFingerprint, shortFingerprint, evaluatePublishGate } from '../src/lib/app/bookVersion'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— bookVersion 用例开始 ——')

// ---------- 构造助手 ----------
function ch(over: Partial<Chapter> & { id: string; order: number }): Chapter {
  return {
    projectId: 'p1', volumeId: 'v1', title: '章', content: '正文', summary: '',
    status: '草稿', wordCount: 100, createdAt: 1, updatedAt: 1, ...over,
  }
}
function vol(over: Partial<Volume> & { id: string; order: number }): Volume {
  return { projectId: 'p1', title: '卷', description: '', createdAt: 1, ...over }
}

// ---------- ① bookStats ----------
{
  const s0 = bookStats([], [])
  ok('空输入 → 全 0 / lastUpdatedAt=null',
    s0.chapters === 0 && s0.writtenChapters === 0 && s0.totalWords === 0
    && s0.avgWordsPerWritten === 0 && s0.emptyChapterIds.length === 0 && s0.lastUpdatedAt === null)

  const chapters = [
    ch({ id: 'a', order: 1, title: '有正文章', content: '一二三', wordCount: 300, updatedAt: 50 }),
    ch({ id: 'b', order: 2, title: '空章', content: '   ', wordCount: 0, updatedAt: 70 }),
    ch({ id: 'c', order: 3, title: '另一章', content: '正文', wordCount: 500, updatedAt: 90 }),
  ]
  const volumes = [vol({ id: 'v1', order: 1 }), vol({ id: 'vf', order: 99, isFree: true })]
  const s = bookStats(chapters, volumes)
  ok('章节总数 3 / 已写 2（空章不计）', s.chapters === 3 && s.writtenChapters === 2)
  ok('totalWords 只累计已写章（300+500=800）', s.totalWords === 800)
  ok('平均 = 800/2 = 400', s.avgWordsPerWritten === 400)
  ok('空章清单 = [b]', s.emptyChapterIds.length === 1 && s.emptyChapterIds[0] === 'b')
  ok('空章标题带出', s.emptyChapterTitles[0] === '空章')
  ok('卷数排除系统「自由卷」（1 个真实卷）', s.volumes === 1)
  ok('lastUpdatedAt = 最大 updatedAt（90）', s.lastUpdatedAt === 90)

  // 空白只算空：全角空格 / 换行也算空
  const blank = bookStats([ch({ id: 'x', order: 1, content: '\n\t  ' })], [])
  ok('纯空白/换行也算空章', blank.writtenChapters === 0 && blank.emptyChapterIds.length === 1)

  // wordCount 非有限值时不计入（防 NaN 污染）
  const weird = bookStats([ch({ id: 'y', order: 1, content: '正文', wordCount: NaN })], [])
  ok('wordCount=NaN 不计入总字数（不炸）', weird.totalWords === 0)
}

// ---------- ② bookFingerprint ----------
{
  const base = [
    ch({ id: 'a', order: 1, title: '一', content: 'aaa', wordCount: 3, updatedAt: 10 }),
    ch({ id: 'b', order: 2, title: '二', content: 'bbb', wordCount: 3, updatedAt: 20 }),
  ]
  const f1 = bookFingerprint(base)
  const f2 = bookFingerprint(base)
  ok('同输入 → 同指纹（稳定）', f1 === f2 && f1.length > 0)

  // 打乱数组顺序（order 不变）→ 同指纹（先按 order 排序再拼）
  const shuffled = [base[1], base[0]]
  ok('数组顺序无关（按 order 排序）', bookFingerprint(shuffled) === f1)

  // 改内容一字 → 变
  const edited = [{ ...base[0], content: 'aab' }, base[1]]
  ok('改正文一字 → 指纹变', bookFingerprint(edited) !== f1)

  // 改 updatedAt（正文一模一样）→ 变（宁严勿松，与 W1-1 同口径）
  const touched = [{ ...base[0], updatedAt: 999 }, base[1]]
  ok('🔴 只动 updatedAt（正文没变）→ 指纹也变', bookFingerprint(touched) !== f1)

  // 改 wordCount → 变
  const reword = [{ ...base[0], wordCount: 999 }, base[1]]
  ok('改 wordCount → 指纹变', bookFingerprint(reword) !== f1)

  // 空书也给一个稳定指纹（不为空串）
  ok('空书指纹稳定且非空', bookFingerprint([]) === bookFingerprint([]) && bookFingerprint([]).length > 0)

  // 顺序改变叙事顺序（order 换）→ 变
  const reordered = [{ ...base[0], order: 2 }, { ...base[1], order: 1 }]
  ok('叙事顺序变化 → 指纹变', bookFingerprint(reordered) !== f1)
}

// ---------- ③ shortFingerprint ----------
{
  ok('取连字符前 8 位', shortFingerprint('deadbeef-12') === 'deadbeef')
  ok('空串 → 占位符「—」', shortFingerprint('') === '—')
}

// ---------- ④ evaluatePublishGate ----------
{
  // 空书 → blocker
  {
    const s = bookStats([], [])
    const g = evaluatePublishGate(s, [], [])
    ok('空书 → blocker empty-book', !g.ok && g.blockers.some(b => b.key === 'empty-book'))
  }
  // 有空章 → blocker
  {
    const cs = [ch({ id: 'a', order: 1, content: '正文' }), ch({ id: 'b', order: 2, content: '' })]
    const s = bookStats(cs, [vol({ id: 'v1', order: 1 })])
    const g = evaluatePublishGate(s, cs, [vol({ id: 'v1', order: 1 })])
    ok('有正文但存在空章 → blocker empty-chapters', !g.ok && g.blockers.some(b => b.key === 'empty-chapters'))
  }
  // 全绿
  {
    const cs = [ch({ id: 'a', order: 1, content: '正文' }), ch({ id: 'b', order: 2, content: '正文二' })]
    const vs = [vol({ id: 'v1', order: 1 })]
    const s = bookStats(cs, vs)
    const g = evaluatePublishGate(s, cs, vs)
    ok('正常书 → 全绿（ok 且无 warn）', g.ok && g.blockers.length === 0 && g.warnings.length === 0)
  }
  // 未分卷 → warn
  {
    const vs = [vol({ id: 'v1', order: 1 })]
    const cs = [ch({ id: 'a', order: 1, volumeId: 'v1', content: 'x' }), ch({ id: 'b', order: 2, volumeId: 'ghost', content: 'y' })]
    const s = bookStats(cs, vs)
    const g = evaluatePublishGate(s, cs, vs)
    ok('有章不属于任何卷 → warn orphan-chapters', g.ok && g.warnings.some(w => w.key === 'orphan-chapters'))
  }
  // 空卷 → warn
  {
    const vs = [vol({ id: 'v1', order: 1 }), vol({ id: 'v2', order: 2, title: '空卷二' })]
    const cs = [ch({ id: 'a', order: 1, volumeId: 'v1', content: 'x' })]
    const s = bookStats(cs, vs)
    const g = evaluatePublishGate(s, cs, vs)
    ok('存在整卷无章 → warn empty-volumes', g.ok && g.warnings.some(w => w.key === 'empty-volumes'))
  }
  // 自由卷为空 → 不报
  {
    const vs = [vol({ id: 'v1', order: 1 }), vol({ id: 'vf', order: 9, isFree: true })]
    const cs = [ch({ id: 'a', order: 1, volumeId: 'v1', content: 'x' })]
    const s = bookStats(cs, vs)
    const g = evaluatePublishGate(s, cs, vs)
    ok('系统「自由卷」为空不报 warn（它本就可能空）', !g.warnings.some(w => w.key === 'empty-volumes'))
  }
}

// ---------- ⑤ 源码闸 ----------
{
  const backups = fs.readFileSync('src/lib/db/backups.ts', 'utf8')
  ok("🔴 BackupKind 含 'frozen'", /'auto5min' \| 'daily' \| 'manual' \| 'frozen'/.test(backups))
  ok('🔴 createFrozenVersion 复用 exportProject（不另写导出）', /export async function createFrozenVersion/.test(backups)
    && /createFrozenVersion[\s\S]{0,400}exportProject\(projectId\)/.test(backups))
  ok("🔴 frozen 写 kind: 'frozen'", /kind: 'frozen'/.test(backups))
  ok('🔴 frozen 不走自动淘汰（没有为它设 MAX 上限）', !/kind === 'frozen'\) return MAX_/.test(backups))
  ok('listFrozenVersions 按 kind===\'frozen\' 过滤', /listFrozenVersions[\s\S]{0,300}b\.kind === 'frozen'/.test(backups))
  ok('🔴 withBytes 保留 note/fingerprint/stats（防列表静默丢字段）',
    /rec\.fingerprint \? \{ fingerprint: rec\.fingerprint \}/.test(backups))

  const panel = fs.readFileSync('src/components/app/BookVersionPanel.tsx', 'utf8')
  ok('🔴 恢复走 restoreBackup（复用 applyBundleToProject，不自己搬）', /db\.restoreBackup\(v\.id\)/.test(panel))
  ok('🔴 恢复后重建资料索引（防静默降级）', /rebuildKbIndexAfterRestore\(pid\)/.test(panel))
  ok('🔴 闸门不硬拦：有 blocker 时按钮降级为「仍要冻结」', /仍要冻结/.test(panel) && /forced/.test(panel))
  ok('冻结走 createFrozenVersion', /db\.createFrozenVersion\(pid/.test(panel))
  ok('导出走 buildBackupFile', /db\.buildBackupFile\(v\.id\)/.test(panel))

  // 🔴 不新建快照表：schema / 迁移里不该出现 frozenVersions 之类的 store
  const idb = fs.readFileSync('src/lib/db/idbMigrations.ts', 'utf8')
  ok("🔴 不新建快照表（无 'frozenVersions' store）",
    !/frozenVersions/.test(idb) && !/frozenVersions/.test(backups))

  // 挂载：创作轨迹页有入口
  const traj = fs.readFileSync('src/components/audit/TrajectoryPanel.tsx', 'utf8')
  ok('入口挂在「创作轨迹」页（与运行账本并列）',
    /BookVersionPanel/.test(traj) && /定稿与版本/.test(traj))
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
