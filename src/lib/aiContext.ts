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

import * as db from './db'
import { tabVisible, type VisCtx, TABS } from './schema'
import { readAliases } from './aliases'
import { splitNames } from './audit'
import { clipText } from './textClip'
import { sortChapters, flattenChapters, chapterSeqMap } from './chapterSeq'
import { composeSubSetsBlock, isInternalFieldKey, isWorldSetTab, splitActive } from './worldSets'
import { normalizeGenrePack } from './schemaTemplates'
import type { Chapter, TabDef, Volume } from './types'

export interface ProjectContextOptions {
  /** 总字符预算，默认 12000。本地小模型建议 6000~8000 */
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
  'positioning',      // 作品定位
  'worldbase',        // 世界设定
  'power',            // 力量体系
  // 制度页签（2026-10-02 · 2.7.1 §8.4）：紧贴世界设定/力量体系 —— 它们是「这个世界怎么运转」，
  // 与前三者同属"开书定位"层的顶层档案，比角色/势力更该先占预算。
  'politics',         // 政治架构
  'economy',          // 经济体系
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
 * 作者侧**字段**（卡片字段名 / 表格列名）：写的是「故事将如何发展」或「作者的设计意图」，
 * 不是角色此刻知道什么。
 *
 * 🔴 为什么段落级排除不够（2026-09-14 端到端测试实测）：
 *   像「次要角色」这类**表本身属于角色常识**（萧景行当然知道自己的性格、功法），
 *   但表内混着「结局归宿：卷六雨夜再战，兵解」「隐藏设定：第14章败走时…」这类**未来向**列。
 *   只排除页签的话，这些列会照原样喂给模型 —— 演员提前知道了自己的结局，
 *   「测角色真实反应」同样失效。故角色视角下需再过滤一层。
 *
 * 口径刻意保守：只列**明确指向尚未发生之事 / 作者底牌**的字段；
 * 中性字段（如「备注」「知情度」「关系现状」）一律保留，避免误伤角色常识。
 * 清单可增删 —— 新增页签若带未来向字段，请一并登记到这里。
 */
const AUTHOR_SIDE_FIELDS = new Set([
  // 角色卡：未来命运与作者规划
  '结局归宿', '死亡/退场规划', '角色弧光', '主角弧光', '高光名场面', '活跃卷与出场频率',
  // 角色卡 / 势力表：作者眼中的「作用」，不是角色认知
  '剧情功能', '剧情作用', '戏剧功能', '功能定位', '本章功能',
  // 人物关系表：关系的**走向**
  '演变轨迹（按卷）', '演变触发事件', '关系终点',
  // 角色卡：作者底牌
  '隐藏设定', '世界终极真相', '体系背后的世界观真相', '体系的隐藏层级', '事件经过（真相）',
  // 结局与揭晓计划
  '计划揭晓章节', '大结局', '各主要角色结局',
  // 伏笔台账（表本身已整体排除，此处兜住散落在其它表里的伏笔列）
  '计划回收位置', '回收前置条件', '回收方式与效果', '对应伏笔编号', '回收伏笔编号', '埋设伏笔编号',
  '可埋伏笔点', '贯穿伏笔推进', '本卷回收伏笔', '本卷新埋伏笔',
  // 世界设定表（worldbase）里的未来向字段 —— 与已登记的「世界终极真相」「可埋伏笔点」同口径。
  // 审计 2026-09-17（P2-12）：原先只登记了同表的一部分，这三个漏网 → 角色视角下照样带进去，
  // 演员会提前知道终局舞台 / 界外真相 / 留白谜题。
  '最终圈', '界外威胁', '世界级悬念',
  // 力量体系 / 物品 / 种族（审计 2026-09-18 P1-1）：同样是「指向尚未发生之事」的列。
  //   漏登记的后果与上面「最终圈」那批一模一样 —— 沉浸档下演员会提前拿到
  //   自己的成长路线（分卷解锁计划）与终局悬念；物品的「流转轨迹」其实是分配计划。
  '金手指的成长路线', '顶端模糊地带',   // 力量体系：分段解锁计划 / 最高境界之上的悬念
  '流转轨迹',                          // 物品资源：谁给谁、怎么给、何时给
  '与主线关系',                        // 种族生物：指向未来的主线关联
  // 制度页签（2026-10-02 · 2.7.1）：新题材模板里的未来向 / 作者底牌字段。
  // 老字段名（如「世界终极真相」「体系的隐藏层级」）在各题材模板里**同名保留** ⇒
  // 上面已登记的条目自动覆盖它们，这里只补**新出现**的字段名。
  '信仰与真相的落差',                  // 宗教信仰：官方教义与真相之间的落差，是作者底牌
])

/** 渲染选项：角色视角下隐藏作者侧字段 */
type RenderOpts = {
  /** 角色视角：整列剔除「作者侧字段」（见 AUTHOR_SIDE_FIELDS） */
  hideAuthorFields?: boolean
  /**
   * 角色视角：整行剔除「保密等级 = S」的条目（S 是绝密 / 剧透，演员不该看到结局）。
   *
   * 🔴 2026-10-02 六维审计 P0：SABC_DESC 一直写着「S=绝密（角色视角看不到）」，
   *    但实现只做了「按页签 / 字段名排除作者侧资料」——**从没有按 S 级剔行**，
   *    等于文案长期在承诺一件没做的事（作者给条目标了 S，演员照样看得到结局）。
   *    本字段把承诺落地：与 D 级同层的**行级**过滤，且同样不进「另有 N 条未列出」的计数。
   */
  hideSecretRows?: boolean
}

/** 各表最多带入的条目数（防止长篇几百行表格直接吃满预算） */
const ROW_CAP: Record<string, number> = {
  'char-main': 30,
  'char-secondary': 24,
  'char-npc': 20,
  relations: 60,
  terms: 60,
  'chapter-master': 60,
  'chapter-outline': 40,
}
const DEFAULT_ROW_CAP = 40

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
const SECRECY_RANK: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 99 }
const DEFAULT_RANK = 2

