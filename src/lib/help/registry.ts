// ============ 内置使用手册 · 注册表（3.3.1 · P1） ============
//
// 一份注册表，三种呈现（规划 §2.2）：页签引导（P2）、手册文章（本模块）、AI 检索片段（`search.ts`）。
// 索引**由注册表生成**，不另存一份手写清单 —— 否则文章改了索引没改，检索会指向不存在的段落。
//
// 🔴 内容与代码同版本发布：`CONTENT_VERSION` 变了，说明目录/正文/索引任一处改过，
//    缓存过的旧索引必须作废（网页版尤其容易残留旧资源，见规划 §4.4）。
import { TABS, EDITOR_TAB } from '@/lib/schema'
import type { HelpArticle, HelpGroup, HelpIndexEntry } from '@/lib/help/types'
import { START_ARTICLES } from '@/lib/help/articles/start'
import { FAQ_ARTICLES } from '@/lib/help/articles/faq'
import { EDITOR_ARTICLES } from '@/lib/help/articles/editor'
import { WORLD_ARTICLES } from '@/lib/help/articles/world'
import { PLAN_ARTICLES } from '@/lib/help/articles/plan'
import { LOOK_ARTICLES } from '@/lib/help/articles/look'
import { WORLD_EXTRA_ARTICLES } from '@/lib/help/articles/world-extra'
import { TRACKING_ARTICLES } from '@/lib/help/articles/tracking'
import { TOOLS_ARTICLES } from '@/lib/help/articles/tools'
import { TAVERN_ARTICLES } from '@/lib/help/articles/tavern'
import { MISC_PAGE_ARTICLES } from '@/lib/help/articles/misc-pages'

/** 整套内容的版本：正文、目录、索引必须同版本，否则来源引用不可信 */
export const CONTENT_VERSION = 1

/** 这套内容核对时对应的软件版本 */
export const SUPPORTED_APP_VERSION = '3.3.1'

/** 全部文章。顺序即同一分组内的展示顺序 */
export const HELP_ARTICLES: HelpArticle[] = [
  ...START_ARTICLES,
  ...EDITOR_ARTICLES,
  ...PLAN_ARTICLES,
  ...WORLD_ARTICLES,
  ...WORLD_EXTRA_ARTICLES,
  ...LOOK_ARTICLES,
  ...TRACKING_ARTICLES,
  ...TOOLS_ARTICLES,
  ...TAVERN_ARTICLES,
  ...MISC_PAGE_ARTICLES,
  ...FAQ_ARTICLES,
]

/** 栏目展示顺序（与规划 §4.2 的目录一致，不按字母排 —— 这是给作者看的动线） */
export const HELP_GROUPS: HelpGroup[] = [
  '快速开始',
  '工作面板与正文',
  '开书定位与大纲',
  '角色与世界',
  '创作与维护',
  '灵感工具',
  '酒馆模式',
  '模型与 AI',
  '数据与界面',
  '常见问题与任务教程',
]

/** 全部真实页签 id（含正文编辑；不含动态分卷页 `chapter-vol-*`） */
export const ALL_TAB_IDS: string[] = [...TABS.map(tab => tab.id), EDITOR_TAB.id]

const byId = new Map<string, HelpArticle>()
for (const article of HELP_ARTICLES) byId.set(article.id, article)

/** 取一篇文章；找不到返回 null（不抛错 —— 失效引用要让界面自己说明，而不是白屏） */
export function getHelpArticle(id: string): HelpArticle | null {
  return byId.get(id) ?? null
}

/** 按分组取文章（保持注册表顺序） */
export function helpArticlesInGroup(group: HelpGroup): HelpArticle[] {
  return HELP_ARTICLES.filter(article => article.group === group)
}

/** 与某个页签关联的文章：手册里的「本页帮助」与引导的「查看完整手册」都用它 */
export function helpArticlesForTab(tabId: string): HelpArticle[] {
  return HELP_ARTICLES.filter(article => article.tabIds.includes(tabId))
}

/**
 * 手册已覆盖的页签集合。
 * 🔴 用途是**如实显示覆盖度**：「这个页签还没有手册」必须能看出来，
 *    不能因为文章少就说手册完整（规划 §10.1 要求逐页映射）。
 */
export function coveredTabIds(): Set<string> {
  const covered = new Set<string>()
  for (const article of HELP_ARTICLES) for (const tabId of article.tabIds) covered.add(tabId)
  return covered
}

