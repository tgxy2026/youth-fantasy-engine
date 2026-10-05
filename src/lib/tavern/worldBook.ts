/**
 * 酒馆模式 · 世界书（W3，2026-10-05）
 *
 * 【要解决的问题】SillyTavern 的 World Info / Lorebook 最核心的能力不是「有设定」，而是
 *   **条目级的关键词命中 + 递归激活**：一个设定条目被命中后，它正文里提到的词又能激活别的条目。
 *   我们原先只有「整份背景设定命中关键词才注入」（world.ts 的 `shouldInjectWorld`），
 *   粒度太粗 —— 提到「城南」就得把整份设定铺进去。
 *
 * 【设计原则：纯粹的逻辑层，不碰存储、不碰 React】
 *   本文件只做「给定一个条目池 + 一段文本 ⇒ 选出该注入的条目 + 渲染成文本」。
 *   两种模式各自适配自己的**数据源**：
 *     · 剧情模式：`WorldSetting.sections[]`（随项目）—— 见 `world.ts`
 *     · 自由模式：`TavernStory.setting`（全局）—— 见 `story.ts`
 *   🔴 这就是「融合开发」的切入点：**归口在判据，不归口在数据** ——
 *      两边的数据归属完全不同（一个随项目、一个全局），强行统一会破坏已有的同步/备份语义。
 *
 * 【为什么必须有递归上限】
 *   条目 A 的正文提到 B、B 提到 A —— 没有上限就是死循环。
 *   上限 2 轮（ST 默认也是 2）+ `visited` 去重：够用，且成本可预测。
 *
 * 【与旧行为的关系（等价性红线）】
 *   没有 `keys` 的条目 = **总是注入**（同 `shouldInjectWorld` 的空关键词语义）。
 *   所以「老数据（sections 里没这些字段）」走本文件的结果 = 全部条目按 order 顺序拼接，
 *   与 `worldToText` 逐字一致 —— 见 `renderEntries` 的 `maxChars` 与拼接格式说明。
 *
 * 【命名】对外叫「世界书」，条目叫「词条」。ST 那边叫 World Info / entry，概念一一对应。
 */

/** 一个世界书词条。与 ST 的 World Info entry 概念对应，但字段更少（够用即可）。 */
export type WorldEntry = {
  id: string
  /** 词条名（渲染时的标题，如「城南旧事」） */
  title: string
  /** 正文 */
  body: string
  /**
   * 触发关键词。**为空 = 总是注入**（与 `shouldInjectWorld` 的空关键词语义一致）。
   * 命中规则：正文（haystack）里 `includes` 任一关键词即命中（大小写不敏感）。
   */
  keys: string[]
  /**
   * 触发概率 0–1（1 = 必中）。命中关键词后还要过这道随机闸 ——
   * 用于「这个设定偶尔提一下就好」的场景。**0 视为 0（不外扩）**，负数按 0、>1 按 1 收口。
   */
  prob: number
  /** 排序权重（小的在前）；渲染时按它稳定排序，保证同一份数据每次拼出的文本一致 */
  order: number
  /** 是否允许它激活别的词条（递归扫描的开关，逐条控制） */
  recursive: boolean
  /** 常驻：即使没命中关键词也注入（等价于 keys 为空的常用写法，但语义更明确） */
  constant?: boolean
  /**
   * 四色灯（2026-10-05）：`on` 常驻 / `hit` 触发 / `ref` 引荐 / `off` 休眠。
   * **不存也无妨** —— 缺省时由 `constant` / `keys` / `recursive` 推导（老数据同形）。
   */
  state?: EntryState
  /**
   * 休眠开关。为 `true` 时本条不参与任何判定（留在库里）。
   * 与 `state: 'off'` 等价 —— 界面走 `state`，老数据可能只有这个布尔。
   */
  off?: boolean
}

/** 词条的默认值（新建时用）。`prob: 1` = 默认必中，别让作者一建词条就随机消失。 */
export function emptyWorldEntry(init: Partial<WorldEntry> = {}): WorldEntry {
  return {
    id: '', title: '', body: '', keys: [], prob: 1, order: 0, recursive: true,
    ...init,
  }
}

/** 递归扫描轮数上限（ST 默认 2）。 */
export const MAX_RECURSION_ROUNDS = 2

