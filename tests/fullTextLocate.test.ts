// ============ 3.3.1 · T1：全文检索命中位置（纯逻辑） ============
//
// 用户点名的问题：检索结果点进去只落到章首，作者还得自己在整章里翻。
// 这批用例守的是「算出来的偏移必须真的指向那一句」：
//   · 章节文档的 body = 标题 + 摘要 + 正文，偏移必须换算成**正文坐标**；
//   · 命中在标题/摘要里 ⇒ 不给偏移（只开章节，不瞎跳）；
//   · 一章多处命中 ⇒ 最多拆 3 行，每行一个精确位置；
//   · 近似匹配（二元组）不进定位，只进摘要。
import { chapterHitOffsets } from '../src/lib/search/search'
import type { SearchDoc } from '../src/lib/search/search'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const title = '第18章 血引'
const summary = '林渊在雾谷遇见旧识。'
const content = '天色未明，林渊已经站在雾谷口。\n雾很大。林渊握紧了刀。\n远处传来一声鸟鸣。'
const doc: SearchDoc = {
  id: 'ch-1', type: 'chapter', title, body: `${title}\n${summary}\n${content}`,
  chapterId: '1', source: '章节正文',
  contentStart: title.length + 1 + summary.length + 1,
  contentRevision: 'rev',
}

// ---------- 坐标换算 ----------
{
  const at = chapterHitOffsets(doc, '林渊握紧了刀')
  const want = content.indexOf('林渊握紧了刀')
  ok('🔴 偏移换算成正文坐标（不是 body 坐标）', at.length === 1 && at[0] === want, `${JSON.stringify(at)} vs ${want}`)
  ok('用换算后的偏移去切正文，正好是那句原文',
    at.length === 1 && content.slice(at[0], at[0] + '林渊握紧了刀'.length) === '林渊握紧了刀')
}

// ---------- 命中落在标题/摘要 ----------
{
  const inTitle = chapterHitOffsets(doc, '血引')
  ok('🔴 命中在标题里 ⇒ 不给偏移（只开章节，不瞎跳）', inTitle.length === 0, JSON.stringify(inTitle))
  const inSummary = chapterHitOffsets(doc, '雾谷遇见')
  ok('🔴 命中在摘要里 ⇒ 同样不给偏移', inSummary.length === 0, JSON.stringify(inSummary))
}

// ---------- 多处命中 ----------
{
  const twice = chapterHitOffsets(doc, '林渊')
  ok('同一章多处命中都算出来（正文里两处）', twice.length === 2, JSON.stringify(twice))
  const second = content.indexOf('林渊', content.indexOf('林渊') + 1)
  ok('第 2 处偏移指向第 2 次出现', twice[1] === second, `${twice[1]} vs ${second}`)

  const many = { ...doc, body: `${title}\n${summary}\n${'雾'.repeat(9)}`, contentStart: doc.contentStart }
  const capped = chapterHitOffsets(many, '雾')
  ok('单字命中最多拆 3 行（不刷屏）', capped.length === 3, JSON.stringify(capped))
}

// ---------- 边界 ----------
{
  ok('空查询不返回位置', chapterHitOffsets(doc, '   ').length === 0)
  ok('找不到时返回空', chapterHitOffsets(doc, '根本不存在的句子').length === 0)
  ok('非章节文档一律不给位置', chapterHitOffsets({ ...doc, type: 'setting' }, '林渊').length === 0)
  ok('没有 contentStart 的章节（老数据）不给位置', chapterHitOffsets({ ...doc, contentStart: undefined }, '林渊').length === 0)
  // 大小写不敏感，但偏移要能精确切出原文
  const en = { ...doc, body: `${title}\n${summary}\nAlpha beta ALPHA`, contentStart: doc.contentStart }
  const enHits = chapterHitOffsets(en, 'alpha')
  ok('英文大小写不敏感，两处都算到', enHits.length === 2, JSON.stringify(enHits))
  ok('偏移对原文精确（第二处是大写 ALPHA）', enHits.length === 2 && 'Alpha beta ALPHA'.slice(enHits[1], enHits[1] + 5) === 'ALPHA')
}

// ---------- 源码守卫：位置必须一路传下去 ----------
{
  const fs = await import('node:fs')
  const read = (p: string) => fs.readFileSync(`${process.cwd()}/${p}`, 'utf8')
  const panel = read('src/components/editor/FullTextSearch.tsx')
  const app = read('src/App.tsx')
  ok('🔴 检索面板把命中位置交给上层（不再只传 chapterId）',
    /onOpenChapter\(r\.chapterId, r\.matchAt == null \? undefined :/.test(panel))
  ok('🔴 App 的 navigate 暴露位置参数（第 4 个）',
    /const navigate = useCallback\(\(id: string, chapterId\?: string, rowId\?: string, position\?: EditorPosition\)/.test(app))
  ok('位置走既有导航意图校验，不在调用点自己拼',
    /pageNavigationIntent\(\{[\s\S]{0,220}offset: position\.offset/.test(app))
  ok('全文检索点击时把位置传给 navigate', /navigate\('editor', id, undefined, position\)/.test(app))
  ok('命中多处时结果行标出「第 n/N 处」', /第 \{r\.hitIndex\}\/\{r\.hitCount\} 处/.test(panel))
  ok('多处命中跳过去后有「第几处」提示（列表已关，作者需要知道自己在看第几处）',
    /已定位到第 \$\{r\.hitIndex\} 处/.test(panel))
  ok('🔴 只定位、不写正文（面板里没有 setContent/updateContent 之类）',
    !/updateContent|setContent|saveChapter/.test(panel))
}

console.log(`\n—— fullTextLocate 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
