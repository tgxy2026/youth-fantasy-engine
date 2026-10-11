/**
 * 酒馆模式 · 角色卡字段模板（第 2、3 章的「细字段」）
 *
 * 【为什么动这一刀】
 * 原来的 2.1 外在、2.2 内核……都是一个大文本框，作者面对空输入框容易写成流水账，
 * 而模型最需要的恰恰是**密度**（一句话一件事）。拆成细字段后，每格只答一个问题。
 *
 * 【为什么不动底层存储（🔴 关键决策）】
 * `FreeCharacter` 的十二个字段仍是**纯字符串**，一个字节都没改。这一层只做
 *     「结构化界面」 ⇄ 「标记文本」 的**往返编解码**。
 * 这样换来三样好处：
 *   ① 记忆整理、设定更新（`revise`）、提示词渲染（`engine`）全都不用跟着改 —— 它们读到的仍是原来那段文本；
 *   ② AI 更新设定时整段替换某个字段，依旧成立（提示词里可以同样按标记输出）；
 *   ③ 老数据 / AI 自由发挥写出来的散文，**打开时整段落进「其他」**，一个字都不丢。
 *   反过来若把 profile 改成嵌套对象，这三条链路要同时重做，收益却一样。
 *
 * 【标记格式】一行一项，`标签：内容`。不在模板里的行一律归入「其他」——
 *            永远不要把认不出来的内容丢掉，那是作者一个字一个字敲的。
 */
import type { CardFieldPath } from '@/lib/tavern/types'

export type SubField = {
  key: string
  label: string
  /** 占位例句。写「什么样算填得好」，比写说明书有用 */
  ph?: string
  rows?: number
  /**
   * 给 AI 的点睛说明（**只进提示词，界面不显示**）。
   * 专治「方向容易搞反」的小项 —— 如 2.1 的「称呼」（别人怎么叫 Ta）
   * 与 2.3 的「称呼别人」（Ta 怎么叫别人）。2026-09-17 审计：实测模型会把这两个填反。
   */
  hint?: string
}

export type StructSpec = {
  /** 对应十二字段里的哪一个（这一层与它有绑定关系，不能随手改） */
  path: CardFieldPath
  /** 大栏名，界面显示用（如「2.1 外在」） */
  label: string
  /** 这一栏拆成哪几个小格 */
  items: SubField[]
  /** 是否有「其他」兜底 —— 目前全部都有：模板永远覆盖不全，得留个口子 */
  other?: boolean
}

/** 「其他」的内部键（同时也作文本标签，pack/unpack 两边共用同一常量，免得对不上） */
export const OTHER_KEY = '其他'

/**
 * 「界面上看到的名字」→「内部键」的归一化映射。
 *
 * 🔴 **为什么必须有这一层**（2026-10-11 实测事故）：
 * 界面**显示 `label`（长名）、读写用 `key`（短名）**，而解包只认 `key` ——
 * 于是作者照着界面上看到的长名写（`怎么称呼别人：…`），解包认不出，整行落进「其他」。
 * 生成脚本 / AI 起草同样是照界面长名写，一样中招。
 *
 * 受影响的是 **label ≠ key** 的四格：`称呼别人`(→怎么称呼别人)、`情绪外露`(→情绪外露程度)、
 * `不知道的`(→哪些事 Ta 不知道)、`知道的范围`(→Ta 的消息来源)。
 *
 * 【方向：双认，且归一到 key】
 *   读入侧（`unpackField` / `normalizeStructMarkup`）**同时认** key 与 label —— 老数据用
 *   label 写的、新数据用 key 写的，都能归位；写回时一律落成 key（`packField` 的形态），
 *   库里只有一种形态，导出 / 比对才不必各认一遍。
 *
 * 【为什么不在 spec 上直接改 label】
 *   label 是给人看的、key 是给代码看的，两者本就该分开；把 label 改成 key 等于抹掉可读性。
 *   这里加一层映射，界面照旧显示好读的长名，读写两侧都能对上 —— 两边都不牺牲。
 */
function buildLabelToKey(spec: StructSpec): Map<string, string> {
  const m = new Map<string, string>()
  /** 归一：去掉所有空白（空格）—— 模板里 `哪些事Ta不知道` 无空格，作者常写成 `哪些事 Ta 不知道` */
  const norm = (s: string) => s.replace(/\s+/g, '')
  for (const it of spec.items) {
    m.set(norm(it.key), it.key)
    m.set(norm(it.label), it.key)
  }
  m.set(OTHER_KEY, OTHER_KEY)
  return m
}

