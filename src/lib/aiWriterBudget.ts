/**
 * 正文写作链路的 AI「资料预算」（全局设置）。
 *
 * 【要解决的问题】
 * 正文写作那一整条链路的额度原本是**散落的硬编码常量**：校对 6000、颉文姬 OOC 10000、
 * 一键续写 12000…… 想调一个数就得改代码；而且它们同样是为本地设备定的，
 * 接上云端大窗口模型时不会跟着放大（酒馆已经有「额度跟着模型走」了，这边没有）。
 *
 * 【设计：一个基准 + 一组系数】
 * 只暴露**一个**用户可调的「基准」（默认 8000 字），各功能按各自的系数换算。
 * 🔴 系数是**从现有硬编码值反推**的，所以出厂基准 8000 下每一项换算结果都**等于改造前的值** ——
 *    升级后一个字的行为都不会变（这是本项目对"默认值"的一贯要求）。
 *
 * 【为什么基准能跟着模型走】
 * 资料预算大不大，取决于模型能吃多少。本地受显存限制（numCtx），云端按可用窗口的一个小比例。
 * 与酒馆的额度**互不影响**：这里只管正文写作链路，酒馆那两个数在「控制面板」里单独设置。
 */
import * as db from './db'
import { adviseCapacity, modelFingerprintOf, shouldApplyTuning, type CapacityAdvice } from './modelCapacity'
import { loadProviders, loadActiveId, type AIProvider } from './ai'
import { getTavernSettings } from './tavern/settings'

const K_WRITER_BUDGET = 'ai.writerBudget'

/** 出厂基准（字）。各功能按系数换算，出厂值下与改造前的硬编码完全一致 */
export const DEFAULT_WRITER_BASE = 8000

/** 基准的可调范围与步长（与面板上的输入框一致）。上限必须 ≥ 云端推荐上限，否则推荐值填不进去 */
export const WRITER_BASE_LIMITS = { min: 1000, max: 200000, step: 500 } as const

/**
 * 「按模型推荐」的比例与上限（2026-09-18 放宽，老大选 30% 档）。
 *
 * 为什么是 30%：资料之外还要放正文片段（本章 / 上一章）与模型输出，
 * 给资料留不到三分之一才合理。
 *
 * 放宽前的两处保守：
 *  · 本地写成 `min(出厂值 8000, numCtx×0.25)` —— 出厂值成了天花板，numCtx 提到 131072 也不动；
 *  · 云端只用 12%（256K 窗口才给 11600，128K 窗口几乎不放大）。
 */
export const WRITER_RECOMMEND = {
  local: { ratio: 0.30, cap: 48000 },
  cloud: { ratio: 0.30, cap: 120000 },
} as const

/**
 * 各功能的系数（相对基准）。
 *
 * ⚠️ 出厂 base = 8000 时，每项换算结果 = 注释里那个数 = **改造前的硬编码值**。
 *    改这里之前先想清楚：任何系数变动都会**改变默认行为**。
 */
export const WRITER_BUDGET_KINDS = {
  'auto-continue': 1.5,           // 12000 逐章连写（创意写作两种起点共用）
  'proofread': 0.75,              //  6000 校对（编辑器）/ 颉文姬深度校对
  'foreshadow-review': 1.5,       // 12000 伏笔闭环审查（只带三张表）
  'continuity-audit': 1.5,        // 12000 连续性校验
  'consistency-selfcheck': 1.0,   //  8000 检查工具页「AI 一致性深度自查」
  'project-diagnose': 1.5,        // 12000 创作健康诊断
  'organize-rows': 1.125,         //  9000 AI 整理（批量补条目）
  'ai-assist': 0.5,               //  4000 AI 辅助规划
  'name-suggest': 0.375,          //  3000 AI 取名
  'plot-canvas': 0.75,            //  6000 情节推演画布
  'jiewenji-proofread': 0.75,     //  6000 颉文姬 · 深度校对
  'jiewenji-diagnosis': 1.0,      //  8000 综合诊断
  'jiewenji-review': 1.0,         //  8000 章节编辑意见
  'jiewenji-ooc': 1.25,           // 10000 OOC 人设检查（读角色卡最全）
  'jiewenji-advice': 1.0,         //  8000 续写方向
  'jiewenji-pleasure': 1.0,       //  8000 爽点 / 毒点
  'jiewenji-opening': 1.0,        //  8000 黄金三章
  'jiewenji-brief': 1.0,          //  8000 本章写作简报
  //  12000 创意写作 · 分卷大纲（要较全的设定才编得动；设定奠基的输入是「种子」本身，不占额度）
  'outline-generate': 1.5,
} as const

