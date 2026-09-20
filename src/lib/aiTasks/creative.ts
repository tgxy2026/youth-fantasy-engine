// ============ AI 任务层 · 创意写作（设定奠基 / 大纲 / 续排细纲）============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #25 段 + #26 的 aiExtendOutline）。
// 方案见 docs/2.2.0-全自动AI小说创作工作流方案.md。
// 🔴 生成与落库严格分离：本文件只产出内存对象，**绝不触达 db**；写库一律由用户在草稿界面上确认。
// 🔴 输出与「一键拆书」的 ExtractedEntity[] 同形状（复用 lib/flow 的判重→草稿→审阅→落库管线）。
import { chat, requireActiveProvider, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { parseLooseObject, asText } from '../aiParse'
import { longStream } from './stream'
import type { SettingEntityType, ExtractedEntity } from './extract'
import type { PromptDef } from '../promptSettings'

// ==================== 创意写作（全自动创作工作流 · 生成型入口）====================
//
// 方案见 `docs/2.2.0-全自动AI小说创作工作流方案.md`：整条链路里**只有这两块要新写**，
// 其余节点（逐章草稿 / 审校闭环 / 伏笔 / 导出）全部复用既有能力。
//
// 🔴 输出故意与「一键拆书」的 `ExtractedEntity[]` **同形状**：这样「判重 → 草稿 → 审阅 → 落库」
//    整条管线（`lib/flow`）与审阅界面（`DraftReviewPanel`）都能直接复用，不另造一套。
// 🔴 生成与落库严格分离：本文件只产出内存对象，**绝不触达 db**；写库一律由用户在草稿界面上确认。
// 🔴 数量必须封顶：不封顶时模型会一口气生成几十个角色，作者光删就删到手软。
// 🔴 不许新造专名（大纲这一步）：新造的名字在设定表里对不上，反而制造"未登记实体"。

/** 设定奠基的产出上限（给模型的硬约束） */
export interface BibleCounts {
  main: number; secondary: number; npc: number
  faction: number; location: number; term: number; item: number
}

export const DEFAULT_BIBLE_COUNTS: BibleCounts = {
  main: 2, secondary: 4, npc: 4, faction: 4, location: 5, term: 6, item: 3,
}

const bibleSys = (c: BibleCounts) => `你是网文设定架构师。作者给了一句话想法，你要把它展开成一套「够开写、不写死」的设定草稿。

铁律：
1. 只输出 JSON，不要任何解释文字，不要 markdown 代码块围栏。
2. 每条设定都必须服务于这句话想法本身，不要偏离题材另起炉灶。
3. **宁可少而准**：每条都要有存在理由（能撑起冲突 / 爽点 / 悬念 / 世界规则），凑数的不要。
4. **留白**：不要把故事写死（例如"他最终成神"）；写到"够开写"就停下。
5. 名字要像正经中文网文：人名 2~3 字、宗门地名带风格感；严禁"张三""某宗""XX城"这类占位名。
6. desc 一句话（不超过 40 字），写清"它在故事里是什么 / 干什么"。
7. tier 只给人物：主要（主角团 / 贯穿全书）/ 次要（宿敌 / 导师 / 重要配角）/ NPC（功能型）。
8. 数量上限（**不得超过**）：主要角色 ${c.main}、次要角色 ${c.secondary}、NPC ${c.npc}、势力 ${c.faction}、地点 ${c.location}、术语 ${c.term}、物品 ${c.item}。
9. 严格使用下面给定的键名，不得增删改名。

JSON 结构：
{
  "characters": [{"name":"","tier":"主要","desc":"","identity":"身份定位","traits":"核心性格","realm":"实力境界","faction":"所属势力","special":"金手指/特殊能力"}],
  "factions":   [{"name":"","desc":"","category":"王朝/宗门/世家/商会/魔道/隐秘组织","leader":"掌权者","relationToMain":"与主角关系"}],
  "locations":  [{"name":"","desc":"","category":"大陆/区域/城市/秘境/禁地/遗迹/山脉","parent":"层级归属"}],
  "terms":      [{"name":"","desc":"","category":"境界/功法/法宝/地名/组织/种族/称谓/物品/其他"}],
  "items":      [{"name":"","desc":"","category":"功法/法宝/丹药/材料/货币/传承/其他","grade":"品级"}]
}`

/**
 * 把 Bible JSON 摊平成 `ExtractedEntity[]`（带 `fields`，供 fieldMap 的 slots 映射到真实列）。
 * 上限在这里**再兜一道**：prompt 说了不许超，但模型偶尔会多给 —— 落草稿前必须裁掉。
 *
 * ⚠️ 导出仅为**可测**（`tests/creativeWriting.test.ts` 验上限裁剪与字段映射）；业务请走 `aiGenerateBible`。
 */
export function collectBibleEntities(obj: Record<string, unknown>, c: BibleCounts): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const push = (type: SettingEntityType, arr: unknown, cap: number, fieldKeys: string[]) => {
    const list = Array.isArray(arr) ? arr : []
    let n = 0
    for (const raw of list) {
      if (n >= cap) break
      const o = (raw ?? {}) as Record<string, unknown>
      const name = asText(o.name ?? o['名称']).trim()
      if (!name) continue
      const fields: Record<string, string> = {}
      for (const k of fieldKeys) {
        const v = asText(o[k]).trim()
        if (v) fields[k] = v
      }
      const tier = asText(o.tier)
      out.push({
        type,
        name,
        desc: asText(o.desc ?? o['描述']).trim(),
        evidence: '', // 生成型入口没有原文（引用核对只对拆书有意义）
        ...(type === '人物' && (tier === '主要' || tier === '次要' || tier === 'NPC') ? { tier } : {}),
        ...(Object.keys(fields).length ? { fields } : {}),
      })
      n++
    }
  }
  push('人物', obj.characters, c.main + c.secondary + c.npc, ['identity', 'traits', 'realm', 'faction', 'special'])
  push('势力', obj.factions, c.faction, ['category', 'leader', 'relationToMain'])
  push('地点', obj.locations, c.location, ['category', 'parent'])
  push('术语', obj.terms, c.term, ['category'])
  push('物品', obj.items, c.item, ['category', 'grade'])
  return out
}

