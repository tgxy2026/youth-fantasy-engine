/**
 * 酒馆模式 · 角色卡单文件导入导出（方案 §7.7）
 *
 * 格式：单文件 JSON（含全部字段 + avatar），文件名 `角色名.taverncard.json`。
 *
 * 【两条必须做的事】
 *   1. **导入时重生成新 id** —— 否则从别处导入一份会和已有卡撞 id，直接覆盖掉别人的卡。
 *   2. **必须校验**：结构完整性（四章字段在不在）、名称非空、大小上限。
 *
 * 【校验的尺度：提醒而非拒绝】
 * 缺章不判死 —— 可能是旧版本导出的卡、或作者故意只填了两章。
 * 但要把「缺哪几章」如实回报，由界面告诉作者（方案 §7.6 的精神：**必须人工审阅**）。
 * 只有「根本不是这个格式」「名字空着」「大得离谱」才拒绝。
 *
 * 不做 PNG 隐写（ST 那套）：JSON 够用、可读、可 diff。
 *
 * 本文件是纯逻辑（无 IO、无 React），文件读写由调用方用 FSA / input[type=file] 完成。
 */
import { uid } from '../id'
import { EMPTY_CAST_SETTING, VAR_KEYS } from './types'
import type { FreeCharacter, CharVars, VarValues, VarKey } from './types'

/** 文件后缀（导出文件名用它收尾） */
export const CARD_FILE_SUFFIX = '.taverncard.json'
/** 单文件大小上限（字符数近似字节）：角色卡是纯文本，512KB 已经非常宽松 */
export const CARD_FILE_MAX_CHARS = 512 * 1024
/** 格式标记：防止把随便一个 JSON 当角色卡导进来 */
const FORMAT = 'yfe.taverncard'
const FORMAT_VERSION = 1

export type CardFilePayload = {
  format: string
  version: number
  exportedAt: number
  app: string
  card: Omit<FreeCharacter, 'id' | 'createdAt' | 'updatedAt'>
}

/** 导出：把角色卡包成单文件 JSON 文本 */
export function toCardFile(c: FreeCharacter, now = Date.now()): string {
  // seededFrom 是**本机的溯源标记**，不进导出文件 —— 否则别人导入后他那边也会把这张卡
  // 当成内置示范卡去「恢复内置版本」/自动升级。importedFrom 相反：那是"从哪来"的记录，
  // 导入时会被重新写成 import:xxx（见 parseCardFile），保留它有溯源价值。
  const { id, createdAt, updatedAt, seededFrom, ...rest } = c
  void id; void createdAt; void updatedAt; void seededFrom
  const payload: CardFilePayload = {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: now,
    app: 'novel-studio',
    card: rest,
  }
  return JSON.stringify(payload, null, 2)
}

/** 导出文件名：角色名 + 后缀（清掉路径分隔符等非法字符） */
export function cardFileName(name: string): string {
  const safe = String(name || '未命名角色')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .trim()
    .slice(0, 40) || '未命名角色'
  return `${safe}${CARD_FILE_SUFFIX}`
}

export type CardFileResult =
  | {
      ok: true
      /** 已重生成 id 的卡（可直接 createFreeChar 落库） */
      card: Omit<FreeCharacter, 'id' | 'createdAt' | 'updatedAt'>
      /** 缺章等提醒（界面必须显示给作者） */
      warnings: string[]
    }
  | { ok: false; error: string }

const isStr = (v: unknown): v is string => typeof v === 'string'

/**
 * 单张卡的校验与归一化 —— `parseCardFile`（单卡文件）与 `parseCardBundle`（批量文件）
 * **共用这一份**：两处各写一份必然漂移，而「校验口径不一致」是最难查的那类 bug。
 *
 * 宽容处：缺字段补空串、旧版本无 format 标记也认（只要结构对）；
 * 严格处：名称必须非空、结构必须是对象。
 */
/**
 * 宽松读取导入文件里的 `vars`（关系状态）。
 *
 * 🔴 2026-09-22 六维审计：导出侧**一直**带着 `vars`（`toCardFile` / `toCardBundle` 的 `...rest` 都含它），
 *    导入侧却从不读 —— 往返一次（导出→导入，或换设备），卡上的「关系状态」
 *    （好感 / 信任 / 精神 / 心情 / 地点 + 每项备注）全部归零。
 *    老大 2026-09-22 拍板：**随卡跨设备** ⇒ 导出带、导入也必须读。两侧要么都带、要么都不带，不能一边带一边丢。
 *
 * 校验取宽松尺度（与本文件其余部分一致）：只认 `VAR_KEYS` 里的键，
 * 数值项收有限数字、文本项收非空字符串，`notes` 同理 —— 其余一律丢弃。
 * 一个可用字段都没有时返回 `undefined`（不给卡硬塞一个空的 vars）。
 * 注意这是**向后兼容**的加法：旧文件没有 `vars` 字段，走的就是这条 `undefined` 分支，
 * 因此 `FORMAT_VERSION` 不需要升版。
 */
