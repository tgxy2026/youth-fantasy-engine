/**
 * 酒馆模式 · 输出后处理规则（路线图 B3，老大 2026-09-14 接受）
 *
 * 【要解决的问题】协议把格式写死了（对白纯文本、动作（）、环境【】），但实测总有模型不听话：
 * 用半角括号、用 *星号* 表示动作、在行首加「角色名：」。这些**不该靠重跑一次去赌**，
 * 而应该在落库之前按规则修一遍 —— 便宜、确定、可解释。
 *
 * 【为什么是「规则」而不是写死几条】
 * 不同模型的坏习惯不一样（本地小模型爱用 markdown、云端模型爱加说话人标签）。
 * 做成可编辑的正则表，作者能针对自己常用的模型调；并且**从上到下依次生效**（顺序有意义：
 * 先去 markdown 再处理单星号动作，否则 `**动作**` 会被拆成 `*（动作）*`）。
 *
 * 【两道保险】
 *   · 正则写错不能把功能弄崩：编译失败就跳过该条并记下来（`errors`），其余规则照跑；
 *   · 命中情况要能看见：界面显示「已按规则修正：…」，也能一键关掉（`postRuleNotice`）。
 *
 * 本文件是纯逻辑：无 React、无 IO、无网络。设置读写归 settings.ts。
 */

export type PostRule = {
  id: string
  /** 给人看的名字（日志里显示的就是它） */
  name: string
  /** 正则**源码**（字符串形式，方便存 JSON） */
  pattern: string
  replacement: string
  /** 默认 'gm' —— 'm' 让 ^ 匹配每一行（行首说话人标签那条要用） */
  flags?: string
  enabled: boolean
  /** 给作者看的补充说明（为什么要开/关、有什么代价）—— 面板上显示在规则下面 */
  note?: string
}

/**
 * 出厂四条。顺序即执行顺序，**别随意调换**：
 * 第 2 条必须先于第 3 条（不然 `**动作**` 会被当成单星号动作处理，留下孤立星号）。
 */
export const DEFAULT_POST_RULES: PostRule[] = [
  {
    id: 'pr-halfwidth-paren',
    name: '半角括号 → 全角',
    pattern: '\\(([^)\\n]*)\\)',
    replacement: '（$1）',
    enabled: true,
    note: '协议要求动作与神态用全角（）。空括号 （） 也会被转成全角，不影响阅读。',
  },
  {
    id: 'pr-strip-markdown',
    name: '去掉 markdown 装饰',
    pattern: '\\*\\*(.+?)\\*\\*|`([^`\\n]+)`|^#{1,6}\\s*',
    replacement: '$1$2',
    enabled: true,
    note: '去掉加粗、行内代码与行首 # 号。必须排在「星号动作」之前，否则「动作」会被拆坏。',
  },
  {
    id: 'pr-star-action',
    name: '星号动作 → （动作）',
    // 🔴 分两支：星号里已经是「（括号）」时**只去掉星号**，其余才补括号。
    //    否则「*(动作)*」会先被「半角括号→全角」转成「*（动作）*」，
    //    再被这条包一层 → 变成「（（动作））」这种双层括号。
    pattern: '\\*(?:（([^*\\n]*?)）|([^*\\n]+?))\\*',
    replacement: '（$1$2）',
    enabled: true,
    note: '模型用 *星号* 表示动作时改写成 （动作）；星号里本来就已经是（括号）的，只去掉星号，不会套成双层。',
  },
  {
    id: 'pr-no-blank-lines',
    name: '去掉空行',
    pattern: '\\n{2,}',
    // 🔴 替换串里的换行必须是**真换行字符**（'\n'），不能写 '\\n'——JS 的 String.replace 替换串只认 $1 这类，
    //    不把 '\n' 解释成换行，写成字面反斜杠 n 会原样塞进文本。
    replacement: '\n',
    enabled: true,
    note: '不允许空行：连续两个及以上的换行压成单个换行（保留段落内的单换行）。酒馆对话里空行既不好看也无意义，模型却常顺手加。',
  },
  {
    id: 'pr-break-after-paren',
    name: '括号后换行',
    // 🔴 解决「人物的语言与客观描写（动作/神态）杂糅在同一行」：右括号后若紧跟（非括号、非换行的）内容，
    //     就补一个换行，让描写与对白各占一行。已换行 / 紧接着又是一个括号块（连续动作）则不插，避免「（动作1）\n（动作2）」被拆断。
    //     必须排在 `pr-star-action` 之后 —— 星号动作先转成全角（动作），这条才认得出「）」。
    //    替换串里的 \n 同样是真换行字符。
    pattern: '）([^（\\n])',
    replacement: '）\n$1',
    enabled: true,
    note: '动作/神态的「）」之后若直接跟对白，则换行，避免描写与语言挤在一行。连续括号块（动作接动作）不插断。',
  },
  {
    id: 'pr-speaker-label',
    name: '去掉行首说话人标签',
    pattern: '^([\\u4e00-\\u9fa5A-Za-z]{2,6})[：:]\\s*',
    replacement: '',
    // 🔴 出厂**默认关**：这一条会误伤 —— 「注意：」「他说：」这类正常叙述同样以「短词 + 冒号」开头，
    //    被当成说话人标签剥掉就是真的丢了内容。协议本来就禁止行首「名字：」，模型多数也不犯；
    //    真遇到爱加标签的模型，作者在面板上打开它即可（那时他知道自己在换什么）。
    //    「可逆的错」才敢默认开，「丢内容的错」宁可默认关 —— 这条是本层唯一会删字的规则。
    enabled: false,
    note: '⚠️ 默认关：会误伤「注意：」「他说：」这类以短词加冒号开头的正常叙述（这条是唯一会删字的规则）。模型爱加说话人标签时才打开。',
  },
]