/**
 * 创意写作①：**设定奠基** —— 一句话想法 → 设定草稿（条目型）。
 * 产出交「闸门①」审阅（复用 `DraftReviewPanel`），用户勾选后才落库。
 *
 * @param opts.onRaw 原始返回回显（**诊断用**：模型不守 JSON 结构时，靠它看清到底回了什么）
 */
export async function aiGenerateBible(
  seed: string,
  opts: { signal?: AbortSignal; onToken?: (d: string) => void; counts?: Partial<BibleCounts>; onRaw?: (raw: string) => void } = {},
): Promise<ExtractedEntity[]> {
  const cfg = await requireActiveProvider()
  const counts = { ...DEFAULT_BIBLE_COUNTS, ...(opts.counts ?? {}) }

  const askOnce = async (): Promise<ExtractedEntity[]> => {
    const text = await chat(
      cfg,
      [
        { role: 'system', content: composeSystemPrompt(bibleSys(counts), cfg) },
        // 同样把数量与体量约束重申在**消息末尾**（system 里的铁律容易被忽略）
        { role: 'user', content: `【一句话想法】\n${seed.trim()}\n\n请据此生成设定草稿。\n\n【必须遵守】数量上限：主要 ${counts.main} / 次要 ${counts.secondary} / NPC ${counts.npc} / 势力 ${counts.faction} / 地点 ${counts.location} / 术语 ${counts.term} / 物品 ${counts.item}，**宁少勿多**；每个字段 ≤ 40 字；只输出 JSON。` },
      ],
      { timeoutMs: CHAT_TIMEOUT_MS, signal: opts.signal, onToken: longStream(opts.onToken), json: true },
    )
    opts.onRaw?.(text)
    // 🔴 宽松解析：小模型常在 JSON **结构位**塞杂散字符（实测 qwen3:4b 会插「、」甚至孤立引号），
    //    严格解析会把整批结果全丢掉，且表现为"生成成功但 0 条"—— 极难排查。
    const raw = parseLooseObject(text)
    if (!raw) return []
    // 🔴 键名容错：国产模型（Qwen 系尤甚）有时连**顶层键**也中文化（"人物" 而非 "characters"）。两种都认。
    const pick = (...keys: string[]): unknown => {
      for (const k of keys) if (raw[k] !== undefined) return raw[k]
      return undefined
    }
    return collectBibleEntities({
      characters: pick('characters', '人物', '角色'),
      factions: pick('factions', '势力', '组织'),
      locations: pick('locations', '地点', '地理', '场景'),
      terms: pick('terms', '术语', '名词'),
      items: pick('items', '物品', '道具'),
    }, counts)
  }

  // 🔴 空结果重试一次：模型输出有随机性，结构瑕疵 regenerate 一次多半就好。
  //    两次都空则**如实返回空数组**，由调用方给出明确提示 —— 绝不在这里静默吞掉
  //    （否则用户看到的是"生成成功但一条设定都没有"，完全无从下手）。
  const first = await askOnce()
  if (first.length) return first
  return askOnce()
}

