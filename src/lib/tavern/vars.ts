/**
 * 酒馆模式 · 变量（C2 第二步：变量 + AI 输出增量）
 *
 * 定位：C2 第一步把「关系状态」这类**文本**摊在状态栏上（只读）；第二步让它们**会动**。
 *
 * 三条设计原则（老大 2026-09-14 定）：
 *   ① 变量＝内置 5 项，作者只能**逐项开关**，不开放自定义 —— 变量要进提示词，
 *      自定义数值没有语义（模型不知道「金钱 320」意味着什么），等于让作者去写协议。
 *   ② 每 N 轮（默认 3）才**请求**一次增量：省输出额度，也让变化看起来像「真的在走」
 *      （每轮都动反而像随机数）。
 *   ③ AI 给增量、作者可手改可重置 —— 模型算错时作者能立刻纠正，而不是干看着。
 *
 * 🔴 解析必须**严格到宁可不认**：格式没对上就把那一行原样留在正文里。
 *    变量是锦上添花，正文是命根子 —— 绝不能因为解析器没看懂就把作者要读的字吃掉。
 *
 * 【为什么不进协议常量】
 * 变量是**可开关**的（关掉就该一个字都不出现），而协议是固定常量、且两个模式共用 ——
 * 规则挂在自由模式的「模式补充」层（`modeExtra`，仍排在协议之前、离生成点很近）。
 * 顺带满足项目那条「空层不占额度」：关掉开关时它连层头都不加。
 */
import {
  VAR_DEFS, varDefOf,
  type VarKey, type VarOp, type VarValues, type VarChange, type TavernVars,
  type VarSource, type FreeSession,
} from './types'

/** 输出侧标记 —— 只在这一行上认变量，正文里出现同样字样也不动（见 parseVarLine 的严格规则） */
export const VAR_LINE_TAG = '〔数值〕'

/** 变动历史保留条数（状态栏回看用） */
export const VAR_LOG_KEEP = 50

// ==================== 解析 ====================

export type VarParseResult = {
  /** 剥掉数值行之后的正文（认不出时**原样返回**） */
  text: string
  ops: VarOp[]
  /** 命中的那一行原文（给日志/调试看） */
  rawLine: string
}

function clampStep(n: number, maxStep: number): number {
  if (!Number.isFinite(n)) return 0
  const m = Math.abs(maxStep)
  return Math.max(-m, Math.min(m, n))
}

function parseOps(body: string, allow: Set<VarKey>): VarOp[] {
  const ops: VarOp[] = []
  for (const item of body.split(/[；;]/)) {
    const seg = item.trim()
    if (!seg) continue
    // 「无变化」是协议里允许的"这一轮没什么可记"的写法 → 不产生任何操作（但整行仍会被剥掉）
    if (/^(无变化|无|不变|no change)$/i.test(seg)) continue

    const def = VAR_DEFS.find(d => allow.has(d.key) && (seg.startsWith(d.label) || seg.startsWith(d.key)))
    if (!def) continue
    const marker = seg.startsWith(def.label) ? def.label : def.key
    let rest = seg.slice(marker.length).trim().replace(/^[：:=＝]\s*/, '')
    if (!rest) continue

    if (def.kind === 'num') {
      if (/^[+＋]\s*\d+$/.test(rest)) {
        ops.push({ key: def.key, label: def.label, kind: 'delta', num: Number(rest.replace(/\D/g, '')) })
      } else if (/^[-－−]\s*\d+$/.test(rest)) {
        ops.push({ key: def.key, label: def.label, kind: 'delta', num: -Number(rest.replace(/\D/g, '')) })
      } else if (/^\d+$/.test(rest)) {
        ops.push({ key: def.key, label: def.label, kind: 'set', num: Number(rest) })
      }
      continue
    }

    // 文本变量：去掉可能带的引号/书名号，长度截到上限
    const text = rest.replace(/^[「『“"']|[」』”"']$/g, '').trim()
    if (text) {
      ops.push({ key: def.key, label: def.label, kind: 'text', text })
    }
  }
  return ops
}

/**
 * 从回复里解析数值行（**只看最后一个非空行**）。
 *
 * 四道闸（缺一不可，都是为了"宁可不认"）：
 *   ① 只认最后一个非空行 —— 正文中间出现同样字样一律不管；
 *   ② 必须以 `〔数值〕` 开头；
 *   ③ 每项必须是**白名单变量**（按中文名或英文键认）；
 *   ④ 数值必须带符号（±N）或直接赋值（N），认不出的项直接丢。
 * 解析出 0 个操作 → **连那一行都不剥**（说明它根本不是数值行，或格式没对上）。
 */
export function parseVarLine(reply: string, keys?: VarKey[]): VarParseResult {
  const src = String(reply ?? '')
  const lines = src.split('\n')
  let idx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) { idx = i; break }
  }
  if (idx < 0) return { text: src, ops: [], rawLine: '' }

  const line = lines[idx].trim()
  if (!line.startsWith(VAR_LINE_TAG)) return { text: src, ops: [], rawLine: '' }

  const body = line.slice(VAR_LINE_TAG.length).trim()
  // 「〔数值〕无变化」是协议允许的写法（这一轮没什么可记）→ 认得出，**把行剥掉**，不产生操作。
  // 与"认不出"区别对待：认不出时一个字都不动，免得吃掉正文。
  const isNoChange = /^(无变化|无|不变|no change)$/i.test(body)
  const allow = new Set<VarKey>(keys && keys.length ? keys : VAR_DEFS.map(d => d.key))
  const ops = isNoChange ? [] : parseOps(body, allow)
  if (!isNoChange && ops.length === 0) return { text: src, ops: [], rawLine: line }

  const kept = [...lines.slice(0, idx), ...lines.slice(idx + 1)]
  return { text: kept.join('\n').replace(/\s+$/, ''), ops, rawLine: line }
}

