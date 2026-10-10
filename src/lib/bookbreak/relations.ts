/**
 * 一键拆书 · 末尾「整理关系」阶段。
 *
 * 【为什么关系不能像实体那样逐章抽】
 * 关系是「两两事实」：一句「萧景行与萧景炎反目」要同时定住两个人，还要知道是否已登记、
 * A→B 与 B→A 各算一条（**有向对**：A 是视角主体；同一对还可并存多种关系类型，
 * 「同对同向 + 同类型」才算重复）。逐章抽会抽出大量半截关系（「师父」——谁的师父？
 * 原文那句里没写），而且**每章都要判一次重、每章都可能写半条**，最后落库的是一地碎片。
 * 所以这一步的形态必须是：**整本看完 + 对齐已有条目，末尾一次整理**。
 *
 * 两张表各一次调用（人物关系 / 势力关系）—— 列不同、来源不同（角色卡名 vs 《国家势力》），
 * 合并不了；分开也让某一张失败不拖垮另一张。两次都走 `lib/organizeRows.ts`
 * （与表格页的「AI 整理」同一套候选值注入 / 项目资料打包 / 本地判重），口径不会漂。
 *
 * 【输入为什么是「实体清单 + 开篇样本」而不是全文】
 * 前面的抽取阶段已经逐章读懂过原文（全字段：身份定位 / 外貌 / 境界 / 剧情作用…），
 * 拿它当输入比重读几十万字便宜两个数量级。原文只截开头一段当题材样本（关系判断最吃
 * 人的身份与立场，这些在实体详情里已经写着了）。材料带上限是硬要求：撞窗口的表现是
 * **静默截断**（模型只看到前半段却照样输出得很像样），见 formSummary 的说明。
 */
import { buildFormMaterial } from '@/lib/bookbreak/formSummary'
import { clampRelationLimits, type RelationMaterialLimits } from '@/lib/bookbreak/relationMaterial'
import type { EntityBatch } from '@/lib/flow/draft'
import type { DraftField, DraftRow } from '@/lib/flow/types'
import { isPrunedForAI, loadCharacterNames } from '@/lib/aiContext'
import * as db from '@/lib/db'
import { organizeRows } from '@/lib/organizeRows'
import { TABS } from '@/lib/schema'
import { normName } from '@/lib/settingLedger'
import type { TabDef } from '@/lib/types'

/** 本阶段负责的两张表（数组顺序 = 界面分组顺序） */
export const RELATION_TAB_IDS = ['relations', 'faction-rels']

/**
 * 要求模型额外交出的**校验字段**名。
 *
 * 🔴 2026-09-19 实机（本地 4B）实测：即使 prompt 写明「只登记材料里明确写出的关系、
 *    项目资料不得用于推断」，模型照样拿项目资料里**本书没提到**的势力互相配对，
 *    编出「中州皇朝 · 血魔教」这类正文里根本不存在的关系。
 *    逼它逐字摘一句原文（+ 本地核对那句话确实在材料里），是唯一确定性的兜底。
 *    摘不出原文的条目一律丢掉，并如实报给界面。
 */
const EVIDENCE_FIELD = '依据'

/**
 * 引文是否真的出现在材料里（**纯函数，可单测**）。
 *
 * 判据与实体抽取的 `evidence` 一致：**逐字**匹配，比较前先归一化空白与常见标点
 * （模型抄句子时常带上引号、省略号）。太短的引文（< 6 字，如就写个人名）判为不通过 ——
 * 那种"依据"证明不了任何关系。
 */
