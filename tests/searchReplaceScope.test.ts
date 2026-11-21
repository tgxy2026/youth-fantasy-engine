// ============ 搜索替换：范围（本章 / 全书）与口径（3.6.1；3.6.2 默认仅搜索）============
//
// 需求：原「全书搜索替换」改为通用搜索，进来先选范围 —— 本章只搜当前章，全书搜全书。
// 3.6.2 起默认「仅搜索」（只定位、不改正文），替换必须显式切到「搜索并替换」模式。
// 这里钉住四件事（都是"静默改错文件/改少东西"的风险点）：
//   ① 范围由**交给函数的语料**决定：本章传一章、全书传全部（界面不各算一遍）；
//   ② 「只命中章名」不计入可替换数量 —— 否则会提示替换 3 处、实际只改 2 处；
//   ③ 替换用 split/join，关键词含正则元字符（括号、星号）也不能炸；
//   ④ 界面默认「本章」+「仅搜索」、换范围会清空上一次结果（拿全书结果点替换＝绕过范围选择）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Chapter } from '../src/lib/types'
import {
  MAX_HIT_CONTEXTS, replaceableCount, replaceAllInContent, replaceTargets, searchChapters,
} from '../src/lib/editor/searchReplace'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const chapter = (id: string, title: string, content: string): Chapter => ({
  id, projectId: 'p1', title, content, wordCount: 0, volumeId: 'v1', order: 0, summary: '',
  status: '草稿', createdAt: 0, updatedAt: 0,
} as Chapter)

const CH1 = chapter('c1', '第1章 风起', '林砚提着剑出门。林砚回头看了一眼。')
const CH2 = chapter('c2', '第2章 林砚的夜', '夜色很深，没有人来。')
const CH3 = chapter('c3', '第3章 收束', '少年负剑出山门。')

function main() {
  // ① 范围 = 语料
  {
    const onlyChapter = searchChapters([CH1], '林砚')
    ok('本章范围：只搜传进来的那一章', onlyChapter.length === 1 && onlyChapter[0].chapter.id === 'c1', JSON.stringify(onlyChapter.map(h => h.chapter.id)))
    const wholeBook = searchChapters([CH1, CH2, CH3], '林砚')
    ok('全书范围：命中的每一章都返回', wholeBook.length === 2, JSON.stringify(wholeBook.map(h => h.chapter.id)))
    ok('本章范围内不会冒出别的章', !onlyChapter.some(h => h.chapter.id !== 'c1'))
  }

  // ② 章名命中不计入可替换数量
  {
    const hits = searchChapters([CH1, CH2], '林砚')
    const ch2Hit = hits.find(h => h.chapter.id === 'c2')
    ok('只命中章名的章仍出现在结果里（便于定位）', !!ch2Hit)
    ok('只命中章名时正文命中数为 0', ch2Hit?.count === 0, JSON.stringify(ch2Hit))
    ok('只命中章名会标记 titleHit', ch2Hit?.titleHit === true)
    ok('可替换处数只算正文（1 章 × 2 处）', replaceableCount(hits) === 2, String(replaceableCount(hits)))
    ok('替换目标只含有正文命中的章', replaceTargets(hits).map(h => h.chapter.id).join(',') === 'c1', replaceTargets(hits).map(h => h.chapter.id).join(','))
    ok('正文与章名同时命中时两者都标出', (() => {
      const both = searchChapters([CH1], '风起')[0]
      return both.count === 0 && both.titleHit === true
    })())
  }

  // ③ 上下文与边界
  {
    const many = chapter('c9', '第9章', Array.from({ length: 9 }, () => '甲').join('乙'))
    const hit = searchChapters([many], '甲')[0]
    ok('上下文最多 5 段（不刷屏）', hit.contexts.length === MAX_HIT_CONTEXTS && hit.count === 9, `${hit.contexts.length}/${hit.count}`)
    ok('空关键词返回空结果（不会把所有章都列出来）', searchChapters([CH1], '   ').length === 0)
    ok('没命中的章不出现', searchChapters([CH1], '不存在的词').length === 0)
  }

  // ④ 替换本身
  {
    ok('全部替换', replaceAllInContent('林砚走了，林砚回头', '林砚', '他') === '他走了，他回头')
    ok('空替换 = 删除', replaceAllInContent('甲甲', '甲', '') === '')
    ok('关键词含正则元字符也不炸（走 split/join）',
      replaceAllInContent('（注）与（注）', '（注）', '〔注〕') === '〔注〕与〔注〕')
    ok('星号/点号同样安全', replaceAllInContent('a*b.c', '*', 'X') === 'aXb.c' && replaceAllInContent('a*b.c', '.', '!') === 'a*b!c')
    ok('关键词两端空格被忽略，按去空格后的词替换', replaceAllInContent('甲 乙', ' 甲 ', '丙') === '丙 乙')
    ok('替换后同一关键词不再命中（可据此核对归零）',
      searchChapters([chapter('c', 't', replaceAllInContent('林砚林砚', '林砚', '他'))], '林砚').length === 0)
  }

  // ⑤ 界面口径（源码闸：防回退成"只能全书"）
  {
    const modals = readFileSync(path.join(process.cwd(), 'src/components/editor/EditorModals.tsx'), 'utf8')
    const editor = readFileSync(path.join(process.cwd(), 'src/components/editor/NovelEditor.tsx'), 'utf8')
    ok('弹窗用纯函数搜（不自己再算一遍）', modals.includes('searchChapters(corpus, q)'))
    ok('可替换数用 replaceableCount', modals.includes('replaceableCount(hits)'))
    ok('替换走 replaceAllInContent', modals.includes('replaceAllInContent('))
    ok('默认范围是「本章」（误点也伤不到全书）', /useState<Scope>\('chapter'\)/.test(modals))
    ok('换范围会清空上一次结果', /useEffect\(\(\) => \{ setSearched\(false\); setHits\(\[\]\) \}, \[scope\]\)/.test(modals))
    ok('两种范围的确认文案都在', modals.includes("'本章替换'") && modals.includes("'全书替换'"))
    ok('只命中章名时明说不可替换', modals.includes('只命中章名'))
    ok('菜单入口保留「搜索替换」', editor.includes('<Search size={14} /> 搜索替换</Button>'))
    ok('把当前章传给弹窗（否则本章范围不可用）', /<GlobalSearch[\s\S]{0,120}activeChapter=\{active\}/.test(editor))
    // 3.6.2：默认只搜不改；替换输入与按钮只在替换模式渲染
    ok('默认是「仅搜索」模式', /useState<Mode>\('find'\)/.test(modals))
    ok('模式切换有「仅搜索 / 搜索并替换」两个入口', modals.includes('仅搜索') && modals.includes('搜索并替换') && modals.includes("setMode('replace')"))
    ok('替换输入只在替换模式渲染', /\{isReplace && \([\s\S]{0,400}替换为…/.test(modals))
    ok('替换按钮只在替换模式渲染', /\{isReplace && \([\s\S]{0,800}全部替换/.test(modals))
    ok('弹窗标题固定为「搜索替换」', modals.includes('title="搜索替换"'))
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} searchReplaceScope ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
