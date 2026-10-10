/**
 * 跑团互动 · KP 主持层（3.0 · W4-3b）
 *
 * 【它解决的问题】既有两种互动里，AI 都是「陪演」：
 *   · 剧情推演 —— 试演一场戏，看角色反应是否**合理**；
 *   · 自由对话 —— 长期陪伴，重点是**关系**。
 *   两者都不负责「推进一个可玩的过程」。跑团要的第三件事：AI 当 **KP（守秘人）**，
 *   主持、裁决、给线索、守秘密 —— 让玩家的**行动有可记录的后果**。
 *
 * 【D2=A：内置轻量检定】不引硬规则书，也不做成纯叙事（那会失去「跑团感」）：
 *   `行动 → 难度 → 掷值 → 四档结果`，结果**由系统掷**（不由模型自己说成败）——
 *   这是「不同玩家 / 不同分支拥有独立经历」可复现的前提。
 *
 * 【边界】本文件是**纯逻辑**：提示词拼装（字符串）＋ 检定判定（纯函数）＋ 结构化解析（走 aiParse）。
 *   不调 AI、不碰 React、不碰 db（AI 往返在 W4-3e 接引擎，照既有的 chat()/aiParse 通道）。
 */
import { parseLooseObject, asText } from '../aiParse'
import type {
  RunAction, RunActionKind, RunOutcome, RunSession, RunCompanion, RunClueSource,
} from './runTypes'

// ==================== 检定（D2=A）====================

/**
 * 默认难度：**观察最易、交谈居中、取证最难**。
 * 语义：掷值 `roll`（1–100）**越高越好**，`difficulty` 是**及格线** —— 两者都是 1–100。
 */
export const DEFAULT_DIFFICULTY: Record<RunActionKind, number> = {
  观察: 30,
  交谈: 45,
  取证: 60,
  其他: 45,
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(1, Math.min(100, Math.round(v)))
}

/**
 * 四档判定（纯函数）。判据是 **margin = roll − difficulty**：
 *   · margin ≥ 30  ⇒ 大成功（远超所需）
 *   · margin ≥ 0   ⇒ 成功
 *   · margin ≥ −15 ⇒ 擦边（险败 / 部分成功 —— 得手但有代价或副作用）
 *   · 否则         ⇒ 失败
 * 🔴 判据写成单调函数：掷值越高、结果只可能更好，绝不会出现「掷 90 却比掷 80 差」这种非单调。
 */
export function judgeOutcome(roll: number, difficulty: number): RunOutcome {
  const m = clamp(roll) - clamp(difficulty)
  if (m >= 30) return '大成功'
  if (m >= 0) return '成功'
  if (m >= -15) return '擦边'
  return '失败'
}

/**
 * 掷一次检定。`rng` 可注入（测试用固定序列）—— 默认 `Math.random`。
 * 返回的 `roll` 是 1–100 的整数（掷值是**可展示、可追问**的：玩家会想知道自己掷了多少）。
 */
export function rollCheck(difficulty: number, rng: () => number = Math.random): { roll: number; outcome: RunOutcome } {
  const d = clamp(difficulty)
  const roll = Math.floor(rng() * 100) + 1   // 1–100
  return { roll, outcome: judgeOutcome(roll, d) }
}

// ==================== 行动归类 ====================

/**
 * 把玩家这一轮的输入归成四类（§10.3 #11 原文：观察 / 交谈 / 取证）。
 * 🔴 顺序＝优先级：**取证最具体**（搜 / 翻找 / 采样），先判它；再交谈，最后观察。
 *    （「我搜查桌子」里也含「查看」，若先判观察就会误归类 —— 故取证必须排最前。）
 */
const KIND_PATTERNS: { kind: RunActionKind; re: RegExp }[] = [
  { kind: '取证', re: /(取证|采样|化验|搜查|搜身|搜|翻找|撬开|撬|拾取|捡起|收集物证|拍照留证)/ },
  { kind: '交谈', re: /(交谈|对话|搭话|打听|询问|问|聊聊|喊住|叫住|说服|劝)/ },
  { kind: '观察', re: /(观察|查看|打量|环视|环顾|端详|留意|注视|看看|看一眼|检查四周|四周)/ },
]

