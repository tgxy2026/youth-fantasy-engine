// ============ AI 任务层 · 设定实体抽取（拆书 / 设定补登共用）============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #23 段）。
// 🔴 字段键从 flow/fieldMap 的 KIND_MAP 派生（见 SLOT_HINT 注释）—— 只读，不改。
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '@/lib/ai'
import { parseObjectArray, asText } from '@/lib/aiParse'
import { newAuthorFence, authorBlock } from '@/lib/promptGuard'
import { KIND_MAP } from '@/lib/flow/fieldMap'
import { longStream } from '@/lib/aiTasks/stream'
import type { PromptDef } from '@/lib/promptSettings'

// ---------- 颉文姬⑤：本章设定补登（实体抽取） ----------
//
// 职责边界（重要）：本函数**只负责从正文抽取候选实体**，
// 「这些实体是否已在设定表里登记过」一律交给 settingLedger.ts 做确定性比对——
// AI 不知道作者的别称机制、也容易把已登记的说成没有，故不让它下这个判断。

export type SettingEntityType = '人物' | '势力' | '地点' | '种族' | '物品' | '术语'

/** AI 抽出的候选实体（尚未与设定表比对） */
export interface ExtractedEntity {
  type: SettingEntityType
  name: string
  /** 一句话描述：拆书＝只写正文写明的；创意写作＝一句话设定 */
  desc: string
  /** 原文原句证据（拆书用；创意写作是凭种子生成，无原文，留空） */
  evidence: string
  /** 仅人物：建议归入哪张角色卡 */
  tier?: '主要' | '次要' | 'NPC'
  /**
   * 别称 / 简称 / 曾用名（不含 `name` 本身）。
   *
   * 🔴 为什么必须有（2026-09-18 对照验证抓到的真问题）：正文里同一个实体常以简称出现
   *    （`铁柱`＝`王铁柱`、`吞天诀`＝`混沌吞天诀`）。不把简称并入本名，就会
   *    ① 在设定表里落出重复条目；② 让 `settingLedger` 的判重失效（它拿抽出的名字
   *    跟登记表的名+别称比，简称对不上全称）—— 实测这会明显压低召回。
   */
  aliases?: string[]
  /**
   * 额外字段。键取 `flow/fieldMap.ts` 里该类型的 `slots[].from`
   * （人物＝identity/traits/realm/faction/special…；势力＝category/leader…）。
   *
   * 拆书 B1 的现成抽取不产出它（只有 name/desc）；**B2 的两遍全字段抽取**与
   * **「创意写作」的设定奠基**用它 —— 这样两者都能复用同一条"判重 → 草稿 → 审阅 → 落库"管线。
   */
  fields?: Record<string, string>
}

const ENTITY_TYPES: SettingEntityType[] = ['人物', '势力', '地点', '种族', '物品', '术语']

let EXTRACT_SYS = `你是长篇小说设定资料助理。请从本章正文中，抽取出「有明确专名的设定实体」，供作者核对是否需要登记进设定表。

type 只能取这 6 个值之一：
- 人物：有姓名或有明确称号的角色（含仅被提及、未正式出场的历史人物）
- 势力：王朝、宗门、世家、商会、军队、隐秘组织等
- 地点：大陆、区域、国家、城市、秘境、山脉、建筑等专有地名
- 种族：种族、魔兽、灵兽、异种等
- 物品：功法、法宝、丹药、材料、货币、传承等
- 术语：境界名、专有称谓、世界独有的名词等

铁律：
1. 只抽「本章正文确实出现」的实体。严禁虚构、严禁推测、严禁"合理补充"——这是资料整理，不是创作。
2. 每个实体必须附 evidence：正文中包含该名称的「原句」（照抄、不要改写，不超过 60 字）。找不到原句的就不要抽。
3. 「只抽"本作独有的专名"」。下面几类「一律不抽」（同类的一律不抽，不要因为"重要"就抽）：
   - 场合与设施：山门、山门口、演武场、议事堂、识海、杂役院、闭关室、后山…
   - 通用物品与货币：铜钱、灵石、银子、油纸、号牌、腰牌、药丸、干粮…
   - 泛称与统称：长老、执事、弟子、守卫、杀手、路人、清道夫、大比、外门大比…
   - 通用器物泛称：长剑、丹药、功法、秘籍、残简、秘境、符箓…
   - 🔴 自检一问：「把这个词单独摘出来给一个没读过这本书的人，他能判断这是本书独有的吗？」
     不能（比如"演武场""铜钱"，任何小说里都有），就「不要抽」。能（比如"青岚宗""镇界塔"），才抽。
4. 不抽现实世界事物、不抽通用词。
5. desc：一句话（不超过 40 字）概括本章展现的该实体信息，只写正文写明的，不知道就留空。
6. 人物额外给 tier：主要（主角团/贯穿全书/终极反派）/ 次要（宿敌/导师/重要配角）/ NPC（功能型、龙套），按本章戏份与定位判断；非人物类型不要给 tier。
7. 🔴 「同一实体的本名与简称/别称只输出一条」：name 写「最完整的那个」（如「王铁柱」而不是「铁柱」、「混沌吞天诀」而不是「吞天诀」），其余简称/别称放进 aliases 数组（如 {"name":"王铁柱","aliases":["铁柱"]}）。
   「绝不把简称单独抽成另一条」 —— 那会让设定表出现重复条目，也会让"是否已登记"的判重失效。
8. 同一实体在本章出现多次只输出一条。
9. 最多 20 条，按重要度排序。没有任何可抽取的实体就返回 []。
10. 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。没有别称时 aliases 给空数组。
    除 name/aliases/desc/evidence 外，请尽量补全下方列出的「全字段」（键名照抄）。`