/** 单个词条的正文长度上限（防一条把额度吃光）。 */
export const ENTRY_MAX_CHARS = 1200

// ============================================================
// 四色灯（2026-10-05）
// ============================================================
/**
 * 词条的四态 —— 对应 SillyTavern World Info 的蓝圈 / 绿圈 / 🔗 / 停用，
 * 但换成**贴合本项目语境的中文名**（主人 2026-10-05 拍板）：
 *
 * | 态 | ST 对应 | 含义 | 判定 |
 * |---|---|---|---|
 * | `on` 常驻 | 🔵 蓝圈 | 无条件必带 | `constant` 或 `keys` 为空 |
 * | `hit` 触发 | 🟢 绿圈 | 命中关键词才带 | 有 `keys` 且非 constant |
 * | `ref` 引荐 | 🔗 链接 | 被别的词条正文提到才带（**只走递归轮**） | `ref` 与 `keys` 配合：第 1 轮不参与 |
 * | `off` 休眠 | 停用开关 | 本条不参与任何判定 | `off` |
 *
 * 🔴 `state` **不必存**：它是作者意图，由 `constant` / `recursive` / `off` 推导得出；
 *    但也可以**显式给** `state`（界面就是用它）。`entryStateOf` 优先读显式值，
 *    这样界面切灯色时只需要动一个字段，不必同时维护三个布尔。
 *
 * 🔴 **老数据等价性**：`state` 未给时按老字段推导，结果与升级前逐字一致。
 */
export type EntryState = 'on' | 'hit' | 'ref' | 'off'

export const ENTRY_STATE_LABEL: Record<EntryState, string> = {
  on: '常驻',
  hit: '触发',
  ref: '引荐',
  off: '休眠',
}

export const ENTRY_STATE_HINT: Record<EntryState, string> = {
  on: '每轮都带上这一条（不写触发词，或明确设成常驻）',
  hit: '提到这些触发词时才带上这一条',
  ref: '不主动触发；其他词条的正文里提到它时，才被带进来',
  off: '这一条暂时不参与（留在库里，随时可以点亮）',
}

/**
 * 把任意来源的「像词条的东西」规整成 `WorldEntry`（宽容读旧数据，绝不抛）。
 * 老数据可能只有 `{id,title,body}` —— 缺的字段一律取默认值 ⇒ 总是注入。
 */
export function normalizeEntry(raw: unknown, idx = 0): WorldEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const title = String(r.title ?? '').trim()
  const body = String(r.body ?? '').trim()
  if (!title && !body) return null
  const rawKeys = Array.isArray(r.keys) ? r.keys : (Array.isArray(r.keywords) ? r.keywords : [])
  const keys = rawKeys.map(k => String(k ?? '').trim()).filter(Boolean)
  const rawProb = r.prob
  const prob = typeof rawProb === 'number' && Number.isFinite(rawProb)
    ? Math.max(0, Math.min(1, rawProb))
    : 1
  const rawOrder = r.order
  return {
    id: String(r.id ?? `e${idx}`),
    title,
    body,
    keys,
    prob,
    order: typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : idx,
    // 缺省 true：老数据（没有这个字段）的正文照样能激活别的条目，与「不设限」的直觉一致
    recursive: r.recursive === undefined ? true : !!r.recursive,
    constant: r.constant === undefined ? undefined : !!r.constant,
    // 四色灯：只在源数据里存在时才回填（老数据不该被塞新键）
    state: isEntryState(r.state) ? r.state : undefined,
    off: r.off === undefined ? undefined : !!r.off,
  }
}

function isEntryState(v: unknown): v is EntryState {
  return v === 'on' || v === 'hit' || v === 'ref' || v === 'off'
}

/**
 * 取词条的灯色。**优先显式 `state`**，缺省时按老字段推导 ——
 * 推导规则刻意与升级前的语义**一对一**（老数据走新代码结果不变）：
 *   · `off` 为真            → 休眠
 *   · `constant` 或 keys 空 → 常驻（老 `isAlwaysOn`）
 *   · `recursive: false`    → 引荐（老语义：只被扫、不拉别人 ⇒ 只可能由递归带进来）
 *   · 其余                  → 触发
 *
 * ⚠️ 为什么 `recursive: false` 落到「引荐」而不是「触发」：老代码里这种词条
 * 第 1 轮照样会被关键词命中（`entryHits` 不看 recursive）。两者在**第 1 轮会命中**这点上
 * 其实一致，但灯色要能表达「它不往外拉人」。故界面**新建**时给 `hit`，
 * 只有老数据缺 `state` 时才落到 `ref` —— 见下方 `pickEntries` 的等价性说明。
 */
