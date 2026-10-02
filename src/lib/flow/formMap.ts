/**
 * 「全书级设定」（表单型页签）的字段清单与草稿构造。
 *
 * 【为什么单独一层】
 * 作品信息 / 世界设定 / 力量体系这些是**表单型（整项目单份）**，字段以 `模块::字段` 存放。
 * 它们与人物、地理这类"条目型"的写入方式根本不同：
 *   · 条目型：逐章增量抽取，一条一个名称，同名判重合并（走 `draft.ts` + `commit.ts` 的 card/table 通道）；
 *   · 表单型：整本书只有一份，**流程末尾汇总一次**，逐字段填充。
 * 硬把两者塞进同一条通道，就会出现「世界观被逐章追加、越写越长、还覆盖作者手改」（§3 冲突 3 的结论）。
 *
 * 【为什么字段清单是**派生**的】
 * 全部表单页签合计 100+ 个字段。手写一份映射表必然随 schema 漂移 —— 加字段没人补、改名两边不一致，
 * 而漂移的表现是"模型填得挺好但就是落不进库"。这里一律从 schema 现查：
 * 模型看不到字段名就填不对，而字段名只能来自 schema。
 *
 * 【为什么草稿行可以复用现有结构】
 * `DraftRow` 只要求"一个 tabId + 一组 `键:值`"，没有假设目标一定是条目标签。
 * 于是表单型可以冒充一行草稿 → 直接复用 `DraftReviewPanel`（勾选/编辑/落库预览）
 * 与 `previewCommit`，界面零改动。
 *
 * 【覆盖范围（老大 2026-09-18 口径：「不止点名的三张，针对所有表」）】
 * 动态取 schema 里**全部** form 型页签 —— 作品信息 / 世界设定 / 力量体系 / 全书总纲 / 写作规范。
 * 以后新增 form 页签会自动纳入，不必回来改这个文件。
 * ⚠️ 覆盖面变广之后，判断权交给作者而不是写死在这里：草稿按「一张表一行」呈现，
 *    不想要的那张在闸门处**不勾**即可 —— 这比替作者决定"哪张该由模型填"稳妥得多。
 */
import { TABS } from '../schema'
import { asText } from '../aiParse'
import type { DraftField, DraftRow } from './types'

/**
 * 页签改过名时的**旧名映射**（id → 旧显示名）。
 *
 * 🔴 2.7.2：「作品定位」改名「作品信息」。改名只动显示层（存储键仍是 `positioning`），
 *    但**模型的输出**可能还用旧名（尤其来自旧提示词 / 旧会话上下文 / 手写 JSON）。
 *    `formDraftRows` 取值时按「新名 → id → 旧名」三级兜底，避免整张表被静默丢弃。
 *
 * ⚠️ 改名时**必须**在这里加一条 —— 否则模型返回旧名的那次汇总会整表落空，
 *    界面只显示「没汇总出可用的全书级设定」，而作者完全看不出哪里错了。
 */
const LEGACY_TAB_NAMES: Record<string, string> = {
  positioning: '作品定位',
  // 2.7.2 同批改名：经济体系 → 经济基础。漏登记 ⇒ 模型返回旧名时整张表静默落空。
  economy: '经济体系',
}

/**
 * 「流程末尾汇总」覆盖的表单页签 id —— schema 里的**全部** form 型。
 * 传参可覆盖（测试或将来做"只汇总某几张"的选项时用）。
 */
export function summaryFormTabs(): string[] {
  return TABS.filter(t => t.type === 'form').map(t => t.id)
}

export interface FormFieldSpec {
  tabId: string
  tabName: string
  /** 所属模块名（如「一、世界总览」） */
  module: string
  /** 字段名（作者看到的那个）；落库键由 `${module}::${name}` 组成 */
  name: string
  desc?: string
  example?: string
}

/** 列出这些表单页签的全部字段，顺序＝schema 顺序（也恰好是作者填表的顺序） */
export function formFieldSpecs(tabIds: readonly string[] = summaryFormTabs()): FormFieldSpec[] {
  const out: FormFieldSpec[] = []
  for (const id of tabIds) {
    const tab = TABS.find(t => t.id === id)
    if (tab?.type !== 'form' || !tab.modules) continue
    for (const m of tab.modules) {
      for (const f of m.fields) {
        out.push({
          tabId: id, tabName: tab.name, module: m.name, name: f.name,
          ...(f.desc ? { desc: f.desc } : {}),
          ...(f.example ? { example: f.example } : {}),
        })
      }
    }
  }
  return out
}

/**
 * 给模型看的字段清单（进提示词）。
 * 🔴 必须带字段说明与示例：只给字段名的话，模型会拿"一句话世界观"当"世界名称"填 ——
 *    而这类错位在落库后极难发现（内容看着都像那么回事）。
 */
