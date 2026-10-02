/**
 * 世界观 · 力量体系 · 制度四页签的「多套条目」结构（C10 · 2.4.2 起，2.7.2 分两种形态）
 *
 * ## 两种形态（2026-10-02 主人定案）
 * | 形态 | 页签 | 有无「全书统一（母级）」 |
 * |---|---|---|
 * | **母子结构** | 世界设定 `worldbase`、力量体系 `power` | ✅ 有（母级永远喂 AI，子项按活跃喂） |
 * | **并列结构** | 政治 `politics`、经济 `economy`、信仰 `belief`、司法 `justice` | ❌ 没有（只有多份平铺条目） |
 *
 * ## 为什么世界设定 / 力量体系要是母子，不是"多套并列"
 * 无限流这类写法，最顶层一定有一个统一的世界观与力量体系（全书舞台、统一等级），
 * 主角在下面一个个副本 / 剧本里经历不同的故事，**每个副本还有自己一套独立的设定**。
 * 所以：
 *   · **母级**＝全书统一那一份（一个项目只有一份，**永远喂给 AI**）
 *   · **子级**＝副本 / 剧本各自一套（可建多项），每项一个「活跃 / 已完结」开关，
 *     **只有活跃的才喂给 AI**（已完结的留着可查，但不再进上下文 —— 这是防「多套互相打架
 *     让模型判断混乱」的关键）
 *
 * ## 为什么制度四页签是并列（2.7.2 改）
 * 政治 / 经济 / 信仰 / 司法本来就是「**一世界多政权 / 多邦国**」的并列条目 ——
 * 硬套母子会逼作者先写一份「天下通例」再逐个政权重复，且母级那一份对多政权本书根本没有意义。
 * 主人 2026-10-02 拍板去掉母级、改为平铺（**但保留活跃开关** —— 「已完结的政权不再发 AI」这个
 * 能力在并列结构下同样有用）。
 *
 * ## 存储形态（这里只定义"是什么"，读写见 `lib/db/worldSets.ts`）
 * ```
 * 母子页签的母级  formData[`${pid}::worldbase`]               ← 原地不动，零迁移
 * 任意多套条目的子级  cardRecords  { tabId:'<tabId>-sub', name:'…', data:{'模块::字段':…} }
 * 活跃  settingsKV[`${pid}::worldSubActive::<tabId>`] = [条目id, …]
 * ```
 * 🔴 子级用的 `<tabId>-sub` 这个 tabId **刻意不放进 `TABS`** —— 于是它不会被当成页签渲染、
 *    不会被 `formMap` 的全书级设定汇总捞到、不会被酒馆 `TARGETABLE` 误收录。
 *    「与所有现存链路天然隔离」正是本方案不需要改 type、不需要迁移的原因。
 * 🔴 **2.7.2 的并列结构与之完全同构** —— 复用同一套存储，只是不再写母级 formData 那一层。
 *    红利：历史项目的 `politics-sub` 等记录**原样继续可读**，零迁移。
 *
 * ## 本文件的三条职责（都只在这一处定义，别在别处写死表名）
 * ① 哪些页签是母子、哪些是并列；② 条目挂在哪个 tabId 下；③ 活跃 / 已完结怎么切分。
 */

/**
 * 「设定草稿箱」的存储键（2.4.4 · 社区反馈）。
 *
 * 形态：母级与**每个子世界各一份**，就存在该层自己的 data 里（键即本常量），
 * 于是切层 / 落库 / 云同步全部自动跟着走，不用再开一张表。
 *
 * 🔴 为什么键要以**双下划线**开头：表单数据的键一向是「模块名::字段名」，
 *    渲染进 AI 上下文时有一道「兼容历史遗留 key」的兜底循环（`renderForm` 末尾）——
 *    它会把任何没在 schema 里登记过的键都当字段渲染出来。
 *    没有统一前缀的话，草稿箱那几千字就会顺着这道兜底混进提示词，
 *    而界面上明明写着「不发给 AI」（口径自相矛盾，比不写更糟）。
 *    故约定：**`__` 前缀 = 内部字段，一律不进 AI**，判据见 `isInternalFieldKey`。
 */
export const FREE_DRAFT_KEY = '__freeDraft__'

/** 内部字段键判据（双下划线前缀）：不渲染进 AI 上下文、不进设定集导出、不计入"已填 N 项" */
export function isInternalFieldKey(key: string): boolean {
  return key.startsWith('__')
}