export function kindOf(text: string): RunActionKind {
  const t = String(text ?? '')
  for (const p of KIND_PATTERNS) if (p.re.test(t)) return p.kind
  return '其他'
}

/** 这一动的默认难度（不传 kind 时按文本归类） */
export function difficultyFor(kind: RunActionKind): number {
  return DEFAULT_DIFFICULTY[kind] ?? DEFAULT_DIFFICULTY.其他
}

// ==================== 行动流水（「可记录的后果」）====================

let actionSeq = 0
function actionId(): string { return `act_${Date.now().toString(36)}_${(actionSeq++).toString(36)}` }

/**
 * 把玩家的一次行动写进流水。**纯函数**（返回新会话，不改原对象）。
 *
 * @param text       玩家输入
 * @param opts.difficulty 难度（省略 = 这一动不检定；界面上可不给掷值）
 * @param opts.update     推进进度用的变量变化（由调用方决定怎么写，本层不判）
 */
export function appendAction(
  s: RunSession,
  text: string,
  opts: { difficulty?: number; rng?: () => number; kind?: RunActionKind } = {},
): RunSession {
  const kind = opts.kind ?? kindOf(text)
  const a: RunAction = { id: actionId(), at: Date.now(), text: String(text ?? '').trim(), kind }
  if (typeof opts.difficulty === 'number') {
    const { roll, outcome } = rollCheck(opts.difficulty, opts.rng)
    a.difficulty = clamp(opts.difficulty)
    a.roll = roll
    a.outcome = outcome
  }
  return { ...s, actions: [...s.actions, a], updatedAt: Date.now() }
}

/** 给最后一次行动补上后果文案（KP 回完话后回填） */
export function setLastConsequence(s: RunSession, consequence: string): RunSession {
  if (!s.actions.length) return s
  const actions = s.actions.slice()
  const last = actions[actions.length - 1]
  actions[actions.length - 1] = { ...last, consequence: String(consequence ?? '').trim() }
  return { ...s, actions, updatedAt: Date.now() }
}

// ==================== 主持人格提示词 ====================

export interface KpLayerOpts {
  /** 同伴（各自知晓边界要写进提示词，防越界） */
  companions?: RunCompanion[]
  /** 已埋但**未揭晓**的秘密文案：只给 KP 看，用于「不到时机不许说破」的约束 */
  pendingSecrets?: string[]
  /** 已获线索条数（让 KP 知道玩家现在掌握多少） */
  clueCount?: number
}

/**
 * 拼出「跑团主持」这一层 system 提示词。
 * 与酒馆既有分层（设定 / 记忆 / 身份 / 协议）并列追加，不改它们的既有语义。
 */
