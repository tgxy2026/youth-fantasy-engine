// ============ 全项目资料上下文 ============
//
// 作用：把当前项目的「所有设定资料」打包成一份紧凑的纯文本，作为 AI 的背景知识。
//
// 为什么要单独一层：
//   1. 模型有上下文长度上限（本地小模型尤其吃紧），必须按重要性排序 + 预算裁剪，
//      而不是把库里所有字符一股脑塞过去。
//   2. 页签是 schema 驱动的，这里也按 TABS 遍历，以后新增页签自动纳入，不用改这里。
//   3. 任一存储读取失败都不能拖垮整体——AI 只是锦上添花，拿不到资料就少带一段，
//      绝不能报错阻断作者。

import * as db from '@/lib/db'
import { tabVisible, type VisCtx, TABS } from '@/lib/schema'
import { readAliases } from '@/lib/settings/aliases'
import { splitNames } from '@/lib/audit/audit'
import { clipText } from '@/lib/editor/textClip'
import { todayKey } from '@/lib/app/date'
import { sortChapters, flattenChapters, flattenAll, orphanChapters, chapterSeqMap } from '@/lib/outline/chapterSeq'
import { pickContinuationSources, type ContinuationPickOpts } from '@/lib/editor/continuationPick'
import { composeSubSetsBlock, composeParallelSetBlock, isInternalFieldKey, isParallelSetTab, isWorldSetTab, splitActive } from '@/lib/world/worldSets'
import { getActivePack, subItemLabel } from '@/lib/schemaTemplates/index'
import { buildSemanticRecallBlock } from '@/lib/semantic/inject'
import { buildKbBlock } from '@/lib/search/kbInject'
import { getTempDocs, renderTempDocs } from '@/lib/ai/tempDocs'
import { buildProjectLevelHint } from '@/lib/ai/projectLevelHint'
import { CHAPTER_RESERVE_CHARS, budgetFromWindow, planFor } from '@/lib/ai/contextLayers'
import { genreLineForAI } from '@/lib/ai/aiGenreHint'
import { isAtlasTab } from '@/lib/atlas/schema'
import { cellCap } from '@/lib/ai/fieldCap'
import {
  renderTable, AUTHOR_SIDE_FIELDS, DEFAULT_ROW_CAP, DEFAULT_TABLE_MAX_CHARS,
  ROW_CAP, SYSTEM_META_FIELDS, type RenderOpts,
} from '@/lib/ai/tableRender'
import { isPrunedForAI, isSecretRow, sortBySecrecy } from '@/lib/ai/secrecy'
import { segCapOf } from '@/lib/ai/segBudget'
import { createContextAssembler } from '@/lib/ai/contextAssembler'
import { loadAtlasFieldsForAI } from '@/lib/ai/atlasContext'
import { loadFieldGating } from '@/lib/templates/labels'
import type { Chapter, TabDef, Volume } from '@/lib/types'
import type { AiContextSnapshot } from '@/lib/ai/aiRunTypes'

export interface ProjectContextOptions {
  /**
   * 总字符预算。**不传则按当前模型的上下文窗口算**（`窗口 × 0.5`，3.1.3 起）。
   *
   * 🔴 不再按项目字数分档：实测大多数用户用线上模型（32K~200K 窗口），
   *    按最保守的档给会让 AI 明明有空间却看不到设定（生成质量白掉）。
   *    只有在**读不到模型配置**时才回落到 `LAYER_PLANS[规模档].budget`。
   *    显式传值仍然优先（伴写 1200~1300、「AI 整理」的完整表等场景需要自己定）。
   */
  budget?: number
  /** 只包含这些页签（不传则按默认优先级全量） */
  onlyTabIds?: string[]
  /** 排除这些页签（例如「AI 整理」时正在整理的那张表另行单独完整给出） */
  excludeTabIds?: string[]
  /** 是否附带章节清单（卷 / 章标题 / 字数 / 摘要），默认 true */
  includeChapterList?: boolean
  /**
   * 只出「骨架」：作品概览 + 章节清单，**不带任何页签资料、也不做相关章节召回**。
   * 酒馆「设定来源 = 背景设定」档用它 —— 世界规则交给作者提炼过的背景设定，
   * 这里只保留「这本书写到哪了」这条最小上下文（章节清单每章带 120 字摘要，够用且便宜）。
   */
  skeletonOnly?: boolean
  /**
   * #015：焦点章节 id。指定后，上下文会优先带入与它**相关**的章节（人物共现 + 叙事邻接），
   * 而不是把章节清单从头截断 —— 长篇时后者喂给模型的往往只有开头几章，越写到后面越失准。
   */
  focusChapterId?: string
  /** 相关章节召回条数上限，默认 8 */
  relatedChapterLimit?: number
  /**
   * #013 语义召回：在「相关章节召回」之后**再补一段**〖语义召回〗。
   * 需要作者配好嵌入模型、且已建过索引；任一条件不满足 ⇒ 静默跳过（零副作用）。
   * 显式传 false 可关掉（留给"AI 整理"这类不需要语义召回的场合）。
   */
  semantic?: boolean
  /** 语义召回条数上限，默认 6 */
  semanticLimit?: number
  /**
   * #017 知识库：在〖语义召回〗之后再补一段〖参考资料〗（作者挂载的外部文档）。
   * 🔴 不传也算**开** —— 判定权交给「有没有已启用的资料」（作者在素材页勾选启用即视为显式开启）。
   *    为什么不加一层"必须传 true"的默认关：只要有一个调用点漏传，这功能就**静默死掉**了，
   *    而那种 bug 比"多带一段文字"难查得多。显式传 false 仍然可以关掉。
   */
  kb?: boolean
  /** 参考资料召回条数上限，默认 4 */
  kbLimit?: number
  /**
   * 🆕 3.0.3 · 〖参考资料〗段的总长上限，默认 2400。
   * 伴写（AI 补全）的总预算只有千余字，必须传更小的值 —— 否则这一段会被预算闸**整段丢掉**，
   * 变成"接了线却依然读不到"（本轮修的就是这类静默失效）。
   */
  kbMaxChars?: number
  /**
   * 🆕 3.1.3 · 单张设定表的字符上限（默认 `min(单段上限, 1600)`）。
   *
   * 表超过它就**先减列、再减行**（见 `ai/tableDigest.ts`），而不是整段塞进装配器再被裁/被丢。
   * 传 `Number.POSITIVE_INFINITY` = 不压（"AI 整理"这类**需要看全表**的场合，
   * 以及测排序/稳定性的用例要用它把变量挡掉）。
   */
  tableMaxChars?: number
  /**
   * 是否在正文尾部附一段「（注：以下资料因长度预算未带入…）」。默认 true。
   * 酒馆模式传 false —— 它把 dropped 交给 buildSystemPrompt 生成**独立的**
   * 〖未带入的资料〗 层（结构化、位置更靠近生成点），两处一起写等于同一件事说两遍。
   * 其余 AI 功能（整理 / 校对 / 审计）不消费 dropped 数组，保持默认 true 以免丢声明。
   */
  inlineDropNote?: boolean