/**
 * 支持**母子结构**的页签（🔴 单一判据：以后要多支持一张表，只往这里加名字）。
 *
 * 🔴 2.7.2 调整：**只有「世界设定」「力量体系」是母子结构**。
 *    政治 / 经济 / 信仰 / 司法四个制度页签已改为**并列结构**（见 `PARALLEL_SET_TABS`）——
 *    它们承载的是「一世界多政权 / 多邦国」的并列条目，**不存在「全书统一」那一层**。
 *    2.7.1 曾把六个页签一律做成母子（`WORLD_SET_TABS` 塞了六个 id），
 *    那会让作者被迫先写一份「天下通例」再逐个政权重复，2026-10-02 主人拍板改回并列。
 *
 * 制度页签 2.7.1 加入本名单的**全部动作**就是往这里加名字：
 * 存储层（`db/worldSets`）、面板（`WorldSetSheet` / `ParallelSetSheet`）、AI 注入（`aiContext`）、
 * 导出 / 汇总 / 检索全都已按 `tab.id` 参数化 + 遍历 `TABS`。
 */
export const WORLD_SET_TABS: readonly string[] = ['worldbase', 'power']

/**
 * 支持**并列结构**的页签（2.7.2 · 主人定案：多份记录平铺，没有母级）。
 *
 * 形态：页签下**只有多份平铺的条目**，每条一个名称 + 一份表单 + 一个「活跃 / 已完结」开关；
 * **没有**「全书统一（母级）」那一行，AI 注入时也不带 `〖全书统一〗` 标题。
 *
 * 🔴 存储与母子结构**完全同构**（复用 `cardRecords` + `<tabId>-sub` + `worldSubActive::<tabId>`），
 *    差别只在**没有 formData 母级那一层** —— 所以：
 *    · 历史项目的 `politics-sub` 记录**原样继续可读**（这是改「结构」而不是改「存储」的红利）；
 *    · 删母级 / 母级字段那条链路不会被触发（本结构压根没有母级 formData）。
 */
export const PARALLEL_SET_TABS: readonly string[] = ['politics', 'economy', 'belief', 'justice']

/** 「有多套条目」的页签全集（母子 ＋ 并列）—— 遍历 / 存储链路用这个 */
export const MULTI_SET_TABS: readonly string[] = [...WORLD_SET_TABS, ...PARALLEL_SET_TABS]

/** 子级的 tabId 后缀（`worldbase` → `worldbase-sub`；并列页签同理，如 `politics-sub`） */
export const SUB_TAB_SUFFIX = '-sub'

/** 该页签是「母子结构」（有母级 formData + 子项） */
export function isWorldSetTab(tabId: string): boolean {
  return WORLD_SET_TABS.includes(tabId)
}

/** 该页签是「并列结构」（只有多份平铺条目，无母级） */
export function isParallelSetTab(tabId: string): boolean {
  return PARALLEL_SET_TABS.includes(tabId)
}

/**
 * 该页签是否为「有多套条目」的结构（母子或并列都算）—— **存储 / AI 注入 / 导出链路的判据用这个**。
 * 🔴 2.7.2 新增：以前只有 `isWorldSetTab` 一个判据，现在拆成两个语义 + 本聚合函数，
 *    以免新代码继续拿 `isWorldSetTab` 当「有多套条目」用（那会漏掉四个制度页签）。
 */
export function isMultiSetTab(tabId: string): boolean {
  return isWorldSetTab(tabId) || isParallelSetTab(tabId)
}

/** 母级页签 id → 存放其子项的 tabId */
export function subTabIdOf(tabId: string): string {
  return `${tabId}${SUB_TAB_SUFFIX}`
}

/** 反向：这个 tabId 是不是某张多套表的子级？（用于在遍历里识别并跳过） */
export function isSubTabId(tabId: string): boolean {
  return MULTI_SET_TABS.some(t => subTabIdOf(t) === tabId)
}

/** 母级页签 → 活跃列表在 settingsKV 里的键（`getSetting/setSetting` 会自动加 `${pid}::` 前缀） */
export function activeKeyOf(tabId: string): string {
  return `worldSubActive::${tabId}`
}

