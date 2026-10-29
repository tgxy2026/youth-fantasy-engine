// ============ 内置使用手册 · 本地全文检索（3.3.1 · P1） ============
//
// 规划 §5.2：面向中文的本地检索。标题/别名/关键词权重高于正文；支持中文片段匹配与常用表达映射；
// 当前页签作为相关性加权（不把检索限制死在当前页）；按段落返回 3～5 个片段；低命中给分类建议。
//
// 🔴 这里**只**查内置手册：不碰作者的项目资料、正文、模型密钥，也不把项目 ID 与书名带进检索。
// 🔴 纯函数、无 DOM、无网络 —— 未配置模型时手册照样能查（规划 §5.1）。
// 阈值与权重会随固定问答样本调（规划 §5.2 明确要求按样本调，不能靠一个没验过的分值下结论）。
import type { HelpHit, HelpIndexEntry, HelpGroup } from '@/lib/help/types'
// 🔴 索引必须**直接来自注册表**：靠调用方记得注入的话，漏一次就是「搜索永远没结果」的静默失明。
//    registry 不 import search，方向单一、无循环。
import { HELP_INDEX } from '@/lib/help/registry'

/**
 * 命中下限：低于它的片段不进结果（宁可不匹配，也不硬凑一篇无关文章）。
 *
 * 🔴 取值来自实测：正常问题的命中分在 20～36 之间；而「量子纠缠的退相干时间」这类无关问题
 *    靠「时间」两个字蹭到《时间脉络》，只有 3～8 分。门槛放在 10 能把后者挡掉，又不误伤前者。
 */
export const MIN_HIT_SCORE = 3

/** 一次最多返回几个片段 */
export const MAX_HITS = 5

/** 同一篇文章最多占几个片段（防止一篇长文把结果位全吃了） */
export const MAX_HITS_PER_ARTICLE = 2

/**
 * 关键词权重：标题 > 关键词 > 段落标题 > 正文（规划 §5.2 的「标题/别名/关键词高于正文」）。
 * `currentTab` 给到 8：作者是在**这一页**提问的，「本页相关的文章」应当明显优先于别页的泛泛提及
 *（实测 2 不够：《自由对话与角色卡片》会压过《主要角色》）。
 */
const WEIGHT = { title: 6, keyword: 4, heading: 3, text: 1, currentTab: 8 } as const

/** 问句里的高频虚词：留着会把「怎么」「什么」当成有效词，把所有文章都命中 */
const STOPWORDS = new Set([
  '为什么', '怎么', '怎样', '如何', '什么', '怎么办', '可以', '能不能', '是否', '一下',
  '这个', '那个', '这里', '那里', '我的', '我要', '想要', '这里', '请问', '帮我', '在哪', '哪里',
])

/**
 * 常用表达映射：作者不会说「界面缩放」，他会说「字太小」「界面变大」。
 * 🔴 映射是**单向补充**：命中任一说法就补上主题词，不替换作者原词（原词仍参与打分）。
 */
const SYNONYMS: { topic: string; phrases: string[] }[] = [
  { topic: '缩放', phrases: ['放大', '缩小', '变大', '变小', '字太小', '字太大', '界面太大', '界面太小', '字体大小', '看不清'] },
  { topic: '保存', phrases: ['存盘', '落盘', '没保存', '存不上', '存不了', '保存失败', '丢稿'] },
  { topic: '模型', phrases: ['ai', '大模型', 'ollama', 'lmstudio', 'lm studio', '接口', '密钥'] },
  { topic: '校对', phrases: ['错别字', '语病', '错字', '标点错', '找错', '改错'] },
  { topic: '备份', phrases: ['导出', '还原', '恢复', '搬迁', '换电脑', '换设备', '数据丢了'] },
  { topic: '方向键', phrases: ['键盘', '上下键', '左右键', '快捷键', '不用鼠标'] },
  { topic: '复制', phrases: ['剪贴板', '粘贴', '复制不了', '复制没反应'] },
  { topic: '新手', phrases: ['第一次', '刚开始', '入门', '上手', '从哪开始'] },
]

/** 虚字：出现在任何 2-gram 里就丢掉整个组合（否则「怎么开始」会切出「么开」这种假词） */
const STOP_CHARS = new Set(['怎', '么', '什', '了', '吗', '呢', '吧', '啊', '呀', '哦', '嘛'])