  // ===== 酒馆模式（方案 §4.2）：以下三项只加参数，不传即完全维持原行为 =====
  /**
   * 视角档位。
   * · 'character-view' —— 角色视角：只带角色的「常识」（世界观 / 角色 / 关系 / 名词），
   *   **排除作者侧资料**（全书总纲、分卷大纲、章节细纲、伏笔追踪、爽点节奏、支线剧情、灵感素材…），
   *   并进一步隐藏常识表内的**作者侧字段**（结局归宿 / 隐藏设定 / 演变轨迹 / 关系终点…，见
   *   AUTHOR_SIDE_FIELDS）—— 只排页签不够：常识表里混着未来向列，会照样把结局递到演员手里。
   *   理由：那些是作者侧资料，带进去等于剧透，AI 会变成「知道结局的演员」，
   *   「测试角色真实反应」这个目的直接归零。
   * · 'director-view' —— 导演视角：作者侧资料照带，但**锚点仍然生效**（只看截至锚点的大纲与伏笔）。
   */
  viewMode?: 'character-view' | 'director-view'
  /**
   * 叙事锚点（章节 id）。指定后，章节清单与相关章节召回**只保留锚点章及之前的** ——
   * 之后再发生的事，此刻的角色不可能知道。
   */
  anchorChapterId?: string
  /**
   * 知情者过滤：`secrets`（知情权限）只带入「该角色是知情者」的条目。
   * 与「扮演设定的知识边界」互补 —— secrets 管事实边界，扮演设定管认知范围。
   */
  knowerName?: string
}

export interface ProjectContextResult {
  /** 拼好的上下文文本（可能为空串，表示项目还没填任何资料） */
  text: string
  /** 实际带入的段落名，供 UI 展示「已带入：世界设定 / 主要角色 …」 */
  sections: string[]
  /** 因预算不足被丢弃的段落名 */
  dropped: string[]
  chars: number
}

/**
 * 上下文段落优先级：越靠前越先塞进预算。
 * 依据：世界观与主角设定是一致性的根，其次是结构性大纲，最后才是运营台账。
 * 刻意排除 progress（写作进度）——纯码字流水，对模型是纯噪音。
 *
 * 2026-09-17 审计修正两处：
 *  · `style`（写作规范）由第 23 位前移 —— 它是"每次生成都要遵守的约束"，体积小却直接决定文风是否一致；
 *    排在末尾等于"长篇后期预算一紧就先丢它"，代价最大、收益最小。原注释把它归进"运营台账"是一处误判。
 *  · `faction-rels`（势力关系）补入 —— 原先**不在本表**，只能靠下方 for 循环"兜底追加"到最末，
 *    结果是明明有数据却几乎带不进去（AI 判断势力格局正需要它）。
 *  🔴 凡新增资料型页签，务必登记进本表 —— 兜底机制只保证"不丢数据"，不保证"进得了预算"。
 */
const PRIORITY: string[] = [
  'positioning',      // 作品信息
  'worldbase',        // 世界设定
  'power',            // 力量体系
  // 制度页签（2026-10-02 · 2.7.1 §8.4）：紧贴世界设定/力量体系 —— 它们是「这个世界怎么运转」，
  // 与前三者同属"开书定位"层的顶层档案，比角色/势力更该先占预算。
  'politics',         // 政治架构
  'economy',          // 经济基础
  'belief',           // 宗教信仰
  'justice',          // 司法制度
  'master',           // 全书总纲
  'char-main',        // 主要角色
  'relations',        // 人物关系
  'char-secondary',   // 次要角色
  'style',            // 写作规范
  'terms',            // 名词术语
  'nations',          // 国家势力
  'faction-rels',     // 势力关系
  'geography',        // 地理风物
  'races',            // 种族生物
  'items',            // 物品资源
  'history',          // 历史事件
  'misc-settings',    // 其他设定（世界构建的兜底页，2026-09-20 新增；当晚由表格改卡片型）
  'volume-outline',   // 分卷大纲
  'chapter-master',   // 章节总表
  'chapter-outline',  // 章节细纲
  'foreshadow',       // 伏笔追踪
  'timeline',         // 时间脉络
  'subplots',         // 支线剧情
  'secrets',          // 知情权限
  'hookpoints',       // 爽点节奏
  'char-npc',         // NPC 角色卡
  'changelog',        // 设定变更
  'ideas',            // 灵感素材
]

/**
 * 作者侧资料：写的是「故事将如何发展」，不是「角色此刻知道什么」。
 * 酒馆模式的「角色视角」下必须排除 —— 参见 ProjectContextOptions.viewMode 的说明。
 */
const AUTHOR_SIDE_TABS = [
  'master',            // 全书总纲
  'volume-outline',    // 分卷大纲
  'chapter-outline',   // 章节细纲
  'chapter-master',    // 章节总表
  'foreshadow',        // 伏笔追踪
  'hookpoints',        // 爽点节奏
  'subplots',          // 支线剧情
  'ideas',             // 灵感素材
  'style',             // 写作规范（作者规范，非角色认知）
  'changelog',         // 设定变更（作者侧台账）
]





/**
 * 「保密等级」= 信息档位（定义见 schema 的字段说明）：在此决定**条目**进上下文预算的先后。
 * 数值越小越先塞：S 必带 → A 优先 → B 常规 → C 最先丢，**D 永不进**（见 isPrunedForAI）。
 *
 * 🔴 它同时是「可见性」的依据（角色视角排除 S 级），但那一步在渲染层做，不在这里 ——
 *   本文件里它只管顺序与 D 档剔除；角色视角的 S 级剔除落在**渲染层**（`RenderOpts.hideSecretRows`
 *   → `isSecretRow`，见 sectionOf / renderCards / renderTable / renderActiveSubSets），
 *   两件事分开放，免得日后改一处忘另一处。
 * 🔴 未填 / 未知值一律按中性（= B 档）。**绝不能当 C** —— 否则历史数据会因为当年没标等级
 *   而被排到最后优先丢弃，等于用一个新功能把老项目的数据静默降级。
 */
// 保密等级的三件事（可见性 / 预算顺序 / D 级剔除）已抽到 `ai/secrecy.ts` ——
// aiContext 贴着 1200 行结构闸。下面 re-export 保持既有 import 路径可用。
export { isPrunedForAI, isSecretRow } from '@/lib/ai/secrecy'

// 单元格字符上限（含 LONG_FIELDS 名单）已抽到 `ai/fieldCap.ts` —— aiContext 贴着 1200 行结构闸。

/**
 * 纯系统调度元数据：**不往提示词里写**。
 *
 * 「保密等级」的使命是"排预算顺序 + 决定可见性"，这两件事在装配层就完成了；
 * 渲染成裸字母（S/A/B/C）喂给模型毫无意义 —— 模型无法解释它，还会被诱导去追问，
 * 纯噪音且白占 token（长篇下这一列的累积量不小）。
 * 它仍然完整参与排序（见 rankOf）与将来的行过滤，只是不出现在提示词里。
 */
export { SYSTEM_META_FIELDS } from '@/lib/ai/tableRender'

/**
 * 写作节奏摘要（2.9.1）。
 *
 * 数据源＝`dailyStats`（编辑器保存章节时自动记录的**净增量**），不是《写作进度》的手工登记 ——
 * 前者是产量数字的权威口径（见写作面板的「近 7 日产量」卡），后者只记作者自己填的计划完成情况。
 *
 * 🔴 只输出**聚合统计**、绝不逐日罗列：模型需要的是「多久没写、节奏稳不稳」，
 *    逐日流水账既占预算，又容易被当成需要复述的内容。
 * 窗口 30 天：够看出断更与节奏，又不会长到失真。
 */