export type WriterBudgetKind = keyof typeof WRITER_BUDGET_KINDS

/** 界面展示用：各功能的称呼（展开明细时列出来，让作者知道"基准调了会影响谁"） */
export const WRITER_BUDGET_LABELS: Record<WriterBudgetKind, string> = {
  'auto-continue': '逐章连写（创意写作）',
  'proofread': '校对 · 逻辑层 / 颉文姬逻辑审校（文字层不读设定，不占额度）',
  'foreshadow-review': '伏笔闭环审查',
  'continuity-audit': '连续性校验',
  'consistency-selfcheck': 'AI 一致性深度自查（检查工具）',
  'project-diagnose': '创作健康诊断',
  'organize-rows': 'AI 整理（批量补条目）',
  'ai-assist': 'AI 辅助规划',
  'name-suggest': 'AI 取名',
  'plot-canvas': '情节推演画布',
  'jiewenji-proofread': '颉文姬 · 深度校对',
  'jiewenji-diagnosis': '颉文姬 · 综合诊断',
  'jiewenji-review': '颉文姬 · 章节编辑意见',
  'jiewenji-ooc': '颉文姬 · OOC 人设检查',
  'jiewenji-advice': '颉文姬 · 续写方向',
  'jiewenji-pleasure': '颉文姬 · 爽点 / 毒点',
  'jiewenji-opening': '颉文姬 · 黄金三章',
  'jiewenji-brief': '颉文姬 · 本章写作简报',
  'outline-generate': '创意写作 · 分卷大纲',
}

export interface WriterBudgetSettings {
  /** 基准（字） */
  base: number
  /**
   * 上次自动套用时的**模型指纹**（`providerId|model|contextWindow`）。
   *
   * 🔴 与酒馆额度同一套判定：自动套用**只在指纹变化（= 真换了模型）时**发生。
   *    若改成"发现偏离就纠正"，作者手调的基准会在每次同步被改回去。
   *    空/缺失 = 尚未登记：首次同步**只登记指纹、不改值**。
   */
  tunedFor?: string
  /** 是否跟着模型自动调整（默认开；关掉即完全手工） */
  autoTuneByModel?: boolean
}

export const DEFAULT_WRITER_BUDGET: WriterBudgetSettings = {
  base: DEFAULT_WRITER_BASE,
  autoTuneByModel: true,
}

/** 读设置。异常/越界一律回退出厂值 —— 额度读不出来不该让 AI 功能整个挂掉 */
export async function getWriterBudget(): Promise<WriterBudgetSettings> {
  try {
    const raw = await db.getMeta<Partial<WriterBudgetSettings> | null>(K_WRITER_BUDGET, null)
    const base = Number(raw?.base)
    const safeBase = (!Number.isFinite(base) || base < WRITER_BASE_LIMITS.min)
      ? DEFAULT_WRITER_BASE
      : Math.min(WRITER_BASE_LIMITS.max, Math.round(base))
    return {
      base: safeBase,
      tunedFor: typeof raw?.tunedFor === 'string' ? raw.tunedFor : undefined,
      autoTuneByModel: raw?.autoTuneByModel !== false,
    }
  } catch {
    return DEFAULT_WRITER_BUDGET
  }
}

export async function saveWriterBudget(next: WriterBudgetSettings): Promise<WriterBudgetSettings> {
  const base = Math.max(WRITER_BASE_LIMITS.min, Math.min(WRITER_BASE_LIMITS.max, Math.round(next.base)))
  const out: WriterBudgetSettings = { base, autoTuneByModel: next.autoTuneByModel !== false }
  if (next.tunedFor) out.tunedFor = next.tunedFor
  await db.setMeta(K_WRITER_BUDGET, out)
  return out
}

/** 某功能在给定基准下实际使用的资料预算（对齐到 100 字，免得界面上出现 6375 这种数） */
export function budgetForKind(kind: WriterBudgetKind, base: number): number {
  const raw = base * WRITER_BUDGET_KINDS[kind]
  return Math.max(1000, Math.round(raw / 100) * 100)
}

