// ============ 正文批量导入（3.0.1 · 方案 B）纯函数 ============
// 覆盖点：JSON 结构校验（正常/异常/版本/顶层）/ 文本切分预览 / 多份合并 /
//         预览→计划换算（勾选过滤 / 空卷丢弃 / 标题兜底）/ 文件类型判定。
// 🔴 只跑纯函数，不触碰 store 与 db（落库走拆书 persist，另有守卫）。
import {
  parseImportJson, previewFromText, previewFromJson, mergePreviews, previewToPlan,
  classifyImportFile, isAcceptedImportFile,
} from '../src/lib/storage/chapterImport'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 1. 文件类型判定 ----------
ok('classify .json', classifyImportFile('a.JSON') === 'json')
ok('classify .docx', classifyImportFile('存稿.docx') === 'docx')
ok('classify .txt', classifyImportFile('第一章.txt') === 'text')
ok('classify .md', classifyImportFile('book.md') === 'text')
ok('classify 无扩展名', classifyImportFile('README') === 'text')

ok('accept .txt', isAcceptedImportFile('a.txt'))
ok('accept .md', isAcceptedImportFile('a.md'))
ok('accept .docx', isAcceptedImportFile('a.docx'))
ok('accept .json', isAcceptedImportFile('a.json'))
ok('accept .doc（收进来好劝退）', isAcceptedImportFile('old.doc'))
ok('accept 无扩展名', isAcceptedImportFile('novel'))
ok('reject .pdf', !isAcceptedImportFile('a.pdf'))
ok('reject .epub', !isAcceptedImportFile('a.epub'))

// ---------- 2. JSON 结构校验 ----------
function throws(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return e instanceof Error ? e.message : String(e) }
}

const goodJson = JSON.stringify({
  format: 'youth-fantasy-engine-chapters', version: 1, book: '测试书',
  volumes: [
    { title: '卷一 风起', chapters: [{ title: '出山', content: '正文一' }, { title: '遇袭', content: '正文二' }] },
    { title: '卷二 剑鸣', chapters: [{ title: '入城', content: '正文三' }] },
  ],
})
const parsed = parseImportJson(goodJson)
ok('JSON 正常解析：卷数=2', parsed.volumes.length === 2)
ok('JSON 正常解析：总分章=3', parsed.volumes.reduce((n, v) => n + v.chapters.length, 0) === 3)
ok('JSON 认 book 字段', parsed.book === '测试书')

ok('JSON 非法语法报错', !!throws(() => parseImportJson('{oops')))
ok('JSON 顶层数组报错', !!throws(() => parseImportJson('[1,2]')))
ok('JSON 缺 volumes 报错', !!throws(() => parseImportJson('{"book":"x"}')))
ok('JSON 版本过高报错', !!throws(() => parseImportJson('{"version":2,"volumes":[]}')))
ok('JSON format 不符报错', !!throws(() => parseImportJson('{"format":"other","volumes":[]}')))
ok('JSON 空卷数组报错', !!throws(() => parseImportJson('{"volumes":[]}')))
ok('JSON 卷缺 title 报错', !!throws(() => parseImportJson('{"volumes":[{"chapters":[]}]}')))
ok('JSON 卷缺 chapters 报错', !!throws(() => parseImportJson('{"volumes":[{"title":"卷"}]}')))
ok('JSON 章缺 title 报错', !!throws(() => parseImportJson('{"volumes":[{"title":"卷","chapters":[{"content":"x"}]}]}')))
// 容错：省略 format/version 也认
ok('JSON 省 format/version 亦认', parseImportJson('{"volumes":[{"title":"卷","chapters":[{"title":"章"}]}]}').volumes.length === 1)

// ---------- 3. 文本切分预览 ----------
const novelText = [
  '第一章 风起云州',
  '　　少年负剑出山门，天光正好。',
  '　　他抬头望向远山。',
  '',
  '第二章 剑鸣中州',
  '　　千里之外，剑气冲霄。',
  '',
  '第三章 剑锁中州',
  '　　大阵既成，天地失色。',
].join('\n')

