/**
 * AI 接入层 · 会话层（2.8.0 从 `lib/ai.ts` 拆出，见 `lib/ai.ts` 顶部说明）。
 *
 * 职责：模型配置的读写（走 `db.meta`，全局共享）、当前模型的解析，以及
 * 「AI 是否就绪」的全局订阅（各入口按钮据此禁用/点亮）。
 */

import * as db from '@/lib/db'
import {
  precheck, setChatTimeoutMs,
  AI_TIMEOUT_MIN_SEC, AI_TIMEOUT_MAX_SEC, AI_TIMEOUT_DEFAULT_SEC,
} from '@/lib/aiCore/core'
import type { AIProvider } from '@/lib/aiCore/core'

// ---- 设置持久化（走 db.meta，全局共享）----
//
// 1.5.0 起模型配置改为「全局」：模型是这台机器的能力，不该随小说项目切换而丢失。
// 旧版本曾写在项目级 settingsKV 里，首次读取时按项目自动迁移到全局，作者无感。

const K_PROVIDERS = 'aiProviders'
const K_ACTIVE = 'aiActiveProviderId'
const K_MIGRATED = 'aiConfigMigratedToGlobal'

/** 已完成旧配置迁移的项目 id（进程内缓存，避免每次读配置都多打两次库） */
let migratedFor: string | null = null

async function ensureMigrated(): Promise<void> {
  const pid = db.getCurrentProjectId()
  if (migratedFor === pid) return
  migratedFor = pid
  try {
    if (await db.getSetting<boolean>(K_MIGRATED, false)) return
    const legacy = await db.getSetting<AIProvider[]>(K_PROVIDERS, [])
    if (legacy.length > 0) {
      const cur = await db.getMeta<AIProvider[]>(K_PROVIDERS, [])
      const merged = [...cur]
      for (const p of legacy) if (!merged.some(x => x.id === p.id)) merged.push(p)
      await db.setMeta(K_PROVIDERS, merged)
      if (!(await db.getMeta<string | null>(K_ACTIVE, null))) {
        const la = await db.getSetting<string | null>(K_ACTIVE, null)
        if (la) await db.setMeta(K_ACTIVE, la)
      }
    }
    await db.setSetting(K_MIGRATED, true)
  } catch {
    // 迁移失败不影响主流程：最坏情况就是作者重新添加一次模型
    migratedFor = null
  }
}

// ---- 「请求超时」（全局设置 · 2.9.0）----
//
// 为什么与模型配置同层：超时是「模型有多慢 / 网络有多慢」的属性，不随小说项目切换。
// 此前 `aiTasks/**` 一律吃 `CHAT_TIMEOUT_MS`（180s 常量），慢模型跑长任务只能干等或失败；
// 酒馆早就有「请求超时」可调，主应用却没有 —— 这里补上，并让全应用共用同一个值。

const K_TIMEOUT_SEC = 'aiRequestTimeoutSec'

/** 已把超时同步进 AI 层的数据源标记（进程内缓存；换库 / 导入数据文件后要重读） */
let timeoutAppliedFor: string | null = null

/**
 * 首次取模型配置时顺带把「请求超时」同步进 AI 层（幂等、廉价）。
 * 🔴 异常一律吞掉：读不到设置绝不该拦住任何 AI 调用（退回出厂默认即可）。
 */
async function ensureTimeoutApplied(): Promise<void> {
  const pid = db.getCurrentProjectId()
  if (timeoutAppliedFor === pid) return
  timeoutAppliedFor = pid
  try {
    setChatTimeoutMs((await loadAiTimeoutSec()) * 1000)
  } catch {
    timeoutAppliedFor = null
  }
}

/** 读「请求超时」（秒）：读不到 / 非法 → 出厂默认；越界钳回。 */
export async function loadAiTimeoutSec(): Promise<number> {
  const raw = await db.getMeta<number>(K_TIMEOUT_SEC, AI_TIMEOUT_DEFAULT_SEC)
  const n = Number(raw)
  if (!Number.isFinite(n)) return AI_TIMEOUT_DEFAULT_SEC
  return Math.min(AI_TIMEOUT_MAX_SEC, Math.max(AI_TIMEOUT_MIN_SEC, Math.round(n)))
}

