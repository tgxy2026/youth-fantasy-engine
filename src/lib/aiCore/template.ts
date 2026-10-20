/**
 * AI 接入层 · 设定补全（2.8.0 从 `lib/ai.ts` 拆出，见 `lib/ai.ts` 顶部说明）。
 *
 * 职责：世界观上下文的组装、设定模板的一次性补全（`aiCompleteTemplate`）、
 * 以及供交互式补全（对话引导）用的结构化轮次（`aiChatJson`）。
 */

import * as db from '@/lib/db'
import { TABS } from '@/lib/schema'
import { resolveTemplateCached } from '@/lib/templates/cache'
import { loadFieldGating } from '@/lib/templates/labels'
import { parsePlainObject } from '@/lib/ai/aiParse'
import { chat } from '@/lib/aiCore/chat'
import { requireProviderFor } from '@/lib/ai/aiRouting'
import { composeSystemPrompt, CHAT_TIMEOUT_MS, type ChatMessage } from '@/lib/aiCore/core'
import { FILL_CONTEXT_SYS, type FillContext } from '@/lib/aiCore/prompts'

// ---- 设定模板 AI 补全 ----

export interface TemplateField {
  /** 内部字段 key（卡片/表单型为 `模块名::字段名`，表格型为列名） */
  key: string
  /** 展示名（中文） */
  label: string
  desc?: string
  example?: string
  /** 锁定字段：不发给模型、不随补全写入（如自动编号），仅在预览中展示 */
  locked?: boolean
}

export interface TemplateFillResult {
  /** key -> 模型补全的值（仅非锁定、且模型实际产出的字段） */
  values: Record<string, string>
  /** 由 AI 补全的字段 key 列表（前端高亮「AI补全」徽标用） */
  aiFilled: string[]
}

/**
 * 世界观上下文的**可挑选分组**（2026-10-03）。
 *
 * 起因：对话引导模式原先**完全不带**母级设定（作者无感知，AI 会把母设定忘掉）；
 * 而一次性全灌又会把作者的脑子一次掏空。折中做法＝**列成清单让作者自己勾**。
 * 🔴 字段名是硬编码白名单：**schema 改字段名这里会静默取空**（新增字段请一并加进来）。
 */
export interface WorldContextGroup {
  key: string
  label: string
  /** 面板上的一行说明：让作者知道带过去的是什么 */
  hint: string
  tabId: 'worldbase' | 'power' | 'positioning'
  names: string[]
}

export const WORLD_CONTEXT_GROUPS: WorldContextGroup[] = [
  {
    key: 'worldbase', label: '世界设定（母级）', tabId: 'worldbase',
    hint: '世界名称 / 一句话世界观 / 文明程度 / 时代背景 / 世界核心规则',
    names: ['世界名称', '一句话世界观', '文明程度', '当前时代背景', '世界核心规则'],
  },
  {
    key: 'power', label: '力量体系（母级）', tabId: 'power',
    hint: '体系名称 / 体系类型 / 力量来源与路线 / 力量的限制规则',
    names: ['体系名称', '体系类型', '力量来源与路线', '力量的限制规则'],
  },
  {
    key: 'positioning', label: '作品信息', tabId: 'positioning',
    hint: '书名 / 类型赛道 / 核心卖点 / 一句话简介',
    names: ['书名', '类型赛道', '核心卖点', '一句话简介'],
  },
]

/**
 * 构建世界观上下文摘要，供补全时保证一致性。
 * v1：抽取表单型「世界设定 / 力量体系 / 作品信息」的关键字段，作为模型补全的约束。
 *
 * @param onlyKeys 只取这些分组；**不传 = 全取**（保持「一次成稿」的既有行为不变）。
 *
 * 🔴 3.2.0：字段的**显示名**统一从 `loadFieldLabels` 取（采用模板 > 别名 > schema 原名），
 *    不再一律用白名单里的字面名。理由（方案 §3.10.3 / §3.12）：
 *    「一对一字段、含义不变的改名，AI 应使用**当前名称**」—— 作者把「世界名称」改名成
 *    「世界称呼」之后，喂给模型的还是旧名，模型就会按旧名理解和回填。
 *    🔴 存储键**一个字节都不动**：`f.sourceKey` 仍是 `模块::字段名`，取值路径不变。
 *    🔴 模板里找不到该字段（schema 改过名 / 历史脏键）⇒ **退回原来的全表扫描**，
 *      宁可名字难听，也不能把作者已经填好的内容丢掉。
 */