function normalizeVars(raw: unknown): CharVars | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Record<string, unknown>
  const rawValues = (src.values && typeof src.values === 'object' ? src.values : {}) as Record<string, unknown>
  const rawNotes = (src.notes && typeof src.notes === 'object' ? src.notes : {}) as Record<string, unknown>

  const values: VarValues = {}
  const notes: Partial<Record<VarKey, string>> = {}
  for (const k of VAR_KEYS) {
    const v = rawValues[k]
    if (typeof v === 'number' && Number.isFinite(v)) values[k] = v
    else if (isStr(v) && v.trim()) values[k] = v.trim()

    const n = rawNotes[k]
    if (isStr(n) && n.trim()) notes[k] = n.trim()
  }

  if (!Object.keys(values).length && !Object.keys(notes).length) return undefined
  return { values, notes }
}

function normalizeCard(cardRaw: Record<string, unknown>): CardFileResult {
  const name = isStr(cardRaw.name) ? cardRaw.name.trim() : ''
  if (!name) return { ok: false, error: '角色卡没有名字' }

  const warnings: string[] = []
  const profile = (cardRaw.profile && typeof cardRaw.profile === 'object' ? cardRaw.profile : {}) as Record<string, unknown>
  const conduct = (cardRaw.conduct && typeof cardRaw.conduct === 'object' ? cardRaw.conduct : {}) as Record<string, unknown>
  const s = (v: unknown) => (isStr(v) ? v : '')

  const world = s(cardRaw.world)
  const examples = s(cardRaw.examples)
  if (!world.trim()) warnings.push('缺「第 1 章 · 角色与设定的关系」')
  if (!examples.trim()) warnings.push('缺「第 4 章 · 示例对话」（这一章最影响演出效果）')

  const profileOut = {
    externals: s(profile.externals), core: s(profile.core), speech: s(profile.speech),
    relations: s(profile.relations), cannot: s(profile.cannot), knowledge: s(profile.knowledge),
  }
  const conductOut = {
    perspective: s(conduct.perspective), bottomLine: s(conduct.bottomLine),
    paceLock: s(conduct.paceLock), rating: s(conduct.rating),
  }
  if (!profileOut.core.trim()) warnings.push('缺「2.2 内核」')
  if (!conductOut.perspective.trim()) warnings.push('缺「视角与人称」')

  const avatar = s(cardRaw.avatar)
  return {
    ok: true,
    warnings,
    card: {
      // 导入的卡**不自带故事归属**（文件里没有这一层）→ 落为自由状态，
      // 作者拿到后在「归属故事」里挂到某个故事下即可。
      storyId: '',
      name,
      avatar: avatar || undefined,
      world,
      profile: profileOut,
      conduct: conductOut,
      examples,
      // 溯源：导入也记一笔来源（便于以后追「这张卡从哪来」）
      importedFrom: { projectId: '', cardId: `import:${uid()}`, at: Date.now() },
      // 🔴 关系状态随卡跨设备（老大 2026-09-22 拍板）：导出侧一直带着它，这里必须读回来，
      //    否则「导出→导入」往返一次，好感/信任/精神/心情/地点 + 备注全部归零。
      vars: normalizeVars(cardRaw.vars),
    },
  }
}

/**
 * 解析并校验单文件。
 * 宽容处：缺字段补空串、旧版本无 format 标记也认（只要结构对）；
 * 严格处：名称必须非空、大小必须在上限内、card 必须是对象。
 */
export function parseCardFile(text: string): CardFileResult {
  const raw = String(text ?? '')
  if (raw.length > CARD_FILE_MAX_CHARS) {
    return { ok: false, error: `文件过大（超过 ${Math.round(CARD_FILE_MAX_CHARS / 1024)} KB），可能不是角色卡` }
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件' }
  }
  if (!data || typeof data !== 'object') return { ok: false, error: '文件内容不是角色卡结构' }

  const obj = data as Record<string, unknown>
  // 有 format 标记就必须对；没有则按裸卡或 {card} 处理（容忍手写/旧版）
  if (isStr(obj.format) && obj.format !== FORMAT) {
    return { ok: false, error: `不是酒馆模式角色卡（format=${obj.format}）` }
  }
  const card = (obj.card && typeof obj.card === 'object' ? obj.card : obj) as Record<string, unknown>
  return normalizeCard(card)
}

