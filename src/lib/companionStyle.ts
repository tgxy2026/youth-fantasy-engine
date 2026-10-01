// ============ AI 伴写 · 文风补充（多维多选，2.6.4）============
//
// 需求（老大 2026-10-02）：AI 伴写是**补作者不擅长的那一块** —— 擅长情节推进的人勾「人物描写」，
// 生成的续写就往人物身上偏；勾「环境描写」就往环境偏。所以文风补充不能只有一句话输入框，
// 也不能只有固定的两个预设（原先只有「丰富人物描写 / 环境描写」两个），要拆开、要多选。
//
// 四条设计依据：
//   1. **每项都带「怎么算做到」的引导语**（`hint`）。只把「人物描写」四个字丢给模型，它会自由发挥
//      成"他有一双深邃的眼眸"这种套话；给一句具体指引，才知道要写微表情、小动作、旁人反应。
//   2. **分组但扁平存储**：界面按 A/B/C 三组排（好扫），存下来就是一个 id 数组（好迁移、好注入）。
//   3. **互斥只提示、不硬拦**（老大定）：「白描简练」与「细腻铺陈」同时勾会互相抵消，
//      界面提示冲突，但决定权留给作者 —— 有人就是想要"整体白描、关键处铺陈"。
//   4. **全局记忆、换项目不重置**（老大定）：与既有 `companionStyleNote` 同一层级，
//      作者换项目后自己按新书调；程序不替他猜。
//
// 🔴 与《写作规范》的关系：那边是「不要做什么」的负面清单（坏习惯词 / 标点 / 视角），
//    这边是「本次往哪儿偏」的正面引导，两者同时注入、互不覆盖。

export interface StyleDimension {
  id: string
  label: string
  /** 注入给模型的引导语：说明「怎么算做到了」，别只给标签名 */
  hint: string
}

export interface StyleGroup {
  id: string
  /** 组名（界面上的小标题） */
  label: string
  /** 一句话说明这管什么 */
  desc: string
  items: StyleDimension[]
}

/** A 组：描写侧重 —— 这一段**写什么** */
export const STYLE_GROUPS: StyleGroup[] = [
  {
    id: 'depict', label: '描写侧重', desc: '这一段该把笔墨花在哪儿',
    items: [
      { id: 'character', label: '人物描写', hint: '多写外貌特征、微表情、下意识小动作与旁人的目光反应，让读者「看见」这个人' },
      { id: 'psyche', label: '心理描写', hint: '写人物此刻的念头、权衡与口是心非，用身体感受侧面写情绪，别只贴「他很愤怒」这类标签' },
      { id: 'scene', label: '环境描写', hint: '写角色当下真切看到、听到、闻到的东西，几笔带过并服务于此刻情绪，不为写景而写景' },
      { id: 'action', label: '动作与打斗', hint: '写清发力顺序、距离与身体反应，一招一式有来有回，让读者看得出胜负是怎么来的' },
      { id: 'sensory', label: '感官细节', hint: '多调动触觉、气味、温度、耳边杂音这类细微感受，替代「美丽」「壮观」等抽象形容' },
      { id: 'dialogue', label: '对白推进', hint: '用对话推情节，台词带口癖、停顿、半句话与潜台词，别让每句都逻辑完整、滴水不漏' },
    ],
  },
  {
    id: 'narrate', label: '叙事侧重', desc: '这一段该怎么往前推',
    items: [
      { id: 'plot', label: '情节推进', hint: '每段都往前推动一件事，少铺陈、少回望，尽快给出新进展与新信息' },
      { id: 'conflict', label: '冲突升级', hint: '让矛盾加码：阻力更大、代价更高、退路更少，别写着写着就平息下去' },
      { id: 'suspense', label: '悬念铺垫', hint: '埋一点尚未解答的疑问与反常之处，让读者想往下翻，但别故弄玄虚、别硬吊胃口' },
      { id: 'pacing', label: '节奏张弛', hint: '紧张段之后给一段缓口气，长短场景交替，别一路平推也别一路爆到底' },
      { id: 'callback', label: '伏笔呼应', hint: '接住前文埋过的细节、道具、人情债，让旧线头在这里收一点、亮一下' },
    ],
  },
  {
    id: 'tone', label: '氛围与笔法', desc: '这一段该是什么调子',
    items: [
      { id: 'mood', label: '情绪渲染', hint: '把气氛压进场景与动作里，靠细节传递情绪，而不是直接宣告人物心情' },
      { id: 'imagery', label: '画面感', hint: '写能被「拍下来」的具体画面：位置关系、光线、物件、人的姿态' },
      { id: 'blank', label: '留白', hint: '该省就省，不把话说尽，给读者留出自己补完的空间' },
      { id: 'humor', label: '幽默轻松', hint: '加一点吐槽、俏皮话或反差喜感，让气氛松一口气（不破坏主线时）' },
      { id: 'plain', label: '白描简练', hint: '短句为主，少修饰，只给必要信息，干净利落' },
      { id: 'detailed', label: '细腻铺陈', hint: '慢下来细写，多层感受与细节叠加，把这一处写透' },
      { id: 'classical', label: '古风韵味', hint: '用词偏古雅，句式带韵律，可用成语与对仗，但别堆砌辞藻' },
    ],
  },
]

