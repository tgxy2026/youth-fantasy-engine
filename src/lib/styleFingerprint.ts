/**
 * 文风指纹（2.8.0 · 台账 #015）。
 *
 * 【要解决的问题】作者写了一段时间后，自己的文风是**隐性**的 —— 想让 AI 续写 / 改写贴合，
 * 只能靠「作者本次追加的文风要求」手打一句话（`companionStyle.ts` 的维度是**预设枚举**，
 * 表达的是"这次想往哪儿偏"，不是"作者本来就是什么味道"）。
 *
 * 【设计】把作者的参考文本（1~2 段 / 已有章节 / 导入 txt）炼成一份**可命名的文风档**：
 *   · **本地统计打底**（`analyzeStyleMetrics`，确定性、可单测、不外发）；
 *   · **AI 只负责归纳措辞**（`style-fingerprint` 提示词，json、温度 0.3）—— 把数字翻译成"人话特征"。
 *   两者都进档，注入时用 `buildFingerprintNote` 拼成一段提示词层。
 *
 * 🔴 三条红线：
 *   ① **空档 / 无档 ⇒ 整层不注入**（`buildFingerprintNote(null) === ''`）—— 升级后行为与改造前**零变化**；
 *   ② **只学风格，不照搬原文**（提示词里写死）—— 参考文本可能是别人的作品，逐字复制等于抄袭；
 *   ③ **立场红线**：这是文风质量功能，**不是反检测功能** —— 不许出现"过检测 / 降 AI 率"这类话术
 *      （`tests/deAiStyle.test.ts` 第 3 组守的就是这条，本模块另有单测同守）。
 *
 * 🔴 本模块**不 import 任何 UI**，也不新增存储表 —— 文风档**按项目存**（2026-10-04 主人拍板：
 *    从「全局」改成「跟项目走」—— 不同题材 / 不同笔名的书本来就该有各自的文风档，
 *    全局一套会让「写仙侠的档」污染「写都市的书」）。落在 `settingsKV` 的 `styleFingerprints`
 *    + `activeStyleFingerprint` 两个键上，经 `getSetting` / `setSetting` 自动带 `${currentProjectId}::` 前缀
 *    （与自定义敏感词 / 取名收藏同一套机制）；删项目时由 `deleteProject` 的前缀清理顺带带走。
 *
 * ⚠️ 命名说明：本模块的 `StyleProfile` 与 `manuscriptCheck.ts` 的 `StyleFingerprint`（**单章**行文
 *    统计）**不是一回事** —— 后者是"这一章写得怎么样"的一次性体检，前者是"作者一贯什么味道"的可命名档案。
 *    两者刻意不复用同一个类型名，避免调用方 import 时混淆。
 */
import * as db from './db'
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from './ai'
import type { PromptDef } from './promptSettings'
import { parseLooseObject, asText } from './aiParse'
import { analyzeStyle } from './manuscriptCheck'
import { countWords } from './textStats'
import { uid } from './id'

/** 「文风指纹」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_style_fingerprint = `你是中文网络小说的文风分析助手。作者会给你一段或多段他的**参考文本**，以及一份程序统计出的量化特征。请只依据这些内容，归纳出这位作者的写作风格特征。

硬性规则：
1. 返回 JSON 对象，形如 {"summary":"两三句话的整体文风概括","traits":["特征短语"],"dos":["宜：写作时应保持的倾向"],"donts":["忌：容易丢掉或不符的味道"]}。
2. **只学风格特征，不得照搬原文句子** —— 参考文本可能来自他人作品；你的输出是"风格描述"，绝不能出现原句、也不要改写原句。
3. 描述要具体、可执行（如「短句为主、对话密集、少用形容词」），不要写「文笔优美」这类空话。
4. traits / dos / donts 各 3~6 条，每条一句话。
5. 量化特征只作参考 —— 与你的阅读感受冲突时，以文本本身为准。
6. 只输出 JSON，不要解释、不要 markdown 代码块标记。`

/** 参考文本的量化特征（本地统计，确定性 —— 同一文本跑两遍必然一致） */
export interface StyleMetrics {
  /** 句数 */
  sentenceCount: number
  /** 平均句长（汉字） */
  avgSentenceLen: number
  /** 句长离散度（变异系数：越小越"整齐"） */
  sentenceLenSpread: number
  /** 对话占比（引号内字数 / 总字数，0~1，保留三位小数） */
  dialogueRatio: number
  /** 标点密度（每千字标点数） */
  punctuationDensity: number
  /** 四字格密度（每千字，近似口径 —— 见 `countFourCharRuns`） */
  idiomDensity: number
  /** 高频重复词（同一文本内出现 ≥3 次的三字词组，取自 `analyzeStyle`） */
  repeatedWords: string[]
}