/** 缓存：spec 是模块级常量，映射只需建一次（同一 spec 引用即同一份表） */
const LABEL_MAP_CACHE = new WeakMap<StructSpec, Map<string, string>>()
function labelToKey(spec: StructSpec): Map<string, string> {
  let m = LABEL_MAP_CACHE.get(spec)
  if (!m) { m = buildLabelToKey(spec); LABEL_MAP_CACHE.set(spec, m) }
  return m
}

/** 第 2 章 · 人物档案：六个大栏各自的细字段 */
export const PROFILE_SPECS: StructSpec[] = [
  {
    path: 'profile.externals',
    label: '2.1 外在',
    items: [
      { key: '称呼', label: '称呼', ph: '平时别人怎么叫Ta（与卡名不同时才用填）', rows: 1, hint: '别人怎么叫Ta，不是Ta怎么叫别人' },
      { key: '性别与年龄', label: '性别与年龄', ph: '女，27 岁', rows: 1 },
      { key: '外貌', label: '外貌', ph: '短发，眼下有颗小痣；左手腕有道旧疤', rows: 2 },
      { key: '穿着', label: '穿着', ph: '总穿同一件洗旧的灰色围裙', rows: 1 },
      { key: '随身物件', label: '随身物件', ph: '一枚掉漆的打火机，从不用来点火', rows: 1 },
    ],
    other: true,
  },
  {
    path: 'profile.core',
    label: '2.2 内核',
    items: [
      { key: '性格', label: '性格', ph: '外冷内热，嘴上不留情', rows: 1 },
      { key: '喜好/爱好', label: '喜好/爱好', ph: '爱伺候花草，周末爱去旧书摊翻闲书；讨厌人多吵闹的场合', rows: 2 },
      { key: '在乎什么', label: '在乎什么', ph: '把店守好，别让常来的客人失望', rows: 1 },
      { key: '内在矛盾', label: '内在矛盾', ph: '想被关心，又不肯先开口', rows: 2 },
      { key: '怕什么', label: '怕什么', ph: '欠债的事被街坊知道', rows: 1 },
      { key: '眼下想要', label: '眼下想要', ph: '在月底之前把钱还上', rows: 1 },
    ],
    other: true,
  },
  {
    path: 'profile.speech',
    label: '2.3 语言特征',
    items: [
      { key: '句子长短', label: '句子长短', ph: '句子短，很少超过十个字', rows: 1 },
      { key: '口癖', label: '口癖 / 说话习惯', ph: '习惯用反问；从不说软话', rows: 1 },
      { key: '称呼别人', label: '怎么称呼别人', ph: '叫「喂」，熟了才叫名字', rows: 1, hint: 'Ta怎么叫别人，不是别人怎么叫Ta' },
      { key: '情绪外露', label: '情绪外露程度', ph: '不太外露，气到极点反而笑', rows: 1 },
    ],
    other: true,
  },
  {
    path: 'profile.relations',
    label: '2.4 关系',
    items: [
      { key: '与用户', label: '与用户的关系', ph: '认识三个月的常客，还算不上朋友', rows: 1 },
      { key: '与其他角色', label: '与其他角色的关系', ph: '替老板看店，欠老板一笔钱', rows: 2 },
      { key: '当前状态', label: '当前关系状态', ph: '关系正常，但上次赊账还没结', rows: 1 },
    ],
    other: true,
  },
  {
    path: 'profile.cannot',
    label: '2.5 做不到的事',
    items: [
      { key: '能力上限', label: '能力上限', ph: '不会开车，也认不出假钞', rows: 1 },
      { key: '性格硬伤', label: '性格硬伤', ph: '说不出关心的话，只能换成别的方式表达', rows: 2 },
    ],
    other: true,
  },
  {
    path: 'profile.knowledge',
    label: '2.6 知识边界',
    items: [
      { key: '不知道的', label: '哪些事Ta不知道', ph: '不知道顾客的职业与过去', rows: 2 },
      { key: '知道的范围', label: 'Ta的消息来源', ph: '只从街坊闲话与店里来客处听说', rows: 1 },
    ],
    other: true,
  },
]