/** id → 维度（含它所属的组名，注入与提示都要用） */
export const STYLE_DIM_BY_ID: Record<string, StyleDimension & { group: string }> = (() => {
  const out: Record<string, StyleDimension & { group: string }> = {}
  for (const g of STYLE_GROUPS) for (const it of g.items) out[it.id] = { ...it, group: g.label }
  return out
})()

export const STYLE_DIM_IDS: string[] = STYLE_GROUPS.flatMap(g => g.items.map(i => i.id))

/**
 * 互斥对：**同时勾选会互相抵消**的组合。
 * 只提示、不硬拦（老大定）—— 有人就是想要「整体白描、关键处铺陈」，
 * 强行禁用会让他没法表达。注入时也不做删改，如实把两项都交给模型。
 */
export const STYLE_CONFLICTS: ReadonlyArray<readonly [string, string]> = [
  ['plain', 'detailed'],   // 简练 vs 铺陈
  ['blank', 'detailed'],   // 留白 vs 铺陈
]

/**
 * 稀释阈值：勾超过这个数就提示「选太多会互相稀释」。
 * 伴写一次只续一两句话，五个侧重挤进去，模型只能每个都浅尝一口 —— 等于没选。
 */
export const STYLE_DILUTE_AT = 3

const STORAGE_KEY = 'novel-companion-dims'

/** 读取已勾选的维度（本机全局记忆；脏数据 / 旧 id 会被过滤掉） */
export function loadStyleDims(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((x: unknown): x is string => typeof x === 'string' && x in STYLE_DIM_BY_ID)
  } catch { return [] }
}

/** 落盘（空数组则清掉键，不留 `"[]"` 这种垃圾） */
export function saveStyleDims(ids: string[]): void {
  try {
    if (!ids.length) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch { /* 隐私模式下 localStorage 不可写：功能降级，不阻断 */ }
}

/** 与 `id` 互斥、且当前已勾选的维度 id（供界面标红提示） */
export function conflictsOf(ids: string[], id: string): string[] {
  const out: string[] = []
  for (const [a, b] of STYLE_CONFLICTS) {
    if (id === a && ids.includes(b)) out.push(b)
    else if (id === b && ids.includes(a)) out.push(a)
  }
  return out
}

/** 当前勾选里存在的所有冲突对（供界面顶部汇总提示） */
export function activeConflicts(ids: string[]): ReadonlyArray<readonly [string, string]> {
  return STYLE_CONFLICTS.filter(([a, b]) => ids.includes(a) && ids.includes(b))
}

/** 勾选数是否超过稀释阈值 */
export function isDiluted(ids: string[]): boolean {
  return ids.length > STYLE_DILUTE_AT
}

/** id 数组 → 「人物描写 / 环境描写」这样的显示串 */
export function dimLabels(ids: string[], sep = ' / '): string {
  return ids.map(i => STYLE_DIM_BY_ID[i]?.label ?? i).join(sep)
}

/**
 * 把「勾选的维度 + 作者一句话」合成注入给模型的文风要求文本（**纯函数，可单测**）。
 *
 * @returns 合成好的文本；**两项都为空时返回空串** —— 调用方拿到空串就整层不注入，
 *          省掉一句「（无）」占位污染提示词。
 *
 * 顺序刻意把**作者原话放最后**：提示词末段权重最高，而原话是作者亲手写的、
 * 比任何预设维度都更该被服从（两者打架时以原话为准，这条也写在注入文本里）。
 */
export function buildStyleNote(dims: string[], custom: string): string {
  const note = (custom ?? '').trim()
  const picked = dims.filter(d => d && d in STYLE_DIM_BY_ID)
  if (!picked.length && !note) return ''
  const lines: string[] = []
  if (picked.length) {
    lines.push('作者勾选了本次要侧重的方面（按此落笔，没勾的方面保持前文既有写法、不要刻意加戏）：')
    for (const d of picked) lines.push(`· ${STYLE_DIM_BY_ID[d].label} —— ${STYLE_DIM_BY_ID[d].hint}`)
  }
  if (note) {
    lines.push(`作者原话（优先级最高，与上面冲突时以原话为准）：${note}`)
  }
  return lines.join('\n')
}