/** 一份可命名的文风档 */
export interface StyleProfile {
  id: string
  name: string
  createdAt: number
  /** 来源：从参考文本提炼 / 作者手动建的（只填 note） */
  source: 'analyzed' | 'manual'
  /** 参考文本的原始字符数（让作者知道这份档基于多少字） */
  sampleChars: number
  /** 本地统计（确定性，可单测） */
  metrics: StyleMetrics
  /** AI 归纳的可读描述 */
  aiSummary: string
  /** 特征短语（AI） */
  traits: string[]
  /** 宜（AI） */
  dos: string[]
  /** 忌（AI） */
  donts: string[]
  /** 作者补充（优先级最高，注入时钉在最后） */
  note?: string
}

const K_LIST = 'styleFingerprints'
const K_ACTIVE = 'activeStyleFingerprint'

/** 产档的最短参考文本（汉字数）—— 太少提炼不出可靠特征，宁可明确报错 */
export const MIN_SAMPLE_WORDS = 120

// ============ 本地统计（纯函数，确定性） ============

// 🔴 字符类里的 **ASCII 引号一律写成 `\x27` / `\x22`**（弯引号不受影响，照写）：
//    `tests/structureGates.test.ts` 的剥离器不认识正则字面量，裸 `'` / `"` 会把它的状态机带偏，
//    于是**从这一行起整份文件对闸门静默失明**（第 ③-b 条就会把一个有函数的文件报成「纯字面量」，
//    ④⑤⑥ 三条对它的检查也全部失效）。这正是项目红线说的「工具的结构假设会静默失明」。
const PUNCT_RE = /[，。！？、；：""''（）()【】《》…—·,.!?;:\x27\x22()[\]{}<>-]/g
const IDIOM_RE = /(?<![\u4e00-\u9fa5])[\u4e00-\u9fa5]{4}(?![\u4e00-\u9fa5])/g

/** 标点总数（中英文常见标点） */
export function countPunctuation(text: string): number {
  return (String(text ?? '').match(PUNCT_RE) ?? []).length
}

/**
 * 四字格出现次数（**近似口径**）。
 * 中文没有分词，这里用「恰好 4 个连续汉字、且左右都不是汉字」做代理 ——
 * 它能稳定抓到独立成词的成语（"莫名其妙。""，面面相觑，"），但会漏掉嵌在长短语里的成语。
 * 所以它在提示词里只作**倾向参考**，不作结论。
 */
export function countFourCharRuns(text: string): number {
  return (String(text ?? '').match(IDIOM_RE) ?? []).length
}

/**
 * 对白的汉字数（引号式 + 冒号式，**不重复计**）。
 *
 * 中文小说写对白有两种常见形态，只认一种会让「对话占比」明显失真：
 *   · 引号式：`“你走吧。”她说。`
 *   · 冒号式：`他说：今天赢了。`
 * 所以两种都算；冒号后面**紧跟引号**时按引号算过一次了，这里跳过（否则同一句算两遍）。
 * ⚠️ 冒号在非对白处也有（「注意：…」），这是**近似口径** —— 它只用来给"这段是否以对白为主"一个倾向，
 *    不作结论，注入提示词时也只作为参考行。
 */