const p1 = previewFromText(novelText, 'test.txt')
ok('文本切分：识别 3 章', p1.totalChapters === 3)
ok('文本切分：单卷（无卷标题）', p1.volumes.length === 1)
ok('文本切分：卷名=导入原文', p1.volumes[0]!.title === '导入原文')
ok('文本切分：章名剥掉「第N章」前缀', p1.volumes[0]!.chapters[0]!.title === '风起云州')
ok('文本切分：正文非空', p1.volumes[0]!.chapters[0]!.content.includes('少年负剑'))
ok('文本切分：章节默认勾选', p1.volumes[0]!.chapters.every(c => c.include))
ok('文本切分：splitMode=chapters（认出标题）', p1.splitMode === 'chapters')

// 卷结构
const withVol = ['卷一 风起', '第一章 出山', '　　正文甲。', '', '第二章 遇袭', '　　正文乙。', '', '卷二 剑鸣', '第三章 入城', '　　正文丙。'].join('\n')
const p2 = previewFromText(withVol, 'v.txt')
ok('卷结构：切出 2 卷', p2.volumes.length === 2)
ok('卷结构：卷名取自「卷X」行', p2.volumes[0]!.title.includes('卷一'))

// 无章节标题 → 兜底分段
const noTitle = '这是一段没有章节标题的长文。'.repeat(50)
const p3 = previewFromText(noTitle, 'plain.txt')
ok('无标题兜底：至少 1 个「第N段」', p3.totalChapters >= 1 && p3.volumes[0]!.chapters[0]!.title.startsWith('第'))
ok('无标题兜底：给出提示', p3.notes.length > 0)
ok('无标题兜底：splitMode=chunks（未认出标题 → 引导去拆书）', p3.splitMode === 'chunks')

// 空文本
const p4 = previewFromText('   ', 'empty.txt')
ok('空文本：0 章', p4.totalChapters === 0)

// ---------- 4. JSON 预览 ----------
const jp = previewFromJson(parsed, 'a.json')
ok('JSON 预览：卷数=2', jp.volumes.length === 2)
ok('JSON 预览：字数>0', jp.totalWords > 0)
ok('JSON 预览：章默认勾选', jp.volumes[0]!.chapters[0]!.include)
ok('JSON 预览：splitMode=given（结构已给定）', jp.splitMode === 'given')

// ---------- 5. 多份合并 ----------
const m1 = mergePreviews([p1, p1])
ok('合并：同名卷归并为一卷', m1.volumes.length === 1)
ok('合并：章数累加', m1.totalChapters === 6)
ok('合并：splitMode=given（不再对整体单一判断）', m1.splitMode === 'given')

const m2 = mergePreviews([p1, p2])
ok('合并：不同卷名各占一卷', m2.volumes.length >= 2)

// ---------- 6. 预览 → 计划换算 ----------
const plan = previewToPlan(p1)
ok('计划：卷数=1', plan.volumes.length === 1)
ok('计划：章数=3', plan.chapterCount === 3)
ok('计划：字数>0', plan.words > 0)

// 取消勾选一半
const half = structuredClone(p1)
half.volumes[0]!.chapters[1]!.include = false
const plan2 = previewToPlan(half)
ok('计划：剔掉未勾选的章', plan2.chapterCount === 2)

// 全部取消 → 空计划
const none = structuredClone(p1)
none.volumes.forEach(v => v.chapters.forEach(c => { c.include = false }))
ok('计划：全不勾 → 0 章', previewToPlan(none).chapterCount === 0)

// 卷名空白 → 兜底「导入正文」
const blankVol = structuredClone(p1)
blankVol.volumes[0]!.title = '   '
ok('计划：卷名空白兜底', previewToPlan(blankVol).volumes[0]!.title === '导入正文')

// 章名空白 → 兜底「未命名」
const blankCh = structuredClone(p1)
blankCh.volumes[0]!.chapters[0]!.title = ''
ok('计划：章名空白兜底', previewToPlan(blankCh).volumes[0]!.chapters[0]!.title === '未命名')

// 空内容章被剔除
const emptyCh = structuredClone(p1)
emptyCh.volumes[0]!.chapters[0]!.content = '   '
ok('计划：空内容章被剔除', previewToPlan(emptyCh).chapterCount === 2)

console.log(`\n${fail === 0 ? '✅' : '❌'} chapterImport: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