// ==================== 应用 ====================

function clampNum(n: number, min = 0, max = 100): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.round(n)))
}

/** 把操作应用到当前值：单步幅度夹取 + 范围夹取；没有实际变化就不记一笔 */
export function applyVarOps(
  values: VarValues,
  ops: VarOp[],
  opts: { maxStep?: number } = {},
): { values: VarValues; changes: VarChange[] } {
  const maxStep = opts.maxStep ?? 5
  const next: VarValues = { ...values }
  const changes: VarChange[] = []

  for (const op of ops) {
    const def = varDefOf(op.key)
    if (!def) continue

    if (op.kind === 'text') {
      // 截断只在**这一个写入关口**做（解析侧不再各截一次，免得两处规则漂移）
      const to = op.text.slice(0, def.maxLen ?? 12)
      const from = String(next[op.key] ?? '')
      if (from === to) continue
      next[op.key] = to
      changes.push({ key: op.key, label: def.label, from, to })
      continue
    }

    const cur = clampNum(Number(next[op.key] ?? def.init), def.min, def.max)
    const target = op.kind === 'set' ? op.num : cur + clampStep(op.num, maxStep)
    const to = clampNum(target, def.min, def.max)
    if (to === cur) continue
    next[op.key] = to
    changes.push({ key: op.key, label: def.label, from: cur, to, delta: to - cur })
  }

  return { values: next, changes }
}

// ==================== 会话上的变量块 ====================

/** 空变量块：以各变量的初始值为起点（作者可以在状态栏上改） */
export function emptyVars(keys?: VarKey[]): TavernVars {
  const allow = keys && keys.length ? new Set(keys) : null
  const values: VarValues = {}
  for (const d of VAR_DEFS) {
    if (!allow || allow.has(d.key)) values[d.key] = d.init
  }
  return { values, turnSeq: 0, log: [] }
}

/**
 * 把这一轮的变化记进变量块。
 *
 * source='ai' 会留下一份"前值"供**重说**撤销；
 * source='manual'（作者手改）**刻意不留** —— 作者的手是最终裁决，
 * 否则"手改 30 → 点重说"会把数值翻回模型算错的那个值（作者会以为软件在跟他捣乱）。
 */
export function recordVarChanges(
  vars: TavernVars,
  changes: VarChange[],
  turnSeq: number,
  source: VarSource = 'ai',
): TavernVars {
  if (changes.length === 0) return vars
  const log = [...(vars.log ?? []), { at: Date.now(), changes, source, turnSeq }].slice(-VAR_LOG_KEEP)
  if (source === 'manual') {
    return { ...vars, values: { ...vars.values }, prev: undefined, log }
  }
  const prev: VarValues = {}
  for (const c of changes) prev[c.key] = c.from
  return { ...vars, values: { ...vars.values }, turnSeq, prev: { values: prev, at: Date.now() }, log }
}