/** 分卷大纲（每卷一条） */
export interface OutlineVolume {
  title: string
  positioning: string
  stage: string
  scope: string
  opening: string
  climax1: string
  turn: string
  climax2: string
  ending: string
  events: string
  subplots: string
  /**
   * 本卷章号范围，如 `第1-20章`。
   *
   * 🔴 **由系统算，不由模型填**（每卷章数是硬指标：第 k 卷 = 第 (k-1)×M+1 ~ k×M 章）。
   *    它是「正文按大纲切卷」的唯一依据 —— 没有它，第 21 章会被塞进卷一。
   *    模型产出时这里是空串，由 `aiWorkflow` 在落库前用 `fillChapterRanges()` 补齐。
   */
  chapterRange: string
}

/** 章节细纲（每章一条；`no` 由顺序决定，不让模型自己编） */
export interface OutlineChapter {
  no: number
  title: string
  event: string
  fn: string
  cast: string
  hook: string
  scenes: string[]
}

export interface OutlineResult {
  volumes: OutlineVolume[]
  chapters: OutlineChapter[]
}

/**
 * 大纲的输出体量目标（字）。按"每卷 11 个字段 × 约 40 字 + 每章约 160 字"估。
 *
 * 🔴 为什么必须给这个数：不给的话模型会把它当正文写 —— 实测（硅基流动 Qwen3-30B）
 *    只要 1 卷 1 章，却连续吐了 **13000+ 字**还在继续，白等 5 分钟以上。
 *    这里只做**提示词层面的预算**，不用 `max_tokens` 硬截断：截断会把 JSON 切残，
 *    反而让整批结果报废（比慢更糟）。
 */
const outlineCharCap = (volumes: number, chapters: number) => 300 + volumes * 420 + chapters * 160

/**
 * 大纲规划的**可编辑提示词头部**（作者可在「模型设置 → AI 提示词」里改）。
 *
 * 🔴 就地声明（禁集中搬）；`read` / `write` 必须同模块 —— 见文件末尾的 `CREATIVE_PROMPTS`。
 * ⚠️ 提示词 id **沿用旧的 `extend-outline`**（2026-09-20 把「从零排」与「接着排」合并成一条
 *    路径时**故意没换 id**）：换了 id，作者此前在设置页改过的内容就会失效。
 */
let PLAN_OUTLINE_BASE = `你是网文大纲师，负责产出**分卷大纲**与**逐章细纲**。接着已有内容往下排时，延续已有的走向、冲突线与伏笔。`