/** 第 3 章 · 行为规范 */
export const CONDUCT_SPECS: StructSpec[] = [
  {
    path: 'conduct.perspective',
    label: '视角与人称',
    items: [
      { key: '人称', label: '人称', ph: '如：Ta 的视角（描写固定第三人称，不随这里改）', rows: 1 },
      { key: '能写什么', label: '能写什么', ph: '只描写Ta自己的动作与感官，不替用户编排反应', rows: 2 },
    ],
    other: true,
  },
  {
    path: 'conduct.bottomLine',
    label: '底线清单',
    items: [
      { key: '碰不得的话题', label: '碰不得的话题', ph: '别问她的债，也别提她父亲', rows: 2 },
      { key: '碰了会怎样', label: '碰了会怎样', ph: '岔开话题，再问就把话说到头', rows: 1 },
    ],
    other: true,
  },
  {
    path: 'conduct.paceLock',
    label: '进度锁',
    items: [
      { key: '当前阶段', label: '当前关系阶段', ph: '点头之交', rows: 1 },
      { key: '推进速度', label: '推进速度', ph: '慢。至少十几次交谈才到熟络', rows: 1 },
      { key: '解锁条件', label: '什么时候能往前走', ph: '她主动开口说起自己的事，才算进入下一阶段', rows: 2 },
    ],
    other: true,
  },
  {
    path: 'conduct.rating',
    label: '尺度',
    items: [
      { key: '尺度', label: '尺度', ph: '日常向', rows: 1 },
      { key: '语言界限', label: '语言界限', ph: '可以有粗口，但不带脏字的羞辱', rows: 1 },
    ],
    other: true,
  },
]

const ALL_STRUCT_SPECS: StructSpec[] = [...PROFILE_SPECS, ...CONDUCT_SPECS]

const SPECS_BY_PATH = new Map(ALL_STRUCT_SPECS.map(s => [s.path as string, s]))

/** 这个字段有没有配套的细字段模板 */
export function structSpecOf(path: string): StructSpec | null {
  return SPECS_BY_PATH.get(path) ?? null
}

/**
 * 文本 → 各小格的值。
 *
 * 🔴 **认不出来的行一律进「其他」**：
 * 可能是作者以前手打的、也可能是 AI 更新设定时写的散文 —— 任何一种丢了都是事故。
 *
 * 🔴 **认得出的是「key 或 label」两种写法**（2026-10-11）：界面显示 label、库里存 key，
 *    作者照界面写的就是 label —— 两种都认，并统一归到 key 上。详见 `labelToKey`。
 */
export function unpackField(text: string, spec: StructSpec): Record<string, string> {
  const out: Record<string, string> = {}
  const rest: string[] = []
  const map = labelToKey(spec)
  for (const item of spec.items) out[item.key] = ''
  out[OTHER_KEY] = ''

  const raw = String(text ?? '')
  if (!raw.trim()) return out

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const i = t.indexOf('：')
    if (i > 0) {
      const key = t.slice(0, i).trim()
      const val = t.slice(i + 1).trim()
      // 双认：key 或 label 都映射到内部 key（认不出则为 undefined）
      // 归一化去掉空白：数据里可能写「哪些事 Ta 不知道」（带空格），而 label 无空格
      const canonical = map.get(key.replace(/\s+/g, ''))
      if (canonical !== undefined) {
        // 同一标签出现多次 → 拼起来，别让第二行把第一行顶掉
        out[canonical] = out[canonical] ? `${out[canonical]}\n${val}` : val
        continue
      }
    }
    rest.push(t)
  }
  if (rest.length) {
    out[OTHER_KEY] = out[OTHER_KEY] ? `${out[OTHER_KEY]}\n${rest.join('\n')}` : rest.join('\n')
  }
  return out
}

/**
 * 各小格的值 → 文本。只写非空的格，按模板顺序排列，「其他」永远垫底
 * （它是兜底，摆在中间会把正经字段切断，读起来也乱）。
 */
export function packField(vals: Record<string, string>, spec: StructSpec): string {
  const lines: string[] = []
  for (const item of spec.items) {
    const v = String(vals?.[item.key] ?? '').trim()
    if (v) lines.push(`${item.key}：${v}`)
  }
  const other = String(vals?.[OTHER_KEY] ?? '').trim()
  if (spec.other && other) lines.push(`${OTHER_KEY}：${other}`)
  return lines.join('\n')
}