export function entryStateOf(e: WorldEntry): EntryState {
  if (e.state) return e.state
  if (e.off) return 'off'
  if (isAlwaysOn(e)) return 'on'
  if (!e.recursive) return 'ref'
  return 'hit'
}

/** 该词条是否「总是注入」（常驻 或 没有关键词） */
export function isAlwaysOn(e: WorldEntry): boolean {
  return !!e.constant || e.keys.length === 0
}

/** 单个词条是否被这段文本命中（大小写不敏感）。总是注入的词条恒 true。 */
export function entryHits(e: WorldEntry, haystack: string): boolean {
  if (isAlwaysOn(e)) return true
  const h = String(haystack ?? '').toLowerCase()
  if (!h) return false
  return e.keys.some(k => h.includes(k.toLowerCase()))
}

/** 概率闸。`rand` 可注入以便单测确定化（默认 `Math.random`）。 */
function passProb(e: WorldEntry, rand: () => number): boolean {
  if (e.prob >= 1) return true
  if (e.prob <= 0) return false
  return rand() < e.prob
}

export type PickOptions = {
  /** 随机源（测试注入） */
  rand?: () => number
  /** 递归轮数上限（默认 2） */
  maxRounds?: number
}

export type PickResult = {
  /** 选中的词条（已按 order 稳定排序） */
  hits: WorldEntry[]
  /** 被概率闸挡掉的词条 id（供界面「为什么没注入」提示用） */
  skippedByProb: string[]
  /**
   * 每条命中的**来源**（2026-10-05 加，供「逐条取舍」判优先级 + 界面展示）：
   * `direct` = 第 1 轮直接命中（或常驻）；`recursive` = 递归轮被引荐进来。
   */
  origin: Map<WorldEntry, 'direct' | 'recursive'>
}

/**
 * 选出该注入的词条（含递归激活）。
 *
 * 算法（与 ST World Info 的语义对齐，但只保留最核心的三条）：
 *   ① 第 1 轮：用**原始 haystack** 扫全部词条 —— 命中的进结果集
 *   ② 递归轮（≤ `maxRounds - 1` 次）：用**上一轮新增条目的正文**当新 haystack 再扫
 *      ——「提到 A，A 的正文里提到的 B 也跟着进来」
 *   ③ `recursive: false` 的词条**只被扫、不参与把别人拉进来**（它的正文不进下一轮 haystack）
 *
 * 🔴 概率闸在**每一轮命中时**判：被挡掉的记进 `skippedByProb`，且它的正文**不进下一轮**
 *    —— 否则「偶尔才出现的设定」会稳定地把一串条目拖进来，概率形同虚设。
 * 🔴 `visited` 全流程去重：同一个词条只进一次结果集，也不会被反复当 haystack。
 *
 * 【四色灯的两条额外规则】（2026-10-05）
 *   · `off` 休眠 —— 全程跳过，连被引荐都不行。
 *   · `ref` / `state:'ref'` 引荐 —— **第 1 轮不参与**（即使关键词就在原始文本里），
 *     只在递归轮被前面命中条目的正文带进来。这正是 ST 的 🔗「Delay until recursion」。
 *     ⚠️ 这一条**只对显式设了 `state:'ref'` 的词条生效**；老数据（缺 `state`、
 *     仅 `recursive:false`）仍按老语义在第 1 轮参与 —— 等价性红线。
 */