const planOutlineSys = (o: {
  volumes: number; perVolume: number; extending: boolean; fromVolumeNo: number; cap: number
}) => `${PLAN_OUTLINE_BASE}

铁律：
1. 只输出 JSON，不要解释文字，不要 markdown 代码块围栏。
2. **本次产出 ${o.volumes} 卷，每卷 ${o.perVolume} 章，共 ${o.volumes * o.perVolume} 章**（每卷章数是硬指标，不得自行增减，也不得把一卷的章匀给另一卷）。
3. **不许新造专名**：人物、地名、势力、功法只能用资料里已有的写法。新造的名字在设定表里对不上，会制造"未登记实体"。
4. 每章都要有"事件 + 钩子"，严禁"过渡章""日常"这类空章。
5. 事件链要有递进（起→承→转→合）；每卷结尾留钩子给下卷。
6. title 只写章名本身，**不要带"第X章"前缀**（系统会自动编号）。
7. 每章 scenes 给 2~3 条场景（地点+人物+发生什么）。
8. **体量纪律（重要）**：这些都是**卡片摘要**，不是正文 —— 单字段不超过 40 字（events / subplots 不超过 60 字），scenes 每条不超过 30 字。整份 JSON 控制在 ${o.cap} 字以内。
9. **严格按量输出**：只写 ${o.volumes} 卷、${o.volumes * o.perVolume} 章，多写出来的会被系统丢弃（白耗时间）。资料撑不满时，把每章写得更精练，而不是多写章。**务必把 ${o.volumes * o.perVolume} 章全部写出来再收尾** —— 写到一半就结束的会被判为不合格。${o.extending ? `
10. **接续**：这是接着作者已有的大纲往下排 —— 延续已有分卷大纲的走向、已有细纲里的冲突线与伏笔、人物当前状态；不要把已经发生过的事件再演一遍。
11. 本次的第一卷是全书**第 ${o.fromVolumeNo} 卷**，它必须接住上一卷结尾留下的钩子。
12. **这是长篇连载的其中一段，不是全书结局**（重要）—— 不要写大结局、不要收束所有主线、不要让主角"功成名就 / 开启新纪元 / 尘埃落定"；本批结尾要留下**新的**悬而未决，给下一批留出推进空间。` : ''}

JSON 结构：
{
  "volumes":[{"title":"","positioning":"本卷一句话定位","stage":"主角境界区间","scope":"舞台范围","opening":"卷首状态","climax1":"第一大高潮","turn":"卷中转折","climax2":"卷末高潮","ending":"卷末状态","events":"事件链 起→承→转→合","subplots":"支线事件"}],
  "chapters":[{"title":"","event":"本章一句话事件","function":"推进主线/铺垫/爽点/情感","cast":"出场人物","hook":"章末钩子","scenes":["场景1","场景2"]}]
}`

/** 单批大纲的**规模上限**（与 `writingPace.MAX_CHAPTERS` 同口径：单批总量 ≤ 60 章） */
export const MAX_OUTLINE_VOLUMES = 8
export const MAX_CHAPTERS_PER_VOLUME = 60
/** 单批总章数上限 —— 90 章细纲一次约 1.5 万字 JSON，本地 27B 截断风险明显，故不放开 */
export const MAX_OUTLINE_CHAPTERS = 60

/** 大纲规划的输入规模（从零与接续共用） */
export interface PlanOutlineInput {
  /** 本批要排几卷（1 ~ `MAX_OUTLINE_VOLUMES`） */
  volumes: number
  /**
   * **每卷多少章**（硬指标，1 ~ `MAX_CHAPTERS_PER_VOLUME`）。
   * 本批总量 = volumes × chaptersPerVolume，且受 `MAX_OUTLINE_CHAPTERS` 约束。
   */
  chaptersPerVolume: number
  /** 本批第一卷的起始章号（接续时 = 已有细纲最大章号 + 1）。🔴 章号由系统定，模型不填 */
  fromNo: number
  /** 本批第一卷是全书第几卷（接续时 = 已有卷数 + 1） */
  fromVolumeNo: number
  /** 是否接着已有内容往下排（只影响提示词里的接续铁律） */
  extending?: boolean
}