/**
 * 把子项分成「活跃 / 已完结」两拨。
 *
 * 🔴 两个防御都在这里（读取路径唯一的净化点，纯函数可测）：
 *   ① **活跃列表里已经不存在的 id 一律忽略** —— 设备 A 删了子项、设备 B 的活跃列表还没同步，
 *      或者删除动作中途失败留下残影；直接拿它去查会得到 undefined 项，进而让 AI 段落里
 *      出现一行空的子世界标题；
 *   ② 活跃列表里**重复**的 id 只算一次（手工改过存储、或两次点击并发都可能留下重复）。
 * 保持传入顺序（存储层已按 order 排好），不在这里重排 —— 排序是存储层的事。
 */
export function splitActive<T extends { id: string }>(
  subs: readonly T[],
  activeIds: readonly string[],
): { active: T[]; closed: T[] } {
  const active = new Set(activeIds)
  const seen = new Set<string>()
  const act: T[] = []
  const rest: T[] = []
  for (const s of subs) {
    if (active.has(s.id) && !seen.has(s.id)) {
      seen.add(s.id)
      act.push(s)
    } else if (!active.has(s.id)) {
      rest.push(s)
    }
  }
  return { active: act, closed: rest }
}

/** 开关某一项（幂等：重复开不会变成两项） */
export function toggleActiveId(activeIds: readonly string[], id: string, on: boolean): string[] {
  const set = new Set(activeIds)
  if (on) set.add(id)
  else set.delete(id)
  return [...set]
}

/**
 * 把活跃列表里**已不存在的 id** 剔掉（删除子项时调用）。
 * 与 `splitActive` 的分工：那个是**读**的时候防御，这个是**删**的时候收拾干净。
 */
export function pruneActiveIds(activeIds: readonly string[], existingIds: readonly string[]): string[] {
  const exist = new Set(existingIds)
  return activeIds.filter(id => exist.has(id))
}

/** 多套条目段里的一条（body 由调用方渲染好再传进来） */
export interface SubSetBlockEntry {
  name: string
  body: string
}

/**
 * 拼装进 AI 上下文的「子世界段」骨架（**母子结构专用**，纯函数：只管标题 / 分隔 / 尾部计数，字段渲染由调用方给）。
 *
 * 🔴 尾部那句「另有 N 个已完结的子世界，未发送」**不能省** —— 它是作者判断
 *    「AI 到底读到了什么」的唯一依据（与 `BY_BUDGET` 同一个诚实口径）。省掉之后，
 *    作者会以为模型读过全部子世界，然后困惑「它怎么没记住那个副本的设定」。
 */
export function composeSubSetsBlock(
  entries: readonly SubSetBlockEntry[],
  total: number,
): string {
  const active = entries.length
  const closed = Math.max(0, total - active)
  const head = `〖子世界（活跃 ${active} / 共 ${total}）〗`
  if (active === 0) {
    return `${head}\n（当前没有活跃的子世界；另有 ${closed} 个已完结，未发送）`
  }
  const body = entries
    .map(e => `▸ ${e.name || '未命名子世界'}${e.body ? '\n' + e.body : ''}`)
    .join('\n')
  return `${head}\n${body}${closed ? `\n（另有 ${closed} 个已完结的子世界，未发送）` : ''}`
}

/**
 * 拼装进 AI 上下文的「并列条目段」骨架（**并列结构专用**，2.7.2）。
 *
 * 与 `composeSubSetsBlock` 的差别只有一处，但**必须换掉**：
 *   标题是「并列条目」而不是「子世界」—— 母级已经取消，称「子世界」会误导作者
 *   （他会以为每条下面还该有子项），也会让模型误判层级。
 *
 * @param label 该页签的条目总称（政治页签＝「政权」、经济＝「势力/集团」…），
 *              拼进标题让作者一眼看出这段是哪一页的。
 */
export function composeParallelSetBlock(
  entries: readonly SubSetBlockEntry[],
  total: number,
  label: string,
): string {
  const active = entries.length
  const closed = Math.max(0, total - active)
  const head = `〖${label}（活跃 ${active} / 共 ${total}）〗`
  if (active === 0) {
    return `${head}\n（当前没有活跃的${label}；另有 ${closed} 个已完结，未发送）`
  }
  const body = entries
    .map(e => `▸ ${e.name || `未命名${label}`}${e.body ? '\n' + e.body : ''}`)
    .join('\n')
  return `${head}\n${body}${closed ? `\n（另有 ${closed} 个已完结的${label}，未发送）` : ''}`
}