/** 重说时撤销上一次变化（把被改过的键还原成前值） */
export function undoLastVarChanges(vars: TavernVars | undefined): TavernVars | undefined {
  if (!vars?.prev) return vars
  const back: VarValues = { ...vars.values }
  for (const [k, v] of Object.entries(vars.prev.values)) back[k as VarKey] = v as VarValues[VarKey]
  const log = (vars.log ?? []).slice(0, -1)
  return { ...vars, values: back, prev: undefined, log }
}

/** 这一轮该不该**请求**模型给增量（每 N 轮一次；N ≤ 1 或没设＝每轮） */
export function shouldAskVars(turnSeq: number, everyTurns: number): boolean {
  const n = Math.max(1, Math.floor(everyTurns || 1))
  return n <= 1 || turnSeq % n === 0
}

/** 数到第几轮（已产出的 AI 回复数 + 1）——「每 N 轮」按这个算 */
export function turnSeqOf(messages: { role: string }[]): number {
  return messages.filter(m => m.role === 'assistant').length + 1
}

/** 只把**启用中**且算得出值的变量渲染成一行（给状态栏/提示词共用） */
export function renderVarValues(values: VarValues | undefined, keys?: VarKey[]): string {
  if (!values) return ''
  const allow = keys && keys.length ? new Set(keys) : null
  return VAR_DEFS
    .filter(d => !allow || allow.has(d.key))
    .map(d => {
      const v = values[d.key]
      if (v === undefined || v === '') return ''
      return `${d.label} ${v}`
    })
    .filter(Boolean)
    .join(' · ')
}

/**
 * 组装自由模式的变量块（进 `modeExtra`）。
 *
 * 三种形态：
 *   · 该请求增量（每 N 轮）→ 当前值 + 明确要求"最后一行输出〔数值〕"
 *   · 不该请求 → **只给当前值**，不提数值格式（省额度、也避免模型每轮都吐一行）
 *   · **场景锚**（2026-09-15 起）：不论该不该请求增量，「当前地点」都在末尾多带一句 ——
 *     地点一旦记错，整场戏的场景就会瞬移（实弹：宿舍楼道一步跨到食堂，只补了句（食堂很吵））。
 *     它是唯一不跟「每 N 轮」走的变量。
 *
 * 🔴 **返回值由调用方挂在 system 的「协议之后」（prompt.ts 的 tail 层）** ——
 *    这条记账要求属于**任务型指令**，放在协议之前会被格式规范压掉（实测 6/6 轮不执行），
 *    所以它自己必须补一句「其余照协议」来划清边界（见函数末尾那句）。
 */