/** 写「请求超时」（秒）并**立即生效**（不必重启、不必换库）。返回实际落库值（已钳位）供界面回显。 */
export async function saveAiTimeoutSec(sec: number): Promise<number> {
  const n0 = Number(sec)
  const n = Number.isFinite(n0)
    ? Math.min(AI_TIMEOUT_MAX_SEC, Math.max(AI_TIMEOUT_MIN_SEC, Math.round(n0)))
    : AI_TIMEOUT_DEFAULT_SEC
  await db.setMeta(K_TIMEOUT_SEC, n)
  setChatTimeoutMs(n * 1000)
  return n
}

export async function loadProviders(): Promise<AIProvider[]> {
  await ensureMigrated()
  await ensureTimeoutApplied()
  return (await db.getMeta<AIProvider[]>(K_PROVIDERS, [])) ?? []
}
export async function saveProviders(list: AIProvider[]): Promise<void> {
  await db.setMeta(K_PROVIDERS, list)
  await refreshAIReady()
}
export async function loadActiveId(): Promise<string | null> {
  await ensureMigrated()
  return (await db.getMeta<string | null>(K_ACTIVE, null)) ?? null
}
export async function saveActiveId(id: string | null): Promise<void> {
  await db.setMeta(K_ACTIVE, id)
  await refreshAIReady()
}

export function typeLabel(p: AIProvider): string {
  return p.type === 'ollama' || p.local ? '本地' : '联网'
}

// ---- AI 就绪状态（全局订阅）----
//
// 存在意义：所有 AI 入口按钮都要能在「未配置模型」时自动禁用并给出说明。
// 各组件若各自去 loadProviders() 判断，既重复又容易漏掉「刚配好模型但按钮还是灰的」。
// 这里做一个极小的发布订阅：配置变更 → 广播 → 所有按钮同步刷新。

export interface AIReadyInfo {
  /** 是否存在「配置完整、可直接调用」的模型 */
  ready: boolean
  /** 当前模型的简短标识，如「本地 Ollama · qwen3:8b」；未就绪为空串 */
  label: string
}

const AI_NOT_READY: AIReadyInfo = { ready: false, label: '' }
let readyInfo: AIReadyInfo = AI_NOT_READY
let readyLoaded = false
const readyListeners = new Set<() => void>()

/** 配置是否填全（能真正发起调用），复用测试前的本地校验 */
export function isProviderUsable(p: AIProvider): boolean {
  return precheck(p) === ''
}

function resolveActive(list: AIProvider[], activeId: string | null): AIProvider | null {
  const byId = activeId ? list.find(p => p.id === activeId) : undefined
  const cand = byId ?? list[0]
  if (cand && isProviderUsable(cand)) return cand
  // 当前选中的那个没填全时，退而取第一个填全的，
  // 免得作者明明配好了另一个模型，按钮却告诉他「未配置」。
  return list.find(isProviderUsable) ?? null
}

/** 取当前生效的模型配置；未配置或配置不全时返回 null（调用方自行决定是否降级） */
export async function getActiveProvider(): Promise<AIProvider | null> {
  const [list, activeId] = await Promise.all([loadProviders(), loadActiveId()])
  return resolveActive(list, activeId)
}

/** 取当前模型；没有就抛出统一的中文提示（供必须依赖 AI 的功能使用） */
export async function requireActiveProvider(): Promise<AIProvider> {
  const cfg = await getActiveProvider()
  if (!cfg) throw new Error('尚未配置可用的 AI 模型，请先到「模型设置 → 模型配置」添加并设为当前。')
  return cfg
}

/** 同步读取当前快照（useSyncExternalStore 用，返回引用稳定的对象） */
export function aiReadySnapshot(): AIReadyInfo {
  return readyInfo
}

/** 重新计算就绪状态，有变化才广播 */
async function refreshAIReady(): Promise<AIReadyInfo> {
  readyLoaded = true
  let next: AIReadyInfo = AI_NOT_READY
  try {
    const cfg = await getActiveProvider()
    if (cfg) next = { ready: true, label: `${cfg.name || typeLabel(cfg)} · ${cfg.model}` }
  } catch {
    next = AI_NOT_READY
  }
  if (next.ready !== readyInfo.ready || next.label !== readyInfo.label) {
    readyInfo = next
    readyListeners.forEach(fn => {
      try { fn() } catch { /* 单个监听者出错不影响其他 */ }
    })
  }
  return readyInfo
}

/** 订阅就绪状态变化；首次订阅时惰性加载一次配置 */
export function subscribeAIReady(fn: () => void): () => void {
  readyListeners.add(fn)
  if (!readyLoaded) void refreshAIReady()
  return () => { readyListeners.delete(fn) }
}