/**
 * 字段键 → 中文提示。**键清单从 `flow/fieldMap` 的 slots 派生**（那份表是唯一真理源），
 * 这里只负责措辞 —— 于是「schema / 落库映射改了、抽取 prompt 没跟」这类漂移在结构上不会发生。
 * ⚠️ fieldMap 新增 slot 时必须在此补一句；`tests/extractFields.test.ts` 会断言两者严格一一对应。
 */
export const SLOT_HINT: Record<string, string> = {
  identity: '身份定位',
  age: '年龄 / 性别（如「16岁/男」）',
  appearance: '外貌特征',
  firstAppear: '首次出场章号',
  traits: '核心性格',
  innerStruggle: '核心矛盾/内在挣扎',
  realm: '实力境界',
  skills: '功法/技能',
  special: '金手指/特殊能力',
  gear: '装备法宝',
  background: '出身背景',
  faction: '所属势力',
  location: '地理位置',
  relations: '人际关系（写成「甲：关系；乙：关系」）',
  category: '类别',
  parent: '上级 / 层级归属',
  geo: '地理位置',
  danger: '危险 / 威胁等级',
  power: '实力等级',
  leader: '掌权者',
  economy: '经济来源',
  relationToMain: '与主角关系',
  role: '剧情作用',
  ability: '能力特性',
  weakness: '弱点',
  grade: '品级',
  origin: '来源 / 出处',
  effect: '能力 / 效果',
  cost: '限制与代价',
  note: '命名备注',
}

/** 每类实体该抽哪些字段键（**派生自 fieldMap**，见上） */
export const EXTRACT_FIELD_KEYS = Object.fromEntries(
  ENTITY_TYPES.map(t => [t, (KIND_MAP[t].slots ?? []).map(s => s.from)]),
) as Record<SettingEntityType, string[]>

/** 追加进 system 的「全字段」说明段（B2 全字段抽取） */
export const EXTRACT_FIELDS_SPEC = [
  '',
  '【应补全的字段】',
  '除 name / aliases / desc / evidence 外，请尽量补全下列字段。键名「照抄」（英文小写），单个值不超过 30 字。',
  '⚠️ 正文没写到的「留空或省略，绝不猜」 —— 编造会污染设定表，比留空糟得多。',
  ...ENTITY_TYPES.map(t => `· ${t}：` + EXTRACT_FIELD_KEYS[t].map(k => `${k}（${SLOT_HINT[k] ?? k}）`).join('、')),
  '',
  '输出示例（一条人物）：',
  '{"type":"人物","name":"陈渊","aliases":["渊儿"],"desc":"一句话描述","evidence":"原文原句",'
  + '"tier":"主要","identity":"外门弟子","realm":"淬体一重","skills":"混沌吞天诀","relations":"老瞎子：恩人"}',
].join('\n')

/** 实际发给模型的系统提示词（B2 起为「专名清单 + 全字段」两份说明） */
export function extractSysFull(): string { return EXTRACT_SYS + EXTRACT_FIELDS_SPEC }

/**
 * 取某个 slot 的值：模型可能平铺在顶层、也可能塞进 `fields` 子对象；
 * 键可能用我们要的英文键、也可能是**表里的中文列名**（模型爱这么干）。两种都认。
 */