export function countDialogueWords(text: string): number {
  const s = String(text ?? '')
  let sum = 0
  const spans: Array<[number, number]> = []
  const quoteRe = /[“「『][^”」』]*[”」』]|\x22[^\x22]*\x22/g
  let m: RegExpExecArray | null
  while ((m = quoteRe.exec(s)) !== null) {
    sum += countWords(m[0])
    spans.push([m.index, m.index + m[0].length])
  }
  const colonRe = /[：:]\s*([^。！？!?…\n]{1,80})/g
  while ((m = colonRe.exec(s)) !== null) {
    const seg = m[1]
    const start = m.index + m[0].length - seg.length
    if (spans.some(([a, b]) => start >= a && start < b)) continue
    sum += countWords(seg)
  }
  return sum
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * 多段参考文本 → 量化特征（**本地统计打底**）。
 * 复用 `manuscriptCheck.analyzeStyle`（句长 / 离散度 / 重复词口径的单一真源），只补对话占比、
 * 标点密度、四字格密度三项它没有的。
 */
export async function analyzeStyleMetrics(texts: string[]): Promise<StyleMetrics> {
  const body = (texts ?? []).filter(t => typeof t === 'string' && t.trim()).join('\n\n')
  const fp = analyzeStyle(body)
  const words = fp.words || 0
  const per1k = (n: number) => (words > 0 ? round1((n / words) * 1000) : 0)
  const dialogueWords = countDialogueWords(body)

  return {
    sentenceCount: fp.sentences,
    avgSentenceLen: fp.avgSentenceLen,
    sentenceLenSpread: fp.sentenceCv,
    dialogueRatio: words > 0 ? round3(dialogueWords / words) : 0,
    punctuationDensity: per1k(countPunctuation(body)),
    idiomDensity: per1k(countFourCharRuns(body)),
    repeatedWords: fp.repeatedGrams.slice(0, 8).map(g => g.gram),
  }
}

/** 把量化特征写成一行给模型看（也是注入文本里"量化特征"那一行的来源） */
export function metricsLine(m: StyleMetrics): string {
  return `平均句长 ${m.avgSentenceLen} 字；句长离散度 ${m.sentenceLenSpread}；对话占比 ${Math.round(m.dialogueRatio * 100)}%；标点密度 ${m.punctuationDensity}/千字；四字格密度 ${m.idiomDensity}/千字`
}

// ============ 提炼 ============

function strArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asText).filter(Boolean)
  const s = asText(v)
  return s ? [s] : []
}

export interface ExtractOptions {
  name?: string
  signal?: AbortSignal
  /** 注入点（单测用）：默认走真实 `chat` */
  chatFn?: typeof chat
}

/**
 * 从参考文本提炼一份文风档：本地统计 + AI 归纳措辞。
 * @throws 参考文本不足 `MIN_SAMPLE_WORDS` 字时抛出（界面据此提示，不产半成品档）
 */
export async function extractFingerprint(texts: string[], opts: ExtractOptions = {}): Promise<StyleProfile> {
  const joined = (texts ?? []).filter(t => typeof t === 'string' && t.trim()).join('\n\n').trim()
  const words = countWords(joined)
  if (words < MIN_SAMPLE_WORDS) {
    throw new Error(`参考文本太短（当前约 ${words} 字）—— 至少给 ${MIN_SAMPLE_WORDS} 字，才能提炼出可靠的文风特征。`)
  }
  const metrics = await analyzeStyleMetrics(texts)

  // AI 归纳：走「批量整理」用途路由 —— 它是一次性分析，不必烧最好的模型
  const cfg = await requireProviderFor('utility')
  const callChat = opts.chatFn ?? chat
  const user = [
    '【参考文本】',
    joined,
    '',
    '【本地统计出的量化特征（仅供参考）】',
    metricsLine(metrics),
    metrics.repeatedWords.length ? `重复词：${metrics.repeatedWords.join('、')}` : '',
  ].filter(Boolean).join('\n')

  const text = await callChat(cfg, [
    { role: 'system', content: composeSystemPrompt(P_style_fingerprint, cfg) },
    { role: 'user', content: user },
  ], { json: true, timeoutMs: CHAT_TIMEOUT_MS, signal: opts.signal })

  const obj = parseLooseObject(text) ?? {}
  return {
    id: uid(),
    name: (opts.name ?? '').trim() || `文风档 ${new Date().toLocaleDateString('zh-CN')}`,
    createdAt: Date.now(),
    source: 'analyzed',
    sampleChars: joined.length,
    metrics,
    aiSummary: asText(obj.summary ?? obj['概括']),
    traits: strArr(obj.traits ?? obj['特征']),
    dos: strArr(obj.dos ?? obj['宜']),
    donts: strArr(obj.donts ?? obj['忌']),
  }
}

