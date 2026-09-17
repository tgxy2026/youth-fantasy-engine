// ============ AI 任务层 ============
//
// 分层约定：
//   ai.ts      —— 传输与配置（provider / chat / 就绪状态 / 设定补全）
//   aiContext  —— 全项目资料打包
//   aiTasks.ts —— 本文件：具体任务的 prompt 与结果解析
//                 （AI 整理 / 校对 / 取名 / 敏感词语境复核 / 一致性深度自查）
//
// 铁律：本文件所有函数都是「可选增强」。调用方必须保证——
//   未配置模型 → 按钮禁用，绝不调用；调用失败 → 只提示，绝不破坏已有数据。

import { chat, requireActiveProvider, isCancelled, CHAT_TIMEOUT_MS, composeSystemPrompt } from './ai'
import { parseObjectArray, asText, humanText, hasSubstance } from './aiParse'
import { authorBlock, newAuthorFence } from './promptGuard'

// ---------- 通用 JSON 解析（已收敛到 ./aiParse，全项目唯一入口） ----------
// 原先这里的 sliceJSON / normalizeParsed / parseObjectArray / hasSubstance / asText / humanText
// 已整体迁至 src/lib/aiParse.ts，避免与 ai.ts、autoContinue.ts 的另两份实现行为分叉。

// ---------- AI 整理（从已有资料 / 正文中抽取结构化条目） ----------

export interface OrganizeColumn {
  name: string
  /** 列语义提示（来自 schema 的 tip） */
  desc?: string
  /** 该列的合法取值：select 选项、角色名清单等。给了模型就必须从中挑 */
  allowed?: string[]
}

export interface OrganizeRequest {
  /** 表名，如「人物关系」 */
  tableName: string
  /** 表用途说明，给模型交代清楚要抽什么 */
  purpose: string
  columns: OrganizeColumn[]
  /** 已登记条目（只需关键列的值，用于让模型避开重复） */
  existingKeys: string[]
  /** 本地判重用的关键列 */
  keyColumns: string[]
  /** A-B 与 B-A 视为同一条（人物关系） */
  unorderedPair: boolean
  /** 待整理的正文（可为空，此时仅依据项目资料整理） */
  sourceText: string
  /** 全项目资料上下文 */
  projectContext: string
  /** 单次最多返回条数 */
  maxRows?: number
  signal?: AbortSignal
  /** 流式回调：提供时整理过程逐块可见 */
  onToken?: (delta: string) => void
}

export interface OrganizeResult {
  /** 去重后可直接入表的新条目 */
  rows: Record<string, string>[]
  /** 模型原始返回条数 */
  rawCount: number
  /** 因与已有条目重复而被丢弃的条数 */
  dupSkipped: number
  /** 因缺关键列而被丢弃的条数 */
  invalidSkipped: number
}

/** 判重指纹：去掉标点空格、统一大小写；无序对则排序后拼接 */
export function rowFingerprint(row: Record<string, string>, keyCols: string[], unordered: boolean): string {
  const norm = (s: string) =>
    (s ?? '')
      .replace(/[\s,.;:!?，。、；：！？·"'"''()（）[\]【】《》<>—\-_/\\|]/g, '')
      .toLowerCase()
  const vals = keyCols.map(c => norm(row[c] ?? ''))
  if (unordered) vals.sort()
  return vals.join('||')
}

const ORGANIZE_SYS = `你是「青春幻想引擎」的小说资料整理助手。作者已经写好了正文与设定，你的工作是把其中**已经明确写出来**的信息，整理登记进指定表格。

铁律：
1. 只登记原文/设定中确有依据的内容。严禁虚构、严禁推测、严禁"合理补全"——这是资料整理，不是创作。
2. 绝不重复【已登记条目】里已有的条目。判断重复时看关键列：只要指向同一对象/同一件事，就算措辞不同也算重复，必须跳过。
3. 返回一个 JSON 数组，每个元素是一个对象，key 必须严格使用【列清单】中给出的列名原文。
4. 某列标注了"可选值"时，必须从可选值中挑选；涉及人物的列必须使用与角色卡完全一致的正式姓名，不要用代称、绰号、"他/她"。
5. 拿不准或原文未写明的列，给空字符串 ""，不要编造。
6. 没有任何可新增的条目时，返回空数组 []。
7. 只输出 JSON 数组本身：不要解释、不要前言后语、不要 markdown 代码块标记。`

/**
 * AI 整理：把正文/设定里已经写明的事实抽成表格行。
 * 双重保险防重复：prompt 里明确告知已有条目 + 返回后本地按关键列再去一遍重。
 */