async function buildPaceDigest(): Promise<string> {
  const stats = await db.getDailyStats()
  if (!stats.length) return ''
  const map = new Map(stats.map(s => [s.date, s.words]))
  const WINDOW = 30
  const today = new Date()
  const keys: string[] = []
  for (let i = WINDOW - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    keys.push(todayKey(d))
  }
  const wordsOf = (k: string) => map.get(k) ?? 0
  const activeDays = keys.filter(k => wordsOf(k) > 0).length
  const total = keys.reduce((s, k) => s + wordsOf(k), 0)
  if (!activeDays && !total) return ''
  // 连续码字（从今天或昨天往前数；今天还没写则不打断）
  let streak = 0
  {
    const cur = new Date(today)
    if (wordsOf(todayKey(cur)) === 0) cur.setDate(cur.getDate() - 1)
    for (;;) {
      if (wordsOf(todayKey(cur)) > 0) { streak++; cur.setDate(cur.getDate() - 1) } else break
    }
  }
  // 窗口内最长断更 + 最近一次有产出的日子距今几天
  let longestGap = 0, run = 0
  for (const k of keys) {
    if (wordsOf(k) > 0) run = 0
    else { run++; longestGap = Math.max(longestGap, run) }
  }
  let sinceLast = -1
  for (let i = 0; i < WINDOW; i++) {
    const k = keys[WINDOW - 1 - i]
    if (wordsOf(k) > 0) { sinceLast = i; break }
  }
  return [
    `近 ${WINDOW} 日：有 ${activeDays} 天在写，合计 ${total} 字，活跃日均 ${Math.round(total / Math.max(1, activeDays))} 字`,
    `连续码字 ${streak} 天；窗口内最长断更 ${longestGap} 天`,
    sinceLast >= 0 ? `最近一次码字：${sinceLast === 0 ? '今天' : `${sinceLast} 天前`}` : `近 ${WINDOW} 日没有码字记录`,
  ].join('\n')
}

function clip(s: string, n: number): string {
  return clipText(s, n, true) // 压空白再截断 —— 见 lib/textClip.ts
}

/** 表单/卡片的存储 key 形如「模块::字段」，取字段名 */
function fieldName(key: string): string {
  const i = key.lastIndexOf('::')
  return i >= 0 ? key.slice(i + 2) : key
}

/** 按 schema 里的模块顺序渲染表单型数据，空字段跳过 */
function renderForm(tab: TabDef, data: Record<string, string>, o: RenderOpts = {}): string {
  const lines: string[] = []
  const used = new Set<string>()
  for (const mod of tab.modules ?? []) {
    for (const f of mod.fields) {
      if (SYSTEM_META_FIELDS.has(f.name)) continue
      if (o.hideAuthorFields && AUTHOR_SIDE_FIELDS.has(f.name)) continue
      const key = `${mod.name}::${f.name}`
      // T3：含义未确认的字段不进上下文（界面照常显示）
      if (o.hidePending?.has(key)) continue
      const v = data[key] ?? data[f.name] ?? ''
      used.add(key)
      // 3.2.0 · T3：模型看到作者当前的名字；存储键不变
      if (v.trim()) lines.push(`${o.labels?.[key] ?? f.name}：${clip(v, cellCap(f.name))}`)
    }
  }
  // 兼容历史遗留 key（schema 改过字段名的老项目），不丢数据
  for (const [k, v] of Object.entries(data)) {
    if (used.has(k) || !v?.trim()) continue
    // 🔴 内部字段（`__` 前缀，如「设定草稿箱」）**必须在这里挡掉**：
    //    本循环本就是「schema 里没登记过的键也照样渲染」的兜底，不挡就等于把作者
    //    标明「不发给 AI」的整段草稿塞进提示词（见 worldSets.ts 的 FREE_DRAFT_KEY）。
    if (isInternalFieldKey(k)) continue
    // T3：待确认含义的字段（含历史遗留键）同样不发送
    if (o.hidePending?.has(k)) continue
    const fn = fieldName(k)
    if (SYSTEM_META_FIELDS.has(fn)) continue
    if (o.hideAuthorFields && AUTHOR_SIDE_FIELDS.has(fn)) continue
    lines.push(`${o.labels?.[k] ?? fn}：${clip(v, cellCap(fn))}`)
  }
  return lines.join('\n')
}

/**
 * 子世界段（C10 · 2.4.2）：**只有活跃的子项才进上下文**。
 *
 * 返回 `null` 表示「这张表还没建过任何子项」⇒ 调用方按老样子只渲染母级，
 * 于是**单世界用户的上下文与改动前一字不差**（这是本次最要紧的回归保护）。
 *
 * 🔴 末尾必须写「另有 N 个已完结的子世界，未发送」—— 与 `BY_BUDGET`（按预算裁剪并注明被略过）
 *    同一个诚实口径。不写的话，作者会以为 AI 读过全部子世界，进而误判模型"怎么没记住那个副本"。
 * 🔴 子项正文复用 `renderForm`：字段键格式与母级完全相同（都是 `模块名::字段名`），
 *    所以口径天然一致，不会出现「母级按模块顺序、子级按字典序」这种偏差。
 */
async function renderActiveSubSets(tab: TabDef, o: RenderOpts = {}): Promise<string | null> {
  try {
    const subs = await db.getSubSets(tab.id)
    if (subs.length === 0) return null
    const { active, closed } = splitActive(subs, await db.getActiveSubIds(tab.id))
    // 角色视角：标了 S 的条目整段剔除；D 级任何视角都不带（与 renderCards / renderTable 同口径）
    // 🔴 2026-10-02 六维审计 P1：这里原来只判 S 不判 D —— 同一份过滤逻辑复制四遍时漏了一处。
    const shown = active.filter(s => !isPrunedForAI(s.data) && !(o.hideSecretRows && isSecretRow(s.data)))
    // 🔴 2026-10-02 六维审计 P1：`total` 必须用**过滤后**的真实集合。
    //    原来传过滤前的 active.length + closed.length，而 compose 内部按 `total - shown.length`
    //    算「已完结」⇒ 被 S 拦掉的活跃条目被文案的「已完结」指认。
    //    那句「另有 N 个已完结」是作者判断「AI 到底读了什么」的唯一依据，撒谎等于误导。
    return composeSubSetsBlock(
      shown.map(s => ({ name: s.name, body: renderForm(tab, s.data ?? {}, o) })),
      shown.length + closed.length,
    )
  } catch {
    // 单段读取失败就当这张表没建过子项（与 sectionOf 同口径：拿不到就少带一段，绝不报错）
    return null
  }
}

/**
 * 并列条目段（2.7.2 · 政治 / 经济 / 信仰 / 司法）：**只有活跃的条目才进上下文**。
 *
 * 与 `renderActiveSubSets` 的差别是**没有母级那一层** —— 这四个页签在 2.7.2 起改成并列结构，
 * 资料全部来自 `<tabId>-sub` 那批条目，标题也从「子世界」换成条目总称（政权 / 行业 / 教团…）。
 *
 * 返回 `''`（空串）表示「一个条目都没建」⇒ 调用方整段不带，
 * 于是**没建条目的用户上下文与改动前一字不差**（与母子版同一条回归保护）。
 */
async function renderActiveParallelSets(tab: TabDef, o: RenderOpts = {}): Promise<string | null> {
  try {
    const subs = await db.getSubSets(tab.id)
    if (subs.length === 0) return null
    const { active, closed } = splitActive(subs, await db.getActiveSubIds(tab.id))
    const label = subItemLabel(tab.id, getActivePack())
    // 角色视角：标了 S 的条目整段剔除；D 级任何视角都不带（与 renderCards/renderTable 同口径）
    const shown = active.filter(s => !isPrunedForAI(s.data) && !(o.hideSecretRows && isSecretRow(s.data)))
    // 🔴 total 用过滤后口径：否则被 S 拦掉的活跃条目会被「已完结」文案指认（与母子版同因，见 B7）
    return composeParallelSetBlock(
      shown.map(s => ({ name: s.name, body: renderForm(tab, s.data ?? {}, o) })),
      shown.length + closed.length,
      label,
    )
  } catch {
    // 单段读取失败就当这张表没建过条目（同口径：拿不到就少带一段，绝不报错）
    return null
  }
}

