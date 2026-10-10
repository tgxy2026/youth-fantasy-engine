/**
 * 「整理关系」的材料上限 —— 可在界面上调（推荐值 + 每项为什么）。
 *
 * 【为什么必须可调，而不是写死几个数】
 * 材料 = 已抽出的实体清单 + 开篇原文样本，它是**一次调用**的输入，必须有上限：
 * 撞窗口的表现是**静默截断**（模型只看到前半段，却照样输出得很像样），而截断发生在
 * `buildFormMaterial` 的层层收口里 —— 所以宁可把"砍掉了多少"写在说明里，也不让它悄悄发生。
 *
 * 但「合适的上限」因书而异：
 *   · 一本两百万字的群像长卷，人物几百个，每类 50 条会把大半角色挡在关系整理之外 ——
 *     表现是"某两个人明明有关系却没整理出来"，而作者只会以为模型不行；
 *   · 一本十万字的中篇，把上限调大只是白烧词元与时间。
 * 所以：给推荐值 + 讲清每项影响什么 + 允许手动调整（持久保存，下次不用重调）。
 *
 * 🔴 天花板与模型窗口的关系：材料 + 系统提示 + 项目资料**共同**占用上下文。
 *    本地模型窗口 ≈ 32K 词元时，材料控制在 8000 字以内是稳妥的；
 *    调大之前先看「模型设置 → 模型配置」里那个模型的上下文窗口。
 */
import * as db from '@/lib/db'

export interface RelationMaterialLimits {
  /** 每类实体最多带多少条（人物 / 势力 / 地点 / 种族 / 物品 / 术语，各自独立计数） */
  perType: number
  /** 单条实体最多多少字（超出截断） */
  perEntityChars: number
  /** 开篇原文样本取多少字（0 = 完全不取原文） */
  rawHeadChars: number
  /** 材料总字数上限（到顶后截断并标注「后面已省略」） */
  maxChars: number
  /** 单张表最多整理出多少条关系 */
  maxRows: number
}

const KEY = 'bookbreak.relationLimits'

/** 推荐值。改这里等于改「恢复推荐」的落点，界面上每个值的理由见 RELATION_LIMIT_META。 */
export const DEFAULT_RELATION_LIMITS: RelationMaterialLimits = {
  perType: 50,
  perEntityChars: 130,
  rawHeadChars: 1500,
  maxChars: 8000,
  maxRows: 20,
}

export interface RelationLimitMeta {
  key: keyof RelationMaterialLimits
  label: string
  unit: string
  min: number
  max: number
  step: number
  /** 这个值影响什么、为什么推荐它 —— 直接显示在界面上，别只写在文档里 */
  why: string
}

export const RELATION_LIMIT_META: RelationLimitMeta[] = [
  {
    key: 'perType', label: '每类实体条数', unit: '条', min: 10, max: 200, step: 10,
    why: '人物 / 势力 / 地点…各自独立计数，决的是「哪些角色进得了关系整理」。群像大长篇可调到 100~200；' +
      '每加 10 条约多 1.3K 字材料。⚠️ 别调太小：实测压到 10 条时，同一段文本一条关系都没整理出来' +
      '（名单里没有那个角色，模型给的关系就落不了地）。',
  },
  {
    key: 'perEntityChars', label: '单条实体字数', unit: '字', min: 60, max: 300, step: 10,
    why: '一条实体带的信息越多，模型越能判断身份与立场（关系的依据多半藏在这里）。' +
      '调到 200 以上能让外貌 / 境界 / 剧情作用全带上，但材料会成倍增长。',
  },
  {
    key: 'rawHeadChars', label: '开篇原文样本', unit: '字', min: 0, max: 6000, step: 100,
    why: '关系靠原文里的互动才看得出来，样本越长越准；但它和实体清单「抢同一份额度」' +
      '（受「材料总字数」限制），长书里调大反而会挤掉实体清单。',
  },
  {
    key: 'maxChars', label: '材料总字数', unit: '字', min: 2000, max: 24000, step: 500,
    why: '材料的硬上限，超了会截断并标注「后面已省略」。它与模型窗口挂钩：材料 + 提示词 + 项目资料' +
      '必须留在窗口内。本地 32K 窗口建议不超过 8000；云端大窗口模型可上调。',
  },
  {
    key: 'maxRows', label: '单表关系条数', unit: '条', min: 5, max: 60, step: 5,
    why: '一次最多整理出多少条关系（人物关系 / 势力关系各算一次调用）。超出的部分不会丢，' +
      '可以再跑一次 —— 已有条目会作为「不得重复」清单带上。',
  },
]

/** 取值钳制（**纯函数，可单测**）：把界面输入或旧存档收敛到安全范围，避免手滑写出极端值 */
export function clampRelationLimits(v: Partial<RelationMaterialLimits> | null | undefined): RelationMaterialLimits {
  const out = { ...DEFAULT_RELATION_LIMITS }
  for (const m of RELATION_LIMIT_META) {
    const raw = v?.[m.key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    out[m.key] = Math.min(m.max, Math.max(m.min, Math.round(raw)))
  }
  // 交叉约束：原文样本不可能比材料总量还大（否则它会把实体清单整段挤没）
  if (out.rawHeadChars > out.maxChars) out.rawHeadChars = out.maxChars
  return out
}

/** 读当前设置（已钳制）。读失败或没存过都给推荐值 —— 这条链上绝不因设置读不到而中断拆书。 */
export async function getRelationLimits(): Promise<RelationMaterialLimits> {
  const raw = await db.getMeta<Partial<RelationMaterialLimits> | null>(KEY, null).catch(() => null)
  return clampRelationLimits(raw)
}

/** 存设置（写前钳制，返回值即实际生效值 —— 界面据此回显，避免"显示 300 实际 200"） */
export async function saveRelationLimits(v: Partial<RelationMaterialLimits>): Promise<RelationMaterialLimits> {
  const next = clampRelationLimits(v)
  await db.setMeta(KEY, next)
  return next
}

/** 恢复推荐值（界面上的「恢复推荐」） */
export async function resetRelationLimits(): Promise<RelationMaterialLimits> {
  return saveRelationLimits(DEFAULT_RELATION_LIMITS)
}

/** 是否与推荐值一致（界面据此决定要不要显示「已调整」标记） */
export function isDefaultLimits(v: RelationMaterialLimits): boolean {
  return RELATION_LIMIT_META.every(m => v[m.key] === DEFAULT_RELATION_LIMITS[m.key])
}