export function evidenceInMaterial(quote: string, material: string): boolean {
  const norm = (s: string) => (s ?? '').replace(/[\s，。、；：！？"'“”‘’（）()《》〈〉【】…·—\-_/\\|]/g, '')
  const q = norm(quote)
  if (q.length < 6) return false
  return norm(material).includes(q)
}

/**
 * 按名单校验关键列，丢掉「名单外」的行（**纯函数，可单测**）。
 *
 * 🔴 为什么除了 prompt 里写明"必须从可选值里挑"，还要一道**本地**校验：
 *    2026-09-19 实机（本地 4B）实测，即使给了名单，模型照样返回
 *      「陈渊 · 青岚宗」（势力塞进人物列）、「陈渊 · 青岚宗山门」（地点当人物）、
 *      「苏念 · 萧家」（势力世家）—— 而这两张表的关键列在界面上是**下拉单选**，
 *      写进名单外的值**不报错**，只静默变成裸文本、联动与图谱统统失效。
 *      这正是「中州萧家被录进人物关系」那个老问题的成因，不能只靠模型自觉。
 *
 * 名单为空时**不校验**（否则新项目里既没角色卡也没抽出人物，整个功能变哑巴）。
 */
export function filterRowsByRoster(
  rows: Record<string, string>[],
  keys: string[],
  roster: string[],
): { kept: Record<string, string>[]; dropped: number } {
  const set = new Set(roster.map(normName).filter(Boolean))
  if (set.size === 0) return { kept: rows, dropped: 0 }
  const kept: Record<string, string>[] = []
  let dropped = 0
  for (const r of rows) {
    const vals = keys.map(k => normName(r[k] ?? ''))
    if (vals.length > 0 && vals.every(v => !!v && set.has(v))) kept.push(r)
    else dropped++
  }
  return { kept, dropped }
}

/** 本次抽出的某类实体名（含别称）—— 拆书时它们还没落库，必须手动并进候选名单 */
function entityNamesOf(batches: EntityBatch[], type: '人物' | '势力'): string[] {
  const out: string[] = []
  for (const b of batches) {
    for (const e of b.entities) {
      if (e.type !== type || !e.name?.trim()) continue
      out.push(e.name.trim())
      for (const a of e.aliases ?? []) if (a.trim()) out.push(a.trim())
    }
  }
  return out
}

/** 关系表的关键列（前两列：A / B）—— 判重、候选名单、产出校验三处共用，避免口径漂移 */
export function keyColsOf(tab: TabDef): string[] {
  return (tab.columns ?? []).filter(c => c.name !== '编号').slice(0, 2).map(c => c.name)
}

/**
 * 表格行 → 草稿行（**纯函数，可单测**）。
 *
 * 🔴 关系行没有「主名」概念：两张表都没有「名称」列（列即 人物A/人物B、势力A/势力B），
 *    所以 `commit` 里那套「按名称列找同名条目」的判重对它们天然失效 —— 判重必须在**本阶段**
 *    靠 `organizeRows` 的 existingKeys + 本地指纹完成（这也是为什么这里只产出"确定不重复"的行）。
 *    `name` 用 `A · B` 合成，`nameKey` 指向第一列：界面上那个主名输入框改的就是「人物A / 势力A」。
 */
export function relationRowsToDrafts(
  tab: TabDef,
  rows: Record<string, string>[],
  evidenceField = EVIDENCE_FIELD,
): DraftRow[] {
  const cols = (tab.columns ?? []).filter(c => c.name !== '编号')
  const [first = '', second = ''] = keyColsOf(tab)
  // 判重键的第三维＝「关系类型」：同一对可并存多种关系（同对同向 + 同类型才算重复）。
  const typeCol = cols.find(c => c.name === '关系类型')?.name
  return rows.map((r, i) => {
    const fields: DraftField[] = cols.map(c => ({
      key: c.name,
      label: c.name,
      value: (r[c.name] ?? '').trim(),
    }))
    const a = (r[first] ?? '').trim()
    const b = (r[second] ?? '').trim()
    return {
      key: `${tab.id}-rel-${i}`,
      tabId: tab.id,
      tabName: tab.name,
      kindLabel: '关系',
      name: [a, b].filter(Boolean).join(' · '),
      aliases: [],
      fields,
      nameKey: first,
      // 🔴 必须声明判重键：关系表没有「名称」列，`commit` 默认那套"按名称列找同名条目"对它们
      //    恒判"不存在" —— 不声明的话，作者在草稿页点两次「写入项目」就登记两条同样的关系
      //    （图谱里直接多一条重复边）。
      // 🔴 2.7.2：配对表改为**有向对**（`isDirectedPairTab`），且判重键含「关系类型」——
      //    同一对可并存多种关系，反向（B→A）也是另一条；只有「同对同向 + 同类型」才算重复。
      dedupKeys: [first, second, typeCol].filter(Boolean) as string[],
      // 状态一律 new：能到这儿的都已经本地判过重（重复的根本没产出）。
      status: 'new',
      // 0.7：整本汇总的可信度 —— 高于默认勾选阈值（0.5），低于"原文逐字有据"的实体条目。
      // 模型给的「依据」进 quotes：审阅面板会把它作为「原文引用」列出来，作者一眼能核对
      // 这条关系到底有没有出处（编的条目已经在 filterRowsByRoster / evidenceInMaterial 挡掉了）。
      confidence: 0.7,
      quotes: (r[evidenceField] ?? '').trim() ? [(r[evidenceField] ?? '').trim()] : [],
      chapters: [],
    }
  })
}

export interface RelationDraftOptions {
  /** 抽取阶段的实体批次（前面已经读懂过原文的成果） */
  batches: EntityBatch[]
  /** 原始文本（只取开头一段当题材样本） */
  rawText: string
  signal?: AbortSignal
  /** 阶段进度（0..1）与一行说明 */
  onProgress?: (ratio: number, detail: string) => void
  /**
   * 材料上限（界面可调，见 `relationMaterial.ts` 里每一项为什么这么推荐）。
   * 缺省或只给部分字段时，其余用推荐值；越界值会被钳制。
   */
  limits?: Partial<RelationMaterialLimits>
}

/** 逐表产出统计（界面文案用：哪张表整理出几条、有没有失败） */
export interface RelationTabOutcome {
  tabId: string
  tabName: string
  count: number
  /** 与已有条目重复 / 缺关键列而被丢弃的条数 */
  skipped: number
  /** 关键列不在候选名单里而被**本地校验**丢掉的行数（模型把势力 / 地点写进人物列这类） */
  dropped: number
  /** 给不出「材料里逐字存在」的引文而被丢掉的行数（模型编造的关系） */
  unproven: number
  /** 失败原因（成功时缺省） */
  note?: string
}

export interface RelationDraftResult {
  rows: DraftRow[]
  perTab: RelationTabOutcome[]
  /**
   * 本次材料的实际字数（实体清单 + 开篇样本，已按上限收口）。
   * 界面要显示它：作者刚在面板上调了上限，跑完得看得见"调完是多少字"，
   * 否则无法判断材料是不是被截断了。
   */
  materialChars: number
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError'
}

/**
 * 整理两张关系表，产出可直接并进草稿包的 `DraftRow[]`。
 *
 * ⚠️ 中止会**原样抛出 AbortError**（不吞）—— 状态机据此把阶段归为 cancelled；
 *    而**单表失败不抛出**（记进 `note` 继续下一张），与抽取阶段"单块失败不中断整本"同一取舍。
 */
export async function buildRelationDrafts(opts: RelationDraftOptions): Promise<RelationDraftResult> {
  const tabs = RELATION_TAB_IDS
    .map(id => TABS.find(t => t.id === id))
    .filter((t): t is TabDef => !!t)

  // 材料：实体清单（人物放宽到 perType 条）+ 开篇样本。没有材料就没有整理依据，直接空手而归。
  const limits = clampRelationLimits(opts.limits)
  const material = buildFormMaterial(opts.batches, opts.rawText, {
    perType: limits.perType,
    perEntityChars: limits.perEntityChars,
    rawHeadChars: limits.rawHeadChars,
    maxChars: limits.maxChars,
  }).trim()
  if (!material) return { rows: [], perTab: [], materialChars: 0 }
  // 先把材料规模报出来：作者在上界面调了上限，得能看见调完是多少字（也便于判断是否被截断）
  opts.onProgress?.(0.02, `材料 ${material.length} 字（实体清单 + 开篇样本）`)

  const out: DraftRow[] = []
  const perTab: RelationTabOutcome[] = []

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]
    if (opts.signal?.aborted) break
    opts.onProgress?.(i / tabs.length, `整理《${tab.name}》…（${i + 1}/${tabs.length}）`)
    try {
      // 已有行用于判重 —— 必须读全表：少传会让已登记的关系被重复生成。
      const existing = (await db.getTableRows(tab.id)).map(r => r.data)
      // 🔴 候选名单 = **库里的已有名字 ∪ 本次刚抽出、还没落库的同类实体**。
      //    少了后半截，拆书时名单是空的（新项目里角色卡与《国家势力》都还没建），
      //    模型手里没有名单就只能自己编 —— 实测会编出「陈渊 · 青岚宗」这种把势力
      //    写进人物列的关系（老问题「中州萧家进了人物关系」的同一个成因）。
      const roster = tab.id === 'faction-rels'
        ? [...new Set([
            // 🔴 D 级（终结 / 弃用）势力不进候选名单 —— 理由同 loadCharacterNames
            ...(await db.getTableRows('nations')).filter(r => !isPrunedForAI(r.data))
              .map(r => String(r.data['名称'] ?? '').trim()).filter(Boolean),
            ...entityNamesOf(opts.batches, '势力'),
          ])]
        : [...new Set([
            ...(await loadCharacterNames({ type: 'full', features: [] }).catch(() => [] as string[])),
            ...entityNamesOf(opts.batches, '人物'),
          ])]
      const keyCols = keyColsOf(tab)
      const allowedOverride: Record<string, string[]> = {}
      for (const k of keyCols) allowedOverride[k] = roster

      const r = await organizeRows(tab, {
        existing,
        sourceText: material,
        useCtx: true,
        // 材料里没有章节清单，且关系表没有章节号列 —— 不需要附
        includeChapterList: false,
        maxRows: limits.maxRows,
        allowedOverride,
        evidenceField: EVIDENCE_FIELD,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ctx: { type: 'full', features: [] },
        // 🔴 这段约束是实测逼出来的（2026-09-19，本地 4B）：
        //    带了项目资料之后，模型会拿《国家势力》里**已有但本书没提到**的势力互相编关系
        //    （实测编出「中州皇朝 · 血魔教」这种正文里根本不存在的关系）—— 因为资料里
        //    确实有这些名字，模型就当成了事实来源。项目资料在这里的**唯一**用途是对齐名字。
        purposeSuffix: '本次依据是「一键拆书」刚抽出的实体清单与开篇样本，不是全文。'
          + '只登记这批材料里「明确写出」的关系，没有把握的宁可不写；'
          + '项目资料仅供你核对人名 / 势力名的写法，「不要」据此推断两者之间存在关系 —— 资料里的势力未必出现在这本书里。',
      })
      // 🔴 本地校验两道：① 关键列必须在候选名单里（模型会把势力/地点写进人物列）
      //    ② 必须给出**材料里逐字存在**的引文（模型会拿项目资料里本书没提到的势力编关系）
      const { kept, dropped } = filterRowsByRoster(r.rows, keyCols, roster)
      const proven = kept.filter(row => evidenceInMaterial(row[EVIDENCE_FIELD] ?? '', material))
      const unproven = kept.length - proven.length
      const drafts = relationRowsToDrafts(tab, proven)
      out.push(...drafts)
      const bits = [`${drafts.length} 条`]
      if (dropped > 0) bits.push(`丢弃 ${dropped} 条（名单里没有那个名字，多半是把势力 / 地点当成了人物）`)
      if (unproven > 0) bits.push(`丢弃 ${unproven} 条（给不出原文依据，属模型编造）`)
      if (r.dupSkipped > 0) bits.push(`已有 ${r.dupSkipped} 条`)
      perTab.push({
        tabId: tab.id,
        tabName: tab.name,
        count: drafts.length,
        skipped: r.dupSkipped + r.invalidSkipped,
        dropped,
        unproven,
      })
      opts.onProgress?.((i + 1) / tabs.length, `《${tab.name}》${bits.join(' · ')}`)
    } catch (e) {
      // 中止要原样抛（状态机归为 cancelled）；其余失败本张跳过，别拖垮另一张
      if (isAbort(e) || opts.signal?.aborted) throw e
      const msg = e instanceof Error ? e.message : String(e)
      perTab.push({ tabId: tab.id, tabName: tab.name, count: 0, skipped: 0, dropped: 0, unproven: 0, note: msg })
      opts.onProgress?.((i + 1) / tabs.length, `《${tab.name}》整理失败：${msg}`)
    }
  }

  return { rows: out, perTab, materialChars: material.length }
}