export async function aiOrganizeRows(req: OrganizeRequest): Promise<OrganizeResult> {
  const cfg = await requireActiveProvider()
  const max = req.maxRows ?? 12

  const colList = req.columns
    .map(c => {
      const bits = [`- ${c.name}`]
      if (c.desc) bits.push(`（${c.desc}）`)
      if (c.allowed && c.allowed.length > 0) {
        const show = c.allowed.slice(0, 40).join(' / ')
        bits.push(`【可选值：${show}${c.allowed.length > 40 ? ' …' : ''}】`)
      }
      return bits.join('')
    })
    .join('\n')

  const existing = req.existingKeys.length > 0
    ? req.existingKeys.slice(0, 300).map((k, i) => `${i + 1}. ${k}`).join('\n')
    : '（暂无，本表还是空的）'

  const user = `【目标表格】${req.tableName}
【整理目标】${req.purpose}

【列清单】
${colList}

【已登记条目（这些绝对不要再返回）】
${existing}

【项目资料（世界观 / 角色 / 设定，用于对齐名称与背景）】
${req.projectContext.trim() || '（无）'}

【待整理文本】
${req.sourceText.trim() ? authorBlock(newAuthorFence(), req.sourceText.trim()) : '（作者未指定正文，请仅依据上方项目资料整理其中已明确写出、但尚未登记进本表的条目）'}

请返回最多 ${max} 条新条目的 JSON 数组，优先返回最重要、最确定的。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(ORGANIZE_SYS, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: req.signal, onToken: req.onToken, json: true },
  )

  const arr = parseObjectArray(text)
  const colNames = req.columns.map(c => c.name)
  const seen = new Set(req.existingKeys.map(k => rowFingerprint(keyLineToRow(k, req.keyColumns), req.keyColumns, req.unorderedPair)))

  const rows: Record<string, string>[] = []
  let dupSkipped = 0
  let invalidSkipped = 0

  for (const item of arr) {
    const row: Record<string, string> = {}
    for (const name of colNames) {
      // 容错：模型可能用了去空格/大小写不同的 key
      const hit = Object.keys(item).find(k => k.trim() === name || k.trim().replace(/\s/g, '') === name.replace(/\s/g, ''))
      row[name] = hit ? asText(item[hit]) : ''
    }
    // 关键列必须齐全，否则这条没法判重也没法用
    if (req.keyColumns.some(c => !row[c]?.trim())) { invalidSkipped++; continue }
    const fp = rowFingerprint(row, req.keyColumns, req.unorderedPair)
    if (seen.has(fp)) { dupSkipped++; continue }
    seen.add(fp)
    rows.push(row)
    if (rows.length >= max) break
  }

  return { rows, rawCount: arr.length, dupSkipped, invalidSkipped }
}

/** 把「张三 ｜ 李四」形态的已登记摘要还原成关键列对象，供统一指纹计算 */
function keyLineToRow(line: string, keyCols: string[]): Record<string, string> {
  const parts = line.split('｜').map(s => s.trim())
  const row: Record<string, string> = {}
  keyCols.forEach((c, i) => { row[c] = parts[i] ?? '' })
  return row
}

/** 生成「已登记条目」摘要行，与 keyLineToRow 成对使用 */
export function keyRowToLine(row: Record<string, string>, keyCols: string[]): string {
  return keyCols.map(c => (row[c] ?? '').trim()).join(' ｜ ')
}

// ---------- AI 校对（错别字 / 语病 / 逻辑 / 设定矛盾） ----------

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

const PROOFREAD_SYS = `你是资深中文网络小说校对编辑。请逐句检查作者给出的正文，只报**确定的问题**，不做文风润色、不提写作建议。

检查范围：
1. 错别字：同音别字、形近字、专有名词写错（含人名前后不一致）。
2. 语病：成分残缺、搭配不当、语序混乱、指代不明、明显重复啰嗦。
3. 逻辑：前后矛盾、时间/空间错乱、常识错误、人物行为动机断裂。
4. 设定矛盾：与【设定资料】冲突（如姓名、境界、称谓、势力归属对不上）。
5. 标点：中英标点混用、引号/书名号不成对、逗号连缀成句。

输出要求：
- 返回 JSON 数组，元素形如 {"type":"错别字","quote":"原文片段","fix":"改后的片段","why":"简短原因"}。
- quote 必须**逐字照抄原文**（含标点，长度 6~40 字，能唯一定位），不得改写、不得省略中间内容——前端要靠它在正文里定位。
- fix 只给 quote 对应位置改好后的完整片段，长度尽量与 quote 接近。
- type 只能是：错别字 / 语病 / 逻辑 / 设定矛盾 / 标点。
- 没有问题就返回 []。宁可少报，不可误报；不确定的不要报。
- 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。`

/**
 * 按段落切块，尽量贴近目标长度且不切断句子。
 * 关键：保留原文的每一个字符（含原始换行个数），使切出的块都是【原文的精确子串】，
 * 这样 aiProofread 里用 text.indexOf(chunk, offset) 定位才可靠——
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
  /** 设定资料上下文（用于查"设定矛盾"），可空 */
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
 * AI 深度校对。分块串行送模型（本地模型并发只会互相抢显存），
 * 每块结果就地在原文里定位，定位不到的条目直接丢弃——避免给作者一堆点不动的提示。
 */
export async function aiProofread(text: string, opts: ProofreadOptions = {}): Promise<ProofreadResult> {
  const cfg = await requireActiveProvider()
  const all = chunkText(text)
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

    const user = `【设定资料】
${opts.context?.trim() || '（无，请只做文字与逻辑层面的校对）'}

【待校对正文】
${authorBlock(newAuthorFence(), chunk)}

请返回问题清单的 JSON 数组。`

    let reply = ''
    try {
      reply = await chat(
        cfg,
        [
          { role: 'system', content: composeSystemPrompt(PROOFREAD_SYS, cfg) },
          { role: 'user', content: user },
        ],
        { timeoutMs: CHAT_TIMEOUT_MS, signal: opts.signal, onToken: opts.onToken, json: true },
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
      // 必须能在原文里定位，否则作者点了也没法改
      const rel = chunk.indexOf(quote)
      if (rel < 0) continue
      const at = chunkStart + rel
      const dedup = `${at}::${quote}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      issues.push({ type, quote, fix, why, at })
    }
    opts.onProgress?.(i + 1, chunks.length)
  }

  issues.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  return { issues, scanned, skipped }
}

// ---------- AI 取名 ----------

export interface NameSuggestRequest {
  /** 取名对象：人物 / 门派 / 地名 / 招式 / 法宝… */
  target: string
  /** 风格要求（东方仙侠 / 现代都市 / 西幻…） */
  style: string
  /** 作者的补充要求 */
  extra: string
  /** 世界观上下文 */
  context: string
  count?: number
  signal?: AbortSignal
  /** 流式回调：提供时取名过程逐块可见 */
  onToken?: (delta: string) => void
}

export interface NameSuggestion {
  name: string
  /** 取名理由 / 寓意 */
  meaning: string
}

export async function aiSuggestNames(req: NameSuggestRequest): Promise<NameSuggestion[]> {
  const cfg = await requireActiveProvider()
  const n = req.count ?? 10
  const sys = `你是网络小说取名顾问。按作者要求生成候选名字，每个名字附一句寓意/来源说明。
规则：
1. 返回 JSON 数组，元素形如 {"name":"名字","meaning":"一句话寓意或来源"}。
2. 名字要契合给定的世界观与风格，读音顺口、不拗口、不生僻到没人会念。
3. 彼此之间风格统一但不重复雷同；不要和【世界观上下文】里已出现的名字重复。
4. meaning 控制在 30 字内，说清取名依据即可。
5. 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。`
  const user = `【取名对象】${req.target}
【风格要求】${req.style || '（未指定，按世界观自行判断）'}
【补充要求】${req.extra || '（无）'}

【世界观上下文】
${req.context.trim() || '（无）'}

请给出 ${n} 个候选。`
  const text = await chat(cfg, [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }], {
    json: true,
    timeoutMs: CHAT_TIMEOUT_MS,
    signal: req.signal,
    onToken: req.onToken,
  })
  const out: NameSuggestion[] = []
  const seen = new Set<string>()
  for (const it of parseObjectArray(text)) {
    const name = asText(it.name ?? it['名字'] ?? it['名称'])
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, meaning: asText(it.meaning ?? it['寓意'] ?? it['说明']) })
    if (out.length >= n) break
  }
  return out
}

// ---------- 敏感词语境复核 ----------

export interface SensitiveHitInput {
  word: string
  /** 命中处的上下文片段 */
  snippet: string
}

export interface SensitiveReview {
  word: string
  /** 误报 / 低 / 中 / 高 */
  risk: string
  reason: string
  /** 建议替换写法（误报时可为空） */
  suggestion: string
}

export async function aiReviewSensitive(hits: SensitiveHitInput[], opts?: { signal?: AbortSignal; onToken?: (delta: string) => void }): Promise<SensitiveReview[]> {
  const cfg = await requireActiveProvider()
  const sys = `你是网络文学平台的审核经验丰富的编辑。作者用本地词库扫出了一批"疑似敏感词"命中，其中很多是误报（词库只匹配字面，不看语境）。请逐条判断真实风险。

规则：
1. 返回 JSON 数组，元素形如 {"word":"命中词","risk":"误报|低|中|高","reason":"简短判断依据","suggestion":"若有风险，给出可直接替换的写法；误报则留空"}。
2. 结合上下文判断：同一个词在不同语境里风险完全不同（如"血"在打斗描写中通常无风险）。
3. suggestion 要保持原意与文风，不要改成不通顺的替代词。
4. reason 控制在 25 字内。
5. 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。`
  const list = hits
    .slice(0, 40)
    .map((h, i) => `${i + 1}. 命中词「${h.word}」\n   上下文：${h.snippet.replace(/\s+/g, ' ').slice(0, 120)}`)
    .join('\n')
  const text = await chat(cfg, [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: `【命中清单】\n${list}\n\n请逐条给出判断。` }], {
    json: true,
    timeoutMs: CHAT_TIMEOUT_MS,
    signal: opts?.signal,
    onToken: opts?.onToken,
  })
  const out: SensitiveReview[] = []
  for (const it of parseObjectArray(text)) {
    const word = asText(it.word ?? it['词'] ?? it['命中词'])
    if (!word) continue
    out.push({
      word,
      risk: asText(it.risk ?? it['风险']) || '低',
      reason: asText(it.reason ?? it['依据'] ?? it['原因']),
      suggestion: asText(it.suggestion ?? it['建议']),
    })
  }
  return out
}

