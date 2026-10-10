/**
 * 酒馆模式 · 单向桥：小说角色 → 自由模式角色卡（方案 §7.6）
 *
 * 【为什么必须用 AI 转换，不能机械映射】
 * 小说角色卡的字段是 **schema 驱动**的（`模块::字段` 形式，字段名千奇百怪，
 * 各表还不一样），与四章结构不是一一对应关系。机械映射做不到 —— 这条是作者拍板的。
 *
 * 【两条必须做的】
 *   1. 转换结果记 `importedFrom`（来源项目 / 卡片 / 时间），便于溯源
 *   2. **明确告知作者这是 AI 生成的草稿、必须审** —— 尤其第 4 章示例对话通常是编的
 *
 * 【提示词里必须写死的一条】
 * **不许编造设定**：小说卡里没有的信息一律留 `〖待补〗`，不要「合理推测」补上。
 * 否则作者会拿到一张看起来完整、实则混了一半假信息的卡 —— 那比空着危险得多。
 *
 * 本文件是纯逻辑 + 提示词；提示词与解析都按「段落标记」而不是 JSON ——
 * 四章带嵌套，让模型输出深层 JSON 很容易在转义/层级上出错，段落标记则天然抗噪。
 */
import { chat, isCancelled, type ChatMessage } from '@/lib/ai'
import { resolveTavernProvider, type ChatFn } from '@/lib/tavern/provider'
import { getTavernSettings, timeoutMsOf } from '@/lib/tavern/settings'
import { emptyFreeCharacter, type FreeCharacter } from '@/lib/tavern/types'
import { authorBlock, newAuthorFence } from '@/lib/ai/promptGuard'
import { structFieldLines } from '@/lib/tavern/cardFields'

/** 缺失信息的标记：提示词要求模型用它，UI 据此提醒作者去补 */
export const MISSING_TAG = '〖待补〗'
/**
 * 老标记（2026-09-16 前的 `【待补】`）。
 * 🔴 `【】` 已废止（输出协议 v1.7），输入侧统一走 `〖〗` —— 但**解析仍要认旧的**：
 *    模型可能还带着旧习惯输出，认不出就会把「待补」当成正文写进卡里。
 */
const LEGACY_MISSING_TAG = '【待补】'

/** 转换结果的四章草稿（不含 id / 时间） */
export type CardDraft = Omit<FreeCharacter, 'id' | 'createdAt' | 'updatedAt'>

export function buildImportSystem(): string {
  return `你在把一份**小说角色设定**改写成「角色扮演用」的角色卡。

〖为什么不能照抄〗
小说卡写的是「Ta在故事里是什么人」（含大量剧情走向、作者视角的规划）；
角色卡写的是「**该怎么演Ta**」—— 落在口吻、习惯、底线这些能直接影响言行的地方。
所以你要**改写**：把设定翻译成行为倾向，把剧情信息丢掉或压缩成背景。

〖四章结构（标题一字不差，每章另起一行写内容）〗
〖第 1 章 · 角色与设定的关系〗
Ta在这个世界里的位置与处境（身份、常去的地方、这个世界怎么影响 Ta、与「用户」的初始关系）。
**不写世界本身** —— 世界观另有归属，这里只写 Ta 与它的关系。

〖第 2、3 章怎么写 —— 硬要求〗
每一栏都**按小项分条写、一行一项**，形如「外貌：短发」。**不要写成一整段** ——
界面是按小项拆开显示的，写成整段会整段落进「其他」，作者还得重新分拣。
模板里没有、但又确实该写的，放进该栏的「其他」小项。各栏可用的小项：
${structFieldLines().join('\n')}

〖2.1 外在〗
外貌、穿着、有记忆点的小特征。
〖2.2 内核〗
性格、在乎的东西、内在矛盾。
〖2.3 语言特征〗
怎么说话：句子长短、口头禅、语气习惯。**这一项非常重要** —— 决定Ta像不像。
〖2.4 关系〗
与其他角色的关系（只写与扮演有关的）。
〖2.5 做不到的事〗
能力与性格上的硬限制（写了它就不会突然全能、突然开窍）。
〖2.6 知识边界〗
哪些事Ta不知道（写了它就不会「恰好知道」）。
〖第 3 章 · 行为规范〗
视角与人称：以谁的视角看这件事（认知视角按角色定，如「Ta 的视角」）；**落笔的描写固定用第三人称**，只写Ta自己的动作与感官，不替用户编排反应。
底线清单：碰到会怎样（写反应，不写理由）。
进度锁：关系推进的速度。
尺度：内容尺度边界。

〖第 4 章 · 示例对话〗
写三段**短**对话示例，覆盖三种不同侧面：常态 / 被戳到时 / 松动时。
格式硬要求（必须与系统的扮演协议一致，会被模型直接照抄）：
· 对方的台词 —— 用〖对方〗起头。这是**输入侧的结构标注**，正式输出里不会出现；
· Ta 的台词 —— 直接写，**不加引号、不加括号、不写名字、也不单独起一行标"谁在说"**，标点照常；
· 动作、神态、心理与客观环境 —— 全部用**全角括号（ ）**包住、一件事一个括号、独立成行
  （光线、天气、声音，以及对面那个人的穿着与姿态都算环境，同样写在（ ）里）；
· **描写一律第三人称** —— 括号里指代人物写名字、写「他」「她」，或按中文习惯省略主语，
  **不要写「我」「你」**（只有对白里才说「我」「你」，那是人物自己说的话）；性别未定的角色一律用「Ta」。
每段一两句就够，不要写成剧情。

〖三条硬要求〗
1. **不许编造**。小说卡里没有依据的信息，一律写「${MISSING_TAG}」，绝对不要推测补全。
2. **丢掉剧透**。小说卡里的结局、后续发展、作者规划一律不要写进角色卡
   —— 角色卡是给Ta演当下用的，Ta不该知道自己后面会怎样。
3. 只输出上面那些标题与内容，不要寒暄、不要解释、不要输出分析过程。`
}