export function buildKpLayer(o: KpLayerOpts = {}): string {
  const parts: string[] = []

  parts.push(
    '〖跑团主持（KP）〗\n'
    + '这一场你是**守秘人（KP）**，不是陪聊的 NPC —— 你的职责是**主持、裁决、推进**：\n'
    + '· 玩家行动后，先给**结果**，再给**场面**；不替玩家做决定、不替玩家开口。\n'
    + '· 没写进「已知线索」的事，**不许当作玩家已经知道** —— 不替他全知全能。\n'
    + '· **线索要给，答案不给**：把能拼出真相的碎片摆出来，让玩家自己拼。\n'
    + '· 检定结果（大成功 / 成功 / 擦边 / 失败）**由系统给定**，你照它演 ——\n'
    + '  系统说失败，就不许写成成功；说擦边，就要给代价或副作用。\n'
    + '· 失败与擦边**也要推进**：不是「什么都没发生」，而是「发生了另一件更糟 / 更偏的事」。',
  )

  if (o.companions?.length) {
    const lines = o.companions.map(c => {
      const knows = c.knows.filter(Boolean)
      const knowsTxt = knows.length ? `知晓：${knows.join('；')}` : '知晓：（无 —— 他什么都不知道）'
      const help = c.canHelp ? '能在检定里搭把手' : '帮不上忙'
      return `· ${c.name}｜${c.stance || '立场未定'}｜${knowsTxt}｜${help}`
    })
    parts.push(
      '〖同伴（「知晓」是硬边界）〗\n'
      + lines.join('\n')
      + '\n' + '同伴只知道各自「知晓」里的事 —— **不许越界**（他们不该忽然说出自己没参与的密谈）。',
    )
  }

  if (o.pendingSecrets?.length) {
    parts.push(
      '〖待揭晓的秘密（暗牌，别提前亮）〗\n'
      + o.pendingSecrets.map(x => `· ${x}`).join('\n')
      + '\n' + '这些是**暗牌**：可以埋伏笔、可以给错觉，但**不到揭晓时机不许说破**。',
    )
  }

  if (typeof o.clueCount === 'number') {
    parts.push(`〖进度〗玩家当前已掌握线索 ${o.clueCount} 条。`)
  }

  return parts.join('\n\n')
}

// ==================== 裁决的结构化输出（走 aiParse，禁裸 JSON.parse）====================

/** KP 裁决返回的形状（模型按 `buildKpVerdictSchema()` 给的契约产出 JSON） */
export interface KpVerdict {
  /** 这一动的难度（1–100）；省略 = KP 认为不必检定 */
  difficulty?: number
  /** 后果（一句话，写进行动流水） */
  consequence: string
  /** 若这一动**新得**一条线索 */
  clue?: { text: string; source?: RunClueSource }
  /** 若这一动**揭晓**了某个秘密（填秘密 id） */
  revealsSecretId?: string
}

/** 给模型的输出契约（附在裁决提示词末尾） */
export function buildKpVerdictSchema(): string {
  return [
    '〖输出契约〗只回一个 JSON 对象，不要解释、不要代码块外的文字：',
    '{',
    '  "difficulty": 0-100 的整数（这一动的难度；纯叙事不需要判定时省略）,',
    '  "consequence": "一句话说清这一动的结果（不重复玩家的动作）",',
    '  "clue": { "text": "新得的线索（没得就省略）", "source": "观察|交谈|取证" },',
    '  "revealsSecretId": "这次行动揭晓了哪个秘密（没有就省略）"',
    '}',
  ].join('\n')
}

/** 难度合法区间（模型偶尔会给 0 / 1000 这种越界值，钳回 1–100） */
function normDifficulty(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return clamp(v)
}

/**
 * 解析 KP 的裁决（AI 文本 → 结构化）。🔴 走 `aiParse` 的 `parseLooseObject`，**禁裸 `JSON.parse`**。
 * 解析不出对象返回 null（调用方据此走兜底：当作「KP 没给结构、只有正文」）。
 */
export function parseKpVerdict(raw: string): KpVerdict | null {
  const obj = parseLooseObject(String(raw ?? ''))
  if (!obj) return null

  const consequence = asText(obj.consequence ?? obj.result ?? obj.后果).trim()
  if (!consequence && !obj.clue && !obj.revealsSecretId) return null

  const out: KpVerdict = { consequence }

  const d = normDifficulty(obj.difficulty ?? obj.难度)
  if (typeof d === 'number') out.difficulty = d

  const rawClue = obj.clue
  if (rawClue && typeof rawClue === 'object') {
    const c = rawClue as Record<string, unknown>
    const text = asText(c.text ?? c.线索).trim()
    if (text) {
      const src = asText(c.source ?? c.来源).trim()
      const source: RunClueSource | undefined =
        src === '观察' || src === '交谈' || src === '取证' || src === '其他' ? src : undefined
      out.clue = source ? { text, source } : { text }
    }
  }

  const secretId = asText(obj.revealsSecretId ?? obj.揭晓秘密).trim()
  if (secretId) out.revealsSecretId = secretId

  return out
}
