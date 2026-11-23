// ============ 3.7.0 · W8 小修 ============
//
// F1 EPUB 孤儿章兜底：含未分卷章的书，EPUB 章数必须与 TXT/全量口径一致（原先静默丢章）。
// F2 引用名清单刷新：编辑器不再只在挂载时加载一次，设定/角色数据变更后防抖重载。
// F3 注释与实现同步：futureImpact 的触发点、changeEvents 的 gap 记账都已兑现。
import fs from 'node:fs'
import { epubChapterOrder, chaptersToTxt } from '../src/lib/storage/exporter'
import type { Chapter, Volume } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const vol = (id: string, order: number, title: string): Volume => ({ id, projectId: 'p', order, title, description: '', createdAt: 1 })
const ch = (id: string, volumeId: string, order: number, title: string, content = ''): Chapter => ({
  id, projectId: 'p', volumeId, order, title, content, wordCount: content.length, summary: '', status: '草稿', createdAt: 1, updatedAt: 1,
})

const volumes = [vol('v2', 1, '卷二'), vol('v1', 0, '卷一')]
const chapters = [
  ch('b1', 'v2', 0, '卷二第1章', '乙一'),
  ch('a2', 'v1', 1, '卷一第2章', '甲二'),
  ch('a1', 'v1', 0, '卷一第1章', '甲一'),
  ch('o2', 'missing-vol', 1, '孤儿二', '孤二'),
  ch('o1', '', 0, '孤儿一', '孤一'),
]

// ---------- F1：EPUB 章节顺序含孤儿章 ----------
{
  const ordered = epubChapterOrder(volumes, chapters)
  ok('EPUB 章数 = 全部章节数（孤儿不丢）', ordered.length === chapters.length, `${ordered.length}/${chapters.length}`)
  ok('卷按卷序、卷内按章序', ordered.slice(0, 3).map(c => c.id).join(',') === 'a1,a2,b1', ordered.map(c => c.id).join(','))
  ok('未分卷 / 卷已删的章垫底且按章序', ordered.slice(3).map(c => c.id).join(',') === 'o1,o2', ordered.map(c => c.id).join(','))
  ok('TXT 也有同样的孤儿章兜底（口径一致）',
    chaptersToTxt(chapters, volumes).includes('孤儿一') && chaptersToTxt(chapters, volumes).includes('孤儿二'))

  const src = fs.readFileSync('src/lib/storage/exporter.ts', 'utf8')
  const epubStart = src.indexOf('export function exportEPUB(')
  const epubEnd = src.indexOf('// ============ DOCX', epubStart)
  const epub = src.slice(epubStart, epubEnd > 0 ? epubEnd : undefined)
  ok('exportEPUB 实际使用 epubChapterOrder（不是只改测试）', epub.includes('epubChapterOrder(volumes, chapters)'))
  ok('EPUB 不再只遍历 volumes 生成章节（无遗留双层循环）', !/for \(const vol of volumes\)[\s\S]{0,200}for \(const ch of chs\)/.test(epub))
}

// ---------- F2：引用名清单可重载 ----------
{
  const hook = fs.readFileSync('src/components/editor/useNovelEditorHighlight.ts', 'utf8')
  ok('引用名装载可重入（useCallback，不是挂载时一次性）', hook.includes('const loadRefNames = useCallback('))
  ok('订阅 db 变更后防抖重载', hook.includes('onDbChange(') && hook.includes('setTimeout(run, 300)'))
  ok('只对设定类写入重载（card / row）', /fact\.kind !== 'card' && fact\.kind !== 'row'/.test(hook))
  ok('卸载时退订并清定时器', hook.includes('off()') && hook.includes('clearTimeout(timer)'))
}

// ---------- F3：注释与实现同步 ----------
{
  const fi = fs.readFileSync('src/lib/outline/futureImpact.ts', 'utf8')
  ok('futureImpact 注释如实列出三条触发点（含章后整理与大纲保存）',
    fi.includes('章后整理确认后') && fi.includes('changeWatch'))
  const ce = fs.readFileSync('src/lib/revision/changeEvents.ts', 'utf8')
  ok('changeEvents 不再自述为未接线的 gap', !ce.includes('本模块是 `gap`。3.6.1 的定案是：'))
  ok('changeEvents 说明两类事件在 W2 已被构造', ce.includes('W2') && ce.includes('buildChangeEvidence'))
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)