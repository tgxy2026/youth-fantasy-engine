/**
 * AI 提示词的「前台设置」底座（2026-09-19）
 *
 * 【要解决的问题】项目里的 AI 提示词散在各个 lib 里，硬编码在代码里 ——
 * 作者想微调一句语气、加一条禁忌，只能改源码重打包。本模块把它们集中登记，
 * 让「模型设置 → AI 提示词」能列出、修改、保存、一键还原。
 *
 * 【设计要点】
 * 1. **默认值仍住在原文件**（就地声明 `let X = \`…默认…\``），这里只登记
 *    「读它 / 写它」的访问器 —— 不把提示词正文搬到一个中心文件里，
 *    否则「提示词 ↔ 用法」被打散，改代码时要满仓库找。
 * 2. 覆写存在**全局 meta**（`ai.promptOverrides`）：提示词是应用级设定，
 *    换项目照样在（与「模型配置」同一层级）。
 * 3. 生效方式：启动时把覆写**写回**原模块的变量（`applyPromptOverrides`），
 *    所以调用点一行都不用改 —— 它读到的永远是"当前生效文本"。
 *    ⚠️ 因此被登记的提示词必须是模块级 `let`（函数内的局部常量改不了）。
 * 4. 取走即用：`promptText(id, fallback)` 给「函数内一次性提示词」用 ——
 *    没有覆写时返回 fallback，省得为它单独 declare 一个模块级变量。
 */
import * as db from './db'

/** 提示词按「功能板块」分组，顺序即界面上从上到下的顺序 */
export type PromptGroup =
  | '正文写作'
  | '编辑与审校'
  | '设定与资料'
  | '项目诊断'
  | '灵感工具'
  | '酒馆模式'
  | '其它'

export interface PromptMeta {
  /** 稳定 id（存覆写用，**改名等于丢设置**，只在提示词被删除时才动） */
  id: string
  group: PromptGroup
  /** 界面上显示的名字（说人话，别用变量名） */
  name: string
  /** 一句话说明这条提示词管什么（可选） */
  note?: string
}

export interface PromptEntry extends PromptMeta {
  /** 出厂默认文本 */
  defaultText: string
  /** 当前生效文本（可能被作者改过） */
  text: string
  /** 是否已被作者改过 */
  overridden: boolean
}

const GROUPS: PromptGroup[] = ['正文写作', '编辑与审校', '设定与资料', '项目诊断', '灵感工具', '酒馆模式', '其它']

/**
 * 一条可注册提示词的「三件套」。
 *
 * 为什么要有这个类型：`registerPrompt` 是**三参数**调用，而拆分后一个域模块里往往有多条提示词，
 * 门面无法逐个写死调用（那会把域模块的内部变量名泄漏到门面）。于是约定：
 * **每个域模块导出一个 `PromptDef[]`，门面按 `PROMPT_ORDER` 逐条注册**。
 *
 * ⚠️ `read` / `write` 必须直接闭包**本模块的 `let` 变量** —— 这样 setter 与变量同模块，
 * 既满足「默认值就地声明」的架构原则，也避开了 ESM「不能给 import 进来的绑定赋值」（TS2632）。
 */
export interface PromptDef {
  meta: PromptMeta
  read: () => string
  write: (t: string) => void
}

interface Registered {
  meta: PromptMeta
  /** 读当前生效文本（从原模块的变量读，保证与真实调用一致） */
  read: () => string
  /** 写回原模块的变量 */
  write: (t: string) => void
  /** 出厂默认（登记那一刻的快照） */
  defaultText: string
}

const registry = new Map<string, Registered>()
let overrides: Record<string, string> = {}

/**
 * 登记一条可编辑提示词。
 * ⚠️ 必须在**模块顶层**调用（模块被 import 时执行），否则界面上看不到它。
 * 默认值取登记瞬间的 read() —— 所以 `loadPromptOverrides()` 必须在所有模块
 * 完成登记**之后**再 apply，否则会把覆写当成默认值快照下来。
 */
export function registerPrompt(meta: PromptMeta, read: () => string, write: (t: string) => void): void {
  if (registry.has(meta.id)) {
    // 重复登记是写错了 id（会互相覆盖），开发期直接报出来
    console.warn(`[promptSettings] 提示词 id 重复登记：${meta.id}`)
    return
  }
  registry.set(meta.id, { meta, read, write, defaultText: read() })
}

/** 一次性提示词：有覆写用覆写，没有就用调用方给的 fallback（不登记进界面） */
export function promptText(id: string, fallback: string): string {
  return overrides[id] ?? fallback
}

/** 全部已登记提示词（按板块分组顺序 + 登记顺序） */
export function listPrompts(): PromptEntry[] {
  const all = [...registry.values()]
  all.sort((a, b) => GROUPS.indexOf(a.meta.group) - GROUPS.indexOf(b.meta.group))
  return all.map(r => ({
    ...r.meta,
    defaultText: r.defaultText,
    text: r.read(),
    overridden: Object.prototype.hasOwnProperty.call(overrides, r.meta.id),
  }))
}

/** 界面上用得到的分组顺序 */
export const PROMPT_GROUPS = GROUPS

const META_KEY = 'ai.promptOverrides'

/** 启动时读一次覆写表（App 的 boot 里调，早于首屏 AI 调用） */
export async function loadPromptOverrides(): Promise<void> {
  overrides = await db.getMeta<Record<string, string>>(META_KEY, {})
  applyPromptOverrides()
}

/** 把覆写写回各模块的变量（登记过的、且确有覆写的） */
function applyPromptOverrides(): void {
  for (const [id, text] of Object.entries(overrides)) {
    const r = registry.get(id)
    if (r && typeof text === 'string') r.write(text)
  }
}

/** 保存一条覆写（立即生效，不必重启） */
export async function savePromptOverride(id: string, text: string): Promise<void> {
  const r = registry.get(id)
  if (!r) throw new Error(`未知的提示词：${id}`)
  const trimmed = text.trim()
  if (!trimmed) throw new Error('提示词不能为空')
  // 与默认值相同就不必存覆写（免得多一条永远和默认一样的脏数据）
  if (trimmed === r.defaultText.trim()) {
    delete overrides[id]
    r.write(r.defaultText)
  } else {
    overrides[id] = text
    r.write(text)
  }
  await db.setMeta(META_KEY, overrides)
}

/** 一键还原出厂设置（只影响这一条） */
export async function resetPromptOverride(id: string): Promise<void> {
  const r = registry.get(id)
  if (!r) throw new Error(`未知的提示词：${id}`)
  delete overrides[id]
  r.write(r.defaultText)
  await db.setMeta(META_KEY, overrides)
}

/** 全部还原（界面上给一个「全部还原」总开关用） */
export async function resetAllPromptOverrides(): Promise<void> {
  for (const id of Object.keys(overrides)) {
    const r = registry.get(id)
    if (r) r.write(r.defaultText)
  }
  overrides = {}
  await db.setMeta(META_KEY, overrides)
}
