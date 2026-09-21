/**
 * 草稿层 —— 「抽取结果 → 待审阅草稿行」。
 *
 * 与 `settingLedger` 的分工（别搞混）：
 * - 「是否已在设定表里登记过」= `settingLedger.classify()` 的**确定性字符串比对**，本文件复用它，
 *   不另写一套 —— 两套判重口径必然漂移，会让同一实体在「一键续写补登」和「一键拆书」里表现不一致。
 * - 本文件负责的是「把抽取结果整理成可审阅的草稿」：同名跨章合并、置信度评分、原文引用核对、
 *   以及用 `fieldMap` 把语义字段解析成目标表的真实键。
 *
 * ⚠️ 本文件**不触达 db 写入**（除了读登记表做判重）—— 落库一律在 `commit.ts`，且必须经用户勾选。
 */
import type { ExtractedEntity, SettingEntityType } from '../aiTasks'
import { TABS } from '../schema'
import { classify, loadRegistry, normName, type EntityRegistry } from '../settingLedger'
import { KIND_MAP, resolveFieldPath, resolveSlot, targetTabOf } from './fieldMap'
import type { DraftBundle, DraftConflict, DraftField, DraftRow, DraftStatus } from './types'

/** 一批来自同一章节（或同一分块）的抽取结果 */
export interface EntityBatch {
  /** 来源标题（如「第3章 风起云州」）—— 会写进目标表的「首次出场」字段 */
  source: string
  /** 该标题的序号（1 起） */
  index: number
  entities: ExtractedEntity[]
}

export interface BuildDraftOptions {
  /** 原文全文（做「引用核对」用）。省略则不做核对、置信度不加「有证据」分。 */
  rawText?: string
  /** 复用已装载的登记表（多批次调用时省一次全项目扫描） */
  registry?: EntityRegistry
  /**
   * 是否做「同物多写法归并」（默认**开**）。
   * 关掉后所有写法各自成行，由作者手工去重 —— 排障时用它对比归并前后的差异。
   */
  foldVariants?: boolean
}

/** 默认勾选阈值：低于它的草稿在界面上默认不勾（用户仍可手动勾） */
export const DRAFT_PICK_THRESHOLD = 0.5

/** 判重结果的最小形状（`settingLedger.LedgerItem` 与本地降级分支的公共部分） */
interface Classified {
  status: 'registered' | 'duplicate' | 'new'
  matchedName?: string
  matchedTabId?: string
  matchedId?: string
}

/**
 * 合并后的实体（同名跨章）。
 * 导出是为了让「同物多写法归并」这条**纯函数**（`foldNameVariants`）能被单测直接覆盖。
 */
export interface MergedEntity {
  type: SettingEntityType
  name: string
  aliases: string[]
  desc: string
  tier?: string
  /** 各来源（标题 + 序号） */
  from: { index: number; source: string }[]
  /** 原文证据（去重后） */
  quotes: string[]
  /** 额外字段（键＝fieldMap.slots 的 from；同名键取更长的一份） */
  extra: Record<string, string>
  /**
   * 同一字段在不同块给出的**互不包含**的值（B2 全字段抽取）。
   * 这类值到底哪个对，代码判不了 —— 记下来交作者在审阅面板里取舍，**不静默选一个**。
   */
  conflicts: { key: string; label: string; values: string[] }[]
}

// ==================== 字段合并与冲突检测（B2 全字段） ====================

