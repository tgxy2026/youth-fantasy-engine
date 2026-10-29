/**
 * AI 用途路由（2.8.0 · 台账 #014）。
 *
 * 【要解决的问题】全应用只有一个「当前模型」，于是「创作用好模型」与「整理用便宜模型」
 * 只能二选一：要么为了省钱让正文写得差，要么为了正文质量让几十次批量调用都烧最好的模型。
 *
 * 【设计】三类用途各存一个 providerId **引用**（照酒馆 `TavernModelRef` 的既有做法，**不复制配置**）：
 *   · 留空 = 跟随当前模型 —— 三格全空时行为与改造前**逐字一致**（升级零行为变化）；
 *   · 指定的模型被删除 / 配置被改动 ⇒ 回落到当前模型，且**不弹错**
 *     （宁可退回当前模型，也不让按钮变灰 —— 与酒馆链路的兜底口径一致）。
 *
 * 🔴 存储走 `db.meta` 的**全局**键（模型是这台机器的能力，不随小说项目切换 —— 与 `aiProviders` 同理）。
 * 🔴 本模块**绝不 import `./ai` 门面** —— 门面会再导出本模块，反向引用立刻成环。
 *    依赖方向固定为 `aiRouting → aiCore/session → aiCore/core`（DAG，无环）。
 */
import * as db from '@/lib/db'
import { getActiveProvider, loadProviders } from '@/lib/aiCore/session'
import type { AIProvider } from '@/lib/aiCore/core'

export type TaskRole = 'create' | 'review' | 'utility'

/** 三用途的固定顺序（设置页三行的显示次序、迁移与断言都按它遍历） */
export const TASK_ROLES: readonly TaskRole[] = ['create', 'review', 'utility'] as const

export const ROLE_LABEL: Record<TaskRole, string> = {
  create: '创作',
  review: '审校',
  utility: '整理',
}

export const ROLE_HINT: Record<TaskRole, string> = {
  create: '逐章连写、续写、AI 补全 —— 直接决定正文质量，建议给最好的模型',
  review: '颉文姬诊断、校对、节奏与爽点检查 —— 读的材料多、输出短，可用中等模型',
  utility: 'AI 整理、表格导入、拆书、取名、使用答疑 —— 批量重复调用，建议给便宜 / 快的模型',
}

export type RoutingMap = Record<TaskRole, string>

const K_ROUTING = 'aiRouting'

/** 出厂：三格全空 ⇒ 全部跟随当前模型（升级后行为与改造前一致） */
export const DEFAULT_ROUTING: RoutingMap = { create: '', review: '', utility: '' }

/** 读路由。空库 / 异常一律回退出厂值 —— 路由读不出来不该让任何 AI 功能挂掉 */
export async function loadRouting(): Promise<RoutingMap> {
  try {
    const raw = await db.getMeta<Partial<RoutingMap> | null>(K_ROUTING, null)
    const pick = (v: unknown): string => (typeof v === 'string' ? v : '')
    return { create: pick(raw?.create), review: pick(raw?.review), utility: pick(raw?.utility) }
  } catch {
    return { ...DEFAULT_ROUTING }
  }
}

/** 写路由。空值一律归一成空串（不存 undefined，免得 JSON 里出现空洞） */
export async function saveRouting(next: RoutingMap): Promise<RoutingMap> {
  const out: RoutingMap = {
    create: next.create || '',
    review: next.review || '',
    utility: next.utility || '',
  }
  await db.setMeta(K_ROUTING, out)
  return out
}

/**
 * 解析某用途该用哪个模型。
 *  · 该用途指定了模型、且它此刻仍在模型列表里 ⇒ 用它；
 *  · 留空、或指定的那个已被删除 ⇒ 回落「当前模型」（与改造前完全一致）。
 */
export async function resolveProviderFor(role: TaskRole): Promise<AIProvider | null> {
  let want = ''
  try {
    want = (await loadRouting())[role]
  } catch {
    want = ''
  }
  if (want) {
    const list = await loadProviders()
    const hit = list.find(p => p.id === want)
    if (hit) return hit
  }
  return getActiveProvider()
}

/** 取某用途的模型；一个都拿不到时抛出统一的中文提示（供必须依赖 AI 的功能使用） */
export async function requireProviderFor(role: TaskRole): Promise<AIProvider> {
  const cfg = await resolveProviderFor(role)
  if (!cfg) throw new Error('尚未配置可用的 AI 模型，请先到「模型设置 → 模型配置」添加并设为当前。')
  return cfg
}

/** 某模型被哪些用途引用（列表行徽标、删除前提示用）；未被任何用途引用则返回空数组 */
export function rolesOf(routing: RoutingMap, providerId: string): TaskRole[] {
  return TASK_ROLES.filter(r => routing[r] === providerId)
}