export async function buildWorldContext(onlyKeys?: string[]): Promise<string> {
  /**
   * 表单页签的字段（存储键 + 当前显示名；含义未确认的字段**不在清单里**）。
   * `blocked` 是同一批字段的**字段名**（`模块::字段` 的最后一段）——`pick` 的兜底扫描
   * 按字段名找值时，必须知道哪些名字此刻不能发。
   */
  const fieldsOf = async (tabId: string): Promise<{
    fields: { key: string; label: string }[]
    blocked: Set<string>
  }> => {
    const tab = TABS.find(t => t.id === tabId)
    if (!tab) return { fields: [], blocked: new Set() }
    // 3.2.0 · T3：显示名统一走 `loadFieldGating`（采用模板 > 别名 > schema 原名），
    // 读失败返回空表 ⇒ 退回模板原名。存储键不变（取值仍用 `f.sourceKey`）。
    const { labels, pending } = await loadFieldGating(tab)
    const tpl = resolveTemplateCached(tab)
    const blocked = new Set<string>()
    for (const k of pending) blocked.add(k.slice(k.lastIndexOf('::') + 2))
    return {
      fields: tpl.fields
        .filter(f => !pending.has(f.sourceKey))
        .map(f => ({ key: f.sourceKey, label: labels[f.sourceKey] ?? f.label })),
      blocked,
    }
  }
  const pick = (
    data: Record<string, string> | undefined,
    names: string[],
    fields: { key: string; label: string }[],
    blocked: ReadonlySet<string>,
  ): string[] => {
    if (!data) return []
    /** 老式扫描：任何 `模块::字段名` 或纯字段名都算（题材包换过、历史数据模块名不同时靠它兜底） */
    const scan = (n: string): string => {
      const hit = Object.entries(data)
        .map(([k, val]) => (k.endsWith(`::${n}`) || k === n ? val : ''))
        .find(Boolean)
      return (hit ?? '').trim()
    }
    const out: string[] = []
    for (const n of names) {
      // T3：含义未确认的字段（含兜底扫描能扫到的旧键）一律不发送
      if (blocked.has(n)) continue
      const f = fields.find(x => x.key === n || x.key.endsWith(`::${n}`))
      // 🔴 先按模板的真实存储键取，取不到再退回全表扫描 ——
      //    只认模板键是不够的：题材包换过之后，老数据的模块前缀可能与当前 schema 不同，
      //    那时 `data[f.key]` 是空的而值其实还在（本轮实机测试抓到的丢值 bug）。
      const v = (f ? (data[f.key] ?? data[n] ?? '').trim() : '') || scan(n)
      if (v) out.push(`${f ? f.label : n}：${v}`)
    }
    return out
  }
  const groups = onlyKeys?.length
    ? WORLD_CONTEXT_GROUPS.filter(g => onlyKeys.includes(g.key))
    : WORLD_CONTEXT_GROUPS
  const need = new Set(groups.map(g => g.tabId))
  const [world, power, pos] = await Promise.all([
    need.has('worldbase') ? db.getFormData('worldbase').catch(() => undefined) : Promise.resolve(undefined),
    need.has('power') ? db.getFormData('power').catch(() => undefined) : Promise.resolve(undefined),
    need.has('positioning') ? db.getFormData('positioning').catch(() => undefined) : Promise.resolve(undefined),
  ])
  const byTab: Record<string, Record<string, string> | undefined> = { worldbase: world, power, positioning: pos }
  const [fWorld, fPower, fPos] = await Promise.all([
    need.has('worldbase') ? fieldsOf('worldbase') : Promise.resolve({ fields: [], blocked: new Set<string>() }),
    need.has('power') ? fieldsOf('power') : Promise.resolve({ fields: [], blocked: new Set<string>() }),
    need.has('positioning') ? fieldsOf('positioning') : Promise.resolve({ fields: [], blocked: new Set<string>() }),
  ])
  const fieldsByTab: Record<string, { fields: { key: string; label: string }[]; blocked: Set<string> }> = {
    worldbase: fWorld, power: fPower, positioning: fPos,
  }
  const lines: string[] = []
  for (const g of groups) {
    const info = fieldsByTab[g.tabId]
    lines.push(...pick(byTab[g.tabId], g.names, info?.fields ?? [], info?.blocked ?? new Set()))
  }
  return lines.join('\n')
}