// ============ 注入文本（纯函数） ============

/**
 * 文风档 → 提示词层文本。
 * @returns **空档 / 全空档返回空串** —— 调用方拿到空串就整层不注入（升级零行为变化）。
 * 顺序刻意把**作者补充**放最后：提示词末段权重最高，作者亲手写的优先于 AI 归纳。
 */
export function buildFingerprintNote(fp: StyleProfile | null): string {
  if (!fp) return ''
  const lines: string[] = [`【本书文风档：${fp.name}】`]
  const summary = (fp.aiSummary ?? '').trim()
  if (summary) lines.push(summary)
  if (fp.traits.length) lines.push(`· 用词倾向：${fp.traits.join('；')}`)
  if (fp.dos.length) lines.push(`· 宜：${fp.dos.join('；')}`)
  if (fp.donts.length) lines.push(`· 忌：${fp.donts.join('；')}`)
  if (fp.metrics) lines.push(`· 量化特征：${metricsLine(fp.metrics)}`)
  const note = (fp.note ?? '').trim()
  if (note) lines.push(`· 作者补充（优先级最高）：${note}`)
  // 只有档名（其余全空）时也算"有内容" —— 至少告诉模型这个档存在；但纯空壳则不注入
  if (lines.length === 1 && !fp.name.trim()) return ''
  return lines.join('\n')
}

// ============ 存储（按项目 · settingsKV 前缀键） ============

/** 脏数据归一：任何字段缺失 / 类型不对都不该让整个档挂掉 */
function normProfile(raw: unknown): StyleProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = asText(o.id)
  if (!id) return null
  const m = (o.metrics ?? {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    id,
    name: asText(o.name) || '（未命名文风档）',
    createdAt: num(o.createdAt),
    source: o.source === 'manual' ? 'manual' : 'analyzed',
    sampleChars: num(o.sampleChars),
    metrics: {
      sentenceCount: num(m.sentenceCount),
      avgSentenceLen: num(m.avgSentenceLen),
      sentenceLenSpread: num(m.sentenceLenSpread),
      dialogueRatio: num(m.dialogueRatio),
      punctuationDensity: num(m.punctuationDensity),
      idiomDensity: num(m.idiomDensity),
      repeatedWords: strArr(m.repeatedWords),
    },
    aiSummary: asText(o.aiSummary),
    traits: strArr(o.traits),
    dos: strArr(o.dos),
    donts: strArr(o.donts),
    ...(asText(o.note) ? { note: asText(o.note) } : {}),
  }
}

/**
 * 读当前项目的全部文风档。空库 / 异常 / 未开项目一律回退空数组 ——
 * 文风档读不出来不该让任何 AI 功能挂掉。
 * 🔴 用 `getSetting`（**按项目**）而不是 `getMeta`（全局）：换项目就该读到另一套。
 */
export async function loadFingerprints(): Promise<StyleProfile[]> {
  try {
    const raw = await db.getSetting<unknown>(K_LIST, [])
    if (!Array.isArray(raw)) return []
    return raw.map(normProfile).filter((x): x is StyleProfile => x !== null)
  } catch {
    return []
  }
}