// ---------- 一致性深度自查 ----------

export interface ContinuityFinding {
  /** 严重 / 中等 / 提示 */
  level: string
  title: string
  detail: string
  /** 涉及位置（章节名 / 设定项） */
  where: string
}

export async function aiContinuityAudit(
  projectContext: string,
  chapterText: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ContinuityFinding[]> {
  const cfg = await requireActiveProvider()
  const sys = `你是长篇网络小说的设定校对与连续性审查专家。请对照作者的设定资料，找出正文中的"前后矛盾/设定冲突/逻辑硬伤"。

规则：
1. 返回 JSON 数组，元素形如 {"level":"严重|中等|提示","title":"一句话结论","detail":"具体冲突在哪、和哪条设定对不上","where":"涉及的章节或设定项"}。
2. 只报**有据可查**的冲突：必须能指出资料/正文中的具体依据。不要报"建议加强描写"之类的写作建议。
3. level 判定：影响读者理解或明显崩设定 = 严重；细节对不上 = 中等；疑似但不确定 = 提示。
4. 最多返回 12 条，按严重程度排序。没发现问题就返回 []。
5. 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。`
  const user = `【设定资料】
${projectContext.trim() || '（无）'}

【待审查正文】
${chapterText.trim() || '（作者未指定正文，请仅在设定资料内部查找互相矛盾之处）'}

请返回问题清单。`
  const text = await chat(cfg, [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }], {
    json: true,
    timeoutMs: CHAT_TIMEOUT_MS,
    signal: opts?.signal,
    onToken: opts?.onToken,
  })
  const out: ContinuityFinding[] = []
  for (const it of parseObjectArray(text)) {
    const title = asText(it.title ?? it['结论'] ?? it['问题'])
    if (!title) continue
    out.push({
      level: asText(it.level ?? it['级别']) || '提示',
      title,
      detail: asText(it.detail ?? it['详情'] ?? it['说明']),
      where: asText(it.where ?? it['位置'] ?? it['涉及']),
    })
    if (out.length >= 12) break
  }
  return out
}

// ============ 读者反馈 AI 分析（任务1） ============
//
// 把连载运营台账（数据 + 吐槽 + 流失点）交给模型做编辑视角诊断。
// 纯增强：未配模型不调用；无数据时模型如实说"暂无可分析数据"，不编造。

export interface FeedbackEntry {
  /** 数据周期（如「第 3 周」） */
  period: string
  /** 追读 / 均订 / 留存等核心指标摘要 */
  metrics: string
  /** 高频吐槽（章评原声） */
  complaints: string
  /** 流失点章节 */
  churnChapter: string
  /** 作者填写的流失原因分析 */
  churnReason: string
}

export interface FeedbackAnalysis {
  /** 总体诊断 */
  summary: string
  /** 流失归因（根因分析） */
  churnAttribution: string
  /** 可落地的应对建议 */
  suggestions: string
}

