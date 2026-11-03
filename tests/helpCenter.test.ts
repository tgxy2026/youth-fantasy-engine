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
  ALL_TAB_IDS, CONTENT_VERSION, HELP_ARTICLES, HELP_GROUPS, HELP_INDEX, MAX_HITS_PER_ARTICLE,
  SUPPORTED_APP_VERSION,
  checkHelpContent, coveredTabIds, getHelpArticle, helpArticlesForTab, searchHelp,
  suggestHelpGroups, tabsWithoutHelp, tokenizeHelpQuery,
} from '../src/lib/help'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
/** 包版本：手册的 verifiedAgainst 必须跟着它走 */
const pkgVersion = JSON.parse(read('package.json')).version as string

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
  // 覆盖度是「算出来的」而不是手写的：缺口必须正好等于全集减已覆盖（不论当前是否有缺口）
  const complement = ALL_TAB_IDS.filter(tabId => !covered.has(tabId))
  ok('🔴 缺口正好等于「全部页签 − 已覆盖」（不是手写清单）',
    missing.length === complement.length && missing.every(tabId => complement.includes(tabId)),
    `缺口 ${missing.length} 个 / 应有 ${complement.length} 个`)

  const ui = read('src/components/help/HelpCenter.tsx')
  // 🔴 断言落在**渲染出来的字符串**上，不认注释里的话（注释写着「已收录」但界面没渲染过就白守）
  const uiCode = ui.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  ok('🔴 手册页显示覆盖度（篇数 + 页签数）', /手册 \{HELP_ARTICLES\.length\} 篇 · 覆盖 \{coveredCount\} 个页签/.test(uiCode))
  ok('有缺口时如实列出「暂无手册」，不冒充完整', /暂无手册/.test(uiCode) && /tabsWithoutHelp\(\)/.test(uiCode))
  const guide = read('src/components/app/GuidePage.tsx')
  ok('使用指南页接入手册（搜索与分类入口）', /HelpCenter/.test(guide))
}

