// ============ AI 任务层 · 校对（文字层 / 逻辑层） ============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #4 段）。
// 2026-09-20 拆分（老大要求）：原先一个 `aiProofread` 混查「错别字 / 语病 / 逻辑 / 设定矛盾 / 标点」，
//   两个代价：
//     ① **慢** —— 文字层本来不需要设定资料，却每块都带 6000 字设定，白烧 prompt 与等待时间；
//     ② **糙** —— 五类问题挤在一个提示词里，注意力被摊薄，错别字语病的检出量明显低于同类工具。
//   现在拆成两条独立任务、两条独立提示词：
//     · 文字层（`aiProofreadText`）只读本章正文 → 更快；
//     · 逻辑层（`aiProofreadLogic`）才读设定资料 → 更准。
//
// 🔴 两条硬约束（改提示词时别破）：
//   ① `quote` 必须逐字照抄原文 —— 前端靠 `text.indexOf(chunk)` 在**原文**里精确定位，
//      定位不到的条目会被直接丢弃（作者点了也改不了），见 promptGuard 的说明。
//   ② 提示词里**不写 markdown 星号**：模型会模仿输出格式，正文里就会混进 `**`。
//      要强调就用「」（本项目文案规范同此）。
import { chat, requireProviderFor, isCancelled, CHAT_TIMEOUT_MS, composeSystemPrompt } from '@/lib/ai'
import { parseObjectArray, asText } from '@/lib/aiParse'
import { authorBlock, newAuthorFence } from '@/lib/promptGuard'
import { stripEmphasis } from '@/lib/mdLite'
import { longStream } from '@/lib/aiTasks/stream'
import type { PromptDef } from '@/lib/promptSettings'

// ---------- 校对 · 文字层（错别字 / 语病 / 标点） ----------

/**
 * 文字层提示词。
 *
 * 判据从「宁可少报，不可误报」改成「先找出来、由作者判断」—— 2026-09-20 老大反馈：
 * 同一段文字，同类工具挑出的错别字与语病明显更多，人工核实后**确实是真错**。
 * 说明原来的判据太保守（模型把"我拿不准"直接当成了"不报"）。
 * 现在改成：读起来确实有错或高度可疑就报，犹豫的在 why 里注明「疑似」。
 * 但"不许编造"这条反而要写得更硬 —— 放宽判据最怕的就是开始瞎报，
 * 而瞎报的条目 quote 在正文里定位不到、会被系统直接丢掉，等于白烧一轮 token。
 */
let PROOFREAD_TEXT_SYS = `你是中文出版级的文字校对员，负责逐字逐句校对一份中文网络小说正文。
你只处理「文字本身的错误」：不评论情节、不评价文笔、不提写作建议、不做润色改写。

【必须逐句读完】
不许跳读、不许只看开头结尾、不许只挑最显眼的几处。逐字比对相邻字词，是发现错别字与
多字漏字的唯一办法。整段读起来顺不顺，要真读一遍才知道。

【检查范围】
1. 错别字
   · 同音 / 近音字：的｜地｜得、在｜再、做｜作、末｜未、已｜己、象｜像｜相、需｜须、
     帐｜账、带｜戴、以｜已、即｜既、拣｜捡、爆发｜暴发、以至｜以致 …
   · 形近字：戊｜戌｜戍、辨｜辩｜辫、己｜已｜巳、抢｜抡、第｜笫、侯｜候 …
   · 偏旁写错、生造词（把一个词的两半写混，如「犹豫」写成「犹预」）。
2. 多字 / 漏字 / 词序颠倒
   · 读到不通顺处就逐字比对：「他走进走进了房间」「把剑拔出来剑鞘」「一一年」。
3. 语病
   · 成分残缺（缺主语 / 缺谓语 / 缺宾语）、搭配不当（动词与宾语不搭、量词不合）、
     句式杂糅（一句话里塞了两套结构）、语序混乱、关联词误用（「因为…所以」与「虽然…但是」混用）、
     指代不明（他 / 她 / 它 / 这 / 那 指谁不清）、明显重复啰嗦。
4. 标点
   · 中英标点混用（半角 , . ? ! 出现在中文句子里）、引号 / 书名号 / 括号不成对、
     逗号一路连缀到段末、句末缺标点、省略号写成「。」重复或半角三点、破折号写成两个减号。
5. 专有名词「前后不一致」
   · 同一段里同一个人 / 地名 / 功法 / 势力出现两种写法（如「青岚宗」与「青岚派」混用）。

【判据 —— 先找出来，再由作者判断】
· 只要读起来确实有错或高度可疑就报，不要因为「也许是作者有意为之」而放过；
  这种犹豫的条目，在 why 里注明「疑似」并写清理由。
· 绝不许编造：不许把正确的字当成错的，不许为了凑数硬造条目。
· ⚠️ 本次没有给你设定资料，所以只报「同一段内写法不一致」这类可自查的问题，
  不要报「这个人名看起来不像中文名」这类需要外部依据的猜测。
· 同一处只报一次；同一类错误出现在多处，每处单独列一条，不要合并成一条。

【输出】
- 返回 JSON 数组，元素形如 {"type":"错别字","quote":"原文片段","fix":"改后的片段","why":"简短原因"}。
- quote 必须逐字照抄原文（含标点，6~40 字，能唯一定位），一个字都不许改、不许省略中间内容 —— 程序要靠它在正文里找到位置。
- fix 只给 quote 对应位置改好后的完整片段，长度尽量与 quote 接近。
- type 只能是：错别字 / 语病 / 标点。
- 没有发现问题就返回 []。
- 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。`

