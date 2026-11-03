// ============ P1 极端数据轰炸：边角输入 × 全部纯函数 + 检查器 ============
// 全部比对本地完成，只输出 PASS/FAIL 摘要。断言分两层：
//   [硬] 已知语义的精确断言；[软] 只要求「不炸 + 返回形状正确」的黑盒断言。
import * as db from '../src/lib/db'
import { auditContinuity } from '../src/lib/outline/continuityCheck'
import { runDataHealthCheck } from '../src/lib/storage/dataHealth'
import { flattenChapters, chapterSeqMap, chapterSeqOf } from '../src/lib/outline/chapterSeq'
import { splitCodes, splitNames, cnNumToArabic, parseStoryDateKey, extractChapterNo } from '../src/lib/audit/audit'
import { nextAutoCode } from '../src/lib/ai/autoCode'
import { normName } from '../src/lib/settings/settingLedger'
import { scanText } from '../src/lib/editor/sensitiveWords'
import { countWords } from '../src/lib/editor/textStats'
import { getChapterTexts, buildChapterDigest } from '../src/lib/ai/aiContext'
import type { Volume, Chapter, TableRow } from '../src/lib/types'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const J = (v: unknown) => JSON.stringify(v)
/** 异步软断言：返回的 promise 收集进 pending，主流程结尾统一 await，避免 exit 竞态漏跑用例 */
const pending: Promise<void>[] = []
function soft(name: string, fn: () => unknown | Promise<unknown>, check?: (r: unknown) => boolean) {
  const run = Promise.resolve().then(fn).then(res => {
    if (!check || check(res)) { pass++; console.log(`PASS ${name}`) }
    else { fail++; console.log(`FAIL ${name} :: 返回 ${J(res)?.slice(0, 120)}`) }
  }).catch(e => { fail++; console.log(`FAIL ${name} :: 抛错 ${(e as Error).message?.slice(0, 100)}`) })
  pending.push(run)
}
const mkVol = (id: string, order: number, title: string): Volume => ({ id, projectId: 'p1', order, title, description: '', createdAt: 0 })
// 注意：此处必须用块体 return，不能写成 `=> ({...})`。
// tsc 会把「箭头 + 换行后的括号对象」误解析成箭头函数的参数列表，
// 导致对象字面量被当成解构模式、报出一串 TS1003/TS1005 语法错误（esbuild 不受影响，但 tsc 会挂）。
const mkCh = (id: string, volId: string, order: number, title: string, extra?: Partial<Chapter>): Chapter => {
  return { id, projectId: 'p1', volumeId: volId, order, title, content: '', summary: '', status: '构思', wordCount: 0, createdAt: 0, updatedAt: 0, ...extra }
}

// ---------- A. chapterSeq 边角 ----------
{
  const vols = [mkVol('v1', 0, '卷一'), mkVol('v2', 0, '卷二同序号'), mkVol('v3', 1, '卷三')]
  const chs = [mkCh('c1', 'v1', 0, 'a'), mkCh('c2', 'v2', 0, 'b'), mkCh('c3', 'v3', 0, 'c'), mkCh('ghost', 'v-none', 0, '孤儿章')]
  soft('卷 order 重复 + 孤儿章：flatten 不炸', () => flattenChapters(vols, chs).length, n => n === 3)
  soft('孤儿章不参与编号（chapterSeqOf=0）', () => chapterSeqOf(vols, chs, 'ghost'), n => n === 0)
  const vols2 = [mkVol('v1', 0, '卷一')]
  const chs2 = [
    mkCh('e1', 'v1', 0, '序章', { excludeFromNumbering: true }),
    mkCh('e2', 'v1', 1, '第一章'),
    mkCh('e3', 'v1', 2, '番外', { excludeFromNumbering: true }),
    mkCh('e4', 'v1', 3, '第二章'),
  ]
  const m2 = chapterSeqMap(vols2, chs2)
  ok('exclude 混排：序号无空洞（1,0,2,3→第1/第2章）', m2.get('e1') === 0 && m2.get('e2') === 1 && m2.get('e3') === 0 && m2.get('e4') === 2, J([...m2]))
  const allEx = [mkCh('x1', 'v1', 0, 'a', { excludeFromNumbering: true }), mkCh('x2', 'v1', 1, 'b', { excludeFromNumbering: true })]
  ok('全部不计入序号：全 0', [...chapterSeqMap(vols2, allEx).values()].every(v => v === 0))
}