function pickSlotValue(
  top: Record<string, unknown>,
  nested: Record<string, unknown> | undefined,
  from: string,
  cn: string,
): unknown {
  for (const src of [top, nested]) {
    if (!src) continue
    const v = src[from] ?? src[cn]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/** 单字段值长度上限：设定表里是给人看的，不是存档 —— 超长的直接截断，别撑破表格 */
const FIELD_VALUE_MAX = 120

/** 人际关系可能是数组（[{with,type,detail}] 或字符串数组），统一拼成「甲：关系；乙：关系」 */
function joinRelations(v: unknown): string {
  if (!Array.isArray(v)) return asText(v).trim()
  const parts: string[] = []
  for (const x of v) {
    if (typeof x === 'string') { const s = x.trim(); if (s) parts.push(s); continue }
    const o = (x ?? {}) as Record<string, unknown>
    const who = asText(o.with ?? o['人物'] ?? o.name ?? o['对象']).trim()
    const how = asText(o.type ?? o.detail ?? o['关系'] ?? o['说明']).trim()
    const s = [who, how].filter(Boolean).join('：')
    if (s) parts.push(s)
  }
  return parts.join('；')
}

export async function aiExtractSettingEntities(
  chapterText: string,
  chapterTitle: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ExtractedEntity[]> {
  // #014 用途路由：从正文抽取设定属「整理」
  const cfg = await requireProviderFor('utility')
  // 🔴 章题与正文都是**不可信文本**：包裹成边界块（内容一字不改，见 promptGuard 文件头）
  const fence = newAuthorFence()
  const user = `【章节】${chapterTitle.trim() ? authorBlock(fence, chapterTitle.trim()) : '（未命名章节）'}

【本章正文】
${chapterText.trim() ? authorBlock(fence, chapterText.trim()) : '（空白）'}

请抽取本章出现的设定实体。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(extractSysFull(), cfg) }, { role: 'user', content: user }],
    // 🔴 走流式（B2 起输出变长：每类实体十几个字段）：非流式要等整段生成完才回响应头，
    //    必然撞 CHAT_TIMEOUT_MS（180s）的总超时墙 —— 与 Bible/大纲是同一类问题。
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: longStream(opts?.onToken), json: true },
  )
  return parseExtractedEntities(text)
}

/**
 * 把模型返回的 JSON 文本解析成实体数组（**纯函数**，不碰网络/数据库，便于单测）。
 * 容错点：顶层/fields 子对象、英文键/中文列名、别称的数组与分隔串、relations 的数组与字符串。
 * 🔴 只认该类型 slots 里声明的字段键 —— 模型偶尔把字段给错类型（给「地点」塞 identity），
 *    照单全收会写出一列驴唇不对马嘴的数据。
 */
export function parseExtractedEntities(text: string): ExtractedEntity[] {
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
    // 别称：数组或「铁柱、阿柱」这类分隔串都吃；剔除与本名相同的、去重
    const rawAlias = it.aliases ?? it['别称'] ?? it['别名'] ?? it['曾用名']
    const aliasSrc = Array.isArray(rawAlias)
      ? rawAlias.map(asText)
      : typeof rawAlias === 'string' ? rawAlias.split(/[、,，;；/／|]+/) : []
    const aliases: string[] = []
    for (const a of aliasSrc) {
      const v = (a ?? '').trim()
      if (!v || v === name || aliases.includes(v)) continue
      aliases.push(v)
    }
    // B2：全字段。**只认该类型 slots 里声明的键** —— 模型偶尔会把字段给错类型
    //（如给「地点」塞 identity），照单全收会写出一列驴唇不对马嘴的数据。
    const slots = KIND_MAP[type].slots ?? []
    const nested = (it.fields ?? it['字段']) as Record<string, unknown> | undefined
    const fields: Record<string, string> = {}
    for (const slot of slots) {
      const raw = pickSlotValue(it, nested, slot.from, slot.to[0] ?? '')
      if (raw === undefined) continue
      const v = (slot.from === 'relations' ? joinRelations(raw) : asText(raw)).trim()
      if (!v) continue
      fields[slot.from] = v.slice(0, FIELD_VALUE_MAX)
    }
    out.push({
      type,
      name,
      desc: asText(it.desc ?? it['描述']),
      evidence: asText(it.evidence ?? it['原文'] ?? it['证据']),
      ...(aliases.length ? { aliases } : {}),
      ...(type === '人物' && (rawTier === '主要' || rawTier === '次要' || rawTier === 'NPC') ? { tier: rawTier } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
    })
    if (out.length >= 20) break
  }
  return out
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const EXTRACT_PROMPTS: PromptDef[] = [
  {
    meta: { id: 'extract-entities', group: '设定与资料', name: '设定实体抽取', note: '从本章正文抽取有专名的设定实体（拆书 / 设定补登共用）。' },
    read: () => EXTRACT_SYS,
    write: t => { EXTRACT_SYS = t },
  },
]