/** 卡片型（角色卡 / 分卷大纲 / 章节细纲）：每条一段 */
function renderCards(tab: TabDef, recs: { name: string; data: Record<string, string> }[], o: RenderOpts = {}): string {
  const cap = ROW_CAP[tab.id] ?? DEFAULT_ROW_CAP
  // 🔴 D 级（终结 / 弃用）先剔除：它不进正文，也不该出现在「另有 N 条未列出」的计数里
  // 🔴 D 级（任何视角）与 S 级（仅角色视角）都先剔除：都不进正文，也不该出现在「另有 N 条未列出」的计数里
  const usable = recs.filter(r => !isPrunedForAI(r.data) && !(o.hideSecretRows && isSecretRow(r.data)))
  const out: string[] = []
  // 2.2.0：先按「保密等级」排预算优先级、再截断（同等级保持录入序）。
  // 原来是纯录入序 slice —— 长篇后段会"琐碎的先占位、重要的进不来"。
  for (const r of sortBySecrecy(usable).slice(0, cap)) {
    const body = renderForm(tab, r.data, o)
    out.push(`〖${r.name || '未命名'}〗${body ? '\n' + body : ''}`)
  }
  if (usable.length > cap) out.push(`（另有 ${usable.length - cap} 条未列出）`)
  return out.join('\n')
}



/**
 * 把叙事序列表截到锚点章为止（含锚点本身）。
 * ⚠️ 锚点找不到时**不裁剪** —— 宁可多带，也不要把上下文清空（锚点章被删属异常情况）。
 */
function cutListAtAnchor<T extends { id: string }>(list: T[], anchorId?: string): T[] {
  if (!anchorId) return list
  const i = list.findIndex(c => c.id === anchorId)
  if (i < 0) return list
  return list.slice(0, i + 1)
}

/** 锚点及其之前全部章节的 id 集合（用于过滤「相关章节召回」）。返回 null = 无法判定，调用方跳过过滤。 */
async function idsUpToAnchor(anchorId: string): Promise<Set<string> | null> {
  try {
    const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    // 🔴 走唯一真源（含孤儿章垫底）：原先这里手写 `[...flattenChapters(), ...orphans]`
    const flat = flattenAll(vols, chs)
    const i = flat.findIndex(c => c.id === anchorId)
    if (i < 0) return null
    return new Set(flat.slice(0, i + 1).map(c => c.id))
  } catch {
    return null
  }
}

/** 单个页签的资料段（空数据返回空串） */
async function sectionOf(tab: TabDef, knowerName?: string, o: RenderOpts = {}): Promise<string> {
  try {
    // 3.2.0 · T3：模型看到作者当前的字段名（采用模板 / 别名）；读不到就退回 schema 原名。
    // 🔴 同时取出「含义未确认」的字段：整段不发送（方案 §3.12.3.3），但界面照常显示。
    const { labels, pending } = await loadFieldGating(tab)
    const ro: RenderOpts = {
      ...o,
      ...(Object.keys(labels).length ? { labels: { ...o.labels, ...labels } } : {}),
      ...(pending.size ? { hidePending: pending } : {}),
    }
    if (tab.type === 'form') {
      // 🔴 2.7.2 并列结构页签（政治 / 经济 / 信仰 / 司法）：**没有母级 formData**，
      //    资料全在 `<tabId>-sub` 那批条目里 ⇒ 直接渲染活跃条目段，**不读也不带「全书统一」层**。
      //    （旧实现会读一份根本不存在的 formData、把空的「〖全书统一〗」喂给 AI。）
      if (isParallelSetTab(tab.id)) {
        return (await renderActiveParallelSets(tab, ro)) ?? ''
      }
      const formData = await db.getFormData(tab.id)
      // 角色视角：整条记录标了 S（绝密 / 剧透）⇒ 整段不带（含它的子世界）
      // 🔴 2026-10-02 六维审计 P1：母级整段原来只判 S、不判 D。
      //    `isPrunedForAI`（D＝终结，任何视角都不进 AI）的契约是「凡是把项目数据交给模型的入口都要过」，
      //    而 renderCards / renderTable 都接了、这里与两个子集渲染器没接 —— 同一份逻辑复制四遍时漏改。
      if (isPrunedForAI(formData)) return ''
      if (ro.hideSecretRows && isSecretRow(formData)) return ''
      const main = renderForm(tab, formData, ro)
      // 母子结构表（世界设定 / 力量体系）：建过子项才引入母／子两层标题。
      // 🔴 没建过子项 ⇒ 原样返回（单世界用户的上下文与改动前**一字不差**）。
      if (!isWorldSetTab(tab.id)) return main
      const sub = await renderActiveSubSets(tab, ro)
      if (sub === null) return main
      return [`〖全书统一〗${main ? '\n' + main : '\n（尚未填写）'}`, sub].join('\n\n')
    }
    if (tab.type === 'card') return renderCards(tab, await db.getCardRecords(tab.id), ro)
    if (tab.type === 'table') {
      const rows = await db.getTableRows(tab.id)
      // 3.1.3：图鉴页签的字段清单（见 ai/atlasContext 的口径）
      const atlasFields = isAtlasTab(tab.id) ? await loadAtlasFieldsForAI(tab) : null
      // 酒馆模式：知情权限只带「该角色是知情者」的条目（方案 §6.5 事实边界的自动推断）
      if (tab.id === 'secrets' && knowerName) {
        // 🔴 2026-10-02 六维审计 P1：`knowerName` 是把多个 AI 角色用「、」拼成的**整串**，
        //    一次 `includes(整串)` 是「整串包含」而非 engine.ts 注释承诺的「任一命中」——
        //    只要 ≥2 个 AI 角色（buildMultiCharRule 明确支持），知情者列就几乎全不匹配
        //    ⇒ 整张「谁不知道什么」的事实边界被静默丢弃。改成按分隔符拆开后 some()。
        const names = knowerName.split(/[、,，;；\s]+/).map(s => s.trim()).filter(Boolean)
        const mine = names.length
          ? rows.filter(r => names.some(n => String(r.data?.['知情者'] ?? '').includes(n)))
          : rows
        return renderTable(tab, mine, ro, atlasFields)
      }
      return renderTable(tab, rows, ro, atlasFields)
    }
  } catch {
    // 单段读取失败就当这段没有，不影响其他资料
  }
  return ''
}