// ==================== 批量文件（一个文件里装多张卡）====================
//
// 【为什么单独一种格式】同一世界观的一批角色往往是**一起建的**（一次填表、一次导入）。
// 让作者导出 N 个文件再逐个导入，既蠢又容易漏；一个文件装整批、一次导入完，才对得上真实用法。
//
// 【宽容尺度与单卡一致】能救的救、不能救的如实报出：第 3 张坏了，不该让前两张也白导
// （作者填一次表不容易）。所以返回的是「成功 items + 失败 failed」两段，而不是一个 ok/fail。

/** 批量文件的后缀（导出整批时用它收尾，与单卡的 .taverncard.json 区分开） */
export const CARD_BUNDLE_SUFFIX = '.taverncards.json'
/** 批量文件的格式标记（与单卡区分开，避免把整批文件当单卡解析） */
const BUNDLE_FORMAT = 'yfe.taverncards'
/** 批量文件上限：一批几十张卡也够用；再大就该拆文件了 */
const CARD_BUNDLE_MAX_CHARS = 4 * 1024 * 1024

export type CardBundlePayload = {
  format: string
  version: number
  exportedAt: number
  app: string
  /** 整批的说明（**仅供人看**，不参与导入）—— 例如这一批共用的世界观出处 */
  note?: string
  cards: Array<Omit<FreeCharacter, 'id' | 'createdAt' | 'updatedAt'>>
}

/** 批量导入里的一张（已归一化、已重生成 id） */
export type CardBundleItem = {
  name: string
  card: Omit<FreeCharacter, 'id' | 'createdAt' | 'updatedAt'>
  warnings: string[]
}

export type CardBundleResult =
  | { ok: true; items: CardBundleItem[]; failed: { index: number; reason: string }[] }
  | { ok: false; error: string }

/**
 * 解析批量文件。**逐张独立校验**：坏的进 `failed`（带序号，便于对着表改），
 * 好的进 `items`；一张都读不出来才算整体失败。
 */
export function parseCardBundle(text: string): CardBundleResult {
  const raw = String(text ?? '')
  if (raw.length > CARD_BUNDLE_MAX_CHARS) {
    return { ok: false, error: `文件过大（超过 ${Math.round(CARD_BUNDLE_MAX_CHARS / 1024 / 1024)} MB），建议拆成几个文件` }
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '批量文件的内容不是对象' }
  }
  const obj = data as Record<string, unknown>
  if (isStr(obj.format) && obj.format !== BUNDLE_FORMAT) {
    return { ok: false, error: `不是批量角色卡文件（format=${obj.format}）` }
  }
  const list = obj.cards
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: '批量文件里没有 cards 数组（或它是空的）' }
  }

  const items: CardBundleItem[] = []
  const failed: { index: number; reason: string }[] = []
  list.forEach((c, i) => {
    const r = normalizeCard((c && typeof c === 'object' ? c : {}) as Record<string, unknown>)
    if (r.ok) items.push({ name: r.card.name, card: r.card, warnings: r.warnings })
    else failed.push({ index: i, reason: r.error })
  })
  if (items.length === 0) {
    return { ok: false, error: `这批 ${list.length} 张卡一张都读不出来：${failed[0]?.reason ?? '结构不对'}` }
  }
  return { ok: true, items, failed }
}

/** 导出整批（与单卡导出对称，供「导出全部」用） */
export function toCardBundle(cards: FreeCharacter[], note = '', now = Date.now()): string {
  const payload: CardBundlePayload = {
    format: BUNDLE_FORMAT,
    version: FORMAT_VERSION,
    exportedAt: now,
    app: 'novel-studio',
    ...(note.trim() ? { note: note.trim() } : {}),
    cards: cards.map(c => {
      // 与单卡导出同一条纪律：本机 id 与溯源标记**不进导出文件**
      const { id, createdAt, updatedAt, seededFrom, ...rest } = c
      void id; void createdAt; void updatedAt; void seededFrom
      return rest
    }),
  }
  return JSON.stringify(payload, null, 2)
}

/** 生成一张空白的导入结果提示（供 UI 复用文案，避免两处措辞不一致） */
export function describeWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '结构完整，四章齐全'
  return `结构有缺：${warnings.join('、')}`
}

export { EMPTY_CAST_SETTING }
