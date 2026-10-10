/**
 * 酒馆模式 · 变量（C2 第二步）
 *
 * 定位：把「关系状态」这类**文本**摊在状态栏上（只读），再让它们**会动**。
 *
 * 三条设计原则：
 *   ① 变量＝内置 5 项，作者只能**逐项开关**，不开放自定义 —— 变量要进提示词，
 *      自定义数值没有语义（模型不知道「金钱 320」意味着什么），等于让作者去写协议。
 *   ② 🔴 **每轮回复后自动刷新**（2026-09-16 老大反馈 #4 —— 推翻 2026-09-15 的旧决策）：
 *      每轮 AI 回复落库后**单跑一次小调用**（`extractSessionVars`）算这一轮的增量，
 *      写在 `runFreeTurn` 末尾（另：收尾 `runRoundEnd` 仍会兜底再算一次，补最后几条）。
 *      表现就是五项状态随对话起伏，而不是「聊完点结束才突然变一次」。
 *      ⚠️ **不要**改成「把记账要求折进主回复末尾」：它要跟 3.5KB 的格式协议抢注意力，
 *      实测遵守率极低（真模型探针 6/6 轮不吐，三次跑分别 1/6、0/6、0/6）。
 *      单开一次「只干这一件事」的小调用，模型反而做得干净 —— 这是 D3 拍板的方案。
 *   ③ AI 给增量、作者可手改可重置 —— 模型算错时作者能立刻纠正，而不是干看着。
 *
 * 📐 数值刻度（2026-09-16 老大定）：三项数值均为 **−100 ~ +100、默认 0**（旧为 0–100、默认 50）。
 *    0 是中立起点：往下是反感/不信任/精神混乱，往上是亲近/信赖/精神清明。
 *    每一项都划了**档位**（`types.VAR_BANDS`），档位会进抽取提示词 —— 让模型知道
 *    「现在落在哪一档、这一轮该往哪走、落在这一档该有什么表现」。
 *
 * 🔴 当前值仍**每轮注入 system**（`buildVarStateBlock`，挂在 protocol 之后的 tail 层）：
 *    地点一错整场戏就会瞬移（实测：从宿舍楼道一步跨到食堂，只补了句（食堂很吵））。
 *
 * 🔴 解析必须**严格到宁可不认**：格式没对上就把那一行原样留在正文里。
 *    变量是锦上添花，正文是命根子 —— 绝不能因为解析器没看懂就把作者要读的字吃掉。
 */
import {
  VAR_DEFS, bandsOf, bandOf, varDefOf,
  type VarKey, type VarOp, type VarValues, type VarChange, type TavernVars,
  type VarSource, type FreeSession, type CharVars,
} from '@/lib/tavern/types'
import { authorBlock, newAuthorFence } from '@/lib/promptGuard'

/** 抽取侧的标记：提示词要求模型只输出以它开头的一行，解析器也只认它 */
export const VAR_LINE_TAG = '〔数值〕'

/** 抽取侧的备注标记：模型可另起一行以它开头，给出「变化项的备注」 */
export const VAR_NOTE_TAG = '〔备注〕'

/**
 * 从抽取回复里解出「变化项的备注」。
 *
 * 形如 `〔备注〕好感：从陌生到熟悉的朋友；信任：开始有了底气` —— 只认以 `VAR_NOTE_TAG`
 * 开头的一行，按「项名：一句话」切分。没有这一行（多数情况）返回空对象。
 * 备注是锦上添花，解析不出就当没给，绝不因此影响数值本身。
 */
export function parseVarNotes(text: string, keys?: VarKey[]): Partial<Record<VarKey, string>> {
  const allow = new Set<VarKey>(keys && keys.length ? keys : VAR_DEFS.map(d => d.key))
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line.startsWith(VAR_NOTE_TAG)) continue
    const body = line.slice(VAR_NOTE_TAG.length).trim()
    const out: Partial<Record<VarKey, string>> = {}
    for (const item of body.split(/[；;]/)) {
      const seg = item.trim()
      if (!seg) continue
      const def = VAR_DEFS.find(d => allow.has(d.key) && (seg.startsWith(d.label) || seg.startsWith(d.key)))
      if (!def) continue
      const marker = seg.startsWith(def.label) ? def.label : def.key
      let rest = seg.slice(marker.length).trim().replace(/^[：:=＝]\s*/, '')
      rest = rest.replace(/^["'「『"']|[」』"']$/g, '').trim()
      if (rest) out[def.key] = rest
    }
    return out
  }
  return {}
}