/** 把小说卡片的数据渲染成可读文本（键是「模块::字段」形式，去掉模块前缀） */
export function renderNovelChar(name: string, data: Record<string, string>): string {
  const lines = Object.entries(data)
    .map(([k, v]) => {
      const field = k.includes('::') ? k.slice(k.lastIndexOf('::') + 2) : k
      const val = String(v ?? '').trim()
      return val ? `${field}：${val}` : null
    })
    .filter((x): x is string => !!x)
  return [`〖角色名〗${name}`, ...lines].join('\n')
}

/** 段落标题匹配（宽松：允许【】包裹、「一、」序号、加粗） */
/**
 * 段落标题 → 字段。
 * ⚠️ 这里只匹配**纯名字** —— 所有序号变体（「第 1 章」「2.5」「一、」「1.」）
 * 都在 normalizeTitle 里统一剥掉。两处若各管一半，就会出现
 * 「裸化去掉了 2.1、正则还要求 ^2」这种对不上的情况（踩过）。
 */
const T = {
  // 🔴 2026-09-16 起新标题是「角色与设定的关系」（世界观搬去故事层）；
  //    旧名（世界 / 世界观 / 背景）**继续认** —— 老卡与老模型的输出还带着它们。
  world: /^(角色与设定的关系|角色与世界的关系|与设定的关系|世界|世界观|背景)$/,
  externals: /^(外在|外貌|外表)$/,
  core: /^(内核|性格|内心)$/,
  speech: /^(语言特征|说话风格|语言|口吻)$/,
  relations: /^(关系|人际关系)$/,
  cannot: /^(做不到的事|能力与限制|限制)$/,
  knowledge: /^(知识边界|不知道的事)$/,
  perspective: /^(视角与人称|视角|人称)$/,
  bottomLine: /^(底线清单|底线)$/,
  paceLock: /^(进度锁|进度)$/,
  rating: /^(尺度|内容尺度)$/,
  /**
   * 🔴 第 3 章是**容器标题**（内容由下面四行键值 `视角与人称：…` 承担）。
   *    必须认出来并**丢弃**：不认的话 `normalizeTitle` 剥完「第 3 章 ·」剩下「行为规范」，
   *    匹配不到任何字段 → 落进 `rest` → 被追加到**上一栏**（实测污染「2.6 知识边界」）（审计 P0-3）。
   *    这里没有 `get('chapter3')`，等于把容器行丢掉 —— 正是想要的行为。
   *    万一模型把第 3 章写成不带键名的散行，那些行也会一并丢掉；
   *    比塞进「知识边界」污染档案好，且提示词本来就要求键值格式。
   */
  chapter3: /^行为规范$/,
  examples: /^(示例对话|对话示例|示例)$/,
}

/**
 * 把一行标题剥成纯名字：去掉包裹符号、加粗标记、各种序号前缀。
 *   「〖第 1 章 · 角色与设定的关系〗」→ 「角色与设定的关系」
 *   「## 2.5 做不到的事」→ 「做不到的事」
 *   「一、示例对话」/「1. 世界」→ 同样只剩名字
 */