/**
 * 设定模板补全：把字段清单 + 草图（+ 可选的世界观上下文与外部素材）发给当前 AI 模型，
 * 返回结构化结果。内部自取当前模型配置（loadProviders + loadActiveId），调用方无需关心 provider。
 *
 * 外部素材＝联网检索结果或作者粘贴的参考（见 `draftMaterial.ts`）。它单独成块而不是并进
 * 「世界观上下文」：一个是**本项目已有的设定**，一个是**外面查来的资料**，冲突时该听谁不一样。
 */
export async function aiCompleteTemplate(
  fields: TemplateField[],
  sketch: string,
  opts: {
    worldContext?: string
    /** 外部素材（联网检索结果 / 作者粘贴的参考，已拼好的块）—— 有就优先依据它 */
    material?: string
    /** 补全语境（决定发哪条系统提示词；缺省 `'template'` ＝ 通用设定补全） */
    context?: FillContext
    onToken?: (delta: string) => void
  } = {},
): Promise<TemplateFillResult> {
  const cfg = await requireProviderFor('create')
  const send = fields.filter(f => !f.locked)

  const fieldList = send
    .map((f, i) => {
      const bits = [`${i + 1}. [${f.label}]`]
      if (f.desc) bits.push(`说明：${f.desc}`)
      if (f.example) bits.push(`示例：${f.example}`)
      return bits.join(' ')
    })
    .join('\n')

  // 🔴 按语境取（2026-10-03）：大纲规划三页签各有一条自己的提示词；缺省仍是通用那条。
  const sys = FILL_CONTEXT_SYS[opts.context ?? 'template']()

  const user = `【字段清单】
${fieldList}

【世界观上下文】
${opts.worldContext && opts.worldContext.trim() ? opts.worldContext.trim() : '（无）'}

【外部素材】
${opts.material && opts.material.trim() ? opts.material.trim() : '（无）'}

【作者草图】
${sketch && sketch.trim() ? sketch.trim() : '（作者未提供草图，请基于世界观上下文合理补全一份）'}

请返回补全后的 JSON（只输出这一个对象，不要解释、不要 Markdown 代码块标记）。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    // 🔴 这是结构化任务（下面走 parseTemplateJSON）—— 必须传 `json: true`，
    //    否则按创意档 0.85 采样，模型会自由发挥、JSON 更容易跑偏/夹带解释。
    //    历史（2026-09-14 审计）已犯过一次同类"漏传低温"，别复发。
    { timeoutMs: CHAT_TIMEOUT_MS, onToken: opts.onToken, output: 'json-object', reasoning: 'off' },
  )

  const parsed = parseTemplateJSON(text, send)
  const values: Record<string, string> = {}
  const aiFilled: string[] = []
  parsed.forEach((val, i) => {
    const key = send[i].key
    const v = (val ?? '').trim()
    if (v) { values[key] = v; aiFilled.push(key) }
  })
  return { values, aiFilled }
}

/**
 * 用**当前活动模型**发一轮「结构化输出」请求（JSON 模式 + 低温度 + 不要思考过程）。
 *
 * 供「对话引导」这类**交互式**补全用：一轮一轮地聊，每轮都要解析 JSON。
 * 有它，界面就不必自己解析模型配置（那件事只有这里该做），也不会各自漏掉 `think:false`
 * —— 漏了的话思考型模型每轮都把推理过程吐出来，JSON 解析直接失败。
 */
export async function aiChatJson(
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const cfg = await requireProviderFor('create')
  return chat(cfg, messages, {
    timeoutMs: opts.timeoutMs ?? CHAT_TIMEOUT_MS,
    signal: opts.signal,
    output: 'json-object', reasoning: 'off',
    think: false,
  })
}

/** 从模型回复中解析出按编号索引的值数组（剥代码块 / 切最外层统一走 aiParse） */
function parseTemplateJSON(raw: string, fields: TemplateField[]): string[] {
  const obj = parsePlainObject(raw) ?? {}
  const out: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const v = obj[String(i + 1)] ?? obj[i + 1] ?? ''
    out.push(typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
  }
  return out
}