// ---------- 校对 · 逻辑层（逻辑 / 设定矛盾） ----------

/**
 * 逻辑层提示词。
 *
 * 与文字层的分工要在提示词里写明 —— 否则模型会把"错别字"也顺手报一遍，
 * 两条任务的结果就重叠了，作者在界面上看到同一处被报两遍。
 */
let PROOFREAD_LOGIC_SYS = `你是中文网络小说的一致性审校员，负责检查上下文逻辑与与既有设定的冲突。
你不处理错别字、语病、标点（那是另一道校对的事），只判「讲不讲得通、跟设定冲不冲突」。

【必须逐句读完】，并把本段内部的前后文与给出的设定资料放在一起对照。

【检查范围】
1. 前后矛盾：同一件事、同一个人的年龄 / 伤势 / 境界 / 位置 / 已知信息在本段内互相冲突。
2. 时间与空间错乱：白天黑夜颠倒、季节对不上、两地距离或行程不可能、路线对不上。
3. 设定矛盾：与设定资料冲突 —— 姓名、称谓（师父 / 师叔 / 长老）、境界层级、势力归属、
   器物来历与能力上限、已发生事件的时间与结果。
4. 常识与物理硬伤：做不到的事被随手写出；能力 / 物品忽然失效或忽然生效，且无交代。
5. 行为动机断裂：人物做了与他的处境或已知信息明显不符的事，且文中没有任何交代。

【判据】
· 只报能指着具体文字说清冲突点的问题；说不清依据的一律不报。
· 与设定资料冲突时，why 里要写明「与设定资料的哪一条冲突」，并引用其内容。
· 同一处只报一次；多处要分别列条。

【输出】
- 返回 JSON 数组，元素形如 {"type":"逻辑","quote":"原文片段","fix":"改后的片段","why":"简短原因"}。
- quote 必须逐字照抄原文（含标点，6~40 字，能唯一定位），一个字都不许改。
- fix 给「改成什么才不矛盾」的完整片段；若在不改情节的前提下无法改好，就把你的修改建议写进 fix，它同样会被替换到 quote 的位置。
- type 只能是：逻辑 / 设定矛盾。
- 没有发现问题就返回 []。
- 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。`

export interface ProofreadIssue {
  type: string
  /** 原文片段（逐字引用，前端据此定位） */
  quote: string
  /** 建议改成 */
  fix: string
  /** 简短原因 */
  why: string
  /** 前端定位到的正文下标；-1 表示未能精确定位；undefined 表示定位已失效（重叠替换后），下次替换走全文搜索兜底 */
  at?: number
}

/**
 * 按段落切块，尽量贴近目标长度且不切断句子。
 * 关键：保留原文的每一个字符（含原始换行个数），使切出的块都是【原文的精确子串】，
 * 这样下面用 text.indexOf(chunk, offset) 定位才可靠——
 * 旧版把多空行压成单换行再重拼，导致 chunk 与原文对不上、at 定位漂移（隐患）。
 */
function chunkText(text: string, target = 2200): string[] {
  // 用捕获分组把「文本段 + 紧随其后的换行分隔段」交替切出，拼接即可无损还原原文
  const parts = text.split(/(\n+)/)
  // 每段 = 文本 + 其后的换行符（结尾段无换行则补空串）
  const paras: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    paras.push(parts[i] + (i + 1 < parts.length ? parts[i + 1] : ''))
  }
  const out: string[] = []
  let buf = ''
  for (const p of paras) {
    // 纯空行：直接并入当前块，不单独成块
    if (!p.trim()) { buf += p; continue }
    if (buf && buf.length + p.length > target) { out.push(buf); buf = '' }
    if (p.trim().length > target * 1.6) {
      // 超长段落再按句末标点切，避免把一句话拦腰斩断
      const sents = p.split(/(?<=[。！？…”])/)
      for (const s of sents) {
        if (buf && buf.length + s.length > target) { out.push(buf); buf = '' }
        buf += s
      }
    } else {
      buf += p
    }
  }
  if (buf.trim()) out.push(buf)
  return out
}

export interface ProofreadOptions {
  /** 设定资料上下文（仅逻辑层用；文字层传了也不会读，见下方 runProofread） */
  context?: string
  /** 进度回调（已完成块 / 总块数） */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /** 最多校对多少块，防止一章几万字把本地模型跑到天亮 */
  maxChunks?: number
  /** 流式回调：提供时逐块可见模型原始输出 */
  onToken?: (delta: string) => void
}

export interface ProofreadResult {
  issues: ProofreadIssue[]
  /** 实际校对的字符数 */
  scanned: number
  /** 因超出块数上限未校对的字符数 */
  skipped: number
}

