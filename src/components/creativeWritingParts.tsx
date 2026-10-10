// ============ 创意写作 · 共用常量 / 类型 / 小件（C1 · 2.4.2 自 CreativeWritingPanel.tsx 拆出）============
// 🔴 纯搬家：一行未改（只给顶层声明补了 export —— 原文里它们是本文件私有，现被子组件共用）。
import { CreativeLength, CreativeTarget } from '@/lib/creativeSession'
import { ContinueStrategy } from '@/lib/autoContinue'
import { ChapterRewriteAction } from '@/lib/aiTasks'
import { RewriteCandidateGroup } from '@/lib/chapterRewrite'

export const NUM_INPUT = 'h-8 w-20 rounded bg-ink-900 border border-ink-700 px-2 text-12 text-ink-100 outline-none focus:border-amber/50'

/**
 * 「已保存 · HH:MM」的时间格式。
 * 只到分钟：秒级数字一直在跳，看起来像界面在抽搐。完整时间放 title 里。
 */
export function fmtSavedAt(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const today = new Date()
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/**
 * 篇幅（老大 2026-09-20 要求）：先选篇幅，再选「这一次要产出什么」。
 * - **短篇**：一次跑完（大纲规划 / 大纲 + 正文），1 卷；
 * - **中长篇**：两阶段分开做（大纲规划 / 只生成正文），每阶段可反复执行。
 *
 * 为什么要有这一档：长篇不可能一次生成完（模型上下文与耗时都不允许），
 * 必须"排一批大纲 → 写一批正文 → 再排一批 → 再写一批"。短篇则没必要拆两趟。
 */
export const LENGTH_META: Record<CreativeLength, { label: string; hint: string }> = {
  short: {
    label: '短篇',
    hint: '一次跑完：设定 → 分卷大纲 → 逐章连写（1 卷）。适合十万字以内的单本作品',
  },
  long: {
    label: '中长篇',
    hint: '分两阶段、每阶段可反复执行：先按「本批几卷 × 每卷几章」分批把大纲排完，再按批写正文。几十万到几百万字都走这条路',
  },
}
export const LENGTHS: CreativeLength[] = ['short', 'long']

/** 各篇幅下可选「这一次要产出什么」（顺序即界面顺序）—— 中长篇没有"一次跑完"这一档 */
export const TARGETS_BY_LENGTH: Record<CreativeLength, CreativeTarget[]> = {
  short: ['outline', 'full'],
  long: ['outline', 'draft'],
}

/**
 * 产出目标文案。
 *
 * 🔴 口径（2026-09-20）：**起点不再由作者选** —— 库里有没有大纲是客观事实，
 *    编排器自己判定（没大纲先跑设定奠基，已有就接着往下排）。
 *    作者要决定的只有"这一次要产出什么"。
 */
export const TARGET_META: Record<CreativeTarget, { label: string; hint: string }> = {
  outline: {
    label: '只做大纲规划',
    hint: '排 / 续排分卷大纲与章节细纲，正文一个字不写。库里还没有大纲时会先做「设定奠基」把基础设定冷启动出来；已有则接着往下排',
  },
  full: {
    label: '大纲 + 正文',
    hint: '设定 → 分卷大纲 → 逐章连写，一次跑完（适合短篇）。库里已有大纲时本次只补正文，不会重排大纲',
  },
  draft: {
    label: '只生成正文',
    hint: '按已排好的分卷大纲与章节细纲逐章写正文，从「正文最后一章 + 1」接着写；本次写几章由你定',
  },
}

/** 整章改写的五种动作（顺序即界面顺序） */
// 🔴 顺序即界面顺序：润色 → 扩写 → 精简 → **续写** → 改写。
//    「续写」放在改写前面 —— 它与扩写同属"加长"，改写是最后一档（重写）。
export const RW_ACTIONS: ChapterRewriteAction[] = ['polish', 'expand', 'condense', 'continue', 'rewrite']

/**
 * 「整章改写」的选章列表（按卷分组，界面做成可搜索的卷章树）。
 * 空卷不出现在树里（见 listRewriteTree）。
 */
export type RewriteTree = RewriteCandidateGroup[]

/**
 * 每章写完之后的「设定同步」策略 —— **两种起点共用同一组档位**（不是「接着写」专属）。
 *
 * 每章固定做三件事：① 抽取本章设定 → ② 新增的补登进设定表 → ③ 已登记且发生了变化的信息做更新。
 * 三个档位只决定 ②③ 的力度，不决定"做不做"。
 */
export const STRATEGY_META: Record<ContinueStrategy, { label: string; hint: string }> = {
  'add-only': { label: '仅限新增', hint: '每章抽取后只补登新设定；已登记的设定一律不动（最稳）' },
  'confirm': { label: '候选确认', hint: '新设定与疑似重复项列出供你勾选；已登记项不改动' },
  'auto-update': { label: '自动更新', hint: '新设定自动补登；已登记实体的变化追加到备注类字段（不覆盖属性列）' },
}
export const STRATEGIES: ContinueStrategy[] = ['add-only', 'confirm', 'auto-update']

/**
 * 改写纪律提示 —— 由「**动作 × 章位置**」两个维度共同决定，与提示词侧（aiTasks 的两条 RULE）是同一个矩阵。
 *
 * 为什么不能只看"是不是最新章"：润色本来就不增删情节与信息，被当成"可放开改写"是越权；
 * 而历史章的**扩写**最大的污染路径是"把描写升级成设定"（原文"一柄剑"→ 扩写成"师父所赠的断岳剑"），
 * 历史章的**精简**最大的风险是"删掉承载设定的句子"（"得自青云宗的储物戒"→"储物戒"）。
 */
export const RW_SCOPE_NOTE: Record<ChapterRewriteAction, { latest: string; history: string }> = {
  polish: {
    latest: '这是项目最新章；但「润色」仍只换字不换事 —— 情节与信息不动，不因是最新章就放开走向。落库后会自动同步设定。',
    history: '这是历史章；「润色」只换字不换事，不动情节与信息，不会影响设定。',
  },
  expand: {
    latest: '这是项目最新章：补细节时可一并补设定信息；落库后会自动抽取 / 补登 / 更新设定表。',
    history: '这是历史章：🔴 描写层可以加（环境 / 动作 / 微表情 / 情绪），但不得新增专名、身份、来历、境界、器物名等设定信息 —— 那是凭空造设定，后文接不上。',
  },
  condense: {
    latest: '这是项目最新章：只删冗余重复与注水过渡，承载设定交代的句子照样保留。落库后会自动同步设定。',
    history: '这是历史章：🔴 只删冗余与注水过渡；承载设定交代的句子（专名 / 来历 / 境界 / 关系 / 器物来源）一律保留 —— 删掉后文就断了。',
  },
  continue: {
    latest: '这是项目最新章：续写只在末尾追加新内容，原有正文一字不动；落库后会自动抽取 / 补登 / 更新设定表。',
    history: '这是历史章：🔴 这一章后面已经有正文了 —— 续写等于往中间插入新情节，会与后文打架。想补长度请改用「扩写」（不新增事件），或先确认你要的确实是插叙。',
  },
  rewrite: {
    latest: '这是项目最新章：五种动作里只有「改写」可以放开手脚（调节奏 / 重排场景 / 强化冲突 / 改写局部走向）。落库后会自动同步设定。',
    history: '这是历史章：只改叙述方式与文字，设定类内容一字不动、不新增剧情事件、不埋伏笔。',
  },
}