/** D 档 = 终结 / 弃用（**任何视角**都不进 AI） */
const PRUNED_LEVEL = 'D'

/** S 档 = 绝密 / 剧透（仅**角色视角**剔除，见 isSecretRow） */
const SECRET_LEVEL = 'S'

/**
 * 取一条记录的保密等级原文（大写；读不到给空串）。
 *
 * 🔴 两种存储口径都要认（2026-09-17 实测踩过）：
 *   · 表格行：**裸列名**键 —— data['保密等级']
 *   · 卡片 / 表单：**复合键** —— data['一、基础信息::保密等级']（与 renderForm 的取值口径一致）
 *   只认前者时，所有角色卡的等级都会被读成"未填" → 全部中性 → 角色卡排序**静默失效**
 *   （表格型却正常，所以光看表格测不出来，必须卡片型也测）。
 */
function secrecyOf(data: Record<string, string> | undefined): string {
  if (!data) return ''
  let raw = data['保密等级']
  if (raw === undefined) {
    for (const [k, v] of Object.entries(data)) {
      if (k.endsWith('::保密等级')) { raw = v; break }
    }
  }
  return String(raw ?? '').trim().toUpperCase()
}

/**
 * 🔴 **D 级（终结 / 弃用）：任何情况下都不进 AI。**
 *
 * 不是"排在最后"，是压根不带 —— 它的定义就是「已经用完或不再使用的数据」，
 * 再喂给模型只会拿过时的结论污染新判断（旧版设定、已废弃的路线、退场的人物）。
 * 凡是"把项目数据交给模型"的入口都要过这一道：
 *   ① 内容装配（renderTable / renderCards 先剔除行，连「另有 N 条未列出」的计数都不算它）；
 *   ② 姓名清单（`loadCharacterNames` —— 它喂给 AI 整理当候选值）；
 *   ③ 判重清单（`organizeRows` 的 existingKeys）。
 *
 * 与角色视角**无关**：作者侧同样排除（这才是"任何情况下"的含义）。
 * `rankOf` 给 D 一个大数只是第二道保险 —— 万一某处漏了过滤，它也会排到最后被预算先丢掉。
 */
