// 3.1 P1 资料提及反向导航：别名召回、排序口径、边界与 snippet。
// 负向控制优先：空名 / 无命中 / 短英文词边界 / 别名去重都必须守住。
import * as db from '../src/lib/db'
import type { Chapter, Project, Volume } from '../src/lib/types'
import { memoryOps, __resetMockStores } from './mock-memory'
import { findMentions } from '../src/lib/search/mentions'

let failures = 0
function check(name: string, condition: boolean) {
  if (condition) console.log(`PASS ${name}`)
  else { failures++; console.error(`FAIL ${name}`) }
}

__resetMockStores()
db.setStoreOps(memoryOps)
const pid = 'mentions-test-project'
const now = Date.now()
const project: Project = { id: pid, name: '提及反查用项目', genre: '东方修真', intro: '', createdAt: now, updatedAt: now }
const v1: Volume = { id: 'v1', projectId: pid, order: 0, title: '第一卷', description: '', createdAt: now }
const v2: Volume = { id: 'v2', projectId: pid, order: 1, title: '第二卷', description: '', createdAt: now }
await memoryOps.put('projects', project)
await memoryOps.put('volumes', v1)
await memoryOps.put('volumes', v2)

function ch(id: string, volumeId: string, order: number, title: string, content: string, summary = ''): Chapter {
  return { id, projectId: pid, volumeId, order, title, content, summary, status: '草稿', wordCount: content.length, createdAt: now, updatedAt: now }
}
// 故意乱序插入：v2 的章 order=0、v1 的章 order=1，验证排序按「卷序 → 章序」而非插入序
await memoryOps.put('chapters', ch('c-v2-0', 'v2', 0, '第二章', '林渊走进雾谷，Ed 在门口等他。'))
// 长正文章：首次命中（小渊）前有标题+摘要 ⇒ snippet 应带头部截断与省略号
await memoryOps.put('chapters', ch('c-v1-1', 'v1', 1, '第三章',
  '小渊独自上路，路过桃花镇，见一老丈檐下晒药，便驻足相问。那老丈抬头瞥他一眼，慢悠悠说道：年轻人，山外有山，莫急莫躁。他谢过老丈，继续北行。',
  '本章讲渊哥的过去'))
await memoryOps.put('chapters', ch('c-v1-0', 'v1', 0, '第一章', '开篇无此人。'))
await memoryOps.put('chapters', ch('c-none', 'v2', 5, 'edition 章', '这本 edition 与任何人都无关。'))
db.setCurrentProject(pid)

// ① 空主名称直接空结果（防御脏调用）
check('空主名称返回空数组', (await findMentions('', ['小渊'])).length === 0)
check('纯空白主名称返回空数组', (await findMentions('   ', [])).length === 0)

// ② 主名称命中（标题+摘要+正文三处都算）
const byName = await findMentions('林渊', [])
check('主名称命中一章', byName.length === 1 && byName[0].chapterId === 'c-v2-0')
check('主名称命中计数为 1', byName[0]?.hits === 1)
check('matchedTerms 含主名称', byName[0]?.matchedTerms.join() === '林渊')
// 短文本整章在窗口内：snippet 精确等于「标题+摘要+正文」全文（换行压平，首尾都不加省略号）
check('snippet 在窗口内时不加省略号', byName[0]?.firstSnippet === '第二章  林渊走进雾谷，Ed 在门口等他。')

// ③ 别名命中 + matchedTerms 记录（别名来自 readAliases 的拆分产物，这里直接传数组）
const byAlias = await findMentions('林渊', ['小渊', '渊哥'])
check('别名命中召回两章', byAlias.length === 2)
check('别称章 matchedTerms 收录正文与摘要中的别称', byAlias.find(h => h.chapterId === 'c-v1-1')?.matchedTerms.join() === '小渊,渊哥')
check('正文与摘要中的别名合计命中 2 处', byAlias.find(h => h.chapterId === 'c-v1-1')?.hits === 2)

// ④ 排序：卷序 → 章序（v1/order0 无命中被跳过；v1/order1 应排在 v2/order0 之前）
check('按卷序+章序排列（先第一卷再第二卷）', byAlias[0]?.chapterId === 'c-v1-1' && byAlias[1]?.chapterId === 'c-v2-0')
check('volumeTitle 正确', byAlias[0]?.volumeTitle === '第一卷' && byAlias[1]?.volumeTitle === '第二卷')

// ⑤ 短英文词边界：'Ed' 不得命中 'edition'（负向控制）
const byEd = await findMentions('Ed', [])
check('短英文词不跨词边界误命中', byEd.length === 1 && byEd[0].chapterId === 'c-v2-0')
check('edition 章不被误召回', !byEd.some(h => h.chapterId === 'c-none'))

// ⑥ 别名去重：与主名称相同 / 重复别名不得重复计数
const dup = await findMentions('林渊', ['林渊', '小渊', '渊哥', '小渊'])
check('重复别名不重复计数', dup.find(h => h.chapterId === 'c-v1-1')?.hits === 2)

// ⑦ snippet：文本长于窗口 ⇒ 尾部省略号；命中位置在窗口内 ⇒ 首部不加省略号（start 钳到 0）
const snip = byAlias.find(h => h.chapterId === 'c-v1-1')?.firstSnippet ?? ''
check('snippet 含命中词', snip.includes('小渊'))
check('snippet 尾部省略号（文本长于窗口）', snip.endsWith('…'))
check('snippet 首部不越界（命中在窗口内则无首省略号）', !snip.startsWith('…'))
check('snippet 不含换行', !snip.includes('\n'))

// ⑧ 无命中返回空数组
check('无命中返回空数组', (await findMentions('不存在的人', ['某某'])).length === 0)

// 计数与摘要必须使用同一单词边界；别称摘要按出现位置选择。
const snippetChapter = (await db.getAllChapters())[0]
await memoryOps.put('chapters', { ...snippetChapter, title: '', summary: '',
  content: 'edition ' + '.'.repeat(90) + ' Ed enters' })
const shortSnippet = (await findMentions('Ed', [])).find(h => h.chapterId === snippetChapter.id)
check('短英文名摘要定位有效词，不定位 edition', !!shortSnippet?.firstSnippet.includes('Ed enters') && !shortSnippet.firstSnippet.includes('edition'))
await memoryOps.put('chapters', { ...snippetChapter, title: '', summary: '',
  content: '小渊先出现' + '。'.repeat(90) + '林渊后出现' })
const earliest = (await findMentions('林渊', ['小渊'])).find(h => h.chapterId === snippetChapter.id)
check('摘要选择实际最早的称法', !!earliest?.firstSnippet.includes('小渊先出现'))

console.log(`\nmentions: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
if (failures > 0) process.exitCode = 1
