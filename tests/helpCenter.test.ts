// ============ 3.3.1 · P1：内置使用手册（内容自检 + 本地检索） ============
//
// 钉死四件事：
//   ① 内容结构没有硬错误（id / 页签 / 引用 / 段落 / 维护字段）；
//   ② 索引由注册表生成，段落一条、不另存手写清单；
//   ③ 固定问答样本能命中正确文章（低命中宁可不给，也不硬凑）；
//   ④ 覆盖度是**如实**的：没写的页签必须能看出来。
import fs from 'node:fs'
import path from 'node:path'
import {
  ALL_TAB_IDS, HELP_ARTICLES, HELP_GROUPS, HELP_INDEX, MAX_HITS_PER_ARTICLE,
  checkHelpContent, coveredTabIds, getHelpArticle, helpArticlesForTab, searchHelp,
  suggestHelpGroups, tabsWithoutHelp, tokenizeHelpQuery,
} from '../src/lib/help'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 内容结构 ----------
{
  const issues = checkHelpContent()
  ok('内容自检无硬错误', issues.length === 0, issues.map(i => `${i.articleId ?? '-'}:${i.problem}`).join(' ｜ '))
  ok('每篇文章都有至少一段正文', HELP_ARTICLES.every(article => article.sections.length > 0))
  ok('每篇文章都标了核对版本与日期', HELP_ARTICLES.every(article => !!article.verifiedAgainst && /^\d{4}-\d{2}-\d{2}$/.test(article.reviewedAt)))
  ok('文章 id 唯一', new Set(HELP_ARTICLES.map(a => a.id)).size === HELP_ARTICLES.length)
  const groupsUsed = new Set(HELP_ARTICLES.map(a => a.group))
  ok('用到的栏目都在栏目表里', [...groupsUsed].every(group => HELP_GROUPS.includes(group)), [...groupsUsed].join('、'))
}

// ---------- ② 索引由注册表生成 ----------
{
  const sectionCount = HELP_ARTICLES.reduce((sum, article) => sum + article.sections.length, 0)
  ok('索引条目数 = 段落总数', HELP_INDEX.length === sectionCount, `${HELP_INDEX.length} vs ${sectionCount}`)
  ok('索引保留了来源文章与段落', HELP_INDEX.every(entry => !!getHelpArticle(entry.articleId)
    && (getHelpArticle(entry.articleId)?.sections ?? []).some(section => section.id === entry.sectionId)))
  ok('页签反查能取到文章', helpArticlesForTab('editor').length > 0)
  ok('不存在的页签反查为空（不抛错）', helpArticlesForTab('no-such-tab').length === 0)
}

// ---------- ③ 固定问答样本 ----------
{
  const top = (query: string, currentTabId?: string) => searchHelp(query, { currentTabId })[0]
  const cases: { query: string; expect: string; why: string }[] = [
    { query: '字太小了怎么放大', expect: 'faq-zoom', why: '界面缩放' },
    { query: '界面变大一点', expect: 'faq-zoom', why: '同义表达 → 缩放' },
    { query: '为什么 AI 按钮是灰色的', expect: 'faq-model-gray', why: '未配模型' },
    { query: '没保存上怎么办', expect: 'faq-save-state', why: '保存状态' },
    { query: '校对结果怎么跳到原文', expect: 'faq-proofread-actions', why: '定位原文' },
    { query: '复制粘贴没反应', expect: 'faq-copy-failed', why: '剪贴板' },
    { query: '图鉴怎么用方向键翻', expect: 'atlas-guide', why: '方向键 + 图鉴' },
    { query: '备份文件怎么还原', expect: 'start-import-project', why: '备份与导入' },
    { query: '新建章节写正文', expect: 'start-first-chapter', why: '第一章' },
    { query: '主角的角色卡在哪填', expect: 'char-main-guide', why: '角色卡' },
    { query: '主题怎么换成深色', expect: 'look-theme-density', why: '主题与密度' },
    { query: '酒馆怎么开始', expect: 'tavern-overview', why: '酒馆控制面板' },
    { query: '一键拆书抽设定', expect: 'tools-bookbreak', why: '拆书' },
    { query: '伏笔埋了没回收怎么办', expect: 'tracking-foreshadow', why: '伏笔回收' },
    { query: '时间线怎么登记', expect: 'tracking-timeline', why: '时间脉络' },
    { query: '术语重名怎么合并', expect: 'page-terms', why: '名词术语' },
    { query: '创意写作会不会自己一直写', expect: 'tools-creative-writing', why: '分批与续跑' },
    { query: '世界设定和子世界怎么分工', expect: 'world-base-power', why: '母级与子世界' },
    { query: '字号', expect: 'faq-zoom', why: '同义词「字号」' },
  ]
  const failures: string[] = []
  for (const item of cases) {
    const hit = top(item.query)
    if (!hit || hit.articleId !== item.expect) failures.push(`${item.query} → ${hit?.articleId ?? '（无结果）'}（期望 ${item.expect} / ${item.why}）`)
  }
  ok('固定问答样本都命中正确文章', failures.length === 0, failures.join(' ｜ '))

  const unrelated = searchHelp('量子纠缠的退相干时间')
  ok('无关问题不硬凑文章', unrelated.length === 0, unrelated.map(h => h.articleId).join('、'))
  ok('空查询不返回结果', searchHelp('   ').length === 0)
  ok('低命中给分类建议而不是假文章', suggestHelpGroups('第一次用这个软件', HELP_GROUPS).length > 0)
}