export function isPrunedForAI(data: Record<string, string> | undefined): boolean {
  return secrecyOf(data) === PRUNED_LEVEL
}

/**
 * 🔴 **S 级（绝密 / 剧透）：角色视角下不进 AI。**
 *
 * 与 D 级的区别：D 是「任何视角、任何功能都不给」（作者侧也排除）；S 只对**角色视角**
 * （酒馆沉浸档的剧情推演 / 扮演）生效 —— 作者 / 导演视角照常带上（那是他自己的底牌）。
 * 判据与 `isPrunedForAI` 同源（都走 `secrecyOf`），所以表格的裸列名键与卡片的复合键都认。
 */
export function isSecretRow(data: Record<string, string> | undefined): boolean {
  return secrecyOf(data) === SECRET_LEVEL
}

/** 取一条记录的预算优先级（读不到等级时给中性档） */
function rankOf(data: Record<string, string> | undefined): number {
  return SECRECY_RANK[secrecyOf(data)] ?? DEFAULT_RANK
}

/**
 * 按预算优先级排序，且**严格稳定**（同等级保持录入顺序）。
 *
 * 🔴 稳定性是硬要求，不是修饰：本地模型的 prompt prefix cache 依赖前缀逐字一致；
 *   同级顺序若随排序抖动，每次请求都要重算 prefill —— 就成了"改了个好事反而更慢"。
 *   故显式带原下标做 tiebreaker，不依赖引擎 sort 的稳定性承诺。
 */
function sortBySecrecy<T extends { data?: Record<string, string> }>(rows: T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rankOf(a.r.data) - rankOf(b.r.data) || a.i - b.i)
    .map(x => x.r)
}

/** 单个字段值的字符上限，超出截断（设定里偶有超长自由文本） */
const CELL_CAP = 200

/**
 * 天生就该长的字段：真相 / 派系斗争 / 关系演变 / 事件链这类自由文本。
 * 按 200 字截断的后果是模型只看到半句，反而容易"接着半句往下编" —— 故单独放宽。
 * 按**字段名**判定（schema 列名即存储键，全库同名同义）。
 */
const LONG_FIELDS = new Set([
  '事件经过（真相）', '民间流传版本（vs真相）', '事件链（起→承→转→合）',
  '内部派系与权力斗争', '演变轨迹（按卷）', '演变触发事件',
  '经济来源', '历史沿革', '对外关系',
  '核心矛盾/内在挣扎', '关键过往经历', '核心性格',
  '距离与行程时间', '地貌与气候', '范围与面积',
  '世界终极真相', '隐藏设定', '体系背后的世界观真相', '体系的隐藏层级',
  '回收方式与效果', '回收前置条件',
  '镇派功法/核心武力', '实力与功法',
])
const CELL_CAP_LONG = 600

/** 取某字段的字符上限（长文本字段放宽到 600） */
function cellCap(name: string): number {
  return LONG_FIELDS.has(name) ? CELL_CAP_LONG : CELL_CAP
}

/**
 * 纯系统调度元数据：**不往提示词里写**。
 *
 * 「保密等级」的使命是"排预算顺序 + 决定可见性"，这两件事在装配层就完成了；
 * 渲染成裸字母（S/A/B/C）喂给模型毫无意义 —— 模型无法解释它，还会被诱导去追问，
 * 纯噪音且白占 token（长篇下这一列的累积量不小）。
 * 它仍然完整参与排序（见 rankOf）与将来的行过滤，只是不出现在提示词里。
 */