/** 写当前项目的全部文风档（同时让当前启用档的内存缓存失效） */
export async function saveFingerprints(list: StyleProfile[]): Promise<void> {
  await db.setSetting(K_LIST, list)
  invalidateFingerprintCache()
}

/** 读当前项目启用的文风档 id（空串 = 未启用） */
export async function loadActiveFingerprintId(): Promise<string> {
  try {
    return asText(await db.getSetting<unknown>(K_ACTIVE, ''))
  } catch {
    return ''
  }
}

/** 启用 / 停用某个文风档（传空串 = 停用） */
export async function saveActiveFingerprintId(id: string): Promise<void> {
  await db.setSetting(K_ACTIVE, id || '')
  invalidateFingerprintCache()
}

/** 新增或按 id 覆盖一份档 */
export async function upsertFingerprint(fp: StyleProfile): Promise<StyleProfile[]> {
  const list = await loadFingerprints()
  const at = list.findIndex(x => x.id === fp.id)
  if (at >= 0) list[at] = fp
  else list.push(fp)
  await saveFingerprints(list)
  return list
}

/** 删除一份档；删的正是当前启用档时，一并停用（不留悬空 id） */
export async function removeFingerprint(id: string): Promise<StyleProfile[]> {
  const list = (await loadFingerprints()).filter(x => x.id !== id)
  await saveFingerprints(list)
  if ((await loadActiveFingerprintId()) === id) await saveActiveFingerprintId('')
  return list
}

// ============ 当前启用档（带内存缓存） ============

/**
 * 缓存当前启用档。`undefined` = 还没读过；**带 pid** 是为了切项目时自动失效。
 *
 * 为什么要缓存：三处注入点（续写 / 整章改写 / 伴写）都在**热路径**上 —— 伴写每停笔一次都调，
 * 每次去读一遍存储纯属浪费（本地模型本来就慢，不该再叠一次读盘）。
 * 失效时机＝任何一次写入（`saveFingerprints` / `saveActiveFingerprintId`）。
 *
 * 🔴 **还要按项目失效** —— 文风档改按项目存之后，换项目必须重新读，
 *    否则会把上一本书的档带到这一本（比"没档"更糟：静默用了错的文风）。
 *    做法是缓存里带 pid、读时比对，而**不是**去 `App.tsx` 的切项目处补一行调用 ——
 *    那等于多一个"将来新增入口会漏"的地方（本项目在别处已经踩过这个坑）。
 */
let activeCache: { pid: string; fp: StyleProfile | null } | undefined = undefined

/** 让缓存失效（写盘后自动调用；单测里手动调用以隔离用例） */
export function invalidateFingerprintCache(): void {
  activeCache = undefined
}

/** 取**当前项目**启用的文风档；未启用 / 已删除 / 异常一律返回 null */
export async function loadActiveFingerprint(): Promise<StyleProfile | null> {
  const pid = db.getCurrentProjectId()
  if (activeCache !== undefined && activeCache.pid === pid) return activeCache.fp
  let fp: StyleProfile | null = null
  try {
    const id = await loadActiveFingerprintId()
    if (id) {
      const hit = (await loadFingerprints()).find(x => x.id === id)
      fp = hit ?? null
    }
  } catch {
    fp = null
  }
  activeCache = { pid, fp }
  return fp
}

/**
 * 当前启用档的注入文本 —— **三处注入点的统一入口**。
 * 无档 / 出错一律返回空串（整层不注入），绝不因为文风档而让续写 / 改写 / 伴写挂掉。
 */
export async function activeFingerprintNote(): Promise<string> {
  try {
    return buildFingerprintNote(await loadActiveFingerprint())
  } catch {
    return ''
  }
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `aiTasks.ts` 的 `PROMPT_ORDER` 决定 = 设置页显示顺序**。
 */
export const STYLE_FINGERPRINT_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'style-fingerprint',
      group: '正文写作',
      name: '文风指纹',
      note: '从参考文本归纳作者文风特征（只学风格，不照搬原文句子）。',
    },
    read: () => P_style_fingerprint,
    write: t => { P_style_fingerprint = t },
  },
]