/**
 * 出厂四条的**旧版本**（`pr-star-action` 的正则会产生双层括号）。
 * 只用于升级判断：库里与它**关键字段全等** ⇒ 作者从没动过输出后处理，可安全换成新版；
 * 只要作者改过任何一条（顺序 / 开关 / 正则），就一个字都不动。
 */
export const LEGACY_DEFAULT_POST_RULES: PostRule[] = [
  {
    id: 'pr-halfwidth-paren',
    name: '半角括号 → 全角',
    pattern: '\\(([^)\\n]*)\\)',
    replacement: '（$1）',
    enabled: true,
  },
  {
    id: 'pr-strip-markdown',
    name: '去掉 markdown 装饰',
    pattern: '\\*\\*(.+?)\\*\\*|`([^`\\n]+)`|^#{1,6}\\s*',
    replacement: '$1$2',
    enabled: true,
  },
  {
    id: 'pr-star-action',
    name: '星号动作 → （动作）',
    pattern: '\\*([^*\\n]+)\\*',
    replacement: '（$1）',
    enabled: true,
  },
  {
    id: 'pr-speaker-label',
    name: '去掉行首说话人标签',
    pattern: '^([\\u4e00-\\u9fa5A-Za-z]{2,6})[：:]\\s*',
    replacement: '',
    enabled: false,
  },
]

export type PostApplied = { name: string; count: number }
export type PostResult = {
  text: string
  /** 实际命中的规则（按顺序），界面据此提示 */
  applied: PostApplied[]
  /** 编译失败 / 跳过的规则名（正则写错时给出可见的反馈，而不是静默失效） */
  errors: string[]
}

/** 只带名字的最小规则形状（设置层可能存了不完整的旧数据） */
export function normalizePostRules(raw: unknown): PostRule[] {
  if (!Array.isArray(raw)) return DEFAULT_POST_RULES.map(r => ({ ...r }))
  const out: PostRule[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const pattern = String(o.pattern ?? '')
    if (!pattern.trim()) continue // 没有正则的条目等于没写，直接丢
    out.push({
      id: String(o.id ?? '') || `pr-${out.length + 1}`,
      name: String(o.name ?? '').trim() || '未命名规则',
      pattern,
      replacement: String(o.replacement ?? ''),
      flags: typeof o.flags === 'string' && o.flags ? o.flags : 'gm',
      // 只有**明确写成 false** 才算关掉 —— 老数据缺这个字段时按开处理，
      // 免得升级时把作者已经打开的规则又静默关回去。
      enabled: o.enabled !== false,
      ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}),
    })
  }
  return out
}

/**
 * 按顺序跑一遍规则。**不做 trim、不留空**——文本形态由调用方决定。
 * 单条规则命中 0 次不算「命中」（不写进 applied，免得日志里全是没生效的项）。
 */
export function applyPostRules(text: string, rules: PostRule[]): PostResult {
  let out = String(text ?? '')
  const applied: PostApplied[] = []
  const errors: string[] = []
  for (const r of rules) {
    if (!r.enabled) continue
    let re: RegExp
    try {
      re = new RegExp(r.pattern, r.flags || 'gm')
    } catch {
      errors.push(r.name)
      continue
    }
    const count = (out.match(re) ?? []).length
    if (count === 0) continue
    out = out.replace(re, r.replacement)
    applied.push({ name: r.name, count })
  }
  return { text: out, applied, errors }
}

/** 试一段：给设置界面用（只回文本，不碰设置） */
export function previewPostRules(text: string, rules: PostRule[]): PostResult {
  return applyPostRules(text, rules)
}