/** 值比较用归一化：忽略空白与常见标点，免得「淬体三重」与「淬体三重。」被判成矛盾 */
function normFieldValue(s: string): string {
  return s.replace(/[\s，。、；：,.;:!！?？"'“”‘’()（）\[\]【】《》]/g, '').toLowerCase()
}

function sameFieldValue(a: string, b: string): boolean {
  return normFieldValue(a) === normFieldValue(b)
}

/** 记一处字段矛盾（同一字段最多留 3 个不同值，免得界面被刷屏） */
function addConflict(m: MergedEntity, from: string, values: string[]): void {
  let c = m.conflicts.find(x => x.key === from)
  if (!c) {
    // 界面显示名用**表里的中文列名**（slot.to[0]），作者才看得懂是哪个字段
    const label = (KIND_MAP[m.type].slots ?? []).find(s => s.from === from)?.to[0] ?? from
    c = { key: from, label, values: [] }
    m.conflicts.push(c)
  }
  for (const v of values) {
    if (!v || sameFieldValue(c.values[0] ?? '', v) && c.values.length > 0) continue
    if (c.values.some(x => sameFieldValue(x, v))) continue
    if (c.values.length >= 3) break
    c.values.push(v)
  }
}

/**
 * 「硬事实」字段：这类字段**只能有一个值**，不同块给出互不包含的值就是真不一致 → 报冲突。
 *
 * 🔴 为什么必须有这条护栏（2026-09-18 实测）：一开始对所有字段都报冲突，
 *    6 章样本上 **23/61 条草稿（38%）** 被标成「有冲突」，点开一看大半是
 *    「壮实，嗓门大」vs「身板结实」这类**互补描述**、或「陈渊：兄长」vs「陈渊：兄妹」这类**同义写法**。
 *    真矛盾（境界从「废脉」跳到「淬体一重」）反而被埋掉了。
 *    其余字段是**可累积的叙述** —— 各块各说一面很正常，取更长的一份即可，不报冲突。
 */
const CONFLICT_FIELDS = new Set(['category', 'realm', 'grade', 'power', 'danger', 'leader'])

/**
 * 合并一个字段值（B2 全字段抽取走了这里）：
 *  · 空 → 直接写
 *  · 归一化后相同 → 不动
 *  · **一个包含另一个** → 视为「更详细的写法」，取长的，**不算矛盾**
 *    （「青岚宗」vs「青岚宗外门」是同一条信息的不同详略，标成矛盾只会淹掉真矛盾）
 *  · 否则 → 主值取长的；**只有硬事实字段**才记进 `conflicts`，叙述型字段安静合并
 */
function mergeExtraField(m: MergedEntity, from: string, val: string): void {
  const old = (m.extra[from] ?? '').trim()
  if (!old) { m.extra[from] = val; return }
  if (sameFieldValue(old, val)) return
  const contained = old.includes(val) || val.includes(old)
  if (val.length > old.length) m.extra[from] = val
  if (!contained && CONFLICT_FIELDS.has(from)) addConflict(m, from, [old, val])
}

/** tier 重要度：主要 > 次要 > NPC（合并时取最高） */
function tierRank(t?: string): number {
  return t === '主要' ? 3 : t === '次要' ? 2 : t === 'NPC' ? 1 : 0
}

function betterTier(a?: string, b?: string): string | undefined {
  return tierRank(a) >= tierRank(b) ? a : b
}

/** 去重保序（过滤空串） */
function uniq(list: string[]): string[] {
  const out: string[] = []
  for (const x of list) if (x && !out.includes(x)) out.push(x)
  return out
}

/**
 * 同名同类型合并：描述取更长的一份（信息更全），证据去重，来源合并；
 * **别称也一起收进来**，并按别称做跨章归并（见下方注释）。
 */
function mergeEntities(batches: EntityBatch[]): MergedEntity[] {
  const byKey = new Map<string, MergedEntity>()
  /**
   * 别称（规范化）→ 规范实体的 key。用来把跨章的简称并进本名那条。
   * 🔴 索引键**必须带类型**：否则「中州皇朝」在「势力」下登记后，
   *    同名的「地点」实体也会被并进去 —— 而"同名异类"是刻意允许共存的
   *    （见本文件下方 `firstByName` 的注释），会破坏那条既有语义。
   */
  const aliasIndex = new Map<string, string>()
  const register = (type: string, key: string, names: string[]) => {
    for (const n of names) {
      const k = `${type}::${normName(n)}`
      if (k && !aliasIndex.has(k)) aliasIndex.set(k, key)
    }
  }
  for (const b of batches) {
    for (const e of b.entities) {
      const name = (e.name ?? '').trim()
      if (!name) continue
      const incoming = uniq((e.aliases ?? []).map(a => (a ?? '').trim()))
      let key = `${e.type}::${normName(name)}`
      if (!byKey.has(key)) {
        // 本名没出现过，但这条实体的**某个名字**已经在别称索引/已有实体里 —— 并进那一条，别新建重复条目：
        //   · 第 1 章叫「王铁柱」（别称 铁柱）、第 5 章只出现「铁柱」  → 本名命中别称索引
        //   · 第 2 章先出现「铁柱」、第 6 章才出现「王铁柱」+别称 铁柱 → 它的别称正好是已有实体的 key
        const names = [name, ...incoming]
        const viaKey = names.map(n => `${e.type}::${normName(n)}`).find(k => byKey.has(k))
        const viaIndex = names.map(n => aliasIndex.get(`${e.type}::${normName(n)}`)).find(k => k && byKey.has(k))
        const target = viaKey ?? viaIndex
        if (target) key = target
      }
      const desc = (e.desc ?? '').trim()
      const quote = (e.evidence ?? '').trim()
      const cur = byKey.get(key)
      if (!cur) {
        byKey.set(key, {
          type: e.type,
          name,
          aliases: incoming.filter(a => a !== name),
          desc,
          ...(e.tier ? { tier: e.tier } : {}),
          from: [{ index: b.index, source: b.source }],
          quotes: quote ? [quote] : [],
          extra: { ...(e.fields ?? {}) },
          conflicts: [],
        })
        register(e.type, key, [name, ...incoming])
        continue
      }
      // 🔴 规范名择优：见过的名字里取**最长**的当本名，其余全进别称。
      //    这样「铁柱」与「王铁柱」最终合成 本名＝王铁柱 / 别称＝[铁柱] 一条，
      //    ① 不再落出重复条目；② settingLedger 判重能按别称命中已登记条目（召回↑）。
      const all = uniq([cur.name, ...cur.aliases, name, ...incoming])
      const canonical = all.reduce((best, x) => (x.length > best.length ? x : best), all[0] ?? '')
      cur.name = canonical
      cur.aliases = all.filter(x => x !== canonical)
      register(e.type, key, all)
      if (desc.length > cur.desc.length) cur.desc = desc
      cur.tier = betterTier(cur.tier, e.tier)
      if (quote && !cur.quotes.includes(quote)) cur.quotes.push(quote)
      if (!cur.from.some(f => f.index === b.index && f.source === b.source)) {
        cur.from.push({ index: b.index, source: b.source })
      }
      // 额外字段（B2 全字段）：更长的一份胜出；**互不包含**的值记一处冲突交作者判断
      for (const [k, v] of Object.entries(e.fields ?? {})) {
        const val = (v ?? '').trim()
        if (val) mergeExtraField(cur, k, val)
      }
    }
  }
  // 稳定顺序：按首次出现，便于界面渲染稳定
  return [...byKey.values()].sort((a, b) => (a.from[0]?.index ?? 0) - (b.from[0]?.index ?? 0))
}

// ==================== 同物多写法归并（确定性规则，不调模型） ====================

/**
 * 短名是不是长名的**后缀**（规范化后）—— 判定两者可能是**同一对象的不同写法**。
 *
 * 三条边界，都是实测踩出来的（详见 `docs/2.2.0-C方案复核实验记录.md` §6）：
 * 1. **只要后缀**（短名是长名的中心词，长名＝修饰语＋短名）：`吞天诀` ⊂ `混沌吞天诀`、
 *    `铁柱` ⊂ `王铁柱`、`藏经阁` ⊂ `青岚宗藏经阁` —— 6/6 都是同一对象。
 * 2. 🔴 **不要前缀**：短名在前缀位时，长名往往是在它后面接了**另一个名词**，
 *    指向的是子体而非同一对象 —— 实测 `青岚宗` ⊂ `青岚宗藏经阁`（宗门 ≠ 它的藏经阁）、
 *    `南荒` ⊂ `南荒秘境`（区域 ≠ 区域里的秘境）。这两条真被并错过，故一律不处理。
 * 3. **不要中间包含**：多半是巧合（`玉牌` ⊂ `青玉腰牌`）。
 */
function isVariantWriting(short: string, long: string): boolean {
  const s = normName(short)
  const l = normName(long)
  if (s.length < 2 || l.length <= s.length) return false
  return l.endsWith(s)
}

/** 数字与量词：限定语里带它，通常意味着**并列层级**（三品玄脉 / 四品玄脉），不是同一对象 */
const ORDINAL_RE = /[0-9零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾品级重层阶星]/

/** 取「长名去掉短名后剩下的修饰语」（短名是后缀，所以修饰语就是它前面那段） */
function modifierOf(shortNorm: string, longNorm: string): string {
  return longNorm.slice(0, longNorm.length - shortNorm.length)
}

/** 把 `short` 并入 `long`：名字全进别称（本名取最长）、描述取更长、证据/来源/额外字段合并 */
function absorbInto(long: MergedEntity, short: MergedEntity, absorbed: Map<MergedEntity, string[]>): void {
  const names = uniq([short.name, ...short.aliases])
  const all = uniq([long.name, ...long.aliases, ...names])
  const canonical = all.reduce((best, x) => (x.length > best.length ? x : best), all[0] ?? '')
  long.name = canonical
  long.aliases = all.filter(x => x !== canonical)
  if (short.desc.length > long.desc.length) long.desc = short.desc
  long.tier = betterTier(long.tier, short.tier)
  for (const q of short.quotes) if (!long.quotes.includes(q)) long.quotes.push(q)
  for (const f of short.from) {
    if (!long.from.some(x => x.index === f.index && x.source === f.source)) long.from.push(f)
  }
  for (const [k, v] of Object.entries(short.extra)) {
    const val = (v ?? '').trim()
    if (val) mergeExtraField(long, k, val)
  }
  const prev = absorbed.get(long) ?? []
  absorbed.set(long, uniq([...prev, ...names.filter(n => n !== long.name)]))
}

export interface FoldVariantsResult {
  /** 保留下来的实体（无歧义的同物多写法已并入） */
  items: MergedEntity[]
  /** 「疑似同一对象」：值＝那条规范条目的**名字**。这类**不合并也不删除**，只默认不勾 */
  variantOf: Map<MergedEntity, string>
  /** 被并入的写法：值＝该条目吸收掉的名字（界面据此如实交代「并了什么进来」） */
  absorbed: Map<MergedEntity, string[]>
}

/**
 * 🔴 **同物多写法归并**（确定性规则，零模型调用、零幻觉、可单测）。
 *
 * 由来（09-18 实测，见 `docs/2.2.0-C方案复核实验记录.md`）：
 * 让模型「二遍复核」去泛称，精度仅约 60%、会误删核心专名（`镇界塔`/`神契`/`封仙路`）、
 * 且提示词两句话之差就从「剔 33 条」翻成「剔 0 条」→ 不能用于破坏性操作。
 * 但同一次实测发现草稿里真正的冗余是**同一实体的多种写法**（占 20%）：
 * `胎记`/`左腕胎记`/`暗金胎记`、`吞天诀`/`混沌吞天诀`、`山门`/`山门口`、`神体`/`混沌神体`…
 * 这类关系字符串规则即可判定 —— 于是有了本函数。
 *
 * 两条处置，**都不删除数据**：
 * 1. **无歧义**（短名只被一个长名包含）且修饰语不带数字/量词 → **自动并入**：
 *    短名进别称，描述/证据/来源/额外字段一并合并（合并只增不减，信息不丢）。
 * 2. **有歧义**（短名被多个长名共用，如「胎记」既在「左腕胎记」又在「暗金胎记」里）→
 *    **只标这条「核心词」**并默认不勾，长名一律不牵连、不合并 —— 理由见下方实现处的注释
 *    （长名之间到底是同物还是并列的两个对象，字符串判不出来，宁可不标）。
 * 数字/量词刹车（三品玄脉/四品玄脉、三品灵脉 这类**并列层级**）用于第 1 条：
 * 修饰语带数字量词时一律不合并，只标注。
 *
 * ⚠️ 残余取舍（已实测排除两条真误并，见 `isVariantWriting` 的注释）：
 * 若一本书里真有两个「同一中心词、不同修饰语」的独立对象（如 `玄天剑宗` 与 `青云剑宗`
 * 之间互不为后缀，不会被并；但 `剑宗` 若也被抽出则会被并进其中一条），会并成一条 ——
 * 名字都进别称、界面标注「已并入 N 个写法」，作者看得到也改得动；
 * 要按项目习惯整体关掉就传 `foldVariants: false`。
 */
export function foldNameVariants(items: MergedEntity[]): FoldVariantsResult {
  const variantOf = new Map<MergedEntity, string>()
  const absorbed = new Map<MergedEntity, string[]>()
  let live = [...items]
  // 按名字长度升序处理：短的先并进长的。长名之后若又并进更长的，别名会随记录一起走
  // （传递归并天然成立，不必再做一次闭包）。
  const order = [...items].sort((a, b) =>
    a.name.length - b.name.length || (a.from[0]?.index ?? 0) - (b.from[0]?.index ?? 0))

  for (const m of order) {
    if (!live.includes(m)) continue
    const containers = live.filter(x => x !== m && x.type === m.type && isVariantWriting(m.name, x.name))
    if (!containers.length) continue

    if (containers.length === 1) {
      const only = containers[0] as MergedEntity
      // 限定语带数字/量词（如 `聚灵境` ⊂ `聚灵境三重`）→ 视为**并列层级**而非同一对象：
      // 只标注、不自动并 —— 层级/品级在一本书里是并列的，并错比不并更糟。
      if (ORDINAL_RE.test(modifierOf(normName(m.name), normName(only.name)))) {
        variantOf.set(m, only.name)
        continue
      }
      absorbInto(only, m, absorbed)
      live = live.filter(x => x !== m)
      continue
    }

    // 有歧义：短名被多个长名共用 → **只标这条「核心词」**，绝不牵连那些长名。
    // 🔴 为什么连"疑似同组"的长名也不标：长名之间可能是同一对象的两种限定写法（`左腕胎记`/`暗金胎记`），
    //    也可能是**两个并列的不同对象**（`混沌吞天诀`/`噬魂吞天诀` 是两个功法）。
    //    字符串规则判不出这个差别，而**误把一个核心实体降级**（默认不勾）的代价，
    //    远大于**留下一条重复条目**（作者一眼能看出并手动删）—— 所以宁可少标。
    const longest = containers.reduce((b, x) => (x.name.length > b.name.length ? x : b), containers[0] as MergedEntity)
    variantOf.set(m, longest.name)
  }

  return { items: live, variantOf, absorbed }
}

function tabNameOf(tabId: string): string {
  return TABS.find(t => t.id === tabId)?.name ?? tabId
}

/**
 * 置信度启发式（照 `一键拆书-详细设计.md` §7.3 的 MVP 简化版）：
 * 基础 0.6 → 引用在原文中命中 +0.2 → 同一实体出现在 ≥2 个来源 +0.2 → 有冲突 −0.3。
 * 结果 clamp 到 [0,1]。
 */
function scoreOf(o: { quoteHit: boolean; sources: number; conflicts: number }): number {
  let c = 0.6
  if (o.quoteHit) c += 0.2
  if (o.sources >= 2) c += 0.2
  if (o.conflicts > 0) c -= 0.3
  return Math.max(0, Math.min(1, c))
}

/** 用 fieldMap 把合并结果落成「目标表真实键 → 值」（带显示名，UI 直接渲染） */
function fieldsOf(m: MergedEntity, tabId: string): { fields: DraftField[]; nameKey: string; descKey?: string } {
  const map = KIND_MAP[m.type]
  const out: DraftField[] = []
  const put = (fieldName: string | undefined, value: string): string | undefined => {
    if (!fieldName || !value) return undefined
    const key = resolveSlot(tabId, fieldName)
    // 找不到落点就**不写**（写一个不存在的键 = 表里多出一列幽灵数据）
    if (key) out.push({ key, label: fieldName, value })
    return key ?? undefined
  }

  const nameKey = put(map.nameField, m.name) ?? ''
  if (map.aliasField && m.aliases.length) put(map.aliasField, m.aliases.join('、'))
  // 🔴 顺序：**先落 slots（B2 的细节字段），再落 desc（一句话概括）**。
  //    两者常抢同一个落点：人物的 `descFields` 与 slot `identity` 都指「身份定位」。
  //    identity 是明确的身份定位、desc 只是一句话概括，前者更准 → 让它先占。
  //    已被前面写过的键跳过 —— 否则同一列会被写两次（后写的覆盖先写的）。
  for (const slot of map.slots ?? []) {
    const v = (m.extra[slot.from] ?? '').trim()
    if (!v) continue
    const hit = resolveFieldPath(tabId, slot.to)
    if (hit && !out.some(f => f.key === hit.key)) out.push({ key: hit.key, label: hit.field, value: v })
  }
  // desc：落点已被占就**不重复写**（让位的是较弱的概括，不是数据）。
  // 但 `descKey` 仍指向那一格 —— 界面折叠行的摘要照样有内容可显示。
  const descAt = resolveFieldPath(tabId, map.descFields ?? [])
  let descKey: string | undefined
  if (descAt && m.desc) {
    const taken = out.find(f => f.key === descAt.key)
    if (taken) descKey = taken.key
    else { out.push({ key: descAt.key, label: descAt.field, value: m.desc }); descKey = descAt.key }
  }
  const first = resolveFieldPath(tabId, map.firstFields ?? [])
  if (first && m.from[0]?.source && !out.some(f => f.key === first.key)) put(first.field, m.from[0].source)
  if (map.statusValue) put('人物状态', map.statusValue)
  return { fields: out, nameKey, ...(descKey ? { descKey } : {}) }
}

/**
 * 由抽取批次构建草稿。
 * @param batches 各章节（或分块）的抽取结果
 */
export async function buildDraftBundle(
  batches: EntityBatch[],
  opts: BuildDraftOptions = {},
): Promise<DraftBundle> {
  const rawMerged = mergeEntities(batches)
  // 🔴 同物多写法归并（确定性，不调模型）—— 必须排在**判重之前**：
  //    并入会让别称变多，而 `settingLedger.classify` 是按「本名 + 别称」比对的，
  //    排在后面就会漏掉「正文只写简称」那些章节的命中。
  const folds: FoldVariantsResult = opts.foldVariants === false
    ? { items: rawMerged, variantOf: new Map(), absorbed: new Map() }
    : foldNameVariants(rawMerged)
  const merged = folds.items
  const reg = opts.registry ?? await loadRegistry().catch(() => null)

  // 复用 settingLedger 的三档判重（registered / duplicate / new）—— 口径只此一处
  // 取双方共有的最小形状：登记表缺失时（离线/读失败）退化为「全部视作新建」，不阻断拆书
  const items: Classified[] = reg
    ? classify(merged.map(m => ({
        type: m.type,
        name: m.name,
        desc: m.desc,
        evidence: m.quotes[0] ?? '',
        ...(m.tier ? { tier: m.tier as '主要' | '次要' | 'NPC' } : {}),
      })), reg)
    : merged.map(m => ({
        type: m.type,
        name: m.name,
        desc: m.desc,
        evidence: m.quotes[0] ?? '',
        key: `${m.type}::${m.name}`,
        status: 'new' as const,
      }))

  const raw = opts.rawText ?? ''
  const rows: DraftRow[] = []
  merged.forEach((m, i) => {
    const it = items[i]
    const tabId = targetTabOf(m.type, m.tier)
    const fo = fieldsOf(m, tabId)
    // 主名落点不存在（schema 改过字段名 / 目标表无此字段）→ 这条草稿根本落不了库。
    // 宁可少一条，也不给界面一条"点写入什么都不会发生"的死条目。
    if (!fo.nameKey) return

    // registered / duplicate 都归入 duplicate（界面语：疑似已存在），点明命中的是谁
    const status: DraftStatus = it.status === 'new' ? 'new' : 'duplicate'
    // B2：同一字段在不同块给出互不包含的值 → 如实列出，交给作者取舍（详细设计 §7.2）
    const conflicts: DraftConflict[] = (m.conflicts ?? []).slice(0, 3).map(c => ({
      field: c.label,
      existing: c.values[0] ?? '',
      incoming: c.values.slice(1).join(' ／ ') || c.values[0] || '',
    }))
    const quoteHit = raw
      ? m.quotes.some(q => q && raw.includes(q))
      : m.quotes.length > 0
    const matched = it.matchedName && it.matchedTabId && it.matchedId
      ? { name: it.matchedName, tabId: it.matchedTabId, id: it.matchedId }
      : undefined
    rows.push({
      key: `${m.type}::${normName(m.name)}`,
      tabId,
      tabName: tabNameOf(tabId),
      kindLabel: KIND_MAP[m.type].label,
      name: m.name,
      aliases: m.aliases,
      fields: fo.fields,
      nameKey: fo.nameKey,
      ...(fo.descKey ? { descKey: fo.descKey } : {}),
      status,
      ...(matched ? { matched } : {}),
      ...(conflicts.length ? { conflicts } : {}),
      confidence: scoreOf({ quoteHit, sources: m.from.length, conflicts: conflicts.length }),
      quotes: m.quotes,
      chapters: [...new Set(m.from.map(f => f.index))].sort((a, b) => a - b),
      // 「同物多写法」的两条如实交代：并进来了哪些写法 / 疑似与谁同物（都不删除、不隐藏）
      ...(folds.absorbed.get(m)?.length ? { foldedNames: folds.absorbed.get(m) as string[] } : {}),
      ...(folds.variantOf.has(m) ? { variantOf: folds.variantOf.get(m) as string } : {}),
    })
  })

  // 🔴 同名但被抽成**不同类型**（模型偶尔会这么做：把「中州皇朝」一次抽成势力、一次抽成地点）——
  //    若不管，会落成两条重复条目（一条进国家势力、一条进地理风物）。实机 6 章样本上真抓到过。
  //    处置：**除首条外**都标 conflict 并写明两边类型，默认不勾选（`defaultPicked` 只认 status==='new'），
  //    由作者在审阅时取舍。刻意**不擅自合并** —— 同名不同类在设定里确实可能存在（如「青云」既是人名又是地名）。
  const firstByName = new Map<string, DraftRow>()
  for (const r of rows) {
    const nk = normName(r.name)
    const prev = firstByName.get(nk)
    if (!prev) { firstByName.set(nk, r); continue }
    r.status = 'conflict'
    r.conflicts = [{
      field: '实体类型',
      existing: `${prev.kindLabel}（写入「${prev.tabName}」）`,
      incoming: `${r.kindLabel}（写入「${r.tabName}」）`,
    }]
    r.confidence = Math.max(0, r.confidence - 0.3)
  }

  return bundleOf(rows)
}

/** 把草稿行整理成分组 + 统计（界面直接消费） */
export function bundleOf(rows: DraftRow[]): DraftBundle {
  const groups: DraftBundle['groups'] = []
  const byTab = new Map<string, DraftBundle['groups'][number]>()
  for (const r of rows) {
    let g = byTab.get(r.tabId)
    if (!g) { g = { tabId: r.tabId, tabName: r.tabName, rows: [] }; byTab.set(r.tabId, g); groups.push(g) }
    g.rows.push(r)
  }
  const byStatus: Record<DraftStatus, number> = { new: 0, duplicate: 0, conflict: 0 }
  const byKind: Record<string, number> = {}
  let folded = 0
  let variants = 0
  for (const r of rows) {
    byStatus[r.status]++
    byKind[r.kindLabel] = (byKind[r.kindLabel] ?? 0) + 1
    folded += r.foldedNames?.length ?? 0
    if (r.variantOf) variants++
  }
  return { rows, groups, stats: { total: rows.length, byStatus, byKind, folded, variants } }
}

/**
 * 默认勾选判定：
 * - 「疑似同一对象的另一种写法」（`variantOf`）→ **不勾**。它没被删也没被藏，作者想留可以自己勾。
 * - 其余：新建 + 置信度达标（重复项默认不勾，避免重复登记）。
 */
export function defaultPicked(r: DraftRow): boolean {
  if (r.variantOf) return false
  return r.status === 'new' && r.confidence >= DRAFT_PICK_THRESHOLD
}

/**
 * 「全选新建」按钮该勾哪些行。
 *
 * 🔴 必须**排除**「疑似同一对象的另一种写法」：否则作者一点「全选新建」，
 *    刚标好的去重提示就被自己撤销了 —— 等于白标。
 *    抽成纯函数是为了能单测（UI 里那行 if 没人测得住，实机也未必碰得到这种数据）。
 */
export function pickableAsNew(r: DraftRow): boolean {
  return r.status === 'new' && !r.variantOf
}