/** 章节清单：卷 → 章（标题 / 字数 / 摘要），不含正文 */
export async function buildChapterDigest(maxChapters = 200, anchorChapterId?: string): Promise<string> {
  let vols: Volume[] = []
  let chs: Chapter[] = []
  try {
    ;[vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  } catch {
    return ''
  }
  if (chs.length === 0) return ''
  const lines: string[] = []
  // 必须按 (卷序, 章序) 展平：order 是卷内序号，直接全局按 order 排会把各卷同序号的章
  // 交错在一起，超过 maxChapters 截断时砍掉的子集也是错的（与 getChapterTexts 同源问题）。
  // 孤儿章（volumeId 指向不存在的卷）追加在叙事序末尾参与截断，否则会被 maxChapters 静默吞掉。
  // 🔴 全书叙事序（含孤儿章垫底）：走唯一真源，与导出 / 编辑器伴写 / 酒馆锚点同口径
  const sorted = flattenAll(vols, chs)
  // 酒馆模式：锚点裁剪 —— 只列到锚点章为止（之后再发生的事，此刻的角色不可能知道）
  const cut = cutListAtAnchor(sorted, anchorChapterId)
  const listed = cut.slice(0, maxChapters)
  const byVol = new Map<string, Chapter[]>()
  for (const c of listed) {
    const arr = byVol.get(c.volumeId) ?? []
    arr.push(c)
    byVol.set(c.volumeId, arr)
  }
  const volOrder = [...vols].sort((a, b) => a.order - b.order)
  const emit = (title: string, items: Chapter[]) => {
    if (items.length === 0) return
    lines.push(title)
    for (const c of items) {
      const sum = c.summary?.trim() ? ` — ${clip(c.summary, 120)}` : ''
      lines.push(`  ${c.title || '未命名章节'}（${c.wordCount || 0}字·${c.status}）${sum}`)
    }
  }
  for (const v of volOrder) emit(`◆ ${v.title || '未命名卷'}`, byVol.get(v.id) ?? [])
  // 孤儿章判定走唯一真源（口径与 flattenAll 同源）
  emit('◆ 未分卷', orphanChapters(vols, listed))
  if (cut.length > listed.length) lines.push(`（另有 ${cut.length - listed.length} 章未列出）`)
  return lines.join('\n')
}

/**
 * 已建档的角色姓名清单。
 * 用途：告诉模型「人物列只能填这些名字」，避免整理出「黑衣男子」「那个少年」这类无主人物。
 */
export async function loadCharacterNames(ctx: VisCtx = { type: 'full', features: [] }): Promise<string[]> {
  const npcDef = TABS.find(t => t.id === 'char-npc')
  // NPC 页签「可见」才纳入：此处不可写成 !tabVisible —— 那会让完整项目反而丢掉全部 NPC 姓名
  const showNpc = npcDef ? tabVisible(npcDef.id, ctx) : false
  const ids = ['char-main', 'char-secondary', ...(showNpc ? ['char-npc'] : [])]
  const out = new Set<string>()
  for (const id of ids) {
    try {
      for (const r of await db.getCardRecords(id)) {
        // 🔴 D 级（终结 / 弃用）不进名单：这份名单是喂给 AI 的候选值 / 判重依据，
        //    带上它就等于告诉模型"这个已弃用的人物还在用"（连带别称也一并跳过）。
        if (isPrunedForAI(r.data)) continue
        if (r.name?.trim()) out.add(r.name.trim())
        // v1.6：别称一并纳入——模型识别正文/关系里的别称，且不会把它当成无主人物
        for (const a of readAliases(id, r.data)) out.add(a)
      }
    } catch { /* 单个页签读失败就跳过 */ }
  }
  return [...out]
}

/** 取指定章节的完整正文（AI 整理 / 校对用），带总字符上限 */
export async function getChapterTexts(ids: string[], charCap = 20000): Promise<string> {
  if (ids.length === 0) return ''
  let chs: Chapter[] = []
  let vols: Volume[] = []
  try {
    ;[chs, vols] = await Promise.all([db.getAllChapters(), db.getAllVolumes()])
  } catch {
    return ''
  }
  // 必须按 (卷序, 章序) 排：order 是卷内序号，卷二第 1 章的 order 同样是 0，
  // 只按 order 排会让跨卷勾选的正文顺序错乱（1.9.2 修复）。
  const pick = sortChapters(
    vols,
    ids.map(id => chs.find(c => c.id === id)).filter((c): c is Chapter => !!c),
  )
  const out: string[] = []
  // 正文头带全局派生章号：模型引用「第N章」时与台账/时间线口径一致；
  // 「不计入序号」的章（seq=0）只给标题，避免模型臆造编号。
  const seqs = chapterSeqMap(vols, chs)
  let used = 0
  for (const c of pick) {
    const seq = seqs.get(c.id) ?? 0
    const head = `〖${seq > 0 ? `第${seq}章 · ` : ''}${c.title || '未命名章节'}〗\n`
    const room = charCap - used - head.length
    if (room <= 200) {
      out.push(`（其余章节因长度限制未带入）`)
      break
    }
    const body = c.content.length > room ? c.content.slice(0, room) + '…（本章后续因长度限制截断）' : c.content
    out.push(head + body)
    used += head.length + body.length
  }
  return out.join('\n\n')
}

/** 取最近 n 章有正文的章节（按真实叙事序），供「AI 深度审计」等全书级检查喂正文 */
export async function getRecentChapterTexts(n = 6, charCap = 16000): Promise<string> {
  try {
    const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    const ids = flattenChapters(vols, chs).filter(c => c.content.trim()).slice(-n).map(c => c.id)
    return getChapterTexts(ids, charCap)
  } catch {
    return ''
  }
}

/** 续写章节素材（2.9.2 · ③）—— 三块各自独立，见 `ContinuationPickOpts` */
interface ContinuationSources {
  /** 焦点章是否找到（false ⇒ 其余字段全空，调用方须据此提示作者） */
  found: boolean
  /** 本章及前若干章的摘要（已拼成文本；空串表示没取到） */
  summaries: string
  /** 摘要区间里有章但未填摘要的数量（「不静默丢」） */
  missingSummaries: number
  /** 当前章之前若干章的正文（已拼成文本；每章取末尾，兼作衔接参照） */
  prevTexts: string
  /** 勾了但未带入的章数（空章 / 超字符上限） */
  droppedPrevTexts: number
}

const EMPTY_CONTINUATION_SOURCES: ContinuationSources = {
  found: false, summaries: '', missingSummaries: 0, prevTexts: '', droppedPrevTexts: 0,
}

/**
 * 颉文姬 · 「续写」的章节素材。
 *
 * 三块（各自独立开关，选项见 `continuationPick.ts`）：
 *   · summaries —— 本章及前若干章的「章节压缩摘要」
 *   · prevTexts —— 当前章之前若干章的正文（最吃预算；**每章取末尾**，兼作衔接参照 ——
 *     2026-10-09 起「上一章结尾」并入了这一项）
 *
 * 🔴 焦点章必须在叙事序里找得到，否则 `found: false` —— 调用方要据此提示作者，
 *    而不是当「没有素材」硬发（那会让模型凭空编）。
 * 🔴 与 `findRelatedChapters` 同口径：孤儿章（volumeId 指向不存在的卷）也并入叙事序，
 *    否则焦点章本身是孤儿时永远挑不到素材。
 */
export async function getContinuationSources(
  focusChapterId: string,
  opts: ContinuationPickOpts = {},
): Promise<ContinuationSources> {
  try {
    const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    const flat = flattenAll(vols, chs)
    const pick = pickContinuationSources(
      flat.map(c => ({ id: c.id, title: c.title, summary: c.summary ?? '', content: c.content ?? '' })),
      focusChapterId,
      opts,
    )
    if (!pick.found) return { ...EMPTY_CONTINUATION_SOURCES }
    return {
      found: true,
      summaries: pick.summaries.map(s => `◆ ${s.title}：${s.summary}`).join('\n'),
      missingSummaries: pick.missingSummaries,
      prevTexts: pick.prevTexts.map(t => `〖${t.title}〗\n${t.content}`).join('\n\n'),
      droppedPrevTexts: pick.droppedPrevTexts,
    }
  } catch {
    return { ...EMPTY_CONTINUATION_SOURCES }
  }
}

/**
 * #015 相关章节召回：找出与指定章节最相关的若干章（按真实叙事序返回）。
 *
 * 为什么需要：AI 上下文有长度预算，长篇时章节清单往往只能塞进开头一部分，
 * 于是写到第 300 章时，模型看到的「前文」还是第 1～20 章 —— 诊断自然失准。
 * 与其平铺截断，不如优先带与「当前这章」真正相关的章节。
 *
 * 打分规则：
 *   · 人物共现 ×2 —— 取自章节台账的「出场人物」字段（数据驱动，比解析章节标题可靠）
 *   · 叙事邻接加成 —— 紧邻的前后章 +2，隔一章 +1（连续性校验最吃这一档）
 * 台账未登记时退化为「正文中出现过的角色名」共现，仍好过纯截断。
 */
async function findRelatedChapters(focusChapterId: string, limit = 8): Promise<Chapter[]> {
  let vols: Volume[] = []
  let chs: Chapter[] = []
  try {
    ;[vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  } catch {
    return []
  }
  // 🔴 孤儿章（volumeId 指向不存在的卷）必须并入叙事序，与 `buildChapterDigest` / `idsUpToAnchor`
  //    口径一致：否则焦点章本身是孤儿时 `findIndex` 找不到、召回整体失效；
  //    其他孤儿章也会被排除在候选之外（明明写过的章却永远不进"相关章节"）。
  //    ⇒ 直接调唯一真源 `flattenAll`（2026-10-17 收敛，原为手写拼接）
  const flat = flattenAll(vols, chs)
  const idx = flat.findIndex(c => c.id === focusChapterId)
  if (idx < 0 || flat.length <= 1) return []

  // 台账只读一次：既取焦点章的实体，也建好各章实体表
  let rows: { id: string; data?: Record<string, string> }[] = []
  try {
    rows = (await db.getAllChapterLedgerRows()) as unknown as { id: string; data?: Record<string, string> }[]
  } catch {
    rows = []
  }
  const entityOf = new Map<string, Set<string>>()
  for (const r of rows) entityOf.set(String(r.id), new Set(splitNames(r?.data?.['出场人物'])))

  let focusEntities = entityOf.get(`ch-${focusChapterId}`) ?? new Set<string>()
  // 台账没登记 → 退化为焦点章正文里出现过的角色名
  if (focusEntities.size === 0) {
    try {
      const names = await loadCharacterNames()
      const text = `${flat[idx].title} ${flat[idx].summary ?? ''} ${flat[idx].content ?? ''}`
      for (const n of names) if (n.length >= 2 && text.includes(n)) focusEntities.add(n)
    } catch {
      /* 拿不到角色名就只按邻接排序 */
    }
  }

  const scored = flat
    .map((c, i) => {
      if (c.id === focusChapterId) return { c, i, score: -1 }
      let score = 0
      if (focusEntities.size > 0) {
        const ents = entityOf.get(`ch-${c.id}`)
        if (ents && ents.size > 0) {
          let hit = 0
          for (const e of focusEntities) if (ents.has(e)) hit++
          score += hit * 2
        } else {
          // 台账缺登记时按正文共现补分
          const text = `${c.title} ${c.summary ?? ''} ${c.content ?? ''}`
          let hit = 0
          for (const e of focusEntities) if (text.includes(e)) hit++
          score += hit
        }
      }
      const d = Math.abs(i - idx)
      if (d === 1) score += 2
      else if (d === 2) score += 1
      return { c, i, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)

  return scored.slice(0, limit).map(x => x.c)
}

/**
 * 打包当前项目的全部设定资料。
 * 按 PRIORITY 顺序累加，超预算的段落被丢弃并记录在 dropped 里（UI 可提示作者）。
 */
/**
 * 最近一次装配结果（模块级）。
 * 🔴 用途：§10.3 #2「上下文查看」—— 让运行账本记下「本次任务实际带了什么」。
 *    长任务在本项目里是**串行互斥**的（见 creativeSession「与创作互斥」），故「最近一次」
 *    即「本次任务那次」；调用方仍应按 `at` 与任务起始时刻比对，避免张冠李戴。
 */
let lastAssembly: AiContextSnapshot | null = null

/** 读最近一次装配结果（供账本记录；调用方自行按 `at` 判归属） */
export function lastContextAssembly(): AiContextSnapshot | null {
  return lastAssembly
}



/**
 * 默认上下文预算：**按当前模型的上下文窗口算**（3.1.3）。
 *
 * `窗口 × 0.5`（1 token ≈ 1 中文字符，一半给资料、一半给提示词与回复）。
 * 读不到模型配置（没配 / 单测环境 / 读失败）⇒ 回落项目规模档。
 *
 * 🔴 用**动态 import**：`aiCore/session` 是配置层，`aiContext` 是装配层，
 *    静态互相引用会把「读配置」拖进每次纯装配的调用链，也让单测更容易炸。
 */
async function resolveContextBudget(fallback: number): Promise<number> {
  try {
    const [{ getActiveProvider }, { effectiveWindowOf }] = await Promise.all([
      import('@/lib/aiCore/session'),
      import('@/lib/ai/modelCapacity'),
    ])
    const p = await getActiveProvider()
    if (!p) return fallback
    return budgetFromWindow(effectiveWindowOf(p))
  } catch {
    return fallback
  }
}

export async function buildProjectContext(opts: ProjectContextOptions = {}): Promise<ProjectContextResult> {
  // 3.0 · W1-2 规模门（§10.3 #2）：预算与召回数**按项目体量**取档，不再写死 12000 ——
  //    长篇（百万字）时那点预算只够塞开头几章，模型看到的「前文」永远是第 1 章。
  // 🔴 小项目（< 10 万字）档位与改造前**逐字一致**（budget 12000 / related 8）—— 中短篇手感零变化。
  let scaleWords = 0
  try { scaleWords = (await db.getProjectStats(db.getCurrentProjectId())).words } catch { /* 拿不到按最小档 */ }
  const plan = planFor(scaleWords)
  const budget = opts.budget ?? await resolveContextBudget(plan.budget)
  // skeletonOnly：页签一个都不带（下面 for 循环里的 only 命中判定于是全部不通过），
  // 而「作品概览」在循环之前无条件 push、「章节清单」由 includeChapterList 单独控制 → 两块都留着。
  const only = opts.skeletonOnly
    ? new Set<string>()
    : (opts.onlyTabIds ? new Set(opts.onlyTabIds) : null)
  const exclude = new Set(opts.excludeTabIds ?? [])
  // 酒馆模式 · 角色视角：排除作者侧资料（带进去 = 剧透，详见 viewMode 说明）
  if (opts.viewMode === 'character-view') {
    for (const id of AUTHOR_SIDE_TABS) exclude.add(id)
  }
  // 锚点白名单（null = 不裁剪）
  const anchorAllow = opts.anchorChapterId ? await idsUpToAnchor(opts.anchorChapterId) : null

  /**
   * 章节清单要**先算再装配** —— 预留额度按它的真实长度定（见下方 reserve）。
   *
   * 3.1.3 · R3（主人 2026-10-18 拍板 A+B）：short 档预算 12000 → 16000，
   * 同时给清单独占一块预留。两件事必须一起做：
   *   · 只抬预算不预留 ⇒ 贪心装载照样把空间吃光，清单位次太靠后，实测 32000 时仍进不来；
   *   · 只预留不抬预算 ⇒ 得从设定段里硬扣，人物关系被裁、丢弃反而变多（实测净损）。
   */
  const chapterDigest = opts.includeChapterList === false
    ? ''
    : await buildChapterDigest(plan.digestChapters, opts.anchorChapterId).catch(() => '')

  /**
   * 预留 = 清单实际长度（上限 `CHAPTER_RESERVE_CHARS`）。
   * 🔴 别改成固定比例：清单只有 800 字时留 3600 会白白浪费，把「写作规范 / 势力关系」
   *    这类小段挤出去（这正是"修一个问题造一个问题"）。清单为空时预留为 0。
   */
  const reserve = chapterDigest ? Math.min(chapterDigest.length + 40, CHAPTER_RESERVE_CHARS) : 0

  /**
   * 装配器：负责「放不放得下 / 放不下怎么裁 / 如何如实申报」。
   * 实现与实测数据见 `lib/ai/contextAssembler.ts` 与 `lib/ai/segBudget.ts`。
   */
  const asm = createContextAssembler(budget, { inlineDropNote: opts.inlineDropNote, reserve })
  const push = asm.push

  // 🆕 3.0.3 · 项目级查询文本（书名 + 简介）—— 供**没有焦点章**的调用点
  //   （AI 助手 / 灵感创作 / AI 伴写…）做〖参考资料〗召回的降级 query。
  //   参考资料是作者**全项目共用**的素材，不该因为某个功能没有"当前写到哪"就一段都读不到。
  let projectLevelQuery = ''

  // 🆕 3.0.3 · 本次附加文件（AI 弹窗「附加文件」的一次性资料，不落库、不进索引）。
  // 🔴 放在**整条序列的最前面**（还在「作品概览」之前）：它是作者**显式**递进来的东西，
  //    优先级应当高于一切自动装配的资料。实测踩过：若放在各类"召回"之后，只要有设定段
  //    先占满预算，附件就会把后者**挤出**预算闸（`push` 超限即丢）——而显式给的东西
  //    被静默丢掉，比参考资料没进来严重得多。
  //    机制与生命周期纪律见 `lib/ai/tempDocs.ts`（独立模块：aiContext 已贴着 1200 行结构闸）。
  if (getTempDocs().length > 0 && !opts.skeletonOnly) {
    // 作者显式递进来的东西整块进，不参与单段裁剪
    push('本次附加文件', renderTempDocs(getTempDocs()), { whole: true })
  }

  // 头部：项目基本信息 + 体量统计（几乎不占预算，但对模型判断"写到哪了"很关键）
  try {
    const pid = db.getCurrentProjectId()
    const proj = await db.getProject(pid)
    if (proj) {
      const st = await db.getProjectStats(pid).catch(() => ({ chapters: 0, words: 0, volumes: 0 }))
      const head = [
        `书名：${proj.name}`,
        // 类型＝题材包（2.7.1）：值就是四字包名 ⇒ 直接可读，无需额外映射。
        // 老数据里的自由文本（'东方玄幻' 等）经别名表归位；为空则整行不输出（与改造前一致）。
        //
        // 🔴🔴 3.0（社区反馈）：这一行**默认不再注入** —— 题材最初的定位是
        //    「只管开书定位组各页签的字段名与示例」，不该顺带影响 AI 生成的内容；
        //    但它一直无条件出现在提示词里（模型看到「类型：都市异能」会照题材套路发挥）。
        //    现改由项目级开关控制（**默认关**）：想让 AI 知道题材的作者在
        //    「编辑项目」里打开它，或填《作品信息》页的「类型赛道」字段（那一路照旧发出）。
        //    见 `lib/ai/aiGenreHint.ts`。
        await genreLineForAI(proj.genre),
        proj.intro ? `简介：${clip(proj.intro, 200)}` : '',
        `体量：${st.volumes} 卷 / ${st.chapters} 章 / ${st.words} 字`,
      ]
        .filter(Boolean)
        .join('\n')
      push('作品概览', head)
      // 🆕 3.0.3 · 给〖参考资料〗当降级 query（没有焦点章时用）。
      //   🔴 必须带上项目级 hint：只靠「书名 + 简介」命中率很低 —— 关键词降级按字面打分，
      //      示范项目书名是玄幻爽文、资料讲「艾尔达/符文术」，一个 token 都匹配不上。
      //      hint 会再拼五个核心设定页的前若干行，那才是「这个项目在写什么」的字面代理。
      //      实现见 lib/ai/projectLevelHint.ts（含这次实测教训的完整说明）。
      projectLevelQuery = [
        proj.name,
        proj.intro ? clip(proj.intro, 200) : '',
      ]
        .filter(Boolean)
        .join('\n')
        .concat('\n', await buildProjectLevelHint())
    }
  } catch {
    // 拿不到项目信息也照常往下走
  }

  // 写作节奏摘要（2.9.1）：把写作的体量压成几行**统计值**注入。
  // 🔴 为什么要有它：《写作进度》此前被完全排除在 AI 之外（下方兜底循环里的 `t.id === 'progress'`），
  //    于是「创作健康诊断」拿不到真实更新节奏，只能凭设定与章数猜有没有断更。
  //    ⚠️ 写入侧仍然不接 AI（那张表本就是纯统计流水，AI 无从代笔）—— 这里只做**只读**注入。
  try {
    const digest = await buildPaceDigest()
    if (digest) push('写作节奏', digest)
  } catch {
    // 拿不到就少带一段，绝不阻断（与上面作品概览同一条纪律）
  }

  const byId = new Map(TABS.map(t => [t.id, t]))
  const ordered = PRIORITY.filter(id => byId.has(id))
  // 兜底：schema 里新增但没写进 PRIORITY 的页签，追加在末尾（除 progress）
  for (const t of TABS) {
    if (t.type !== 'form' && t.type !== 'card' && t.type !== 'table') continue
    if (t.id === 'progress' || ordered.includes(t.id)) continue
    ordered.push(t.id)
  }

  // 角色视角下再过滤一层「作者侧字段」（段落级排除管不到表内的未来向列，见 AUTHOR_SIDE_FIELDS 说明）
  /**
   * 单表上限跟预算走（三档都要兜住，别用固定值）：
   *   · 小预算（伴写 1300，segCap 2000）—— 至少给 1600，否则一张表就吃光额度；
   *   · short 档 16000 —— 约 1920（≈ 表头 + 10 条摘要），八张表约 1.5 万刚好装得下；
   *   · 大预算（epic 48000 / 测试用的 20 万）—— 按 12% 放大，别把本来就宽裕的场景压瘦。
   * 上限再夹一道 segCap（单段上限），保证不会单表突破装配层预算。
   */
  const tableMaxChars = opts.tableMaxChars
    ?? Math.min(segCapOf(budget), Math.max(DEFAULT_TABLE_MAX_CHARS, Math.floor(budget * 0.12)))
  const renderOpts: RenderOpts = {
    hideAuthorFields: opts.viewMode === 'character-view',
    // S 级（绝密 / 剧透）在角色视角下整行剔除 —— 见 RenderOpts.hideSecretRows 的说明
    hideSecretRows: opts.viewMode === 'character-view',
    tableMaxChars,
  }

  /**
   * 单遍装载（3.1.3 定稿）。
   *
   * 🔴 曾经做过「两遍：先给落选段铺 400 字符保底，再补满前面的段」——
   *    实测在真正紧张的预算下它会把每张表切成 2 行（物品资源 26 条只剩 2 条），
   *    也就是主人明确反对的「为了兼容小窗口而牺牲内容」。
   *    预算现在按模型窗口算（`budgetFromWindow`），宽裕时本来都装得下；
   *    真装不下时，**完整少数几段**比**每段都半截**对生成质量更有益。
   *    真正需要"防某一张表吃光预算"的地方，交给 `ai/tableDigest.ts` 的单表上限。
   */
  for (const id of ordered) {
    if (only && !only.has(id)) continue
    if (exclude.has(id)) continue
    const tab = byId.get(id)!
    // 章节总表按卷建表后，行分散在 chapter-vol-* 各表，需合并所有卷台账再渲染
    const body = id === 'chapter-master'
      ? renderTable(tab, await db.getAllChapterLedgerRows(), renderOpts)
      : await sectionOf(tab, opts.knowerName, renderOpts)
    push(tab.name, body)
  }

  // #015：若指定焦点章节，优先召回与之相关的章节（人物共现 + 叙事邻接），
  // 取代"从头截断"——长篇时模型看到的"前文"不再只有开头几章，诊断更准。
  // 该段在「章节清单」之前注入，预算紧张时优先于通用清单占位。
  if (opts.focusChapterId && !opts.skeletonOnly) {
    try {
      const found = await findRelatedChapters(opts.focusChapterId, opts.relatedChapterLimit ?? plan.relatedChapters)
      // 锚点生效时，锚点之后的章节不进召回（否则等于把「未来」喂给此刻的角色）
      const related = anchorAllow ? found.filter(c => anchorAllow.has(c.id)) : found
      if (related.length > 0) {
        const relLines: string[] = [
          `（与当前章节关联度最高的 ${related.length} 章，含人物共现与叙事邻接，供判断前后文一致性）`,
        ]
        for (const c of related) {
          const sum = c.summary?.trim() ? ` — ${clip(c.summary, 120)}` : ''
          const snippet = c.content?.trim() ? '\n' + clip(c.content, 500) : ''
          relLines.push(`◆ ${c.title || '未命名章节'}（${c.wordCount || 0}字·${c.status}）${sum}${snippet}`)
        }
        push('相关章节召回', relLines.join('\n'))
      }
    } catch {
      /* 召回失败不阻断主流程，少带一段即可 */
    }
  }

  // #013 语义召回：把「当前章写到什么」用嵌入向量去全书捞意思相近的片段。
  // 定位是**补一层**，不是替换 —— 上面的结构化选材与关键词召回仍是主干。
  // 🔴 只在有焦点章时生效；`buildSemanticRecallBlock` 自身永不抛，且未配嵌入模型时零开销早退
  //    （它先问 `aiEmbedding` 有没有配，没配就直接返回空串，连库都不读）。
  // 🔴 角色视角下 S 级来源被剔除（`hideSecretRows`）；D 级在索引阶段就根本不存在了。
  if (opts.semantic !== false && opts.focusChapterId && !opts.skeletonOnly) {
    const semanticBlock = await buildSemanticRecallBlock({
      projectId: db.getCurrentProjectId(),
      focusChapterId: opts.focusChapterId,
      hideSecretRows: opts.viewMode === 'character-view',
      allowChapterIds: anchorAllow,
      limit: opts.semanticLimit,
    })
    if (semanticBlock) push('语义召回', semanticBlock)
  }

  // #017 知识库：作者挂载的外部参考资料，按需召回片段注入。
  // 🔴 buildKbBlock 自身永不抛；没有启用的资料时零开销早退（只读一次元数据表，不碰向量库）。
  // 🔴 3.0.3 起**不再要求有焦点章**：没有焦点章时退用 `projectLevelQuery`（书名 + 简介）。
  //    此前"必须有焦点章"这一条，把 29 个装配点里的 16 个（AI 助手 / 灵感创作 / AI 伴写…）
  //    挡在门外 —— 作者挂了资料却一段都读不到。那不是设计意图，是漏接。
  //    ⚠️ 〖语义召回〗仍保持"要有焦点章"：它比的是**章节之间**的相似度，没有"当前写到哪"
  //    确实无从谈起（与参考资料"全项目共用素材"的定位不同，两者不可一并放宽）。
  if (opts.kb !== false && !opts.skeletonOnly) {
    const kbBlock = await buildKbBlock({
      focusChapterId: opts.focusChapterId,
      fallbackQuery: projectLevelQuery,
      limit: opts.kbLimit,
      maxChars: opts.kbMaxChars,
    })
    if (kbBlock) push('参考资料', kbBlock)
  }

  if (chapterDigest) {
    // 它是「写到哪了」的唯一来源 ⇒ 允许动用预留额度，否则永远排不到
    push('章节清单', chapterDigest, { reserved: true })
  }

  // 收尾：被丢弃 / 被裁剪的段落都在文末如实声明（否则模型会把残缺当全集）
  const built = asm.build()
  // 3.0 · W1-2c：记下本次装配（供运行账本「上下文查看」）
  lastAssembly = { at: Date.now(), sections: built.sections, dropped: built.dropped, trimmed: built.trimmed, chars: built.chars, budget }
  return { text: built.text, sections: built.sections, dropped: built.dropped, chars: built.chars }
}

/**
 * 伴写专用「相关设定切片」——**刻意极短且只取四类**。
 *
 * 为什么另开一个函数、而不复用 buildProjectContext 的默认口径：
 *   伴写是"停笔即出"的低打扰场景，端到端延迟直接决定手感（27B 实测已 3.3s）。
 *   默认口径下，2000 预算会被**章节清单（目录）**和"相关章节召回"吃掉大半 ——
 *   可伴写已经拿到了光标前正文，再给卷/章目录纯属重复，真正的设定反而挤不进来。
 * 故此处：① 关掉章节清单；② 只带这四类 ——
 *   作品信息（是不是这本书）/ 世界设定 / 主要角色（身份称谓别写错）/ 名词术语（专名别漂移）。
 *   《写作规范》由调用方单独摘取（只取 3 个字段，比整表带过来更省更准），故不在此重复。
 */
/**
 * AI 伴写（inline ghost）的设定简报。
 *
 * 🔴 预算 900 → **1300**（3.0.3）：原先 900 只够装 4 个设定页，而本轮要给伴写接上〖参考资料〗
 *    （作者挂载的素材）—— 400 字上限 + 段头在 900 里根本挤不下，会被预算闸**整段丢掉**
 *    （就是"接了线却读不到"）。多出的 400 字对伴写影响很小：它只输出 40~110 token，
 *    且上下文有 `ghostCtxCache` 缓存、并非每句话都重新装配。
 *    ⚠️ **别顺手把预算开大"多带点东西"** —— 当初从 2000 降到 900，正是因为章节目录吃光预算、
 *    真正该给的设定反而挤不进来（见 `useNovelEditorGhost.ts` 的注释）。
 *
 * 🔴 传 `focusChapterId` 是**为了让〖参考资料〗用"当前章正文"做召回 query**（比书名准得多）。
 *    但必须同时关掉两段随焦点章而来的召回，否则会把预算吃光：
 *    · `relatedChapterLimit: 0` ⇒ 〖相关章节召回〗不产出（伴写已有光标前正文，不需要它）；
 *    · `semantic: false`        ⇒ 〖语义召回〗不发请求（同理由，且它是全书片段、更贵）。
 */
export async function buildInlineBriefing(
  opts: { budget?: number; focusChapterId?: string } = {},
): Promise<string> {
  try {
    const r = await buildProjectContext({
      budget: opts.budget ?? 1300,
      onlyTabIds: ['positioning', 'worldbase', 'char-main', 'terms'],
      includeChapterList: false,
      focusChapterId: opts.focusChapterId,
      relatedChapterLimit: 0,
      semantic: false,
      // 伴写是"最轻的一档"：参考资料只取 1 条、段长限 400，别把设定挤出去
      kbLimit: 1,
      kbMaxChars: 400,
    })
    return r.text
  } catch {
    return '' // 拿不到设定就少带一段，绝不阻断伴写
  }
}
