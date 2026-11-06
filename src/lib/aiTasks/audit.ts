// ============ AI 任务层 · 审校与诊断六件套 ============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #7–#12 段）。
// 收编：连续性自查 / 读者反馈分析 / 项目健康诊断 / 伏笔闭环 / 术语去重 / 文风体检。
// ⚠️ #9 项目诊断用到 #7 的 `ContinuityFinding` 类型 —— 同文件内引用，不再跨模块。
// ⚠️ 六条提示词各自就地声明；注册顺序由门面的 PROMPT_ORDER 决定，**别在这里调整顺序**。
import type { CallRequestContext } from '@/lib/ai/callTracking'
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt, isCancelled } from '@/lib/ai'
import { parseObjectArray, parseObjectArrayDetailed, asText, humanText } from '@/lib/ai/aiParse'
import { newAuthorFence, authorBlock } from '@/lib/ai/promptGuard'
import type { PromptDef } from '@/lib/ai/promptSettings'
import type { StepExecutionResult, StepResultState } from '@/lib/revision/revisionTypes'

/** 「文风体检」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_style_audit = `你是资深中文网文文风编辑。作者提供了《写作规范》（个人坏习惯词清单 / 标点规范 / 视角规则）和本章正文，请对照规范体检本章文风质量，指出影响阅读体验的文风毛病。

体检维度与规则：
1. 坏习惯词：逐一核查本章是否出现《写作规范》中列举的个人坏习惯词汇或高频口头禅，指出具体位置并摘录上下文。
2. 视角（POV）：检查是否存在非受限视角的越界越权描写（如在第三人称限知视角下突然跳脱去描写对手的隐秘心理活动或不在场事件）。
3. 标点：排查中英文标点混用、用三个点"..."代替标准六角省略号"……"、破折号不规范、引号缺失或不成对等格式毛病。
4. 节奏：指出长段落不换行导致密集压抑、对话与叙述严重失衡、大段空泛说教或报菜名式解释等节奏问题（提示级）。
5. 宁可少报，不可误报：只报确凿问题，不把正常叙述强行挑刺；没有问题时返回空数组 []。
6. 返回 JSON 数组，元素形如 {"type":"坏习惯词|视角|标点|节奏|其他","quote":"命中原文（可空）","issue":"问题说明","suggestion":"具体修改建议","level":"严重|中等|提示"}。
7. 只输出一个 JSON 数组，不要任何额外解释、不要 markdown 代码块标记。`

/** 「术语去重」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_term_dedup = `你是网络小说专有名词与设定管理助手。作者给出了一份「名词术语」列表，其中可能存在同义重复（同一概念的不同写法，如「灵气/灵元」「凝气期/练气期」）或概念换皮、跨类别重名等问题。请将它们聚类成「应合并」的术语组。

聚类判据：
1. 真实同义合并：只把确指同一事物、同种概念或由于笔误/前后设定演变导致的分裂名称归为一组；不同事物仅字面相近的绝不归并（例如「青云剑」与「青云门」是法宝与宗门，不可合并）。
2. 跨类别识别：识别跨越不同设定位的重复（如「境界类·神海」与「地理类·神海穴」若指同一设定概念应提示合并）。
3. 规范建议：每组说明合并理由（reason）并给出最符合网文惯例或作者核心体系的标准推荐词（suggestion）。
4. 没有重复项时返回 {"groups": []}。
5. 返回 JSON 对象：{"groups":[{"terms":["词1","词2"],"reason":"合并依据","suggestion":"标准推荐名"}]}。
6. 只输出一个 JSON 对象，不要任何解释说明、不要 markdown 代码块标记。`

/** 「伏笔闭环审查」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_foreshadow_review = `你是长篇连载小说伏笔管理与剧情闭环专家。作者提供了「伏笔追踪表」与「章节总表」（含每章已标记埋设与回收的伏笔编号），请对照两张表从全局视角审查伏笔生态的健康度。

重点审查方向：
1. 跨度过大：伏笔埋设后超过 30~50 章以上毫无动静且未有任何阶段性线索，读者已被动遗忘（建议提前给出侧面呼应或加快回收进度）。
2. 悬空断头：已埋设且总纲进入中后期却从未安排回收、或追踪表中登记但各章从未实际埋设的虚设伏笔。
3. 埋收失衡：某些章节区间密集挖坑（如连挖多坑）却长期零回收，形成烂尾风险与读者疲劳。
4. 节奏突兀：伏笔回收时缺乏必要的前置因果铺垫，导致解密如同机械降神或强行圆场。

规则：
- 只报有文本与数据可查的判断，没有问题时返回空数组 []。
- 返回 JSON 数组，元素形如 {"level":"严重|中等|提示","title":"一句话结论","detail":"具体哪条伏笔、跨几章、为什么有问题","where":"涉及的伏笔编号或章节"}。
- 只输出一个 JSON 数组，不要任何解释说明、不要 markdown 代码块标记。`

/** 「项目健康诊断」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_project_diagnosis = `你是资深网络小说创作项目的全方位健康诊断助手。作者提供了当前项目的设定资料、章节清单与统计数据，请综合评估作品的创作健康度与商业连载潜力。

诊断维度与要求：
1. 健康分（score）：0~100 的整数，基于设定自洽度、主线推进清晰度、角色立体度与伏笔健康度综合打分。
2. 总体诊断（summary）：一句话提炼核心现状，附 2~3 句对当前优势与最大软肋的客观分析，不讲空泛鼓励套话。
3. 风险清单（risks）：最多 6 条，按严重程度降序排列。
   - 严重：直接导致情节卡死、战力崩塌、设定自相矛盾或主角动机瓦解的致命硬伤；
   - 中等：支线喧宾夺主、日常拖沓注水、配角工具人化或节奏钝化；
   - 提示：可进一步深挖或润色的细节。
   - 每条包含 level（严重|中等|提示）、title（简短问题）、detail（具体剖析）、where（涉及章节或设定分类）。
4. 下一步建议（nextSteps）：3~5 条清晰、具体、可立刻动手的实操动作（如「先补齐第X卷卷终高潮的破局代价」），不给空泛口号。
5. 返回 JSON 对象：{"score":85,"summary":"…","risks":[{"level":"严重|中等|提示","title":"…","detail":"…","where":"…"}],"nextSteps":["…"]}。
6. 只输出一个 JSON 对象，不要任何解释说明、不要 markdown 代码块标记。`

/** 「读者反馈分析」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_feedback_analysis = `你是网络小说连载运营与读者留存分析专家。作者提供了一段时间的「读者反馈 / 运营数据」记录（如追读走势、均订留存、章评吐槽、流失点章节与读者反馈内容）。请站在资深责编视角进行深度归因与实操指导。

分析任务：
1. 总体诊断（summary）：基于数据趋势与读者情绪给出整体判断，指出当前是处于上升蓄势期、平稳期还是留存滑坡危险期。
2. 流失归因（churnAttribution）：将流失章节、章评高频负反馈与剧情走向进行交叉比对，精准找出读者跑路的根本原因（例如：主角持续吃瘪受气且无合理反击、突兀喂毒、战力崩坏吃设定、连续数章水日常无核心推进、重要配角人设崩塌等）。
3. 应对建议（suggestions）：给出立竿见影的 3~5 条破局动作建议（如：加快释放高潮打脸、紧急回收关键伏笔提振期待、通过侧面情节修补配角人设、明确下一阶段主线目标）。

规则：
- 坚持客观事实分析，绝不凭空臆造数据或虚假评论；若无有效数据，直接在 summary 明确写明「暂无可分析数据」。
- 返回 JSON 对象：{"summary":"总体诊断","churnAttribution":"流失归因深度分析","suggestions":"可执行应对建议"}。
- 只输出一个 JSON 对象，不要任何解释说明、不要 markdown 代码块标记。`

/** 「连续性校验」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_continuity_audit = `你是长篇网络小说的设定校对与连续性审查专家。请对照作者的设定资料与前文事实，审查正文中出现的「前后矛盾、设定冲突、逻辑硬伤」。

重点核查类别：
1. 设定与事实硬伤：人物修为境界/品级前后不一、已损毁物品突然完好出现、死者无复活依据突然登场、所属势力或阵营关系自相矛盾。
2. 时空与历法错位：人物行进距离与历法时间矛盾（如一日跨越万里却无传送解释）、昼夜季节颠倒、角色年龄或代际关系对不上。
3. 战力与规则崩坏：低阶在无特殊底牌/代价下无理由秒杀高阶、既定力量体系规则被随意违背。
4. 知情与因果悖论：角色提前知道尚未发生或在保密范围内的秘密（穿帮）、未发生的事被当作前文共识。

规则：
- 严格遵循证据：只报有确凿设定依据或正文白纸黑字冲突的问题，绝不报「建议增加环境描写」等文笔主观建议。
- level 判定：严重=直接颠覆设定或读者完全看不懂的逻辑断裂；中等=具体细节或数值对不上；提示=存疑但尚能勉强圆回。
- 最多返回 12 条，按严重程度从高到低排序；没有发现问题时返回空数组 []。
- 返回 JSON 数组，元素形如 {"level":"严重|中等|提示","title":"一句话结论","detail":"具体冲突在哪、和哪条设定对不上","where":"涉及的章节或设定项"}。
- 只输出一个 JSON 数组，不要任何解释说明、不要 markdown 代码块标记。`

// ---------- 一致性深度自查 ----------

export interface ContinuityFinding {
  /** 严重 / 中等 / 提示 */
  level: string
  title: string
  detail: string
  /** 涉及位置（章节名 / 设定项） */
  where: string
}