export function buildVarsBlock(a: {
  values: VarValues | undefined
  keys: VarKey[]
  /** 该不该请求这一轮的增量 */
  ask: boolean
  everyTurns: number
  maxStep: number
  /** 这一场的剧本目标（有就带上，进度才有锚） */
  goal?: string
}): string {
  const keys = a.keys.filter(k => VAR_DEFS.some(d => d.key === k))
  if (keys.length === 0) return ''
  const now = renderVarValues(a.values, keys)
  /**
   * 这一轮要它写什么记账行。**这几句必须是整块的最后一句话** ——
   * ⚠️ 曾把「其余照协议」那句排到它们后面，结果模型末读到的是「照协议」，
   *    第 1 轮的地点就没落下来（2026-09-15 探针实测）。
   */
  const demands: string[] = []
  if (a.ask) {
    const range = keys
      .map(k => { const d = varDefOf(k)!; return d.kind === 'num' ? `${d.label}（${d.min}–${d.max}）` : `${d.label}（≤${d.maxLen} 字）` })
      .join(' / ')
    demands.push(
      `规则：这一轮**必须**在回复的**最后一行**单独写一行 —— ${VAR_LINE_TAG}好感 +2；心情 微妙的动摇`,
      `（可用项：${range}。数值写 ±N 或直接写新值；单次变化不超过 ±${a.maxStep}，越界会按边界取。这一轮真的没什么可记，也必须写「${VAR_LINE_TAG}无变化」。）`,
      `这一行只用于记账、不会展示给用户，所以别把它写进对白里；除了它，其余内容照协议的输出规范。`,
    )
  }
  // 场景锚：地点**不跟「每 N 轮」走** —— 它一错，整场戏的场景就会瞬移。
  // 所以哪怕这一轮不该请求增量，也单独给它一句极短的提示（其余数值仍按 everyTurns 走，省额度）。
  if (!a.ask && keys.includes('place')) {
    const placeLabel = varDefOf('place')!.label
    const cur = String(a.values?.place ?? '').trim()
    demands.push(cur
      ? `若这一轮地点有变，在**最后一行**补：${VAR_LINE_TAG}${placeLabel} XXX`
      : `地点还没记下来 —— 请在**这一轮的最后一行**单独写一行：${VAR_LINE_TAG}${placeLabel} XXX（你此刻所在的具体位置，10 字内；这一行用户看不到）`)
  }

  const lines: string[] = ['〖本场数值〗']
  if (now) lines.push(`现在的值：${now}`)
  if (a.goal?.trim()) lines.push(`这一场的目标：${a.goal.trim()}`)
  if (demands.length) {
    // 🔴 边界声明排在**要求之前**：这一块挂在协议之后，得先说清「除了记账行都照协议」，
    //    但它绝不能排在最后 —— 否则模型末读到的是「照协议」，反而把记账行挤掉。
    lines.push('（除下面要求的记账行之外，其余内容一律照上面的协议写：对白纯文本，其余全部用（ ）包住。）')
    lines.push(...demands)
  }
  return lines.join('\n')
}

/** 会话上的变量块（没有就按初始值造一个，但**不落库** —— 由调用方决定何时写回） */
export function varsOf(session: FreeSession | null | undefined, keys?: VarKey[]): TavernVars {
  return session?.vars ?? emptyVars(keys)
}

// ==================== 作者手改 ====================

/**
 * 作者手改一个变量。
 *
 * 与模型增量走**同一个写入关口**（`applyVarOps`），所以夹取、去重、变更记录只有一套规则 ——
 * 唯二的区别：① 数值是**直接赋值**（`kind:'set'`），不受"单步 ±maxStep"限制（那是给模型用的刹车）；
 * ② 变更来源标记成 manual（见 `recordVarChanges`）。
 * 认不出的输入（空、非数）**原样不动**，而不是当成 0 —— 误把好感清零比不改更坏。
 */
export function setVarManually(
  values: VarValues,
  key: VarKey,
  raw: string,
): { values: VarValues; changes: VarChange[] } {
  const def = varDefOf(key)
  if (!def) return { values, changes: [] }
  if (def.kind === 'num') {
    const n = Number(String(raw).trim())
    if (!Number.isFinite(n)) return { values, changes: [] }
    return applyVarOps(values, [{ key, label: def.label, kind: 'set', num: n }])
  }
  return applyVarOps(values, [{ key, label: def.label, kind: 'text', text: String(raw) }])
}

/** 把（启用的）变量全部恢复成初始值。返回变更列表（空 = 本来就在初始值） */
export function resetVarValues(values: VarValues | undefined, keys: VarKey[]): { values: VarValues; changes: VarChange[] } {
  const ops: VarOp[] = []
  for (const key of keys) {
    const def = varDefOf(key)
    if (!def) continue
    if (def.kind === 'num') ops.push({ key, label: def.label, kind: 'set', num: def.init as number })
    else ops.push({ key, label: def.label, kind: 'text', text: String(def.init ?? '') })
  }
  return applyVarOps(values ?? {}, ops)
}

/** 某个变量最近一次变化的差量文案（状态栏显示用；没有就返回空串） */
export function lastChangeText(vars: TavernVars | undefined, key: VarKey): string {
  const last = [...(vars?.log ?? [])].reverse().find(e => e.changes.some(c => c.key === key))
  if (!last) return ''
  const c = last.changes.find(x => x.key === key)!
  if (c.delta !== undefined) return `${c.delta > 0 ? '+' : ''}${c.delta}`
  return c.from ? `${String(c.from)} → ${String(c.to)}` : '已填写'
}