// ---------- B. audit 纯函数 ----------
ok('cnNumToArabic 常规', cnNumToArabic('十二') === 12 && cnNumToArabic('九') === 9 && cnNumToArabic('9') === 9 && Number.isNaN(cnNumToArabic('abc')))
ok('cnNumToArabic 超纲输入返回 NaN 不炸（一百零八在文档外）', Number.isNaN(cnNumToArabic('一百零八')))
ok('extractChapterNo 常规', extractChapterNo('第12章 废脉') === 12 && extractChapterNo('第 5 章') === 5 && extractChapterNo('序章') === null && extractChapterNo('番外·铁柱传') === null)
ok('splitNames 去括号注释', J(splitNames('陈渊、陈瑶（昏迷） 执事；黑风，洛清欢')) === J(['陈渊', '陈瑶', '执事', '黑风', '洛清欢']), J(splitNames('陈渊、陈瑶（昏迷） 执事；黑风，洛清欢')))
ok('splitCodes 大小写归一', J(splitCodes('f0001，f0002 F0003;、')) === J(['F0001', 'F0002', 'F0003']))
ok('parseStoryDateKey 边界', parseStoryDateKey('3024年3月9日') === 30240309 && parseStoryDateKey('3024年13月1日') === null && parseStoryDateKey('3024-03-09') === null && parseStoryDateKey(undefined) === null)

// ---------- C. autoCode ----------
ok('自动编号：空表续 0001', nextAutoCode('secrets', []) === 'S0001')
// ⚠️ 规则已于 2026-09-29 由「最大 +1」改为**顺序补缺**（删错了能补回来），
//    口径以 tests/autoCode.test.ts 为准 —— 这里额外钉住「与传入顺序无关」。
ok('自动编号：乱序也能正确补缺（最大+1 已退役）', nextAutoCode('secrets', [
  { id: 'r1', projectId: 'p', tabId: 'secrets', order: 0, data: { '编号': 'S0003' } },
  { id: 'r2', projectId: 'p', tabId: 'secrets', order: 1, data: { '编号': 'S0001' } },
] as TableRow[]) === 'S0002')
ok('自动编号：非标编号不干扰默认续号', nextAutoCode('secrets', [
  { id: 'r1', projectId: 'p', tabId: 'secrets', order: 0, data: { '编号': 'X9!' } },
] as TableRow[]) === 'S0001')

// ---------- D. normName 归一 ----------
ok('normName 去标点+小写+幂等', normName('  陈渊（主角） ') === '陈渊主角' && normName('ABC，def！') === normName('abc def') && normName(normName('X')) === normName('X'), normName('  陈渊（主角） '))

// ---------- E. 敏感词 ----------
ok('敏感词：空文本', scanText('').length === 0)
soft('敏感词：正则特殊字符自定义词不炸', () => scanText('这段提到 C++ 和 $.fn 与 (括号)', ['C++', '$.fn', '(括号)']), r => Array.isArray(r))

// ---------- F. 字数 ----------
ok('countWords 边角', countWords('') === 0 && typeof countWords('hello 世界！') === 'number' && countWords('hello 世界！') > 0)