/** 调用点用这个：读设置 + 换算一步到位 */
export async function writerBudgetFor(kind: WriterBudgetKind): Promise<number> {
  const { base } = await getWriterBudget()
  return budgetForKind(kind, base)
}

/**
 * 按当前模型推荐基准。
 *  · 本地：跟着 `numCtx`（窗口由显存决定）—— numCtx 变大时资料预算也跟着涨，**不再封顶在出厂值**。
 *  · 云端：按可用窗口的比例，下限出厂值、上限见 `WRITER_RECOMMEND`。
 */
export function recommendWriterBase(cap: CapacityAdvice): number {
  const snap100 = (v: number) => Math.round(v / 100) * 100
  const R = WRITER_RECOMMEND
  if (cap.local) {
    return Math.max(WRITER_BASE_LIMITS.min, Math.min(R.local.cap, snap100(cap.windowTokens * R.local.ratio)))
  }
  return Math.max(DEFAULT_WRITER_BASE, Math.min(R.cloud.cap, snap100(cap.approxPromptTokens * R.cloud.ratio)))
}

/** 按模型推荐值时，各功能会变成多少（面板上展开明细用） */
export function previewAt(base: number): { kind: WriterBudgetKind; label: string; value: number }[] {
  return (Object.keys(WRITER_BUDGET_KINDS) as WriterBudgetKind[]).map(kind => ({
    kind,
    label: WRITER_BUDGET_LABELS[kind],
    value: budgetForKind(kind, base),
  }))
}

// ==================== 跟着模型走（与酒馆额度同一套判定） ====================

/**
 * 当前生效模型的能力与推荐基准 —— **面板与自动跟随共用同一个口径**，
 * 免得"面板显示的推荐值"与"实际自动套用的值"算得不一样。
 */
export async function currentModelAdvice(): Promise<
  { cap: CapacityAdvice; recommended: number; fingerprint: string } | null
> {
  try {
    const [providers, activeId, tav] = await Promise.all([
      loadProviders().catch(() => [] as AIProvider[]),
      loadActiveId().catch(() => null),
      getTavernSettings().catch(() => null),
    ])
    const p = providers.find(x => x.id === activeId) ?? null
    // 本地窗口由显存决定 —— 取酒馆那边设的 numCtx（同一个模型，窗口也是同一个）
    const numCtx = tav?.common.numCtx ?? 32768
    const cap = adviseCapacity(p, { numCtx, contextBudget: tav?.common.contextBudget ?? 24000 })
    return { cap, recommended: recommendWriterBase(cap), fingerprint: modelFingerprintOf(p) }
  } catch {
    return null
  }
}

export interface WriterSyncResult {
  changed: boolean
  reason: 'off' | 'registered' | 'same-model' | 'no-drift' | 'applied' | 'error'
  base?: number
}

/**
 * 换模型后把基准同步成当前模型的推荐值。
 *
 * 判定链（与酒馆额度共用 `shouldApplyTuning`）：
 *  ① 关掉开关 → off；② 首次（指纹未登记）→ 只登记、不改值；
 *  ③ 同模型 → 不动（**保住作者手调的基准**）；④ 换了模型 → 套用推荐值。
 *
 * 异常一律吞掉 —— 同步额度失败不该拦住任何 AI 功能。
 */
export async function syncWriterBudgetToModel(): Promise<WriterSyncResult> {
  try {
    const st = await getWriterBudget()
    if (st.autoTuneByModel === false) return { changed: false, reason: 'off' }
    const info = await currentModelAdvice()
    if (!info) return { changed: false, reason: 'error' }

    const verdict = shouldApplyTuning({ autoTune: true, tunedFor: st.tunedFor, fingerprint: info.fingerprint })
    if (verdict === 'same-model') return { changed: false, reason: 'same-model' }
    if (verdict === 'registered') {
      await saveWriterBudget({ ...st, tunedFor: info.fingerprint })
      return { changed: false, reason: 'registered' }
    }
    const changed = info.recommended !== st.base
    await saveWriterBudget({ ...st, base: info.recommended, tunedFor: info.fingerprint })
    return { changed, reason: changed ? 'applied' : 'no-drift', base: info.recommended }
  } catch {
    return { changed: false, reason: 'error' }
  }
}