function normalizeTitle(line: string): string {
  return line
    .replace(/[\s*#]/g, '')
    .replace(/^[【\[（(]+/, '')
    .replace(/[】\]）)]+$/, '')
    // 「第 1 章 ·」「第4章.」这类章节前缀
    .replace(/^第[一二三四五六七八九十\d]+[章卷节][·.、]?/, '')
    .replace(/^[一二三四五六]、/, '')
    // 「2.5」「1.」这类数字序号（含小数）
    .replace(/^(\d+(\.\d+)?)[.、]?/, '')
}

/** 解析模型输出的四章草稿（空段留空，不报错） */
export function parseCardDraft(text: string): CardDraft {
  const base = emptyFreeCharacter()
  const raw = String(text ?? '').replace(/\r\n/g, '\n')

  // 先把「标题 + 同行内容」拆开，再按标题分段
  const buckets: Record<string, string[]> = {}
  let current: string | null = null

  const titleOf = (line: string): string | null => {
    const bare = normalizeTitle(line)
    for (const [key, re] of Object.entries(T)) {
      if (re.test(bare)) return key
    }
    return null
  }

  for (const line of raw.split('\n')) {
    const body = line.trim()
    if (!body) continue
    const whole = titleOf(body)
    if (whole) { current = whole; buckets[current] ??= []; continue }
    const m = body.match(/^[〖【\[（(]\s*([^〗】\]）)]+?)\s*[〗】\]）)]\s*(.*)$/)
    if (m) {
      const hit = titleOf(m[1])
      if (hit) {
        current = hit
        buckets[current] ??= []
        if (m[2].trim()) buckets[current].push(m[2].trim())
        continue
      }
    }
    // ② 行内键值：「视角与人称：以谁的视角看这件事……」
    //    提示词给第 3 章的正是这种风格（容器标题 + 键值行），不认它整章都会丢。
    const kv = body.match(/^([^：:]{2,14})\s*[:：]\s*(.+)$/)
    if (kv) {
      const hit = titleOf(kv[1])
      if (hit) {
        current = hit
        ;(buckets[hit] ??= []).push(kv[2].trim())
        continue
      }
    }
    if (current) (buckets[current] ??= []).push(body)
  }

  const get = (k: string) => (buckets[k] ?? []).join('\n').trim()
  base.world = get('world')
  base.profile = {
    externals: get('externals'), core: get('core'), speech: get('speech'),
    relations: get('relations'), cannot: get('cannot'), knowledge: get('knowledge'),
  }
  base.conduct = {
    perspective: get('perspective'), bottomLine: get('bottomLine'),
    paceLock: get('paceLock'), rating: get('rating'),
  }
  base.examples = get('examples')
  return base as CardDraft
}

/** 草稿里哪些地方还欠着信息（UI 必须显示，让作者知道要去补哪里） */
export function draftGaps(draft: CardDraft): string[] {
  const gaps: string[] = []
  // 新旧标记都算欠信息（老模型可能还输出【待补】）
  const check = (label: string, v: string) => {
    const t = String(v ?? '')
    if (t.includes(MISSING_TAG) || t.includes(LEGACY_MISSING_TAG)) gaps.push(label)
  }
  // 全部字段都过一遍 —— 只抽查几项的话，作者会以为「没提示=都填好了」
  check('第 1 章 · 角色与设定的关系', draft.world)
  check('2.1 外在', draft.profile.externals)
  check('2.2 内核', draft.profile.core)
  check('2.3 语言特征', draft.profile.speech)
  check('2.4 关系', draft.profile.relations)
  check('2.5 做不到的事', draft.profile.cannot)
  check('2.6 知识边界', draft.profile.knowledge)
  check('视角与人称', draft.conduct.perspective)
  check('底线清单', draft.conduct.bottomLine)
  check('进度锁', draft.conduct.paceLock)
  check('尺度', draft.conduct.rating)
  if (!draft.examples.trim()) gaps.push('第 4 章 · 示例对话（通常是模型编的，务必自己改）')
  else check('第 4 章 · 示例对话', draft.examples)
  return gaps
}

export type ConvertArgs = {
  /** 小说角色的名字 */
  name: string
  /** 小说卡片的原始数据（键为「模块::字段」） */
  data: Record<string, string>
  /** 来源（写进 importedFrom，便于溯源） */
  source?: { projectId: string; cardId: string }
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
}

/**
 * 跑一次转换。**不落库** —— 返回的是草稿，由作者在表单里审完再保存（方案 §7.6 硬要求）。
 */
export async function convertNovelChar(args: ConvertArgs): Promise<{ draft: CardDraft; gaps: string[] }> {
  const { name, data, source, providerId, chatFn, signal } = args
  const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
  const runChat = chatFn ?? chat

  const msgs: ChatMessage[] = [
    { role: 'system', content: buildImportSystem() },
    {
      role: 'user',
      content: [
        '〖小说角色设定原文〗',
        // 🔴 小说卡原文属作者文本，包边界（审计 P1-14）——全项目唯一一处没包的作者原文
        authorBlock(newAuthorFence(), renderNovelChar(name, data)),
        '',
        '请按四章结构改写成角色扮演用的角色卡。',
      ].join('\n'),
    },
  ]

  const reply = await runChat(provider, msgs, {
    timeoutMs: timeoutMsOf(await getTavernSettings()),
    signal,
    think: false,
  })

  const draft = parseCardDraft(reply)
  // 名字用原文的（模型可能改写名字，那是它不该动的东西）
  draft.name = name
  if (source) draft.importedFrom = { projectId: source.projectId, cardId: source.cardId, at: Date.now() }
  return { draft, gaps: draftGaps(draft) }
}

export { isCancelled }