export function pickEntries(pool: readonly WorldEntry[], haystack: string, opts: PickOptions = {}): PickResult {
  const rand = opts.rand ?? Math.random
  const maxRounds = Math.max(1, opts.maxRounds ?? MAX_RECURSION_ROUNDS)

  const hits: WorldEntry[] = []
  const skippedByProb: string[] = []
  const origin = new Map<WorldEntry, 'direct' | 'recursive'>()
  // 🔴 去重键不能只用 `id`：id 为空串的条目（手工构造 / 老数据缺 id）会互相顶掉，
  //    表现为「只注入了第一条」。优先用 id，缺失时退回「池内下标」——两者都稳定。
  const keyOf = (e: WorldEntry, i: number) => (e.id ? `id:${e.id}` : `at:${i}`)
  const visited = new Set<string>()

  // 第 1 轮：原始文本
  let scanText = String(haystack ?? '')
  for (let round = 0; round < maxRounds; round++) {
    // 本轮新激活的条目正文（下一轮的扫描素材）
    const nextTexts: string[] = []
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i]
      const key = keyOf(e, i)
      if (visited.has(key)) continue
      // 休眠：全程不参与（也不进 visited 之外的任何集合）
      if (e.state === 'off' || (!e.state && e.off)) { visited.add(key); continue }
      // 引荐：只在递归轮参与（显式 state 才生效 —— 老数据保持老语义）
      if (round === 0 && e.state === 'ref') continue
      if (!entryHits(e, scanText)) continue
      // 命中了，但要过概率闸
      if (!passProb(e, rand)) {
        visited.add(key)   // 记下来免得每轮重复判（概率判两次结果会走样）
        skippedByProb.push(e.id || `at:${i}`)
        continue
      }
      visited.add(key)
      hits.push(e)
      origin.set(e, round === 0 ? 'direct' : 'recursive')
      // 只有 recursive 的词条才把正文贡献给下一轮
      if (e.recursive) {
        nextTexts.push(`${e.title}\n${e.body}`)
      }
    }
    // 本轮没有任何新条目 ⇒ 递归无意义，提前收工
    if (!nextTexts.length) break
    scanText = nextTexts.join('\n')
  }

  // 🔴 稳定排序：order 小的在前；order 相同按在原池里的下标（保证同一份数据每次拼出同一串）
  const idxOf = new Map<WorldEntry, number>()
  pool.forEach((e, i) => { if (!idxOf.has(e)) idxOf.set(e, i) })
  hits.sort((a, b) => (a.order - b.order) || ((idxOf.get(a) ?? 0) - (idxOf.get(b) ?? 0)))

  return { hits, skippedByProb, origin }
}

export type RenderOptions = {
  /** 总长度上限（超出截断并注明）。不传 = 不限制 */
  maxChars?: number
  /** 截断提示语（可覆盖，便于两模式说自己的话） */
  truncateNote?: string
  /**
   * 逐条取舍时的**来源表**（`pickEntries` 的 `origin`）。给了就按 ST 的优先级砍：
   * 常驻 → 直接命中 → 引荐命中；同级按 order 大者优先（越靠后的对输出影响越大）。
   * 不给则退回「按传入顺序从后往前砍」的保守行为。
   */
  origin?: Map<WorldEntry, 'direct' | 'recursive'>
}

/** 渲染结果：文本 + **被额度挡掉的条目**（界面要如实告诉作者「哪几条没进去」） */
export type RenderResult = {
  text: string
  /** 因超出额度而**整条**未注入的词条 */
  dropped: WorldEntry[]
}

/**
 * 逐条取舍：按 ST 的口径排出「预算不够时先砍谁」。
 *
 * ST 的分配顺序（官方文档）：常量条目最先 → 然后顺序号大的 → **直接命中的优先于
 * 递归（引荐）命中的**。这里照搬，但把「顺序号大者优先」放到同级内部。
 *
 * 返回一个**从后往前砍**的序列（越靠前越该保留）：
 *   1. 常驻（`isAlwaysOn`）—— 定调内容，砍它等于整层没了
 *   2. 直接命中（`origin === 'direct'`）—— 作者写了触发词、且真被提到了
 *   3. 引荐命中 —— 被别的条目顺带拉进来的
 * 同级内按 order **降序**（大的先保留）—— 与 ST「顺序号大的先插入、影响更大」一致。
 */
function dropOrder(hits: readonly WorldEntry[], origin?: Map<WorldEntry, 'direct' | 'recursive'>): WorldEntry[] {
  const rank = (e: WorldEntry): number => {
    if (isAlwaysOn(e)) return 0
    if (!origin) return 1
    return origin.get(e) === 'recursive' ? 2 : 1
  }
  // 保留优先级高的在前 ⇒ 从尾部（优先级最低）开始砍
  return [...hits].sort((a, b) => (rank(a) - rank(b)) || (b.order - a.order))
}