export async function aiAnalyzeFeedback(
  entries: FeedbackEntry[],
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<FeedbackAnalysis> {
  const cfg = await requireActiveProvider()
  const list = entries.length
    ? entries
        .map((e, i) => {
          const lines = [
            `${i + 1}. 周期【${e.period || '—'}】`,
            `   数据：${e.metrics || '—'}`,
            `   高频吐槽：${e.complaints || '—'}`,
            `   流失点：${e.churnChapter || '—'}`,
            `   流失原因：${e.churnReason || '—'}`,
          ]
          return lines.join('\n')
        })
        .join('\n')
    : '（暂未登记任何读者反馈记录）'

  const sys = `你是网络小说连载运营分析助手。作者提供了一段时间的「读者反馈 / 运营数据」记录（追读、均订、留存、章评吐槽、流失点与原因）。请站在责编视角做三件事：
1. 总体诊断：数据趋势与读者情绪的整体判断。
2. 流失归因：把"流失点章节 + 流失原因 + 吐槽"交叉分析，指出最可能导致读者跑路的根因（节奏拖沓 / 毒点 / 水文 / 设定崩坏 / 人设崩等）。
3. 应对建议：可落地的下一步动作（调节奏 / 回收伏笔 / 加戏 / 改设定），每条一句话。

规则：
- 只做分析，不创作剧情。
- 没有数据时明确说"暂无可分析数据"，不要编造数字或吐槽。
- 返回 JSON：{"summary":"总体诊断","churnAttribution":"流失归因","suggestions":"应对建议"}，不要 markdown 代码块标记。`

  const user = `【读者反馈记录】
${list}

请给出诊断。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )

  const objs = parseObjectArray(text)
  const obj = objs[0] ?? {}
  return {
    summary: asText(obj.summary) || humanText(text),
    churnAttribution: asText(obj.churnAttribution) || '（模型未单独给出流失归因）',
    suggestions: asText(obj.suggestions) || '（模型未单独给出应对建议）',
  }
}

// ============ 写作面板 AI 健康诊断（任务2） ============
//
// 替换 Dashboard 原来写死的风险清单文案：读项目实际资料 + 关键统计，
// 输出健康分 + 风险清单 + 下一步建议。未配模型时 Dashboard 不调用、沿用静态提示。

export interface ProjectDiagnosis {
  /** 0~100 健康分 */
  score: number
  /** 总体诊断 */
  summary: string
  /** 风险清单（复用 ContinuityFinding 结构） */
  risks: ContinuityFinding[]
  /** 下一步建议 */
  nextSteps: string[]
}

export async function aiDiagnoseProject(
  projectContext: string,
  stats: { chapters: number; words: number; volumes: number; unf: number; unusedIdeas: number },
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ProjectDiagnosis> {
  const cfg = await requireActiveProvider()
  const sys = `你是网络小说创作项目的健康诊断助手。作者提供了当前项目的设定资料、章节清单与几项关键统计。请综合判断项目健康度，给出：
1. 健康分（0~100 的整数，越高越健康）。
2. 总体诊断（一句话 + 2~3 句展开）。
3. 风险清单：按严重程度列出最该马上处理的问题（最多 6 条），每条含 level（严重/中等/提示）、title、detail、where。
4. 下一步建议：作者接下来最该做的 3~5 件事（数组）。

规则：
- 只基于【项目资料】里的事实判断，不要编造设定。
- 风险与建议要具体、可操作，不要空话。
- 返回 JSON：{"score":int,"summary":"…","risks":[{"level","title","detail","where"}],"nextSteps":["…"]}，不要 markdown 代码块标记。`

  const user = `【关键统计】
- 卷数：${stats.volumes}　章节数：${stats.chapters}　累计字数：${stats.words}
- 未回收伏笔：${stats.unf} 条　闲置灵感素材：${stats.unusedIdeas} 条

【项目资料】
${projectContext.trim() || '（无）'}

请给出诊断。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )

  const objs = parseObjectArray(text)
  const obj = objs[0] ?? {}
  const risks = (Array.isArray(obj.risks) ? obj.risks : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    .map(x => ({
      level: asText(x.level) || '提示',
      title: asText(x.title ?? x['结论']) || '',
      detail: asText(x.detail ?? x['详情']),
      where: asText(x.where ?? x['位置']),
    }))
    .filter(r => r.title)
  const nextSteps = (Array.isArray(obj.nextSteps) ? obj.nextSteps : [])
    .map(asText)
    .filter(Boolean) as string[]
  const scoreNum = Number(obj.score)
  return {
    score: Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : 0,
    summary: asText(obj.summary) || humanText(text),
    risks: risks.slice(0, 6),
    nextSteps: nextSteps.slice(0, 5),
  }
}

// ============ 伏笔闭环 AI 增强（任务6） ============
//
// 在本地确定性「伏笔闭环看板」之外，提供一版 AI 视角的伏笔健康审查：
// 跨度节奏、悬空伏笔、埋设回收失衡等。未配模型不调用，本地看板照常可用。

export interface ForeshadowReviewFinding {
  level: string
  title: string
  detail: string
  where: string
}

export async function aiForeshadowReview(
  projectContext: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ForeshadowReviewFinding[]> {
  const cfg = await requireActiveProvider()
  const sys = `你是长篇伏笔管理专家。作者提供了「伏笔追踪」与「章节总表」（含每章埋设/回收的伏笔编号）。
请对照两张表，从 AI 视角审视伏笔闭环健康度，重点指出：
1. 跨度过大：某伏笔埋设到回收跨越太多章节，读者早已忘记（建议提前铺陈或加快回收）。
2. 悬空伏笔：埋了但始终没回收、或追踪表有但总表从未登记的"孤儿"。
3. 埋设/回收失衡：某段章节疯狂挖坑却零回收，烂尾预警。
4. 节奏：连章密集埋设或回收，缺乏呼吸感。

规则：
- 返回 JSON 数组，元素形如 {"level":"严重|中等|提示","title":"一句话结论","detail":"具体哪条伏笔、跨几章、为什么有问题","where":"涉及的伏笔编号或章节"}。
- 没问题时返回 []。只报有据可查的判断。
- 不要 markdown 代码块标记。`

  const user = `【项目资料（含伏笔追踪与章节总表）】
${projectContext.trim() || '（无）'}

请审查伏笔闭环健康度。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )

  const out: ForeshadowReviewFinding[] = []
  for (const it of parseObjectArray(text)) {
    const title = asText(it.title ?? it['结论'] ?? it['问题'])
    if (!title) continue
    out.push({
      level: asText(it.level ?? it['级别']) || '提示',
      title,
      detail: asText(it.detail ?? it['详情'] ?? it['说明']),
      where: asText(it.where ?? it['位置'] ?? it['涉及']),
    })
    if (out.length >= 12) break
  }
  return out
}

// ============ 名词术语 AI 查重归一（任务5） ============
//
// 对现有术语做同义 / 重复聚类，建议合并归一。未配模型不调用，手动录入不受影响。

export interface TermDupGroup {
  /** 被判定为同义 / 重复的术语名 */
  terms: string[]
  /** 为什么认为它们重复 / 同义 */
  reason: string
  /** 建议统一成的标准写法 */
  suggestion: string
}

export async function aiDedupTerms(
  terms: { term: string; category: string; definition: string }[],
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<{ groups: TermDupGroup[] }> {
  const cfg = await requireActiveProvider()
  const list = terms
    .map((t, i) => `${i + 1}. ${t.term}${t.category ? `（${t.category}）` : ''}：${t.definition || '—'}`)
    .join('\n')
  const sys = `你是小说专有名词管理助手。作者给出了一份「名词术语」，其中可能存在同义重复（同一概念两种写法，如"灵气/灵元""剑修/剑士"）或完全重复。请把它们聚类成"应合并"的组。

规则：
1. 只把**确为同义 / 同一事物不同叫法 / 明显重复**的归为一组；措辞不同但指不同事物的不要归并。
2. 跨类别重复也要识别（如"境界类·灵气"与"物品类·灵元"指向同一物）。
3. 每组给出 reason（为什么认为是同义/重复）和 suggestion（建议统一成的标准术语名）。
4. 没有重复项时返回 groups: []。
5. 返回 JSON：{"groups":[{"terms":["名1","名2"],"reason":"…","suggestion":"标准名"}]}，不要 markdown 代码块标记。`

  const user = `【名词术语】
${list || '（空）'}

请找出应合并的重复 / 同义术语。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )

  const objs = parseObjectArray(text)
  const obj = objs[0] ?? {}
  const groups = (Array.isArray(obj.groups) ? obj.groups : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    .map(x => ({
      terms: Array.isArray(x.terms) ? x.terms.map(asText).filter(Boolean) : [],
      reason: asText(x.reason),
      suggestion: asText(x.suggestion),
    }))
    .filter(g => g.terms.length >= 2)
  return { groups }
}

// ============ 文风体检 AI 增强（任务8） ============
//
// 在本地《写作规范》静态体检之外，提供一版 AI 文风体检：对照作者写的规范
// （坏习惯词 / 视角 / 标点），审本章文风。未配模型不调用，本地体检照常可用。

export interface StyleCheckFinding {
  /** 坏习惯词 / 视角 / 标点 / 节奏 / 其他 */
  type: string
  /** 命中原文（可空） */
  quote: string
  /** 问题描述 */
  issue: string
  /** 修改建议 */
  suggestion: string
  /** 严重 / 中等 / 提示 */
  level: string
}

export async function aiStyleCheck(
  chapterText: string,
  styleContext: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<StyleCheckFinding[]> {
  const cfg = await requireActiveProvider()
  const sys = `你是文风编辑。作者提供了《写作规范》（个人坏习惯清单 / 标点规范 / 视角规则）和本章正文，请对照规范体检本章文风。

规则：
1. 返回 JSON 数组，元素形如 {"type":"坏习惯词|视角|标点|节奏|其他","quote":"命中原文（可空）","issue":"问题","suggestion":"建议","level":"严重|中等|提示"}。
2. 坏习惯词：本章出现《写作规范》里列出的坏习惯词，逐一指出并给上下文。
3. 视角：若正文疑似出现非当前 POV 的越界描写，指出。
4. 标点：中英文标点混用、滥用省略号"..."代替"……"、引号不成对等。
5. 节奏：长段落密、对话与叙述失衡等可优化点（提示级）。
6. 没有问题就返回 []。宁可少报不可误报。不要 markdown 代码块标记。`

  const user = `【写作规范】
${styleContext.trim() || '（作者尚未填写写作规范）'}

【本章正文】
${chapterText.trim() || '（空）'}

请体检本章文风。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )

  const out: StyleCheckFinding[] = []
  for (const it of parseObjectArray(text)) {
    const issue = asText(it.issue ?? it['问题'])
    if (!issue) continue
    out.push({
      type: asText(it.type ?? it['类型']) || '其他',
      quote: asText(it.quote ?? it['原文']),
      issue,
      suggestion: asText(it.suggestion ?? it['建议']),
      level: asText(it.level ?? it['级别']) || '提示',
    })
    if (out.length >= 20) break
  }
  return out
}

// ============ 颉文姬 · 编辑器 AI 助手（v1.6 收官功能） ============
//
// 四块能力：AI 综合诊断（对本地体检报告再加工）/ 章节编辑意见（可读性商业性审读）/
// OOC 检查 / 选区改写（建议段模式，改写文本交给作者取舍）/ 续写方向（只给思路不生成正文）。
// 铁律同本文件其余函数：未配模型不调用；失败只提示；绝不直接改正文。

// ---------- 颉文姬①：AI 综合诊断 ----------

export interface EditorDiagnosis {
  /**
   * 排版好的 markdown 风格报告（## 小标题 / - 列表 / **加粗**）。
   * 直接面向作者展示，避免结构化 JSON 在兜底时泄漏键名。
   */
  report: string
}

export async function aiEditorDiagnosis(
  projectContext: string,
  chapterText: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void; textKind?: 'full' | 'summary' },
): Promise<EditorDiagnosis> {
  const cfg = await requireActiveProvider()
  // 简略模式喂的是压缩摘要而非全文——必须如实告知，否则模型会按全文标准评价文笔细节
  const textHeader = opts?.textKind === 'summary'
    ? '【本章压缩摘要（约原文 1/10，非完整正文；请基于摘要评估结构/节奏/设定一致性，不要评价逐句文笔）】'
    : '【本章正文】'
  const sys = `你是网文主编。作者把「本章正文」和设定资料一起给你，请站在主编视角做一次综合诊断，输出面向作者的 markdown 报告。

报告结构（必须包含这四个部分）：
## 总体结论
一句话概括本章最需要处理的问题。

## 按优先级
1. 最优先处理的问题（影响读者体验最大的在前，合并同类项，最多 6 条）
2. …

## 隐藏风险
- 高｜你发现的隐患（如伏笔埋太早/钩子太弱/信息密度失衡/人设言行不符/设定冲突），后跟一句应对动作

## 批量建议
- 3~5 条可落地的修改建议

规则：
- 综合分析节奏、钩子、信息密度、设定一致性、文风、人设与伏笔，兼顾可读性与商业性；不做逐字校对（那是校对编辑的活）。
- 只给建议，不创作剧情、不直接改写正文。
- 用中文输出；除了 ## 小标题与 - 列表外不要夹杂任何英文；不要 JSON、不要代码块。`
  const user = `${textHeader}
${chapterText.trim() || '（空）'}

【设定资料（摘要）】
${projectContext.trim() || '（无）'}

请输出综合诊断报告。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken },
  )
  return { report: humanText(text) || text.trim() }
}

// ---------- 颉文姬②：章节编辑意见 ----------

export interface ReviewDimension {
  name: string
  /** 0~10 */
  score: number
  comment: string
}

export interface ChapterReview {
  /** 0~100 总体分 */
  score: number
  /** 一句话总评 */
  verdict: string
  dimensions: ReviewDimension[]
  highlights: string[]
  warnings: string[]
}

export async function aiChapterReview(
  projectContext: string,
  chapterText: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ChapterReview> {
  const cfg = await requireActiveProvider()
  const sys = `你是资深网文责任编辑。请以"可读性与商业性"为标准审读本章（区别于设定校对：这里不看逻辑硬伤，看读者阅读体验）。

审读维度（各给 0~10 分与一句话点评）：
- 节奏：开场钩子、冲突密度、是否拖沓或过赶
- 钩子：本章结尾是否留悬念、是否值得点下一章
- 信息密度：新信息/新人物/新设定是否过量或过少
- 水文指数：有效信息占比，是否有明显凑字数段落
- 对话质量：对话是否推动剧情或塑造人物，还是水对话
- 情绪曲线：本章是否有起伏（爽/紧张/温情等）

规则：
1. 总分 = 各维度加权，0~100。
2. 亮点 2~4 条；警告给最需要处理的 2~5 条（尽量指向具体段落）。
3. 返回 JSON：{"score":72,"verdict":"一句话总评","dimensions":[{"name":"节奏","score":7,"comment":"..."}],"highlights":["..."],"warnings":["..."]}，不要 markdown 代码块标记。`
  const user = `【本章正文】
${chapterText.trim() || '（空）'}

【设定资料（摘要）】
${projectContext.trim() || '（无）'}

请按网文编辑视角审读。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )
  const obj = parseObjectArray(text)[0] ?? {}
  const scoreNum = Number(obj.score)
  const dims: ReviewDimension[] = (Array.isArray(obj.dimensions) ? obj.dimensions : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    .map(x => {
      const s = Number(x.score)
      return { name: asText(x.name ?? x['维度']) || '其他', score: Number.isFinite(s) ? Math.max(0, Math.min(10, Math.round(s))) : 0, comment: asText(x.comment) }
    })
    .filter(d => !!d.name)
    .slice(0, 8)
  const highlights = (Array.isArray(obj.highlights) ? obj.highlights : []).map(asText).filter(Boolean).slice(0, 4)
  const warnings = (Array.isArray(obj.warnings) ? obj.warnings : []).map(asText).filter(Boolean).slice(0, 5)
  return {
    score: Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : 0,
    verdict: asText(obj.verdict) || humanText(text),
    dimensions: dims,
    highlights,
    warnings,
  }
}

// ---------- 颉文姬③：OOC 人设偏离检查 ----------

export interface OocFinding {
  character: string
  /** 原文证据 */
  evidence: string
  issue: string
  suggestion: string
  level: string
}

export async function aiOocCheck(
  projectContext: string,
  chapterText: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<OocFinding[]> {
  const cfg = await requireActiveProvider()
  const sys = `你是人设监督编辑。请对照角色卡中的性格/动机/价值观/说话风格，检查本章正文里角色的言行是否符合人设（OOC = Out Of Character）。

规则：
1. 返回 JSON 数组，元素形如 {"character":"角色名","evidence":"引用该角色言行原文","issue":"哪里偏离人设","suggestion":"如何圆回/修改","level":"严重|中等|提示"}。
2. 必须引用原文证据，并明确指出违背了角色卡哪条设定。
3. 没有明显 OOC 就返回 []。宁可少报不可误报。
4. 最多 10 条。不要 markdown 代码块标记。`
  const user = `【设定资料】
${projectContext.trim() || '（无）'}

【本章正文】
${chapterText.trim() || '（空）'}

请检查角色言行是否符合人设。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )
  const out: OocFinding[] = []
  for (const it of parseObjectArray(text)) {
    const character = asText(it.character ?? it['角色'])
    const issue = asText(it.issue ?? it['问题'])
    if (!character || !issue) continue
    out.push({
      character,
      evidence: asText(it.evidence ?? it['原文']),
      issue,
      suggestion: asText(it.suggestion ?? it['建议']),
      level: asText(it.level ?? it['级别']) || '提示',
    })
    if (out.length >= 10) break
  }
  return out
}

// ---------- 颉文姬④：选区改写（建议段模式） ----------

export interface RewriteResult {
  /** 修改后的完整段落（是否采用由作者决定，写入"建议段"） */
  rewritten: string
  /** 一句话说明改了什么 */
  notes: string
}

export async function aiRewritePassage(
  passage: string,
  instruction: string,
  styleContext: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<RewriteResult> {
  const cfg = await requireActiveProvider()
  const sys = `你是小说文字编辑，负责对作者选中的段落做局部修改。

规则：
1. 只修改选中段落本身，保持上下文衔接、人物口吻与全文风格一致；不改动段落以外的内容。
2. 严格按要求执行：润色=提升文字表现力但不改剧情与信息；扩写=补充细节/感官/情绪但不得注水跑题；精简=去冗余保留全部有效信息；改语气=调整叙述/对话语气；换视角=在允许范围内调整叙述角度。
3. 返回 JSON：{"rewritten":"修改后的完整段落","notes":"一句话说明改了什么（可空）"}。
4. 不要 markdown 代码块标记。`
  const user = `【写作规范】
${styleContext.trim() || '（无）'}

【修改要求】
${instruction.trim() || '润色'}

【选中段落】
${passage.trim() || '（空）'}

请修改并返回。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }],
    // json: true 让 chat 内部自动采用 JSON_TASK_TEMPERATURE 低温——0.85 会让模型在 JSON
    // 外夹带寒暄/解释，直接抬高解析失败率。温度判断收在 ai.ts 一处，此处不再手填数值。
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )
  const obj = parseObjectArray(text)[0] ?? {}
  // 兜底：JSON 解析失败时才走 humanText 抽取，但抽取结果可能只剩标点残骸
  // （旧版单对象恒解析为空 → 长期依赖此兜底，故表现为"仅输出个别标点符号"）。
  // 这里用 hasSubstance 拦掉无实质内容的抽取结果，宁可交给 UI 提示重试，也不把垃圾塞给作者。
  const fallback = humanText(text)
  return {
    rewritten: asText(obj.rewritten) || (hasSubstance(fallback) ? fallback : ''),
    notes: asText(obj.notes ?? obj['说明']),
  }
}

// ---------- 颉文姬⑤：续写方向（只给思路，不生成正文） ----------

export interface ContinuationAdvice {
  /** 下一段最值得推进的冲突/情节方向（2~4 句） */
  direction: string
  /** 可用的章末钩子 / 悬念点子 */
  hooks: string[]
  /** 容易踩的坑 */
  pitfalls: string[]
  /** 结合伏笔回收计划，建议埋/收哪些伏笔 */
  foreshadow: string
}

export async function aiContinuationAdvice(
  projectContext: string,
  chapterText: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ContinuationAdvice> {
  const cfg = await requireActiveProvider()
  const sys = `你是小说写作指导（卡文救星）。作者刚写完本章，请你给下一部分的创作方向建议。

规则：
1. direction：下一段最值得推进的冲突/情节方向（2~4 句）。
2. hooks：可用的章末钩子/悬念点子 2~4 条（只描述效果，不写成品句子）。
3. pitfalls：容易踩的坑（重复本章节奏、信息过载、与人设或伏笔冲突等），2~3 条。
4. foreshadow：结合设定里的伏笔，建议埋/收哪些伏笔（可空）。
5. 返回 JSON：{"direction":"...","hooks":["..."],"pitfalls":["..."],"foreshadow":"..."}，不要 markdown 代码块标记。`
  const user = `【设定资料（摘要）】
${projectContext.trim() || '（无）'}

【本章正文】
${chapterText.trim() || '（空）'}

请给续写方向建议。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )
  const obj = parseObjectArray(text)[0] ?? {}
  return {
    direction: asText(obj.direction) || humanText(text),
    hooks: (Array.isArray(obj.hooks) ? obj.hooks : []).map(asText).filter(Boolean).slice(0, 4),
    pitfalls: (Array.isArray(obj.pitfalls) ? obj.pitfalls : []).map(asText).filter(Boolean).slice(0, 3),
    foreshadow: asText(obj.foreshadow),
  }
}

// ---------- 颉文姬⑥：爽点 / 毒点检查 ----------
//
// 依据网文行业共识（YY/代入感/金手指 三大核心元素 + "黄金三章"节奏 + 爽点滑向毒点的预警），
// 站在责编视角审本章的"爽感供给"与"劝退风险"。输出 markdown 报告，直接面向作者。

export interface PleasureReport {
  report: string
}

export async function aiPleasureCheck(
  projectContext: string,
  chapterText: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<PleasureReport> {
  const cfg = await requireActiveProvider()
  const sys = `你是网文责任编辑，专精"爽感管理"。网文行业共识：爽感来自 YY（变强/打脸/收获/扬名）、代入感（主角处境与情绪共鸣）与金手指（优势与底牌）；每章至少要给读者一次"短暂快速的矛盾爆发"维持追读黏性；而爽点经营不善会滑向毒点（读者强烈劝退：主角长期憋屈、狗血情节、降智送人头、主角被绿/送女、无意义虐主等）。

请审读本章，输出 markdown 报告，结构：
## 爽点供给
- 本章给了读者几次"情绪爆点"（升级/打脸/收获/反转/温情），各在什么位置
- 如果爆点太少或间隔过长，明确说"本章爽点不足"

## 毒点预警
- 高｜明确的劝退毒点（引原文）
- 中｜疑似毒点苗头
- 没有则写"未发现明显毒点"

## 代入感与金手指
- 主角视角是否连贯、处境是否让读者共情；金手指使用是否合理（有代价、有成长、不无脑）

## 期待感
- 章末是否留下值得点下一章的钩子/悬念；下一章最该给读者什么

规则：
- 用中文输出；除 ## 小标题与 - 列表外不要夹带英文；不要 JSON、不要代码块；不创作剧情。`
  const user = `【设定资料（摘要）】
${projectContext.trim() || '（无）'}

【本章正文】
${chapterText.trim() || '（空）'}

请按爽感管理视角输出报告。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken },
  )
  return { report: humanText(text) || text.trim() }
}

// ---------- 颉文姬⑦：黄金三章检查 ----------
//
// "黄金三章"是网文界共识：前三章必须在读者不费脑的情况下建立主角信息+性格+期待，
// 打出足够的冲突/悬念/爽点——全书不过是黄金三章的无限复制与延长。

export interface OpeningReport {
  report: string
}

export async function aiOpeningCheck(
  projectContext: string,
  openingText: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<OpeningReport> {
  const cfg = await requireActiveProvider()
  const sys = `你是网文主编，负责"开篇定生死"的审稿。请按"黄金三章"标准检查作品开头（前三章或已有章节）：
1. 开局是否在读者不费脑的情况下，快速建立：主角是谁/性格/处境/当前目标。
2. 第一章是否在千字内给出第一个冲突或悬念（读者是否愿意点第二章）。
3. 前几章是否至少有一次"小爽点"（被认可/得便宜/打脸/反转），维持追读意愿。
4. 是否有劝退风险：开局信息过载、主角背景铺陈太长、冲突迟迟不来、文风劝退。

输出 markdown 报告，结构：
## 开局结论
一句话定调：能签 / 需改 / 有扑街风险。

## 黄金三章四查
- 第一章千字内冲突：有/无（引原文）
- 主角立住：人物信息+性格+目标是否建立
- 首个小爽点：位置与效果
- 劝退风险：具体问题（引原文）

## 修改建议
1. 最该改的一处
2. …

规则：
- 只针对开头文本做判断，不创作剧情。
- 用中文输出；除 ## 小标题与 - 列表外不要夹带英文；不要 JSON、不要代码块。`
  const user = `【设定资料（摘要）】
${projectContext.trim() || '（无）'}

【作品开头（前三章或已有章节）】
${openingText.trim() || '（作者尚未提供开头文本）'}

请按黄金三章标准检查。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken },
  )
  return { report: humanText(text) || text.trim() }
}

// ---------- 颉文姬⑦：灵感简报（开写前本章待办，v1.6.1） ----------

export interface BriefingReport {
  /** markdown 报告（## 小标题 + - 列表，纯中文） */
  report: string
}

export async function aiBriefing(
  projectContext: string,
  chapterContext: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<BriefingReport> {
  const cfg = await requireActiveProvider()
  const sys = `你是网文资深编辑兼创作助手。作者马上要动笔写下一章，请基于提供的设定资料与当前进度，生成一份「本章写作简报」，帮作者不丢线、不卡文、不 OOC。

简报结构（必须包含以下四个部分，用中文）：
## 待办伏笔
- 列出仍未回收、且计划回收位置临近的伏笔（编号 + 一句话内容 + 建议本章埋/收动作）
## 钩子与爽点
- 2~3 条本章可安排的钩子 / 爽点方向（只给方向，不写正文）
## 角色状态提醒
- 本章可能出场角色的当前状态 / 动机 / 关系提醒（防止言行失格）
## 下一章衔接
- 与上一章结尾的衔接建议 + 章末钩子方向

规则：
- 只给方向与提醒，不生成正文、不代写段落、不替作者做决定。
- 用中文输出；除 ## 小标题与 - 列表外不要夹杂任何英文；不要 JSON、不要代码块。`
  const user = `【设定资料（摘要）】
${projectContext.trim() || '（无）'}

【当前章节 / 进度】
${chapterContext.trim() || '（无）'}

请输出本章写作简报。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken },
  )
  return { report: humanText(text) || text.trim() }
}

/** 基于本章正文，生成「压缩摘要」：按正文长度 ×1/10 向上取整到最近百字（保留全部关键情节/人物/伏笔/转折/设定），供编辑器「AI 生成摘要」、校对/推演本/综合诊断「简略模式」复用。
 * 比例说明：1/10 能在大头压缩的同时保住绝大多数信息（避免一句话摘要把 80% 内容丢掉）；字数向上取整到百字（如 3700 字→400 字、4400 字→500 字），下限自然为 100 字（ceil 到百），上限 1200 字防止超长章摘要失控。 */
export async function aiChapterSummary(
  text: string,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const cfg = await requireActiveProvider()
  const chars = text.replace(/\s/g, '').length
  const target = Math.min(1200, Math.max(100, Math.ceil((chars * 0.1) / 100) * 100))
  const sys = `你是网文资深编辑。请把下面这一章正文压缩成约 ${target} 个汉字的连贯摘要（约为原文长度的 1/10）。\n`
    + `要求：\n`
    + `· 保留全部关键情节、人物动作与动机、伏笔的埋设/回收、重要转折、世界观设定点，信息密度要高；\n`
    + `· 用若干自然段或分点呈现，不要只写一句话，但也不要复述无关细节；\n`
    + `· 直接输出摘要正文，不要解释、不要标题、不要引号、不要序号。`
  const user = `【本章正文】\n${text.trim() || '（空白）'}`
  const out = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal },
  )
  return (humanText(out) || out.trim()).replace(/\n{3,}/g, '\n\n').trim().slice(0, 1600)
}

// ---------- 颉文姬⑤：本章设定补登（实体抽取） ----------
//
// 职责边界（重要）：本函数**只负责从正文抽取候选实体**，
// 「这些实体是否已在设定表里登记过」一律交给 settingLedger.ts 做确定性比对——
// AI 不知道作者的别称机制、也容易把已登记的说成没有，故不让它下这个判断。

export type SettingEntityType = '人物' | '势力' | '地点' | '种族' | '物品' | '术语'

/** AI 从本章正文抽出的候选实体（尚未与设定表比对） */
export interface ExtractedEntity {
  type: SettingEntityType
  name: string
  /** 一句话描述，只写正文写明的 */
  desc: string
  /** 原文原句证据 */
  evidence: string
  /** 仅人物：建议归入哪张角色卡 */
  tier?: '主要' | '次要' | 'NPC'
}

const ENTITY_TYPES: SettingEntityType[] = ['人物', '势力', '地点', '种族', '物品', '术语']

const EXTRACT_SYS = `你是长篇小说设定资料助理。请从本章正文中，抽取出「有明确专名的设定实体」，供作者核对是否需要登记进设定表。

type 只能取这 6 个值之一：
- 人物：有姓名或有明确称号的角色（含仅被提及、未正式出场的历史人物）
- 势力：王朝、宗门、世家、商会、军队、隐秘组织等
- 地点：大陆、区域、国家、城市、秘境、山脉、建筑等专有地名
- 种族：种族、魔兽、灵兽、异种等
- 物品：功法、法宝、丹药、材料、货币、传承等
- 术语：境界名、专有称谓、世界独有的名词等

铁律：
1. 只抽**本章正文确实出现**的实体。严禁虚构、严禁推测、严禁"合理补充"——这是资料整理，不是创作。
2. 每个实体必须附 evidence：正文中包含该名称的**原句**（照抄、不要改写，不超过 60 字）。找不到原句的就不要抽。
3. 只抽有专名的（如"青岚宗""陈渊"）；不抽无名代称（如"那个老者""一名侍卫"）。
4. 不抽现实世界事物、不抽通用词（如"灵气""长剑"这类泛称）。
5. desc：一句话（不超过 40 字）概括本章展现的该实体信息，只写正文写明的，不知道就留空。
6. 人物额外给 tier：主要（主角团/贯穿全书/终极反派）/ 次要（宿敌/导师/重要配角）/ NPC（功能型、龙套），按本章戏份与定位判断；非人物类型不要给 tier。
7. 同一实体在本章有本名与别称时只输出一条，name 用正文最常用的那个。
8. 最多 20 条，按重要度排序。没有任何可抽取的实体就返回 []。
9. 只输出 JSON 数组，元素形如 {"type":"人物","name":"张三","desc":"…","evidence":"…","tier":"NPC"}，不要解释、不要 markdown 代码块标记。`

export async function aiExtractSettingEntities(
  chapterText: string,
  chapterTitle: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ExtractedEntity[]> {
  const cfg = await requireActiveProvider()
  const user = `【章节】${chapterTitle || '（未命名章节）'}

【本章正文】
${chapterText.trim() || '（空白）'}

请抽取本章出现的设定实体。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(EXTRACT_SYS, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  for (const it of parseObjectArray(text)) {
    const name = asText(it.name ?? it['名称'])
    if (!name) continue
    const rawType = asText(it.type ?? it['类型'])
    const type = (ENTITY_TYPES as string[]).includes(rawType) ? (rawType as SettingEntityType) : null
    if (!type) continue
    // 同名同类型只保留第一条（模型偶尔重复输出）
    const key = `${type}::${name}`
    if (seen.has(key)) continue
    seen.add(key)
    const rawTier = asText(it.tier ?? it['层级'])
    out.push({
      type,
      name,
      desc: asText(it.desc ?? it['描述']),
      evidence: asText(it.evidence ?? it['原文'] ?? it['证据']),
      ...(type === '人物' && (rawTier === '主要' || rawTier === '次要' || rawTier === 'NPC') ? { tier: rawTier } : {}),
    })
    if (out.length >= 20) break
  }
  return out
}

// ---------- 颉文姬⑦：AI 伴写（inline ghost 逐句续写 · 2.2.0） ----------
//
// 与「续写方向」（aiContinuationAdvice：只给方向、不落正文）的区别：本函数**直接产出正文续写片段**，
// 一次一句话，交给编辑器以浅灰 ghost 文本透在光标处；作者按 Tab 采纳才真正落进正文，继续打字即丢弃。
// 定位是"最轻的一档"——日常不断流、完全可逆、零打扰。
//
// 三条实现依据都来自本项目已实测结论，别随手改：
//   1. 🔴 反重复 / 去 AI 味的提示词**只有钉在 system 末尾才有效**，埋中段≈0（酒馆模式实测）。
//   2. 🔴 采样沿用 repeat_last_n=512 + frequency_penalty=0.1（手部率 28.9%→13.4%）；
//      **绝不调高 repeat_penalty** —— 1.4 实测动作行 2.08→0.43/轮且括号不闭合
//      （`（`/`）` 本身就在回看窗口里，惩罚会打在格式符上）。
//   3. 文风锚定不靠"文风枚举标签"，而走三层：①前文样本（必带、最准）②《写作规范》摘录（可关）
//      ③作者自定义补充。理由：枚举永不够用、选错标签反而更假，且伴写是低打扰场景，多一个选择就是多一次打断。

/** 伴写长度档位。给用户的是「档」不是数字——数字输入是伪自由度，用户不知该填多少，填大了 ghost 会糊住半屏 */
export type InlineSuggestLength = 'short' | 'sentence' | 'two'

export const INLINE_SUGGEST_LIMITS: Record<InlineSuggestLength, { label: string; chars: number; numPredict: number }> = {
  short: { label: '短句', chars: 20, numPredict: 40 },
  sentence: { label: '一句话', chars: 40, numPredict: 64 },
  two: { label: '两句', chars: 80, numPredict: 110 },
}

/**
 * 去 AI 味约束（**生成向**）。
 *
 * ⚠️ 不要复用 autoContinue.ts 的 DEAI_TEMPLATES：那 4 条写的是「把正文改得…」的**改写**指令，
 * 放进"生成"场景会让模型先去找正文再改写，甚至输出「以下是修改后的内容：」这类前言。
 * 这里只抽它们的共性，写成生成向的短约束——针对"一句话"这个粒度，不用长清单。
 */
const DEAI_INLINE_RULE = `【文风纪律 · 最重要】
不要用「仿佛 / 似乎 / 宛如 / 不禁 / 然而 / 值得一提的是 / 不知为何」这类 AI 高频套话开头；
不要堆四字成语与对称排比；不要写空泛的总结、升华或哲理感慨；
不要滥用破折号与省略号；多给具体的动作、对白、感官细节，句子长短错落，像活人顺手写下来的。`

/**
 * 伴写结果后处理（**纯函数，可单测**）。
 * 把模型返回的文本洗成"可直接落进正文的一段"：剥围栏 / 前言 / 包裹引号 → 折掉换行 → 按句末标点截断到字数上限。
 * @returns 可插入正文的片段；**返回空串表示本次不作建议**（少于 4 字视为噪声，宁缺毋滥——显示垃圾建议比不显示更烦人）。
 */
export function trimInlineSuggestion(raw: string, maxChars: number): string {
  let s = (raw ?? '').replace(/\r/g, '').trim()
  if (!s) return ''
  s = s.replace(/```[a-zA-Z]*\n?/g, '')                       // 去掉 markdown 代码围栏
  s = (s.split(/\n{2,}/)[0] ?? '').trim()                     // 只要第一段（模型偶尔会多续一段）
  s = s.replace(/\n+/g, '')                                   // ghost 是"一句话"，不落换行
  s = s.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '')       // 整段被引号包裹
  s = s.replace(/^(?:好的|明白)[，,]\s*/, '')                  // 「好的，…」开场
  s = s.replace(/^(?:以下[是为][^：:]{0,14}[：:]|续写[：:]|接续[：:]|接下来[^：:]{0,8}[：:])\s*/u, '')
  s = s.trim()
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars)
    // 优先切在句末标点（保证 ghost 不会以半句悬空收尾）；退而求其次切在逗号；都没有才硬切
    let at = -1
    for (const p of ['。', '！', '？', '…', '；', '!', '?']) at = Math.max(at, cut.lastIndexOf(p))
    if (at >= Math.floor(maxChars * 0.4)) s = cut.slice(0, at + 1)
    else {
      const comma = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf(','))
      s = comma >= Math.floor(maxChars * 0.5) ? cut.slice(0, comma + 1) : cut
    }
  }
  s = s.trim()
  return s.length >= 4 ? s : ''
}

export interface InlineSuggestOptions {
  /** 设定资料摘要（可空）。只用于核对专名 / 身份 / 称谓，不要求模型照抄内容 */
  projectContext?: string
  /** 《写作规范》摘录（已知坏习惯清单 / 标点规范 / 视角切换规则）；关闭该层时传空串 */
  styleSpec?: string
  /** ③ 作者自定义风格补充（可空） */
  styleNote?: string
  /** 长度档位，默认 'sentence'（一句话 ≤40 字） */
  length?: InlineSuggestLength
  /** 是否挂「去 AI 味」约束，默认 true（轻量档） */
  deAiFlavor?: boolean
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

/**
 * AI 伴写：根据光标之前的正文，续写紧接着的**一句话**（纯文本，非 JSON）。
 * @param contextBefore 光标之前的正文（调用方切片，建议末尾 2000 字内）
 * @returns 可直接插入正文的片段；空串 = 本次无合适建议，调用方应静默丢弃、不显示 ghost
 */
export async function aiInlineSuggest(contextBefore: string, opts: InlineSuggestOptions = {}): Promise<string> {
  const body = (contextBefore ?? '').trim()
  if (body.length < 8) return ''            // 前文太短（还没起句），无从"接着写"
  const cfg = await requireActiveProvider()
  const limit = INLINE_SUGGEST_LIMITS[opts.length ?? 'sentence']
  const goal = opts.length === 'short' ? '一个短句' : opts.length === 'two' ? '一到两句' : '一句话'

  // system 分层：基础约束 → 设定 → 写作规范 → 自定义补充 → 去 AI 味（🔴 必须最后）
  const layers: string[] = [
    `你是中文网络小说的「伴写」引擎，紧贴在作者的键盘后面，替他往下接${goal}。

【任务】只输出**紧接着前文往下写的正文本身**，${goal}，不超过 ${limit.chars} 字，写完立刻停。
【硬性要求】
1. 直接给正文。不要解释、不要说"好的"、不要引号、不要 markdown、不要标题、不要分点、不要换行。
2. 严格顺着前文的语气、人称、视角、时态、称呼与叙事节奏往下写，衔接自然到看不出接缝。
3. 不要复述或改写前文的最后一句，从它的下一步写起。
4. 不写总结、不写升华、不预告后文、不替作者收尾。`,
  ]
  if (opts.projectContext?.trim()) layers.push(`【设定资料（仅用于核对专名、身份、称谓，不要照抄内容）】\n${opts.projectContext.trim()}`)
  if (opts.styleSpec?.trim()) layers.push(`【作者的《写作规范》· 必须遵守】\n${opts.styleSpec.trim()}`)
  if (opts.styleNote?.trim()) layers.push(`【作者本次追加的文风要求】\n${opts.styleNote.trim()}`)
  if (opts.deAiFlavor !== false) layers.push(DEAI_INLINE_RULE)

  const user = `【光标之前的正文】\n${authorBlock(newAuthorFence(), body)}\n\n请接着往下写。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(layers.join('\n\n'), cfg) }, { role: 'user', content: user }],
    {
      // 这是创作任务，走全局创意档（默认 0.85），不手填温度——温度唯一真源在 ai.ts（项目铁律）
      timeoutMs: CHAT_TIMEOUT_MS,
      signal: opts.signal,
      onToken: opts.onToken,
      // 🔴 必须关思考链（ai.ts 的 think 注释里已把伴写登记为第二个「有意关闭」的例外，与酒馆同类）：
      //    思考型模型（qwen3 系等）会先吐一大段推理，① 延迟从 1~3s 变成十几秒，ghost 手感直接崩；
      //    ② 万一只吐思考不给结论，ollamaChatRaw 有「content 为空则退用 thinking」的兜底，
      //    那段推理会被当成续写内容透到正文里。伴写要的是"顺手接一句"，不是推理。
      think: false,
      extraOptions: {
        top_p: 0.92,
        // Ollama 原生字段：显式限产出长度（不传时按模型默认，可能吐一长段）。
        // OpenAI 兼容端点的白名单只放行 top_p / presence_penalty / frequency_penalty，
        // 该字段会被 openaiSampling() 丢弃 —— 那边靠 prompt 约束 + 客户端句末截断兜底。
        num_predict: limit.numPredict,
        // 两把「治复读」的旋钮必须显式下发才生效（见 docs/酒馆模式-工程红线.md）：
        // repeat_last_n 默认仅 64 词元≈50 汉字，是三种惩罚共用的回看窗口，射程半句 → 跨句复读罚不到；
        // frequency_penalty 不传则默认 0，按词频扣分这件事根本没发生。
        repeat_last_n: 512,
        frequency_penalty: 0.1,
      },
    },
  )
  return trimInlineSuggestion(text, limit.chars)
}
