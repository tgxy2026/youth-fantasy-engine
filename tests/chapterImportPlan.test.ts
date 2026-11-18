// ============ 正文批量导入弹窗的编排判定（3.6.1 · B7）============
//
// 切分与落库本体在 `lib/storage/chapterImport`（已有单测）。这里钉的是组件里
// **算错就会误导作者**的四处：
//   ① 底部「已勾选 N 章 · 约 M 字」：只算勾选的章，字数口径与落库同源；
//   ② notes 去重：`chunks` 模式下「没识别到章节标题」不能同时出现在琥珀条与 notes 里；
//   ③ 主按钮闸：三种「点不动」的原因各一句话，顺序不能乱；
//   ④ 落库回执：已导入过 / 中途中止必须各自成句，不能报成普通成功。
import type { ImportPreview } from '../src/lib/storage/chapterImport'
import type { PersistResult } from '../src/lib/bookbreak/persist'
import {
  chapterImportGate, chapterImportResultText, importNotesForDisplay, summarizeImportSelection,
} from '../src/lib/editor/chapterImportPlan'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  volumes: [{
    key: 'v1', title: '第一卷', chapters: [
      { key: 'c1', title: '一', content: '一二三', include: true, source: 'a.txt' },
      { key: 'c2', title: '二', content: '四五', include: false, source: 'a.txt' },
    ],
  }],
  totalChapters: 2, totalWords: 5, notes: [], splitMode: 'chapters',
  ...over,
})

const result = (over: Partial<PersistResult> = {}): PersistResult => ({
  volumes: [{ id: 'v', title: '第一卷', chapters: 2 }],
  chaptersCreated: 2, words: 5, aborted: false, alreadyImported: false,
  ...over,
})

function main() {
  // ① 勾选统计：只算勾选的章，字数与落库同口径
  {
    const s = summarizeImportSelection(preview())
    ok('只统计勾选的章', s.pickedCount === 1, String(s.pickedCount))
    ok('字数只算勾选的章（3 字，不含未勾选的 2 字）', s.pickedWords === 3, String(s.pickedWords))
    ok('没有预览时两项都是 0', JSON.stringify(summarizeImportSelection(null)) === JSON.stringify({ pickedCount: 0, pickedWords: 0 }))
    const all = summarizeImportSelection(preview({ volumes: [{ key: 'v1', title: '一', chapters: [
      { key: 'c1', title: '一', content: '一二三', include: true, source: '' },
      { key: 'c2', title: '二', content: '四五', include: true, source: '' },
    ] }] }))
    ok('全勾选时章数与字数都累加', all.pickedCount === 2 && all.pickedWords === 5, JSON.stringify(all))
    ok('英文按词计（与 chapterImport 的 countWordsLoose 同源）',
      summarizeImportSelection(preview({ volumes: [{ key: 'v', title: 'v', chapters: [
        { key: 'c', title: 'c', content: 'hello world 你好', include: true, source: '' },
      ] }] })).pickedWords === 4)
  }

  // ② notes 去重（只在 chunks 模式下让位给琥珀条）
  {
    const notes = ['没有识别到章节标题，已按段落分块', '「b.docx」里未读取：批注']
    const chunks = importNotesForDisplay(preview({ splitMode: 'chunks', notes }))
    ok('chunks 模式下去掉重复的那条', chunks.length === 1 && chunks[0].startsWith('「b.docx」'), JSON.stringify(chunks))
    const chapters = importNotesForDisplay(preview({ splitMode: 'chapters', notes }))
    ok('按标题切章时保留全部 notes', chapters.length === 2, JSON.stringify(chapters))
    ok('没有预览时返回空数组', importNotesForDisplay(null).length === 0)
  }

  // ③ 主按钮闸：三种点不动的原因各一句话
  {
    ok('还没预览时提示先读取', JSON.stringify(chapterImportGate({ hasPreview: false, pickedCount: 0, committing: false }))
      === JSON.stringify({ canCommit: false, title: '先读取文件或粘贴原文' }))
    ok('有预览但一章没勾时提示至少勾一章', JSON.stringify(chapterImportGate({ hasPreview: true, pickedCount: 0, committing: false }))
      === JSON.stringify({ canCommit: false, title: '至少勾选一章' }))
    const committing = chapterImportGate({ hasPreview: true, pickedCount: 3, committing: true })
    ok('正在导入时不可点', committing.canCommit === false)
    ok('导入中不新增提示语（与 3.6.1 之前逐字一致）', committing.title === '把勾选的卷章写入正文编辑', committing.title)
    ok('条件齐备时可点并说明动作', JSON.stringify(chapterImportGate({ hasPreview: true, pickedCount: 3, committing: false }))
      === JSON.stringify({ canCommit: true, title: '把勾选的卷章写入正文编辑' }))
    ok('没预览时优先说"先读取"（不先说勾选）', chapterImportGate({ hasPreview: false, pickedCount: 0, committing: true }).title === '先读取文件或粘贴原文')
  }

  // ④ 落库回执
  {
    const normal = chapterImportResultText(result())
    ok('普通成功带卷数/章数/字数与卷明细', normal.includes('新建 1 卷') && normal.includes('2 章') && normal.includes('《第一卷》2章'), normal)
    ok('普通成功不带中止说明', !normal.includes('中途中止'))
    const aborted = chapterImportResultText(result({ aborted: true }))
    ok('中途中止要如实说明且说清已导入部分保留', aborted.includes('中途中止') && aborted.includes('已保留'), aborted)
    const dup = chapterImportResultText(result({ alreadyImported: true, volumes: [], chaptersCreated: 0, words: 0 }))
    ok('已导入过的回执独立成句（含"已跳过"与删除提示）', dup.includes('已经导入过') && dup.includes('跳过'), dup)
    ok('已导入过时不报"新建 0 卷"这种误导话术', !dup.includes('新建'), dup)
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} chapterImportPlan ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