/**
 * 写入侧规范化：把「小项名」后面的**半角冒号**改成全角。
 *
 * 【为什么需要】（2026-09-19 审计 → 老大拍板「按写入侧规范化」）
 * 库里存的是 `小项名：内容`，解包只认**全角**冒号 —— 半角的那一行认不出标签，
 * 会整行落进「其他」：内容一个字不丢，但**归错了位**，作者看到的是
 * 「AI 明明填了这一格，界面里却在『其他』」。模型（尤其小模型）在长文本里
 * 偶发把 `：` 打成 `:` —— 它们不会照着模板逐字抄标点。
 *
 * 【为什么放写入侧，而不是把解包放宽成 `[：:]`】
 * 放宽读入侧＝把歧义长期留在**数据里**（库里两种冒号混存，任何按文本做的导出 /
 * 比对 / 统计都得各认一遍）。写入侧只管「AI 产出落库的那一瞬间」，库里永远是
 * 全角一种形态：数据是干净的，读的一侧就不必猜。
 *
 * 【只动认得出的标签】
 * 行首不是本栏小项名（也不是「其他」）的行**原样保留** —— 那些是散文
 * （「他说: 我不去」），改了就是篡改文本。
 *
 * 【双认 key 与 label（2026-10-11）】
 * 界面**显示 label、库里存 key**，作者照界面写的就是 label ⇒ 解包/规范化都要能认。
 * 归一化把下面三种都收成「key + 全角冒号」这一种形态：
 *   · `外貌: 短发`          （key + 半角）
 *   · `怎么称呼别人: 叫喂`   （label + 半角）
 *   · `情绪外露程度：藏着`   （label + 全角）
 * 已经是「key + 全角」的行（`外貌：短发`）**原样放过**，不做无意义加工。
 *
 * 认得出的标签会顺手**去掉冒号后的前导空格**，与 `packField` 的产出形态对齐
 * （`外貌：短发`）—— 解包本来就会 trim 值，所以这一步不丢任何内容。
 * 行首缩进一律保留。
 */
export function normalizeStructMarkup(text: string, spec: StructSpec): string {
  const raw = String(text ?? '')
  if (!raw || (raw.indexOf(':') < 0 && raw.indexOf('：') < 0)) return raw
  const map = labelToKey(spec)
  /** 把「内部键」的集合单独拎出来 —— 用来判断一行是不是**已经合规**（标签就是 key） */
  const keySet = new Set(spec.items.map(i => i.key))
  keySet.add(OTHER_KEY)
  const norm = (s: string) => s.replace(/\s+/g, '')
  return raw
    .split(/\r?\n/)
    .map(line => {
      // 找**最靠前**的那个冒号（全角或半角），它就是这行的标签分隔符
      const full = line.indexOf('：')
      const half = line.indexOf(':')
      const i = full < 0 ? half : (half < 0 ? full : Math.min(full, half))
      if (i <= 0) return line
      const prefix = line.slice(0, i)
      const indent = prefix.slice(0, prefix.length - prefix.trimStart().length)
      const label = prefix.trim()
      const canonical = map.get(norm(label))
      if (canonical === undefined) return line
      // 已经是内部键 + 全角 → 完全合规，原样放过（不做无意义加工）
      if (full === i && keySet.has(label)) return line
      // 其余命中（label 长名，或半角冒号）→ 归一到「key + 全角」形态
      return `${indent}${canonical}：${line.slice(i + 1).replace(/^[ \t]+/, '')}`
    })
    .join('\n')
}

/** 有几格是填了内容的（给折叠块显示进度用） */
export function filledCount(vals: Record<string, string>, spec: StructSpec): number {
  const keys = [...spec.items.map(i => i.key), ...(spec.other ? [OTHER_KEY] : [])]
  return keys.filter(k => String(vals?.[k] ?? '').trim()).length
}

/**
 * 第 2、3 章各栏「可用的小项清单」，**由模板生成**。
 *
 * 🔴 源头只有这一份：手写一遍迟早和界面那边对不上（界面加了一格、提示词没提），
 *    作者就会看到「界面有这一格、AI 从来不填」的怪事。角色卡起草（draft.ts）与
 *    小说角色转换（import.ts）都从这里取。
 */
export function structFieldLines(): string[] {
  const out: string[] = []
  for (const s of ALL_STRUCT_SPECS) {
    const keys = [
      ...s.items.map(i => (i.hint ? `${i.key}（${i.hint}）` : i.key)),
      ...(s.other ? [OTHER_KEY] : []),
    ]
    out.push(`  · ${s.path.split('.').pop()}（${s.label}）：可用小项 ${keys.join(' / ')}`)
  }
  return out
}

/**
 * 给 AI 用的格式说明（贴在设定更新 / 起草提示词里，让它按同样的标记输出）。
 * 只有理解了「我们存的就是这个样子」，AI 才能在不破坏格式的前提下改某一格。
 */
export function structHintFor(path: string): string {
  const spec = structSpecOf(path)
  if (!spec) return ''
  return `可按小项输出，一行一项，形如「${spec.items[0].key}：…」；小项只有：${spec.items.map(i => i.key).join(' / ')}（其余写进「${OTHER_KEY}」）。`
}