/** 变动历史保留条数（状态栏回看用） */
const VAR_LOG_KEEP = 50

// ==================== 解析 ====================


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

// ==================== 应用 ====================

/**
 * 夹取到变量自己的区间。
 * ⚠️ 默认值只是兜底 —— 上面 `applyVarOps` 永远会显式传 `def.min/def.max`。
 *    2026-09-16 起数值是 **−100~+100**（不再是 0–100），这里的兜底也跟着改，
 *    免得哪天多一个调用方忘了传区间，就把负数统统夹成 0。
 */
function clampNum(n: number, min = -100, max = 100): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.round(n)))
}

/** 把操作应用到当前值：单步幅度夹取 + 范围夹取；没有实际变化就不记一笔 */
export function applyVarOps(
  values: VarValues,
  ops: VarOp[],
  opts: { maxStep?: number; pinned?: Iterable<VarKey> } = {},
): { values: VarValues; changes: VarChange[] } {
  const maxStep = opts.maxStep ?? 5
  const pinned = opts.pinned ? new Set(opts.pinned) : null
  const next: VarValues = { ...values }
  const changes: VarChange[] = []

  for (const op of ops) {
    const def = varDefOf(op.key)
    if (!def) continue

    // 作者刚手改过这一项 → 只收增量，不收绝对值（见 manualPinnedKeys）
    if (op.kind === 'set' && pinned?.has(op.key)) continue

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

/**
 * 当前刻度版本（写进 `TavernVars.scale`）。
 * `1` = 旧的 0–100 制；`2` = 当前的 −100~+100 制（好感/信任/精神默认 0）。
 */
export const VAR_SCALE = 2

/** 空变量块：以各变量的初始值为起点（作者可以在状态栏上改） */
export function emptyVars(keys?: VarKey[]): TavernVars {
  const allow = keys && keys.length ? new Set(keys) : null
  const values: VarValues = {}
  for (const d of VAR_DEFS) {
    if (!allow || allow.has(d.key)) values[d.key] = d.init
  }
  return { values, turnSeq: 0, log: [], scale: VAR_SCALE }
}

/**
 * 旧刻度（0–100 制）→ 新刻度（−100~+100 制）的一次性迁移（老大 2026-09-16 定，D2）。
 *
 * 【为什么是「归零」而不是「线性映射」】老大拍的板：**全部重置为 0**，不写映射。
 *   ① 测试期，本场数值本来就是会话级的一次性产物，不是要长期积累的资产；
 *   ② 更重要的：旧刻度里「50」到底该映射成什么，其实没有正确答案 ——
 *      旧手感是「一上来就 50 分」，新刻度里 0 才是中立起点，硬映射只会把老会话的手感弄得更怪。
 *   清清爽爽从 0 开始，比一个似是而非的换算更诚实。
 *
 * 【只重置数值项，文本项保留】心情与地点（mood / place）没有刻度可言，
 *   旧库里那两栏写的内容依然有效，没有理由连它们一起清掉。
 *
 * 【为什么要有这个函数而不是读取时顺手改】若只在内存里归零，库里还是旧值 ——
 *   每次打开会话都会再归零一遍，**作者手改的数值会被反复抹掉**。
 *   所以必须落库一次（调用方负责 `saveFreeSession`，见 `TavernFree.openSession`）。
 *
 * @returns 迁移后的会话；已经在新刻度上则**原样返回**（调用方据此跳过写库）。
 */
export function migrateVarScale(session: FreeSession): FreeSession {
  const v = session.vars
  if (!v || v.scale === VAR_SCALE) return session
  const values: VarValues = { ...v.values }
  for (const d of VAR_DEFS) if (d.kind === 'num') values[d.key] = d.init
  return {
    ...session,
    vars: {
      ...v,
      values,
      scale: VAR_SCALE,
      turnSeq: v.turnSeq ?? 0,
      // 变动记录**保留**：它是「上一场发生过什么」的历史，只是不再对应新刻度的数。
      // 删掉它等于把作者回看变动过程的入口一并拿掉，代价比留着大。
      log: v.log ?? [],
    },
  }
}

/**
 * 把一次变化记进变量块（AI 抽取与作者手改走**同一个写入关口**）。
 *
 * source 只影响日志里的来源标记 —— 手改同样是既成事实，不需要「撤回」语义，
 * 所以两者都直接改值。（旧版的「重说撤销」随「每轮记账」一起下线了：
 * 数值现在只在整理记忆时变，没有「跟着某一条回复一起撤」的对应关系。）
 */
/**
 * 作者最近一次手改过、且之后 AI 还没动过的键（审计 P2）。
 *
 * 【为什么要它】模型偶尔会用**绝对值**写法（`好感 80`）而不是增量（`好感 +3`）。
 * 作者刚手改成 20 的意思就是「我就要 20」，下一轮被一句 `好感 80` 盖回去，等于手改没生效。
 * 所以对这些键**只接受增量**，绝对值一律忽略（增量仍放行 —— 那是 AI 在正常微调）。
 *
 * log 是正序追加的（最近的在后），所以倒着看，每个键第一条命中的就是它最近一次变动。
 */
export function manualPinnedKeys(vars: TavernVars | undefined): VarKey[] {
  const last = new Map<VarKey, VarSource | undefined>()
  for (const e of [...(vars?.log ?? [])].reverse()) {
    for (const c of e.changes) if (!last.has(c.key)) last.set(c.key, e.source)
  }
  const out: VarKey[] = []
  for (const [k, src] of last) if (src === 'manual') out.push(k)
  return out
}

export function recordVarChanges(
  vars: TavernVars,
  changes: VarChange[],
  turnSeq: number,
  source: VarSource = 'ai',
): TavernVars {
  if (changes.length === 0) return vars
  const log = [...(vars.log ?? []), { at: Date.now(), changes, source, turnSeq }].slice(-VAR_LOG_KEEP)
  return { ...vars, values: { ...vars.values }, turnSeq, log }
}

/** 数到第几轮（已产出的 AI 回复数 + 1） */
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
 * 组装自由模式的「本场数值」块（由调用方挂在 system 的 tail 层 —— 协议之后）。
 *
 * **只给当前值，不含任何要求**：数值不靠模型每轮记账，而是整理记忆时统一算一次
 * （见 `buildVarExtractSystem` 与 summarize.ts 的 `extractSessionVars`）。
 *
 * 🔴 当前值必须每轮在上下文里 —— 「当前地点」错了，整场戏就会瞬移。
 */
export function buildVarStateBlock(a: {
  values: VarValues | undefined
  keys: VarKey[]
  /** 这一场的剧本目标（有就带上，进度才有锚） */
  goal?: string
  /** 各项数值的备注（角色卡持久保存）：随当前值一起进上下文，让模型知道「这个分背后是什么」 */
  notes?: Partial<Record<VarKey, string>>
}): string {
  const keys = a.keys.filter(k => VAR_DEFS.some(d => d.key === k))
  if (keys.length === 0) return ''
  const now = renderVarValues(a.values, keys)
  if (!now) return ''
  const lines: string[] = ['〖本场数值〗', `你此刻的状态：${now}`]
  // 🔴 3.0 · W2-4a（§12）：把「数值 → 言行」的翻译也喂给**扮演侧**。
  //    原先档位（名字 + effect 行为指引）只进抽取提示词，演戏的模型只看得到裸数
  //    （`好感 45` 是什么概念？），「低好感该疏远、高好感会依赖」全靠它自己领会 ——
  //    本地小模型这一层领会得飘，不是硬约束。
  //    · **只对数值项**：`bandsOf()` 对文本项（心情 / 地点）返回 null，自然不进；
  //    · **只输出当前档位一行**，绝不把五档全表塞进来（每轮都注入、额度敏感；全表仍只在抽取侧给）；
  //    · 取值一律走 `bandOf`（与界面 TavernVarsPanel 共用同一份 VAR_BANDS，不另立口径）；
  //    · 越界值由 bandOf 兜底夹到端点档。
  const bandLines: string[] = []
  for (const k of keys) {
    if (!bandsOf(k)) continue          // 文本项没有刻度
    const b = bandOf(k, a.values?.[k])
    if (!b) continue
    const label = varDefOf(k)?.label ?? k
    bandLines.push(`${label}「${b.name}」— ${b.effect}`)
  }
  if (bandLines.length) lines.push(`当前档位：${bandLines.join('；')}`)
  if (a.goal?.trim()) lines.push(`这一场的目标：${a.goal.trim()}`)
  // 备注：作者写 / 模型改写的对「这个分」的旁白，喂给模型当上下文（不要求它回写）
  const noteLines = keys.map(k => (a.notes?.[k] ?? '').trim()).filter(Boolean)
  if (noteLines.length) lines.push(`（备注：${noteLines.join('；')}）`)
  lines.push('（这是给你把握分寸用的状态，不要把它抄进正文。）')
  return lines.join('\n')
}

// ==================== 角色卡上的持久状态（CharVars）====================

/** 空角色卡状态块：值取各变量初始值，备注为空 */
function emptyCharVars(keys?: VarKey[]): CharVars {
  return { values: emptyVars(keys).values, notes: {} }
}

/** 改某项备注（作者手改入口；空串＝清掉这条备注） */
export function setCharNote(cv: CharVars | undefined, key: VarKey, text: string): CharVars {
  const base = cv ?? emptyCharVars()
  const notes = { ...base.notes }
  const t = text.trim()
  if (t) notes[key] = t
  else delete notes[key]
  return { values: { ...base.values }, notes }
}

// ==================== 整理时抽取（与记忆整理同一次触发） ====================

/**
 * 抽取用的提示词（system）。
 *
 * 🔴 单一职责：**只输出一行**。以前是把这个任务塞给每轮的扮演回复（`B2 每轮推进一点`
 *    旁边加一句"最后一行写〔数值〕"），它要跟 3.5KB 的格式协议抢注意力，遵守率自然低。
 *    单开一次调用、只干这一件事，模型反而做得干净。
 */
export function buildVarExtractSystem(keys: VarKey[], opts: { maxStep: number }): string {
  const allow = keys.filter(k => VAR_DEFS.some(d => d.key === k))
  const defs = allow.map(k => varDefOf(k)!)
  const range = defs
    .map(d => d.kind === 'num' ? `${d.label}（${d.min}–${d.max}）` : `${d.label}（≤${d.maxLen} 字）`)
    .join(' / ')
  // 只提**启用中**的项：把没开的也写进去，模型会照着编一个出来（实弹里出现过）
  const textItems = defs.filter(d => d.kind === 'text')
  const numDefs = defs.filter(d => d.kind === 'num')
  /**
   * 数值档位（老大 2026-09-16 要求，见 `types.VAR_BANDS`）。
   *
   * 【为什么必须给它】−100 ~ +100 是个很宽的连续区间：只丢一个裸数（如「好感 -37」），
   *   模型无从判断这算轻还是重、这一轮该往上还是往下走 —— 给每一档起个名字、
   *   写一句「落在这档大致是什么状态」，数值才真正能翻译成言行。
   *
   * ⚠️ 这段是**每轮**都要进 system 的（反馈 #4 改成每轮刷新），所以写得紧凑：
   *    一项一行，档与档之间用「｜」分隔。
   */
  const bandsLines = numDefs.some(d => bandsOf(d.key))
    ? [
        '',
        '〖数值的档位（判断「现在落在哪一档、该往哪走」时参考）〗',
        ...numDefs.map(d => {
          const bands = bandsOf(d.key)
          if (!bands?.length) return `- ${d.label}：${d.min} ~ ${d.max}`
          return `- ${d.label}：${bands.map(b => `${b.from}~${b.to} ${b.name}（${b.effect}）`).join('｜')}`
        }),
      ]
    : []
  // 各项的判定要点（反馈 #6）：把「什么情况下该动、往哪动」写明，让信任/精神不再几轮不动然后突然跳。
  const criteriaLines = numDefs.some(d => d.criteria)
    ? [
        '',
        '〖各项的判定要点（这一轮该不该动这一项、往哪动，照这个判断）〗',
        ...numDefs.filter(d => d.criteria).map(d => `- ${d.label}：${d.criteria}`),
      ]
    : []
  const ex = [
    ...numDefs.slice(0, 1).map(d => `${d.label} +2`),
    ...textItems.slice(0, 1).map(d => `${d.label} ${d.key === 'place' ? '便利店收银台' : '松了一点'}`),
  ].join('；')
  return [
    '你是角色扮演的「状态记录员」。读一段刚发生的对话，判断下面这几项有没有发生变化。',
    '',
    `〖可记录的项〗${range}`,
    ...bandsLines,
    ...criteriaLines,
    '',
    '〖怎么判断〗',
    '1. 只报告**真的变了**的项；没变的一律不写 —— 宁可不报，也不要编。',
    `2. 数值项写增量（+2 / -1）或直接写新值；单项一次不超过 ±${opts.maxStep}，越界按边界取。`,
    '   · 变化要有依据：这一轮的话或事真的让关系挪动了，才动数；日常寒暄不该让数值原地刷存在感。',
    ...(textItems.length
      ? [`3. 文本项写**此刻**的状态：${textItems.map(d => `${d.label} ≤${d.maxLen} 字`).join('；')}。`]
      : []),
    ...(defs.some(d => d.key === 'place')
      // 「当前地点」→「地点」（2026-09-16 改名，五栏统一成两个字）
      ? ['   · 「地点」尤其重要 —— 它决定下一轮这场戏发生在哪，对话里看得出换了地方就更新它。']
      : []),
    `4. 一项都没变 → 只输出：${VAR_LINE_TAG}无变化`,
    `5. 若有项**变了**，可在下一行以 ${VAR_NOTE_TAG} 开头，给每项写一句≤20字的旁白（如「好感：从陌生到熟悉的朋友」）；没变的不写、没有就不写这一行。这句旁白会存进角色卡、下轮当上下文，所以写「这一栏现在意味着什么」，别写事件过程。`,
    '',
    '〖输出〗',
    `先输出一行，以 ${VAR_LINE_TAG} 开头，各项用「；」分隔；若本轮回写备注，再单独起一行以 ${VAR_NOTE_TAG} 开头。不要解释、不要寒暄、不要输出任何多余内容。`,
    `例：${VAR_LINE_TAG}${ex || '无变化'}`,
    ex ? `例：${VAR_LINE_TAG}${ex}　${VAR_NOTE_TAG}好感：从陌生到熟悉的朋友` : '',
  ].join('\n')
}

/** 抽取用的提示词（user）：当前值 + 这一段的对话 */
export function buildVarExtractUser(a: {
  values: VarValues | undefined
  keys: VarKey[]
  goal?: string
  /** 当前各项备注（角色卡持久保存）—— 让模型知道「这个分背后是什么」，回写时据此调整 */
  notes?: Partial<Record<VarKey, string>>
  /** 已渲染好的对话片段（调用方负责标注说话人） */
  transcript: string
}): string {
  const now = renderVarValues(a.values, a.keys)
  const notesText = a.keys
    .map(k => (a.notes?.[k] ?? '').trim())
    .filter(Boolean)
    .join('；')
  return [
    `〖当前值〗${now || '（都还是初始值）'}`,
    notesText ? `〖当前备注〗${notesText}` : '',
    a.goal?.trim() ? `〖这一场的目标〗${a.goal.trim()}` : '',
    '',
    '〖刚发生的对话〗',
    // 🔴 包边界（审计 P1-12）：对话正文是自由文本，裸拼会让人写在正文里的指令跨段生效
    authorBlock(newAuthorFence(), a.transcript),
    '',
    `请输出那一行（没有变化就写 ${VAR_LINE_TAG}无变化；若有项变了要回写备注，另起一行以 ${VAR_NOTE_TAG} 开头）。`,
  ].filter(x => x !== '').join('\n')
}

/**
 * 从抽取回复里解出操作。
 *
 * 与旧版「解析正文末尾的记账行」的区别：**不要求那一行在末尾，也不剥正文**。
 * 抽取调用只有一个任务，模型偶尔会在前后多写一句客套（"好的，我看了一下……"），
 * 对它宽容一点没有风险 —— 这里没有正文可吃。
 */
export function parseVarsFromText(text: string, keys?: VarKey[]): VarOp[] {
  const allow = new Set<VarKey>(keys && keys.length ? keys : VAR_DEFS.map(d => d.key))
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line.startsWith(VAR_LINE_TAG)) continue
    const body = line.slice(VAR_LINE_TAG.length).trim()
    if (/^(无变化|无|不变|no change)$/i.test(body)) return []
    return parseOps(body, allow)
  }
  return []
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