/** 还没有手册文章的页签（按注册表顺序，便于维护时逐条补） */
export function tabsWithoutHelp(): string[] {
  const covered = coveredTabIds()
  return ALL_TAB_IDS.filter(tabId => !covered.has(tabId))
}

/** 由文章生成段落级索引；每段一条，保留来源与加权所需的元信息 */
export function buildHelpIndex(articles: HelpArticle[]): HelpIndexEntry[] {
  const entries: HelpIndexEntry[] = []
  for (const article of articles) {
    const titleText = [article.title, ...article.aliases].join(' ')
    const keywordText = article.keywords.join(' ')
    for (const section of article.sections) {
      entries.push({
        articleId: article.id,
        articleTitle: article.title,
        sectionId: section.id,
        heading: section.heading,
        text: section.body.join('\n'),
        titleText,
        keywordText,
        group: article.group,
        tabIds: article.tabIds,
      })
    }
  }
  return entries
}

/** 索引：随注册表构建一次，检索直接用它（不重复计算） */
export const HELP_INDEX: HelpIndexEntry[] = buildHelpIndex(HELP_ARTICLES)

export interface HelpContentIssue {
  /** 相关文章（全局问题为空） */
  articleId?: string
  problem: string
}

/**
 * 内容自检：结构层面的硬错误。
 *
 * 🔴 只查「一定能判对」的事（id 重复、页签不存在、引用悬空、段落空、日期格式），
 *    不查「内容写得对不对」—— 那要靠人工核对与 `verifiedAgainst`，代码判不了。
 */
export function checkHelpContent(articles: HelpArticle[] = HELP_ARTICLES): HelpContentIssue[] {
  const issues: HelpContentIssue[] = []
  const seenIds = new Set<string>()
  const validTabs = new Set(ALL_TAB_IDS)
  const articleIds = new Set(articles.map(article => article.id))
  for (const article of articles) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(article.id)) issues.push({ articleId: article.id, problem: 'id 必须是英文小写连字符' })
    if (seenIds.has(article.id)) issues.push({ articleId: article.id, problem: 'id 重复' })
    seenIds.add(article.id)
    if (!article.title.trim()) issues.push({ articleId: article.id, problem: '缺少标题' })
    if (!article.summary.trim()) issues.push({ articleId: article.id, problem: '缺少一句话说明' })
    if (!Number.isInteger(article.revision) || article.revision < 1) issues.push({ articleId: article.id, problem: 'revision 必须是正整数' })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(article.reviewedAt)) issues.push({ articleId: article.id, problem: 'reviewedAt 必须是 YYYY-MM-DD' })
    if (!article.verifiedAgainst) issues.push({ articleId: article.id, problem: '缺少 verifiedAgainst（核对时的软件版本）' })
    if (article.sections.length === 0) issues.push({ articleId: article.id, problem: '没有正文段落' })
    const sectionIds = new Set<string>()
    for (const section of article.sections) {
      if (!section.id.trim()) issues.push({ articleId: article.id, problem: `段落 "${section.heading}" 缺 id` })
      if (sectionIds.has(section.id)) issues.push({ articleId: article.id, problem: `段落 id 重复：${section.id}` })
      sectionIds.add(section.id)
      if (!section.heading.trim()) issues.push({ articleId: article.id, problem: '段落缺标题' })
      if (section.body.length === 0 || section.body.every(text => !text.trim())) {
        issues.push({ articleId: article.id, problem: `段落 "${section.heading}" 没有正文` })
      }
    }
    if (article.tabIds.length === 0) issues.push({ articleId: article.id, problem: '没有关联页签' })
    for (const tabId of article.tabIds) {
      if (!validTabs.has(tabId)) issues.push({ articleId: article.id, problem: `页签不存在：${tabId}` })
    }
    for (const action of article.actions ?? []) {
      if (!validTabs.has(action.tabId)) issues.push({ articleId: article.id, problem: `动作目标页签不存在：${action.tabId}` })
      if (!action.label.trim()) issues.push({ articleId: article.id, problem: '动作缺标签' })
    }
    for (const related of article.related ?? []) {
      // 相关文章只在**本批内容**内校验：允许跨文件引用，但不允许指向不存在的 id
      if (!articleIds.has(related)) issues.push({ articleId: article.id, problem: `相关文章不存在：${related}` })
    }
  }
  return issues
}