// ---------- ④ 当前页签加权与结果形态 ----------
{
  const withTab = searchHelp('角色', { currentTabId: 'char-main' })
  ok('当前页签参与加权（角色页里问「角色」先给角色文章）', withTab[0]?.articleId === 'char-main-guide', withTab[0]?.articleId ?? '（无结果）')
  const withoutTab = searchHelp('角色')
  ok('不给当前页签时也能检索到同一篇', withoutTab.some(hit => hit.articleId === 'char-main-guide'))

  const many = searchHelp('保存 模型 角色 大纲 图鉴 备份')
  const counts = new Map<string, number>()
  for (const hit of many) counts.set(hit.articleId, (counts.get(hit.articleId) ?? 0) + 1)
  ok(`同一篇文章最多 ${MAX_HITS_PER_ARTICLE} 段`, [...counts.values()].every(count => count <= MAX_HITS_PER_ARTICLE), [...counts].join(' '))
  ok('结果数量有上限（3～5 段）', many.length <= 5)
  const first = searchHelp('字太小了怎么放大')[0]
  ok('片段摘要围绕命中词截取', !!first && /放大|缩放|字/.test(first.excerpt), first?.excerpt ?? '')
  ok('片段带回文章标题与栏目（来源可追溯）', !!first && !!first.articleTitle && !!first.group)
}

// ---------- ⑤ 分词细节 ----------
{
  ok('同义表达会补上主题词', tokenizeHelpQuery('字太小').has('缩放'))
  ok('停用词不会被当成有效词', tokenizeHelpQuery('怎么办').size === 0, [...tokenizeHelpQuery('怎么办').keys()].join('、'))
  ok('单字不进词表', !tokenizeHelpQuery('图').has('图'))
  ok('英文查询能保留整词', tokenizeHelpQuery('ollama 怎么配').has('ollama'))
}

// ---------- ⑥ 覆盖度如实 ----------
{
  const covered = coveredTabIds()
  const missing = tabsWithoutHelp()
  ok('已覆盖页签都在真实页签表里', [...covered].every(tabId => ALL_TAB_IDS.includes(tabId)))
  ok('未覆盖页签与已覆盖互不重叠', missing.every(tabId => !covered.has(tabId)))
  ok('🔴 手册尚未覆盖全部页签时，必须能算出缺口', missing.length > 0, `缺口 ${missing.length} 个，全部覆盖=${missing.length === 0}`)

  const ui = read('src/components/help/HelpCenter.tsx')
  ok('🔴 手册页显示覆盖度（不能只说「完整手册」）', /已收录/.test(ui) && /暂无手册/.test(ui))
  const guide = read('src/components/app/GuidePage.tsx')
  ok('使用指南页接入手册（搜索与分类入口）', /HelpCenter/.test(guide))
}

console.log(`\n—— helpCenter 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
