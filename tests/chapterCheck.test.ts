// ============ 本章体检（C3 · 2.4.2）纯函数单测 ============
//
// runChapterCheck 本体依赖 IndexedDB，不进单测（与 manuscriptCheck 同一取舍）；
// 这里钉住三块纯逻辑：
//   1. filterChapterIssues —— 只认「location.kind === 'chapter' 且 id 匹配」，全书性问题必须被滤掉；
//   2. pickChapterForeshadow —— 按章标题命中埋设/回收，且只收该伏笔自己的 issues；
//   3. countActionable —— 提示性 info（通过 ✓ / 未登记）不计入「需关注」。
import {
  filterChapterIssues, pickChapterForeshadow, countActionable, type ChapterCheckReport,
} from '../src/lib/chapterCheck'
import type { AuditIssue } from '../src/lib/audit'
import type { ForeshadowBoardItem } from '../src/lib/foreshadowEngine'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ chapterCheck')

const issue = (id: string, loc?: AuditIssue['location']): AuditIssue => ({
  id, severity: 'warn', category: '连续性', title: `t-${id}`, detail: '', ...(loc ? { location: loc } : {}),
})

// ---------- 1) filterChapterIssues ----------
{
  const issues = [
    issue('a', { kind: 'chapter', chapterId: 'c1', hint: '第一章' }),
    issue('b', { kind: 'chapter', chapterId: 'c2' }),
    issue('c', { kind: 'tab', tabId: 'timeline' }),
    issue('d', { kind: 'row', tabId: 'terms', rowId: 'r1' }),
    issue('e'), // 无定位
  ]
  const got = filterChapterIssues(issues, 'c1')
  ok('只留定位在本章的', got.length === 1 && got[0].id === 'a', JSON.stringify(got.map(i => i.id)))
  ok('别章的问题不算本章', filterChapterIssues(issues, 'c2').every(i => i.id === 'b'))
  ok('tab / row / 无定位一律滤掉', filterChapterIssues(issues, 'c3').length === 0)
  ok('空输入不崩', filterChapterIssues([], 'c1').length === 0)
}

// ---------- 2) pickChapterForeshadow ----------
{
  const board: ForeshadowBoardItem[] = [
    {
      code: 'F01', content: '', importance: '卷级', status: '进行中',
      plantChapters: ['第一章'], recycleChapters: [], span: null,
      issues: [issue('f01-1')],
    },
    {
      code: 'F02', content: '', importance: '小伏笔', status: '已回收',
      plantChapters: ['第二章'], recycleChapters: ['第一章'], span: 3,
      issues: [issue('f02-1'), issue('f02-2')],
    },
    {
      code: 'F03', content: '', importance: '小伏笔', status: '孤儿',
      plantChapters: [], recycleChapters: [], span: null,
      issues: [issue('f03-1')],
    },
  ]
  const got = pickChapterForeshadow(board, '第一章')
  ok('按章标题命中埋设与回收', got.codes.length === 2 && got.codes.includes('F01') && got.codes.includes('F02'), got.codes.join(','))
  ok('每条伏笔只收自己的问题', got.issues.length === 3, String(got.issues.length))
  ok('未涉及的伏笔不混入', !got.codes.includes('F03'))
  ok('没命中的章返回空', pickChapterForeshadow(board, '第九十九章').codes.length === 0)
  ok('空看板不崩', pickChapterForeshadow([], '第一章').issues.length === 0)
}

// ---------- 3) countActionable ----------
{
  const base: ChapterCheckReport = {
    chapterId: 'c1', chapterTitle: '第一章',
    continuity: [issue('a'), issue('b')],
    foreshadow: { codes: ['F01'], issues: [issue('f')] },
    sensitive: [{ word: '赌博', count: 2, context: '' }],
    typos: [{ word: '帐号', suggest: '账号', count: 1, context: '' }],
    style: [
      { id: 's-ok', severity: 'info', category: '文风', title: '通过', detail: '' },
      { id: 's-style-missing', severity: 'info', category: '文风', title: '未登记', detail: '' },
      { id: 's-habit-x', severity: 'warn', category: '文风', title: '坏习惯词', detail: '' },
    ],
  }
  // 2(连续) + 1(伏笔) + 2(敏感词按出现次数) + 1(错别字) + 1(文风去掉两条提示性 info) = 7
  ok('计数口径：敏感词/错别字按出现次数、文风剔除提示性 info', countActionable(base) === 7, String(countActionable(base)))
  const empty: ChapterCheckReport = {
    ...base, continuity: [], foreshadow: { codes: [], issues: [] },
    sensitive: [], typos: [], style: [{ id: 's-ok', severity: 'info', category: '文风', title: '通过', detail: '' }],
  }
  ok('全干净时计数为 0', countActionable(empty) === 0, String(countActionable(empty)))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