/**
 * 把选中的词条渲染成注入用文本。
 *
 * 格式与 `world.ts` 的 `worldToText` **逐字一致**（`〖标题〗\n正文` 之间空一行），
 * 这样老数据（无 keys）走这里与走老的 `worldToText` 得到同样的结果 —— 等价性红线。
 *
 * 【超限行为：逐条取舍，不切字符串】（2026-10-05 改，对齐 ST）
 *   改造前是 `text.slice(0, max)` —— 会把**最后一条切一半**，作者看到的是
 *   「设定写到一半断了」，而且界面没法告诉他是哪条被切了。
 *   现在改成：按 `dropOrder` 的优先级**逐条**剔除，直到装得下。
 *   实在一条都装不下（第一条本身就超）时才回退到截断，并注明。
 *
 * 🔴 **不设 `maxChars` 时行为完全不变**（老路径的等价性）：不砍任何条目。
 */
export function renderEntries(hits: readonly WorldEntry[], opts: RenderOptions = {}): RenderResult {
  const parts: string[] = []
  for (const e of hits) {
    const body = (e.body ?? '').trim()
    const title = (e.title ?? '').trim()
    if (!body && !title) continue
    parts.push(title ? `〖${title}〗\n${body}` : body)
  }
  const max = opts.maxChars
  // 不限额 / 不超限：原样返回（老路径走这里，行为一字不变）
  if (typeof max !== 'number' || max <= 0) return { text: parts.join('\n\n'), dropped: [] }
  const full = parts.join('\n\n')
  if (full.length <= max) return { text: full, dropped: [] }

  const note = opts.truncateNote ?? '\n（世界书较长，此处已截断 —— 建议精简词条或收紧关键词）'
  // 逐条剔除：从优先级最低的开始砍
  const order = dropOrder(hits, opts.origin)
  const dropped: WorldEntry[] = []
  const kept = new Set(hits)
  let text = full
  for (let i = order.length - 1; i >= 0; i--) {
    const e = order[i]
    // 常驻条目砍到就剩它一条时仍超——那就只能截断（下面兜底），不再继续砍
    if (!kept.has(e)) continue
    const nextKept = [...kept].filter(x => x !== e)
    if (!nextKept.length) break
    const trial = nextKept
      .map(x => {
        const b = (x.body ?? '').trim()
        const t = (x.title ?? '').trim()
        return t ? `〖${t}〗\n${b}` : b
      })
      .filter(Boolean)
      .join('\n\n')
    // 砍掉这条之后装得下 ⇒ 真砍
    if (trial.length + note.length <= max + note.length) {
      kept.delete(e)
      dropped.push(e)
      text = trial
    }
    if (text.length <= max) break
  }
  // 兜底：全部砍完（或只剩常驻）仍超 ⇒ 只能截断（并注明是截断而非取舍）
  if (text.length > max) {
    text = text.slice(0, max) + note
    return { text, dropped }
  }
  return { text: dropped.length ? `${text}\n（已达本层额度，另有 ${dropped.length} 条未注入）` : text, dropped }
}

/**
 * 一步到位：选 + 渲染（调用方最常用的形态）。
 * `pool` 为空 ⇒ 返回空串（整层不出现，与既有「空设定不注入」一致）。
 *
 * `dropped` = 因额度不够被**整条**剔除的词条（界面据此如实提示，不静默丢）。
 */
export function buildWorldBookText(
  pool: readonly WorldEntry[],
  haystack: string,
  opts: PickOptions & RenderOptions = {},
): { text: string; hits: WorldEntry[]; skippedByProb: string[]; dropped: WorldEntry[]; origin: Map<WorldEntry, 'direct' | 'recursive'> } {
  if (!pool.length) return { text: '', hits: [], skippedByProb: [], dropped: [], origin: new Map() }
  const { hits, skippedByProb, origin } = pickEntries(pool, haystack, opts)
  const { text, dropped } = renderEntries(hits, { ...opts, origin })
  return { text, hits, skippedByProb, dropped, origin }
}