/**
 * 审查类任务的公共选项（3.2.0 · WQ7 加 `request`）。
 * 🔴 审查也是要记账的模型调用 —— 不带归属就只能靠"唯一任务"兼容路径。
 */
type ReviewAiOpts = {
  signal?: AbortSignal
  onToken?: (delta: string) => void
  request?: CallRequestContext
}

/**
 * WQ1（3.2.0）：连续性审查的**带状态**版本。
 *
 * 为什么要它：旧签名只返回 `ContinuityFinding[]`，`[]` 分不清「审了没问题」与
 * 「请求失败 / 解析失败」—— 连写自检把三种都当成"通过"（Q1 登记病灶）。
 * 本函数返回 `StepExecutionResult`：合法空结果是 completed，失败/取消/截断
 * 分别有状态，调用方（selfRefine）据此决定是否暂停自动应用。
 */
export async function aiContinuityAuditWithStatus(
  projectContext: string,
  chapterText: string,
  opts?: ReviewAiOpts,
): Promise<StepExecutionResult<ContinuityFinding[]>> {
  const one = (state: StepResultState, errorCode?: string): StepExecutionResult<ContinuityFinding[]> =>
    ({ state, coverage: { requested: 1, completed: state === 'completed' ? 1 : 0, failed: state === 'failed' ? 1 : 0, skipped: 0 }, ...(errorCode ? { errorCode, retryable: state === 'failed' } : {}) })
  try {
    const cfg = await requireProviderFor('review')
    // 🔴 作者资料与正文都是**不可信文本**：包裹成边界块（内容一字不改，见 promptGuard 文件头）
    const fence = newAuthorFence()
    const sys = P_continuity_audit
    const user = `【设定资料】
${projectContext.trim() ? authorBlock(fence, projectContext.trim()) : '（无）'}

【待审查正文】
${chapterText.trim() ? authorBlock(fence, chapterText.trim()) : '（作者未指定正文，请仅在设定资料内部查找互相矛盾之处）'}

请返回问题清单。`
    const text = await chat(cfg, [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }], {
      output: 'json-object', reasoning: 'off',
      timeoutMs: CHAT_TIMEOUT_MS,
      signal: opts?.signal,
      onToken: opts?.onToken,
      ...(opts?.request ? { request: opts.request } : {}),
    })
    // WQ1：三态解析 —— invalid 是失败，合法空数组是"审了没问题"
    const parsed = parseObjectArrayDetailed(text)
    if (parsed.outcome === 'invalid') return one('failed', 'parse-invalid')
    const out: ContinuityFinding[] = []
    for (const it of parsed.data) {
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
    return {
      state: 'completed',
      result: { outcome: parsed.outcome, data: out, diagnostics: parsed.diagnostics, truncated: parsed.truncated },
      coverage: { requested: 1, completed: 1, failed: 0, skipped: 0 },
      sourceId: 'continuity',
    }
  } catch (e) {
    if (isCancelled(e)) return one('cancelled', 'cancelled')
    return one('failed', e instanceof Error ? e.message.slice(0, 80) : 'unknown')
  }
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
  opts?: ReviewAiOpts,
): Promise<FeedbackAnalysis> {
  const cfg = await requireProviderFor('review')
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

  const fence = newAuthorFence()
  const sys = P_feedback_analysis

  const user = `【读者反馈记录】
${entries.length ? authorBlock(fence, list) : list}

请给出诊断。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    {
      timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, output: 'json-object', reasoning: 'off',
      ...(opts?.request ? { request: opts.request } : {}),
    },
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
  opts?: ReviewAiOpts,
): Promise<ProjectDiagnosis> {
  const cfg = await requireProviderFor('review')
  const fence = newAuthorFence()
  const sys = P_project_diagnosis

  const user = `【关键统计】
- 卷数：${stats.volumes}　章节数：${stats.chapters}　累计字数：${stats.words}
- 未回收伏笔：${stats.unf} 条　闲置灵感素材：${stats.unusedIdeas} 条

【项目资料】
${projectContext.trim() ? authorBlock(fence, projectContext.trim()) : '（无）'}

请给出诊断。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    {
      timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, output: 'json-object', reasoning: 'off',
      ...(opts?.request ? { request: opts.request } : {}),
    },
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

/** WQ1：伏笔审查的带状态版本（判定口径同 `aiContinuityAuditWithStatus`） */
export async function aiForeshadowReviewWithStatus(
  projectContext: string,
  opts?: ReviewAiOpts,
): Promise<StepExecutionResult<ForeshadowReviewFinding[]>> {
  const one = (state: StepResultState, errorCode?: string): StepExecutionResult<ForeshadowReviewFinding[]> =>
    ({ state, coverage: { requested: 1, completed: state === 'completed' ? 1 : 0, failed: state === 'failed' ? 1 : 0, skipped: 0 }, ...(errorCode ? { errorCode, retryable: state === 'failed' } : {}) })
  try {
    const cfg = await requireProviderFor('review')
    const fence = newAuthorFence()
    const sys = P_foreshadow_review

    const user = `【项目资料（含伏笔追踪与章节总表）】
${projectContext.trim() ? authorBlock(fence, projectContext.trim()) : '（无）'}

请审查伏笔闭环健康度。`

    const text = await chat(
      cfg,
      [
        { role: 'system', content: composeSystemPrompt(sys, cfg) },
        { role: 'user', content: user },
      ],
      {
      timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, output: 'json-object', reasoning: 'off',
      ...(opts?.request ? { request: opts.request } : {}),
    },
    )

    const parsed = parseObjectArrayDetailed(text)
    if (parsed.outcome === 'invalid') return one('failed', 'parse-invalid')
    const out: ForeshadowReviewFinding[] = []
    for (const it of parsed.data) {
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
    return {
      state: 'completed',
      result: { outcome: parsed.outcome, data: out, diagnostics: parsed.diagnostics, truncated: parsed.truncated },
      coverage: { requested: 1, completed: 1, failed: 0, skipped: 0 },
      sourceId: 'foreshadow',
    }
  } catch (e) {
    if (isCancelled(e)) return one('cancelled', 'cancelled')
    return one('failed', e instanceof Error ? e.message.slice(0, 80) : 'unknown')
  }
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
  opts?: ReviewAiOpts,
): Promise<{ groups: TermDupGroup[] }> {
  const cfg = await requireProviderFor('review')
  const fence = newAuthorFence()
  const list = terms
    .map((t, i) => `${i + 1}. ${t.term}${t.category ? `（${t.category}）` : ''}：${t.definition || '—'}`)
    .join('\n')
  const sys = P_term_dedup

  const user = `【名词术语】
${list.trim() ? authorBlock(fence, list) : '（空）'}

请找出应合并的重复 / 同义术语。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    {
      timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, output: 'json-object', reasoning: 'off',
      ...(opts?.request ? { request: opts.request } : {}),
    },
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
  opts?: ReviewAiOpts,
): Promise<StyleCheckFinding[]> {
  const cfg = await requireProviderFor('review')
  const fence = newAuthorFence()
  // ⚠️【写作规范】是模型要**遵守**的规则（不是待处理素材），刻意不包裹；只有正文需要边界保护
  const sys = P_style_audit

  const user = `【写作规范】
${styleContext.trim() || '（作者尚未填写写作规范）'}

【本章正文】
${chapterText.trim() ? authorBlock(fence, chapterText.trim()) : '（空）'}

请体检本章文风。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    {
      timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, output: 'json-object', reasoning: 'off',
      ...(opts?.request ? { request: opts.request } : {}),
    },
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

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const AUDIT_PROMPTS: PromptDef[] = [
  {
    meta: { id: 'continuity-audit', group: '编辑与审校', name: '连续性校验', note: '对照设定资料，找正文里的前后矛盾与设定冲突。' },
    read: () => P_continuity_audit,
    write: t => { P_continuity_audit = t },
  },
  {
    meta: { id: 'feedback-analysis', group: '项目诊断', name: '读者反馈分析', note: '把追读 / 均订 / 章评吐槽交叉分析，给出应对建议。' },
    read: () => P_feedback_analysis,
    write: t => { P_feedback_analysis = t },
  },
  {
    meta: { id: 'project-diagnosis', group: '项目诊断', name: '项目健康诊断', note: '从设定资料与章节清单看项目整体健康度。' },
    read: () => P_project_diagnosis,
    write: t => { P_project_diagnosis = t },
  },
  {
    meta: { id: 'foreshadow-review', group: '设定与资料', name: '伏笔闭环审查', note: '查悬空伏笔、跨度失衡、埋设与回收失衡。' },
    read: () => P_foreshadow_review,
    write: t => { P_foreshadow_review = t },
  },
  {
    meta: { id: 'term-dedup', group: '设定与资料', name: '术语去重', note: '找出同义重复的专有名词并给合并建议。' },
    read: () => P_term_dedup,
    write: t => { P_term_dedup = t },
  },
  {
    meta: { id: 'style-audit', group: '编辑与审校', name: '文风体检', note: '按《写作规范》查坏习惯词、标点、视角规则。' },
    read: () => P_style_audit,
    write: t => { P_style_audit = t },
  },
]