/**
 * 大纲规划：**分卷大纲 + 章节细纲** → 大纲草稿（交「闸门②」审阅，确认后才建卷/章）。
 *
 * 从零创作与接着往下排**共用这一个入口**，差别只在 `material` 装的是什么：
 * - 从零：设定摘要（`buildProjectContext`）
 * - 接续：已有全部卷大纲 + 已有细纲尾部 + 细纲章节脉络 + 正文进度 + 设定摘要
 *
 * 🔴 两条纪律（都与「章号」有关，合并在一个入口后尤其要守住）：
 *   ① 章号由**系统**按 `fromNo + i` 赋（模型返回的 `no` 一律忽略 —— 它经常从 1 重新数）；
 *   ② 卷的章号范围由**系统**算（`fillChapterRanges`），模型不填。
 *
 * @param material 组装好的资料正文（调用方负责组装，本函数不认识"从零 / 接续"）
 */
export async function aiPlanOutline(
  material: string,
  opts: PlanOutlineInput & { signal?: AbortSignal; onToken?: (d: string) => void; onRaw?: (raw: string) => void },
): Promise<OutlineResult> {
  const cfg = await requireActiveProvider()
  const volCount = Math.max(1, Math.min(MAX_OUTLINE_VOLUMES, Math.round(opts.volumes) || 1))
  const perVolume = Math.max(1, Math.min(MAX_CHAPTERS_PER_VOLUME, Math.round(opts.chaptersPerVolume) || 1))
  // 本批总量按上限夹住：模型多写的会被裁掉（宁少写也不让 JSON 被截断）
  const total = Math.min(volCount * perVolume, MAX_OUTLINE_CHAPTERS)
  const start = Math.max(1, Math.round(opts.fromNo) || 1)
  const volNoStart = Math.max(1, Math.round(opts.fromVolumeNo) || 1)
  const extending = opts.extending === true

  const askOnce = async (tighten = false, missing = 0): Promise<OutlineResult> => {
    // 🔴 重试必须**换策略**：实测（本地 27B，2026-09-18）同样的 prompt 重试会断在同一处
    //    （模型输出到一半自己停住，少一个收尾 `}`），连试两次都失败。第二次收紧体量预算，
    //    并在末尾点明"上次被截断"，比原样重发有用得多。
    const cap = tighten
      ? Math.max(240, Math.round(outlineCharCap(volCount, total) * 0.7))
      : outlineCharCap(volCount, total)
    const task = extending
      ? `请接着往下排：本次从全书第 ${volNoStart} 卷起，共 ${volCount} 卷、每卷 ${perVolume} 章（对应第 ${start} 章起）。`
      : `请产出分卷大纲与逐章细纲：共 ${volCount} 卷，每卷 ${perVolume} 章。`
    const text = await chat(
      cfg,
      [
        { role: 'system', content: composeSystemPrompt(planOutlineSys({ volumes: volCount, perVolume, extending, fromVolumeNo: volNoStart, cap }), cfg) },
        // 🔴 硬约束放**消息末尾**：模型对最后一条指令最敏感。实测仅写在 system 里时
        //    Qwen3-30B 会无视"只写 1 卷 1 章"，连吐 13000+ 字；末尾重申才压得住。
        {
          role: 'user',
          content: `【资料】\n${material.trim() || '（无资料，请按通用网文逻辑克制地设定）'}\n\n${task}` +
            `\n\n【必须遵守】只输出 ${volCount} 卷、每卷 ${perVolume} 章（共 ${total} 章），**一章不少、一章不多**；单字段 ≤ 40 字；整份 JSON ≤ ${cap} 字。` +
            (tighten ? '\n【注意】上一次输出被截断了（JSON 没有闭合）。这一次请写得更精练，并务必把 JSON 完整输出到最后一个括号。' : '') +
            (missing > 0 && missing < total
              ? `\n【注意】上一次只写了 ${missing} 章就收尾了，**还差 ${total - missing} 章**。这一次务必把 ${total} 章全部写出来（每章可以更精练，但不能少写）。`
              : ''),
        },
      ],
      { timeoutMs: CHAT_TIMEOUT_MS, signal: opts.signal, onToken: longStream(opts.onToken), json: true },
    )
    opts.onRaw?.(text)
    // 同 aiGenerateBible：宽松解析 + 顶层键中英双认（只认英文键会表现为"生成成功但 0 章"）
    const rawObj = parseLooseObject(text) ?? {}
    const obj: Record<string, unknown> = {
      volumes: rawObj.volumes ?? rawObj['卷'] ?? rawObj['分卷'] ?? rawObj['分卷大纲'],
      chapters: rawObj.chapters ?? rawObj['章节'] ?? rawObj['章'] ?? rawObj['章节细纲'],
    }

    // 🔴 卷数按 volCount 裁、章数按 total 裁：提示词压不住时靠这里兜底
    const volumes: OutlineVolume[] = (Array.isArray(obj.volumes) ? obj.volumes : []).slice(0, volCount).map(raw => {
      const o = (raw ?? {}) as Record<string, unknown>
      return {
        title: asText(o.title).trim(),
        positioning: asText(o.positioning).trim(),
        stage: asText(o.stage).trim(),
        scope: asText(o.scope).trim(),
        opening: asText(o.opening).trim(),
        climax1: asText(o.climax1).trim(),
        turn: asText(o.turn).trim(),
        climax2: asText(o.climax2).trim(),
        ending: asText(o.ending).trim(),
        events: asText(o.events).trim(),
        subplots: asText(o.subplots).trim(),
        // 章号范围由系统算（见 OutlineVolume 说明），模型这里一律留空
        chapterRange: '',
      }
    }).filter(v => v.title)

    const chapters: OutlineChapter[] = (Array.isArray(obj.chapters) ? obj.chapters : []).slice(0, total).map((raw, i) => {
      const o = (raw ?? {}) as Record<string, unknown>
      const scenes = (Array.isArray(o.scenes) ? o.scenes : []).map(asText).filter(Boolean).slice(0, 3)
      // 防御：模型偶尔会自带「第X章」前缀 —— 系统会重新编号，这里剥掉避免双重编号
      const title = asText(o.title).trim().replace(/^第\s*[\d零一二三四五六七八九十百千]+\s*[章回]\s*/, '')
      return {
        // 🔴 章号由调用方给的起点决定，不用模型返回的 no —— 它经常从 1 重新数
        no: start + i,
        title,
        event: asText(o.event).trim(),
        fn: asText(o['function'] ?? o.fn).trim(),
        cast: asText(o.cast).trim(),
        hook: asText(o.hook).trim(),
        scenes,
      }
    }).filter(c => c.title)

    return { volumes, chapters }
  }

  // 重试策略（两种情形都要重试，但给模型的提示不同）：
  //   ① 空结果 / JSON 被截断 → 收紧体量重发（同 prompt 重发会断在同一处）
  //   ② 🔴 **产出不足**：模型有时写一半就收尾，而 JSON 本身是**闭合**的
  //      （实测线上 Qwen3.8-27B：2 卷 × 10 章只给了 10 章）→ 把差额写进提示词再要一次。
  //      这一条不能省：静默接受会让「章号范围」按**承诺**算，落出一批没有细纲的**幽灵范围**。
  const first = await askOnce(false)
  if (first.chapters.length >= total) return first
  const second = await askOnce(true, first.chapters.length)
  return second.chapters.length > first.chapters.length ? second : first
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const CREATIVE_PROMPTS: PromptDef[] = [
  {
    meta: {
      // ⚠️ id 保持 `extend-outline` 不变（2026-09-20 合并「从零排 / 接着排」时**故意没改 id**）：
      //    改了 id，作者在设置页里改过的提示词会失效。只更新显示名与说明，说清它现在管两条路。
      id: 'extend-outline',
      group: '正文写作',
      name: '大纲规划',
      note: '产出分卷大纲与逐章细纲（「从一句话创作」与「接着已有内容写」共用；接续时延续已有走向与伏笔）。',
    },
    read: () => PLAN_OUTLINE_BASE,
    write: t => { PLAN_OUTLINE_BASE = t },
  },
]