/**
 * 校对的公共执行体：分块串行送模型（本地模型并发只会互相抢显存），
 * 每块结果就地在原文里定位，定位不到的条目直接丢弃——避免给作者一堆点不动的提示。
 *
 * @param withContext 是否把设定资料带进提示词。**文字层传 false**：这是本次拆分的主要收益，
 *   既能省掉每块 6000 字的设定注入（更快），也让模型不受设定内容干扰、专注于文字本身。
 */
async function runProofread(
  text: string,
  sys: string,
  opts: ProofreadOptions,
  withContext: boolean,
  chunkTarget: number,
): Promise<ProofreadResult> {
  const cfg = await requireProviderFor('review')
  const all = chunkText(text, chunkTarget)
  const maxChunks = opts.maxChunks ?? 8
  const chunks = all.slice(0, maxChunks)
  const skipped = all.slice(maxChunks).reduce((s, c) => s + c.length, 0)

  const issues: ProofreadIssue[] = []
  const seen = new Set<string>()
  let scanned = 0
  let offset = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    // 本块在全文中的起点（分块只做了空白归并，用 indexOf 足够可靠）
    const base = text.indexOf(chunk, offset)
    const chunkStart = base >= 0 ? base : offset
    offset = chunkStart + chunk.length

    const user = [
      withContext
        // 逻辑层才给设定资料。文字层刻意省略整段 —— 见 runProofread 的说明
        ? `【设定资料】\n${opts.context?.trim() || '（无设定资料，请只做本段内部的前后一致性判断）'}\n`
        : '',
      `【待校对正文】\n${authorBlock(newAuthorFence(), chunk)}`,
      '',
      '请返回问题清单的 JSON 数组。',
    ].filter(Boolean).join('\n')

    let reply = ''
    try {
      reply = await chat(
        cfg,
        [
          { role: 'system', content: composeSystemPrompt(sys, cfg) },
          { role: 'user', content: user },
        ],
        { timeoutMs: CHAT_TIMEOUT_MS, signal: opts.signal, onToken: longStream(opts.onToken), json: true },
      )
    } catch (e) {
      if (isCancelled(e)) break
      // 单块失败不整轮报废，继续下一块
      opts.onProgress?.(i + 1, chunks.length)
      continue
    }

    scanned += chunk.length
    for (const it of parseObjectArray(reply)) {
      const quote = asText(it.quote ?? it['原文'] ?? it.text)
      const fix = asText(it.fix ?? it['建议'] ?? it.suggestion)
      const type = asText(it.type ?? it['类型']) || '其他'
      const why = asText(it.why ?? it['原因'] ?? it.reason)
      if (!quote || quote.length < 2) continue
      // 必须能在原文里定位，否则作者点了也没法改。
      // 🔴 模型有时给引文自行加了 markdown 强调（**…**）：先原样定位，不行再剥一次
      //    （否则 quote 定位不到 → 这条问题被静默丢掉，白烧一轮 token）。
      let q = quote
      let rel = chunk.indexOf(q)
      if (rel < 0) {
        const clean = stripEmphasis(quote)
        if (clean && clean !== quote && clean.length >= 2 && chunk.indexOf(clean) >= 0) {
          q = clean
          rel = chunk.indexOf(clean)
        }
      }
      if (rel < 0) continue
      const at = chunkStart + rel
      const dedup = `${at}::${q}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      issues.push({ type, quote: q, fix, why, at })
    }
    opts.onProgress?.(i + 1, chunks.length)
  }

  issues.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  return { issues, scanned, skipped }
}

/**
 * 校对 · 文字层：错别字 / 语病 / 标点。
 * **不读设定资料** —— 每块 prompt 更短，出结果更快；也避免了"用设定内容去猜专名是不是写错"这类误报。
 */
export function aiProofreadText(text: string, opts: ProofreadOptions = {}): Promise<ProofreadResult> {
  return runProofread(text, PROOFREAD_TEXT_SYS, opts, false, 2200)
}

/**
 * 校对 · 逻辑层：逻辑矛盾 / 设定冲突。
 * 会读设定资料（`opts.context`），块也切得更大 —— 判前后矛盾需要更宽的视野。
 */
export function aiProofreadLogic(text: string, opts: ProofreadOptions = {}): Promise<ProofreadResult> {
  return runProofread(text, PROOFREAD_LOGIC_SYS, opts, true, 3500)
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const PROOFREAD_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'proofread-text',
      group: '编辑与审校',
      name: '文字校对（错别字 / 语病 / 标点）',
      note: '逐字逐句找文字层面的错误；只读本章正文，不读设定资料。',
    },
    read: () => PROOFREAD_TEXT_SYS,
    write: t => { PROOFREAD_TEXT_SYS = t },
  },
  {
    meta: {
      id: 'proofread-logic',
      group: '编辑与审校',
      name: '逻辑与设定审校',
      note: '查前后矛盾与设定冲突；会读项目设定资料。',
    },
    read: () => PROOFREAD_LOGIC_SYS,
    write: t => { PROOFREAD_LOGIC_SYS = t },
  },
]