// ---------- ⑦ 答疑助手的形态：宽窗侧板 / 窄窗对话框 ----------
{
  const dockRaw = read('src/components/help/AssistantDock.tsx')
  // 断言只看代码，不看注释（注释里写着「不设 aria-hidden」会自己把自己判失败）
  const dock = dockRaw.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  const app = read('src/App.tsx')
  ok('侧板有稳定锚点（探针按它取面板）', /data-assistant-dock/.test(dock))
  ok('🔴 侧板是非模态：不设 aria-hidden、不加遮罩', !/aria-hidden/.test(dock) && !/data-guide-mask|backdrop/.test(dock))
  ok('🔴 Esc 只在焦点落在面板内时才收起（不抢别处的 Esc）',
    /panel\.contains\(document\.activeElement\)/.test(dock) || /contains\(document\.activeElement\)/.test(dock))
  ok('面板宽度跟着界面缩放折算（与 fixed 定位同一坐标系）', /var\(--ui-zoom/.test(dock))
  ok('🔴 形态按**布局宽度**决定（窗口宽 ÷ 界面缩放）',
    /window\.innerWidth \/ currentUiZoom\(\) >= 1180/.test(app))
  // 形态在打开那一刻决定：不能再有「跟随宽度切换形态」的 effect（换壳会卸载问了一半的对话）
  ok('🔴 形态不在打开后跟随宽度变化（避免换壳丢对话）',
    !/setAssistantDock\([^)]*\).*\n[\s\S]{0,200}addEventListener\('resize'/.test(app))
  ok('两种形态共用同一份 HelpCenter 属性（内容一致）',
    (app.match(/receiveArticleRequests=\{false\}/g) ?? []).length >= 2)
  ok('侧板与对话框都用「使用答疑助手」这个叫法', /使用答疑助手/.test(app) && /使用答疑助手/.test(dock))
}

// ---------- ⑨ 项目管理首页：手册入口与新手引导放在一起 ----------
//
// 🔴 2026-10-31 主人反馈 F1 之后，顶部按钮由 8 个并成 6 个：
//    「新手引导 + 使用手册」合并成「帮助」下拉，「看板娘设置 + 应用图标」合并成「外观」下拉。
//    所以这里不能再找 `onClick={() => setHelpOpen(true)}` 这种"独立按钮"的写法，
//    改为钉住三件事：① 手册入口还在且只有一处；② 它与新手引导同处「帮助」菜单；
//    ③ 两个合并入口真的存在（否则按钮又被拆回去，两排问题会复发）。
{
  const hubSrc = read('src/components/app/ProjectHub.tsx')
  const helpOpenCalls = (hubSrc.match(/setHelpOpen\(true\)/g) ?? []).length
  ok('项目管理页有「使用手册」入口', helpOpenCalls > 0)
  ok('🔴 只保留一个「使用手册」入口（合并菜单里只有一处，没有留下旧的）',
    helpOpenCalls === 1, String(helpOpenCalls))

  // 🔴 不要用 indexOf('帮助') 这类整文件下标比大小：同一个词在 title / 注释里也出现，
  //    比出来的顺序毫无意义（第一次写就是这么红的）。改成**按块切片**：
  //    从每个菜单的展开回调起、到下一个块的开头止，只在这段里查关键字。
  const helpStart = hubSrc.indexOf('setHelpMenuOpen(o => !o)')
  const helpEnd = hubSrc.indexOf('{/* 新建表单 */}')
  const helpBlock = helpStart > 0 && helpEnd > helpStart ? hubSrc.slice(helpStart, helpEnd) : ''
  ok('🔴 「新手引导」与「使用手册」在同一个「帮助」菜单里',
    helpBlock.includes('新手引导') && helpBlock.includes('使用手册'),
    helpBlock ? '' : '找不到帮助菜单块')

  const appStart = hubSrc.indexOf('setAppearanceMenuOpen(o => !o)')
  const appBlock = appStart > 0 && helpStart > appStart ? hubSrc.slice(appStart, helpStart) : ''
  ok('🔴 顶部有「外观」合并入口，内含看板娘设置与应用图标（F1）',
    appBlock.includes('看板娘设置') && appBlock.includes('应用图标'),
    appBlock ? '' : '找不到外观菜单块')
  ok('🔴 顶部不再有独立的应用图标 / 新手引导按钮（否则又会排成两排）',
    (hubSrc.match(/<ImageIcon size=\{13\} \/> 应用图标/g) ?? []).length === 0
    && (hubSrc.match(/<Compass size=\{13\} \/> 新手引导/g) ?? []).length === 0)
}

// ---------- ⑧ P6：把「覆盖度 + 内容自检 + 内容版本」做成检查入口里的一行摘要 ----------
// 🔴 为什么要打印：`npm test` / `run-batches.sh all` 是日常唯一入口（规划 §P6「手册覆盖检查
//    接入现有检查入口」）。只在文档里写「已覆盖 55 个入口」，改内容时没人看得见实际数字。
{
  const sections = HELP_ARTICLES.reduce((sum, article) => sum + article.sections.length, 0)
  const covered = coveredTabIds().size
  const missing = tabsWithoutHelp()
  const issues = checkHelpContent()
  console.log(`\n手册：${HELP_ARTICLES.length} 篇 / ${sections} 段 / 覆盖 ${covered}/${ALL_TAB_IDS.length} 个入口`
    + ` / 缺口 ${missing.length} / 内容版本 v${CONTENT_VERSION} / 自检 ${issues.length} 个问题`)

  ok('🔴 覆盖度算得出来且不超过全集', covered > 0 && covered <= ALL_TAB_IDS.length, `${covered}/${ALL_TAB_IDS.length}`)
  ok('🔴 内容自检在检查入口里为 0 问题（改坏内容门禁就红）', issues.length === 0)
  /**
   * 🔴 手册声明的核对版本**不能落后于包版本**：落后说明手册讲的是上一版界面，事实要重核。
   * 允许「高于包版本」—— 开发期就是这么走的（包还是 3.3.0，手册已在按 3.3.1 核对），
   * 这是提前定口径，不是错。真正要拦的是「包升到 3.3.2 了，手册还写 3.3.1」。
   */
  const compareVersion = (a: string, b: string) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
      if (diff !== 0) return diff > 0 ? 1 : -1
    }
    return 0
  }
  ok('🔴 手册核对版本不落后于包版本（包升版了手册必须重核）',
    compareVersion(SUPPORTED_APP_VERSION, pkgVersion) >= 0,
    `手册 ${SUPPORTED_APP_VERSION} / 包 ${pkgVersion}`)
}

console.log(`\n—— helpCenter 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