export function formFieldsPrompt(tabIds: readonly string[] = summaryFormTabs()): string {
  const specs = formFieldSpecs(tabIds)
  const lines: string[] = []
  let lastTab = ''
  let lastMod = ''
  for (const s of specs) {
    if (s.tabId !== lastTab) { lines.push(`\n〖${s.tabName}〗`); lastTab = s.tabId; lastMod = '' }
    if (s.module !== lastMod) { lines.push(`  ${s.module}`); lastMod = s.module }
    const hint = [s.desc, s.example ? `例：${s.example}` : ''].filter(Boolean).join('；')
    lines.push(`    - ${s.name}${hint ? `（${hint}）` : ''}`)
  }
  return lines.join('\n').trim()
}

/** 该页签的字段名集合（用于把模型多写的字段挡在外面） */
export function formFieldNames(tabId: string): Set<string> {
  const tab = TABS.find(t => t.id === tabId)
  const out = new Set<string>()
  if (tab?.type !== 'form') return out
  for (const m of tab.modules ?? []) for (const f of m.fields) out.add(f.name)
  return out
}

/**
 * 把模型给的「页签 → 模块 → 字段」压平成「字段名 → 值」。
 *
 * 🔴 为什么必须容这两层（2026-09-18 实机抓到的真问题）：
 *   提示词里字段清单是按「页签 〖〗 → 模块 → 字段」三层给的（那是最贴近作者填表习惯的读法），
 *   模型于是**照着这个层级输出**：
 *     {"世界设定":{"一、世界总览":{"世界名称":"苍澜大陆"}}}
 *   而原来的实现只认两层（`页签 → 字段`）—— 拿 `bag['世界名称']` 取到的是 undefined，
 *   结果**5 张表全部被静默丢弃**，界面只显示"没汇总出可用的全书级设定"。
 *   产出本身完全正确，错的是我们读它的方式。
 * 所以这里兼容：值是对象 → 当它是一层模块继续摊；值是标量 → 直接取。
 */
function flattenFormBag(bag: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(bag)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        const t = asText(v2).trim()
        if (t) out[k2] = t
      }
    } else {
      const t = asText(v).trim()
      if (t) out[k] = t
    }
  }
  return out
}

/**
 * 模型产出 → 草稿行（**每张表单一行**，一整份设定就是一行）。
 *
 * @param values 顶层键＝页签名（`世界设定`）或页签 id（`worldbase`），值＝`{ 字段名: 内容 }`。
 *               两种键都接受 —— 模型给哪个不由我们决定，认两种比事后补救便宜。
 * @returns 只包含**真填到了内容**的页签；一个字段都没填的页签不产出空行（免得界面出现一行空的"世界设定"）
 */
export function formDraftRows(
  values: Record<string, Record<string, unknown>>,
  tabIds: readonly string[] = summaryFormTabs(),
): DraftRow[] {
  const rows: DraftRow[] = []
  for (const tabId of tabIds) {
    const tab = TABS.find(t => t.id === tabId)
    if (tab?.type !== 'form' || !tab.modules) continue
    // 🔴 2.7.2：页签「作品定位」改名「作品信息」⇒ 模型（尤其旧提示词/旧会话上下文）很可能
    //    仍按旧名输出。这里按「显示名 → id → 旧名」三级兜底取，避免改名后**静默丢掉整张表**。
    const bag = values[tab.name] ?? values[tabId] ?? values[LEGACY_TAB_NAMES[tabId]]
    if (!bag || typeof bag !== 'object') continue
    // 模型可能按「页签 → 模块 → 字段」输出（提示词就是那么给的），先压平成「字段 → 值」
    const flat = flattenFormBag(bag)
    const allowed = formFieldNames(tabId)
    const fields: DraftField[] = []
    // 按 schema 顺序遍历（而不是遍历模型给的键）→ 行内字段顺序稳定，落库顺序也稳定
    for (const m of tab.modules) {
      for (const f of m.fields) {
        if (!allowed.has(f.name)) continue
        const v = flat[f.name] ?? ''
        if (!v) continue
        fields.push({ key: `${m.name}::${f.name}`, label: f.name, value: v })
      }
    }
    if (fields.length === 0) continue
    rows.push({
      key: `form::${tabId}`,
      tabId,
      tabName: tab.name,
      kindLabel: '全书设定',
      name: tab.name,
      aliases: [],
      fields,
      // 表单没有独立"主名称"，用第一个字段当行名（作品信息→书名 / 世界设定→世界名称 …）
      nameKey: fields[0].key,
      // 表单是单份、且这里是"按 schema 字段逐个填"，不存在同名判重问题 → 恒为 new
      status: 'new',
      confidence: 0.8,
      quotes: [],
      chapters: [],
    })
  }
  return rows
}