// ---------- G. AI 上下文：截断 / 跨卷 / 畸形正文 ----------
__resetMockStores()
;(async () => {
  const pid = 'p1'
  await memoryOps.put('projects', { id: pid, name: '轰炸场', createdAt: 0, updatedAt: 0 })
  db.setCurrentProject(pid)
  const vols = [mkVol('vA', 0, '卷一'), mkVol('vB', 1, '卷二')]
  for (const v of vols) await memoryOps.put('volumes', v)
  const big = '正文'.repeat(30000) // 6 万字
  const chs = [
    mkCh('ca', 'vA', 0, '卷一章', { content: '<img src=x onerror=alert(1)>短正文' }),
    mkCh('cb', 'vB', 0, '卷二章', { content: '卷二正文' }),
    mkCh('cc', 'vB', 1, '卷二三章', { content: '卷三内容占位' }),
    mkCh('cbig', 'vB', 2, '超长章', { content: big }),
  ]
  for (const c of chs) await memoryOps.put('chapters', c)

  const t1 = await getChapterTexts(['cb', 'ca'], 20000)
  ok('AI 正文：跨卷顺序正确（卷一在先）', t1.indexOf('卷一章') < t1.indexOf('卷二章'), t1.slice(0, 60))
  const t1b = await getChapterTexts(['cbig'], 20000)
  ok('AI 正文：超长章截断有标注且预算受控', t1b.includes('截断') && t1b.length < 21000, `len=${t1b.length}`)
  const t2 = await getChapterTexts(['cb', 'ghost-id'], 5000)
  ok('AI 正文：不存在的章 id 被忽略', !t2.includes('ghost') && t2.includes('卷二章'))
  ok('AI 正文：HTML 注入串按纯文本带出（不执行）', t1.includes('<img src=x'))

  // buildChapterDigest：卷序打乱 + 孤儿章 + 超 maxChapters 截断
  const many: Chapter[] = []
  for (let i = 0; i < 201; i++) {
    const vi = i % 3
    if (!vols.find(v => v.id === `mv${vi}`)) await memoryOps.put('volumes', mkVol(`mv${vi}`, vi, `轰炸卷${vi}`))
    many.push(mkCh(`mc${i}`, `mv${vi}`, Math.floor(i / 3), `轰炸章${String(i).padStart(3, '0')}`))
  }
  await memoryOps.put('chapters', mkCh('orphan', 'v-none', 0, '无主孤章'))
  for (const c of many) await memoryOps.put('chapters', c)
  // 大数据：截断计数（动态算：全库章数 - 200）
  const totalChs = (await memoryOps.getAll<Chapter>('chapters')).length
  const digest = await buildChapterDigest(200)
  ok('章节清单：超 200 章截断有标注且计数正确', new RegExp(`另有 ${totalChs - 200} 章未列出`).test(digest), `总章=${totalChs} tail=${digest.slice(-40)}`)
  ok('章节清单：截掉的是叙事序最末的章（回归 1.9.2 修复）', !digest.includes('轰炸章200') && digest.includes('轰炸章199'), '')
  // 小口径：maxChapters 放大后孤儿章必须以「未分卷」段展示
  const digestFull = await buildChapterDigest(1000)
  ok('章节清单：孤儿章归入未分卷', digestFull.includes('未分卷') && digestFull.includes('无主孤章'))

  // ---------- H. 连续性检查：畸形标题互含 + 特殊字符 ----------
  // ⚠️ 2.4.4 起时间脉络「故事内时间」拆为「发生时间 / 结束时间」，连续性检查读的是「发生时间」
  //     （continuityCheck.ts 第 1 类）—— 喂旧字段名日期解析为 null，「时间倒流」会静默检不出。
  await memoryOps.put('tableRows', { id: 'tl1', projectId: pid, tabId: 'timeline', order: 0, data: { '章节号': '第1章', '章节标题': '修炼', '发生时间': '3024年3月9日', '主角当前境界/年龄': '淬体一重/15岁' } })
  await memoryOps.put('tableRows', { id: 'tl2', projectId: pid, tabId: 'timeline', order: 1, data: { '章节号': '第2章', '章节标题': '修炼后续与" quoted"｜竖线', '发生时间': '3024年3月1日', '主角当前境界/年龄': '淬体三重/15岁' } })
  await memoryOps.put('tableRows', { id: 'fs1', projectId: pid, tabId: 'foreshadow', order: 0, data: { '编号': 'F0001', '状态': '未回收', '伏笔内容': '测试｜含竖线' } })
  await memoryOps.put('tableRows', { id: 'ms1', projectId: pid, tabId: 'chapter-master', order: 0, data: { '章节号': '第1章', '章节标题': '标题含｜竖线与"引号', '出场人物': '陈渊、无名氏', '埋设伏笔编号': 'F0001, F9999', '回收伏笔编号': '' } })
  // 节奏预警用例：爽点 第1章→第5章 间隔 4（超 3 预警线）；存稿缓冲最新一天为 2（低于 3）
  await memoryOps.put('tableRows', { id: 'hp1', projectId: pid, tabId: 'hookpoints', order: 0, data: { '章节号': '第1章', '章节标题': '修炼', '爽点内容': '开局小爽' } })
  await memoryOps.put('tableRows', { id: 'hp2', projectId: pid, tabId: 'hookpoints', order: 1, data: { '章节号': '第5章', '章节标题': '', '爽点内容': '间隔测试' } })
  await memoryOps.put('tableRows', { id: 'pg1', projectId: pid, tabId: 'progress', order: 0, data: { '日期': '2026-01-01', '存稿缓冲（章）': '5' } })
  await memoryOps.put('tableRows', { id: 'pg2', projectId: pid, tabId: 'progress', order: 1, data: { '日期': '2026-01-02', '存稿缓冲（章）': '2' } })
  soft('连续性检查：标题互含/竖线/引号/日期倒流全喂进去不炸', () => auditContinuity(), r => Array.isArray(r) && r.some(i => i.title.includes('时间倒流')))
  soft('节奏预警：爽点断档 + 存稿缓冲告急均被检出', () => auditContinuity(), r => Array.isArray(r) && r.some(i => i.title.includes('爽点断档')) && r.some(i => i.title.includes('存稿缓冲')))
  soft('数据体检：悬空引用/重复编号/孤儿行全喂进去不炸', async () => {
    await memoryOps.put('tableRows', { id: 'dup1', projectId: pid, tabId: 'foreshadow', order: 1, data: { '编号': 'F0001', '状态': '已回收' } })
    await memoryOps.put('tableRows', { id: 'dang1', projectId: pid, tabId: 'chapter-vol-不存在卷', order: 0, data: { '章节标题': '悬空行' } })
    return runDataHealthCheck() as unknown as { issues: unknown[] }
  }, r => {
    // soft 的 check 形参是 unknown，需先收窄再访问 issues
    const rr = r as { issues?: unknown[] }
    return Array.isArray(rr?.issues) && (rr.issues?.length ?? 0) > 0
  })

  await Promise.all(pending)
  console.log(`\n===== 结果：${pass} PASS / ${fail} FAIL =====`)
  process.exit(fail > 0 ? 1 : 0)
})()