/** 归一化：全角转半角、小写、标点转空格、压掉多余空白 */
export function normalizeHelpText(input: string): string {
  return input
    .replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000]+/g, ' ')
    .toLowerCase()
    .replace(/[，。！？、；：“”‘’（）《》【】…—,.!?;:"'()<>[\]|/\\~`+=*&^%$#@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把作者的问题拆成检索词。
 *
 * 中文没有空格分词，这里用「整段（短语）+ 2-gram」两级：
 *   · 整段权重高（作者常常就是连着说的，如「界面缩放」）；
 *   · 2-gram 兜住语序变化（「缩放界面」也能命中）。
 * 单字一律丢弃：命中率太高、几乎不携带信息。
 */
export function tokenizeHelpQuery(raw: string): Map<string, number> {
  const tokens = new Map<string, number>()
  const push = (token: string, weight: number) => {
    if (token.length < 2) return
    tokens.set(token, Math.max(tokens.get(token) ?? 0, weight))
  }
  const normalized = normalizeHelpText(raw)
  for (const chunk of normalized.split(' ')) {
    if (!chunk) continue
    const isChinese = /[\u4e00-\u9fff]/.test(chunk)
    if (!isChinese) { push(chunk, 2); continue }
    // 整段就是虚词（「怎么办」「为什么」）⇒ 连 2-gram 也不再产，
    // 否则「怎么办」会被切成「么办」这种看似有意义的假词，把所有文章都命中一遍。
    if (STOPWORDS.has(chunk)) continue
    if (chunk.length <= 12) push(chunk, 2)
    if (chunk.length >= 2) {
      for (let i = 0; i + 1 < chunk.length; i++) {
        const gram = chunk.slice(i, i + 2)
        if (STOPWORDS.has(gram)) continue
        // 含虚字的组合不成词（「怎么开始」→ 不要「么开」）
        if (STOP_CHARS.has(gram[0]) || STOP_CHARS.has(gram[1])) continue
        push(gram, 1)
      }
    }
  }
  // 同义补词：作者说「字太小」时也去找「缩放」
  for (const { topic, phrases } of SYNONYMS) {
    if (phrases.some(phrase => normalized.includes(phrase))) push(topic, 1)
  }
  return tokens
}

/**
 * 词区分度（简化 IDF）：一个词在越多篇里出现，越不说明问题。
 *
 * 🔴 为什么必须有它：「时间」「开始」「保存」这类词几乎每篇都有，靠它们命中的文章
 *    和「酒馆」「拆书」这种只在一两篇里出现的专有词，权重不该一样。
 *    实测：没有 IDF 时「量子纠缠的退相干时间」会靠「时间」蹭进《时间脉络》，
 *    而「酒馆怎么开始」又会被《第一次打开》抢走 —— 两头都不对。
 */
function tokenIdf(token: string, entries: HelpIndexEntry[]): number {
  let df = 0
  for (const entry of entries) {
    if (entry.titleText.includes(token) || entry.keywordText.includes(token)
      || entry.heading.includes(token) || entry.text.includes(token)) df++
  }
  // 越少见越接近 1；到处都是的词掉到 0.1 以下（平方放大差距）
  const idf = Math.log(1 + entries.length / (1 + df))
  const max = Math.log(1 + entries.length / 2)
  return Math.pow(Math.min(1, idf / max), 2)
}

/**
 * 通用词：几乎每篇都出现、或本身就是问句骨架，**不能单独作为「找到了」的依据**。
 *
 * 🔴 准入判据不是分数高低，而是「有没有命中一个实词」：
 *    · 「量子纠缠的退相干时间」只剩「时间」→ 通用词 → 整条不成立（否则《时间脉络》会被顶上来）；
 *    · 「酒馆怎么开始」的实词是「酒馆」→ 命中《酒馆模式》，而《第一次打开》只命中「开始」→ 出局；
 *    · 「没保存上怎么办」的实词是「保存」→ 正常命中《保存状态》。
 */
const GENERIC_TOKENS = new Set([
  '时间', '开始', '功能', '页面', '内容', '设置', '数据', '问题', '方法', '情况', '时候',
  '东西', '地方', '记录', '使用', '操作', '时候', '一下', '怎样', '需要', '没有', '不会',
])

/** 单条索引项的得分 */
function scoreEntry(entry: HelpIndexEntry, tokens: Map<string, number>, currentTabId: string | null, entries: HelpIndexEntry[]): number {
  if (tokens.size === 0) return 0
  const title = normalizeHelpText(entry.titleText)
  const keywords = normalizeHelpText(entry.keywordText)
  const heading = normalizeHelpText(entry.heading)
  const body = normalizeHelpText(entry.text)
  let raw = 0
  let matched = 0
  /** 至少一个「实词命中标题 / 关键词 / 段落标题」才成立；只命中正文不算找到 */
  let strong = false
  for (const [token, weight] of tokens) {
    let hit = 0
    const inTitle = title.includes(token)
    const inKeywords = keywords.includes(token)
    const inHeading = heading.includes(token)
    if (inTitle) hit += WEIGHT.title
    if (inKeywords) hit += WEIGHT.keyword
    if (inHeading) hit += WEIGHT.heading
    if (body.includes(token)) hit += WEIGHT.text
    if (hit > 0) {
      raw += hit * weight * tokenIdf(token, entries)
      matched++
      if (!GENERIC_TOKENS.has(token) && (inTitle || inKeywords || inHeading)) strong = true
    }
  }
  if (matched === 0 || !strong) return 0
  /**
   * 覆盖率：命中 3 个检索词即满分。
   *
   * 🔴 不用「命中数 / 全部词数」：中文查询会被切成十几个 2-gram，分母一大，
   *    「术语重名怎么合并」这种只命中「术语」一条的正常问题就会被压到门槛以下（实测）。
   */
  const coverage = Math.min(1, matched / 3)
  const tabBonus = currentTabId && entry.tabIds.includes(currentTabId) ? WEIGHT.currentTab : 0
  return raw * (0.5 + 0.5 * coverage) + tabBonus
}

/** 摘出一段以首个命中词为中心的上下文 */
export function buildHelpExcerpt(entry: HelpIndexEntry, tokens: Map<string, number>, maxLength = 90): string {
  const text = entry.text.replace(/\n+/g, ' ').trim()
  // 直接在原文里找（中文不受大小写影响；英文只把正文转小写比对），避免归一化改长度导致截断位置偏移
  const lower = text.toLowerCase()
  let at = -1
  for (const token of tokens.keys()) {
    const found = lower.indexOf(token)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) return text.slice(0, maxLength) + (text.length > maxLength ? '…' : '')
  const start = Math.max(0, at - Math.floor(maxLength / 3))
  const end = Math.min(text.length, start + maxLength)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/** 检索：返回按相关度排序的片段（同篇文章最多 2 段） */
export function searchHelp(raw: string, options: { currentTabId?: string | null; limit?: number } = {}): HelpHit[] {
  const tokens = tokenizeHelpQuery(raw)
  if (tokens.size === 0) return []
  const currentTabId = options.currentTabId ?? null
  const limit = options.limit ?? MAX_HITS
  const scored = HELP_INDEX
    .map(entry => ({ entry, score: scoreEntry(entry, tokens, currentTabId, HELP_INDEX) }))
    .filter(item => item.score >= MIN_HIT_SCORE)
    .sort((a, b) => b.score - a.score)
  const hits: HelpHit[] = []
  const perArticle = new Map<string, number>()
  for (const { entry, score } of scored) {
    const used = perArticle.get(entry.articleId) ?? 0
    if (used >= MAX_HITS_PER_ARTICLE) continue
    perArticle.set(entry.articleId, used + 1)
    hits.push({
      articleId: entry.articleId,
      articleTitle: entry.articleTitle,
      sectionId: entry.sectionId,
      heading: entry.heading,
      group: entry.group,
      tabIds: entry.tabIds,
      score: Math.round(score * 100) / 100,
      excerpt: buildHelpExcerpt(entry, tokens),
    })
    if (hits.length >= limit) break
  }
  return hits
}

/**
 * 低命中时的分类建议：先按栏目名弱匹配，再回落到「新手常问」的几个栏目。
 * 🔴 给的是分类，不是硬凑的文章 —— 规划 §5.2 明确禁止「低命中还推荐一篇不相关的文章」。
 */
export function suggestHelpGroups(raw: string, groups: HelpGroup[]): HelpGroup[] {
  const normalized = normalizeHelpText(raw)
  const matched = groups.filter(group => {
    const name = normalizeHelpText(group)
    if (normalized.includes(name)) return true
    // 栏目名里的关键词（「工作面板与正文」→「正文」也能拉上）
    return name.split(/[与和]/).some(part => part.length >= 2 && normalized.includes(part))
  })
  if (matched.length > 0) return matched.slice(0, 3)
  const fallback: HelpGroup[] = ['快速开始', '常见问题与任务教程']
  return fallback.filter(group => groups.includes(group))
}