const SYSTEM_META_FIELDS = new Set(['保密等级'])

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
      const v = data[key] ?? data[f.name] ?? ''
      used.add(key)
      if (v.trim()) lines.push(`${f.name}：${clip(v, cellCap(f.name))}`)
    }
  }
  // 兼容历史遗留 key（schema 改过字段名的老项目），不丢数据
  for (const [k, v] of Object.entries(data)) {
    if (used.has(k) || !v?.trim()) continue
    // 🔴 内部字段（`__` 前缀，如「设定草稿箱」）**必须在这里挡掉**：
    //    本循环本就是「schema 里没登记过的键也照样渲染」的兜底，不挡就等于把作者
    //    标明「不发给 AI」的整段草稿塞进提示词（见 worldSets.ts 的 FREE_DRAFT_KEY）。
    if (isInternalFieldKey(k)) continue
    const fn = fieldName(k)
    if (SYSTEM_META_FIELDS.has(fn)) continue
    if (o.hideAuthorFields && AUTHOR_SIDE_FIELDS.has(fn)) continue
    lines.push(`${fn}：${clip(v, cellCap(fn))}`)
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
    return composeSubSetsBlock(
      // 角色视角：标了 S 的子世界整段剔除（与 sectionOf 的母级同口径）
      active.filter(s => !(o.hideSecretRows && isSecretRow(s.data)))
        .map(s => ({ name: s.name, body: renderForm(tab, s.data ?? {}, o) })),
      active.length + closed.length,
    )
  } catch {
    // 单段读取失败就当这张表没建过子项（与 sectionOf 同口径：拿不到就少带一段，绝不报错）
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

/** 表格型：首行列名，之后每行用 ｜ 分隔（比 JSON 省 token 得多） */
function renderTable(tab: TabDef, rows: { data: Record<string, string> }[], o: RenderOpts = {}): string {
  // 角色视角：作者侧列整列不渲染（连列名都不出现，避免模型去追问）；
  // 系统元数据列（保密等级）两个视角都不渲染 —— 它已完成使命，对模型只是噪音。
  const cols = (tab.columns ?? []).map(c => c.name)
    .filter(c => !SYSTEM_META_FIELDS.has(c))
    .filter(c => !(o.hideAuthorFields && AUTHOR_SIDE_FIELDS.has(c)))
  if (cols.length === 0) return ''
  const cap = ROW_CAP[tab.id] ?? DEFAULT_ROW_CAP
  // 🔴 D 级（任何视角）与 S 级（仅角色视角）都先剔除（同 renderCards：正文与「另有 N 行未列出」的计数都不算它）
  const usable = rows.filter(r => !isPrunedForAI(r.data) && !(o.hideSecretRows && isSecretRow(r.data)))
  // 2.2.0：同 renderCards —— 先按「保密等级」排预算优先级再截断（同等级保持录入序）
  const use = sortBySecrecy(usable).slice(0, cap).filter(r => cols.some(c => (r.data[c] ?? '').trim()))
  if (use.length === 0) return ''
  const out = [cols.join(' ｜ ')]
  for (const r of use) out.push(cols.map(c => clip(r.data[c] ?? '', cellCap(c))).join(' ｜ '))
  if (usable.length > cap) out.push(`（另有 ${usable.length - cap} 行未列出）`)
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
    const orphans = chs.filter(c => !vols.some(v => v.id === c.volumeId))
    const flat = [...flattenChapters(vols, chs), ...orphans]
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
    if (tab.type === 'form') {
      const formData = await db.getFormData(tab.id)
      // 角色视角：整条记录标了 S（绝密 / 剧透）⇒ 整段不带（含它的子世界）
      if (o.hideSecretRows && isSecretRow(formData)) return ''
      const main = renderForm(tab, formData, o)
      // 世界设定 / 力量体系 / 四个制度页签都是「母子结构」表（C10；2.7.1 扩到六表）：建过子项才引入母／子两层标题。
      // 🔴 没建过子项 ⇒ 原样返回（单世界用户的上下文与改动前**一字不差**）。
      if (!isWorldSetTab(tab.id)) return main
      const sub = await renderActiveSubSets(tab, o)
      if (sub === null) return main
      return [`〖全书统一〗${main ? '\n' + main : '\n（尚未填写）'}`, sub].join('\n\n')
    }
    if (tab.type === 'card') return renderCards(tab, await db.getCardRecords(tab.id), o)
    if (tab.type === 'table') {
      const rows = await db.getTableRows(tab.id)
      // 酒馆模式：知情权限只带「该角色是知情者」的条目（方案 §6.5 事实边界的自动推断）
      if (tab.id === 'secrets' && knowerName) {
        const mine = rows.filter(r => String(r.data?.['知情者'] ?? '').includes(knowerName))
        return renderTable(tab, mine, o)
      }
      return renderTable(tab, rows, o)
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
  const flat = flattenChapters(vols, chs)
  const orphans = chs.filter(c => !vols.some(v => v.id === c.volumeId))
  const sorted = [...flat, ...orphans]
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
  const orphan = listed.filter(c => !volOrder.some(v => v.id === c.volumeId))
  emit('◆ 未分卷', orphan)
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
  const orphans = chs.filter(c => !vols.some(v => v.id === c.volumeId))
  const flat = [...flattenChapters(vols, chs), ...orphans]
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
export async function buildProjectContext(opts: ProjectContextOptions = {}): Promise<ProjectContextResult> {
  const budget = opts.budget ?? 12000
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

  const parts: string[] = []
  const sections: string[] = []
  const dropped: string[] = []
  let used = 0

  const push = (title: string, body: string) => {
    if (!body.trim()) return
    const block = `〖${title}〗\n${body.trim()}`
    if (used + block.length > budget) {
      dropped.push(title)
      return
    }
    parts.push(block)
    sections.push(title)
    used += block.length + 2
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
        proj.genre ? `类型：${normalizeGenrePack(proj.genre)}` : '',
        proj.intro ? `简介：${clip(proj.intro, 200)}` : '',
        `体量：${st.volumes} 卷 / ${st.chapters} 章 / ${st.words} 字`,
      ]
        .filter(Boolean)
        .join('\n')
      push('作品概览', head)
    }
  } catch {
    // 拿不到项目信息也照常往下走
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
  const renderOpts: RenderOpts = {
    hideAuthorFields: opts.viewMode === 'character-view',
    // S 级（绝密 / 剧透）在角色视角下整行剔除 —— 见 RenderOpts.hideSecretRows 的说明
    hideSecretRows: opts.viewMode === 'character-view',
  }

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
      const found = await findRelatedChapters(opts.focusChapterId, opts.relatedChapterLimit ?? 8)
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

  if (opts.includeChapterList !== false) {
    const digest = await buildChapterDigest(200, opts.anchorChapterId)
    push('章节清单', digest)
  }

  // 被预算丢弃的段落必须在文末声明，否则模型会把自己没看到的资料当成不存在
  const note = dropped.length > 0 && opts.inlineDropNote !== false
    ? `\n\n（注：以下资料因长度预算未带入本提示，仅供参考时留意其可能存在：${dropped.join('、')}）`
    : ''
  const text = parts.join('\n\n') + note
  return { text, sections, dropped, chars: text.length }
}

/**
 * 伴写专用「相关设定切片」——**刻意极短且只取四类**。
 *
 * 为什么另开一个函数、而不复用 buildProjectContext 的默认口径：
 *   伴写是"停笔即出"的低打扰场景，端到端延迟直接决定手感（27B 实测已 3.3s）。
 *   默认口径下，2000 预算会被**章节清单（目录）**和"相关章节召回"吃掉大半 ——
 *   可伴写已经拿到了光标前正文，再给卷/章目录纯属重复，真正的设定反而挤不进来。
 * 故此处：① 关掉章节清单；② 只带这四类 ——
 *   作品定位（是不是这本书）/ 世界设定 / 主要角色（身份称谓别写错）/ 名词术语（专名别漂移）。
 *   《写作规范》由调用方单独摘取（只取 3 个字段，比整表带过来更省更准），故不在此重复。
 */
export async function buildInlineBriefing(budget = 900): Promise<string> {
  try {
    const r = await buildProjectContext({
      budget,
      onlyTabIds: ['positioning', 'worldbase', 'char-main', 'terms'],
      includeChapterList: false,
    })
    return r.text
  } catch {
    return '' // 拿不到设定就少带一段，绝不阻断伴写
  }
}
