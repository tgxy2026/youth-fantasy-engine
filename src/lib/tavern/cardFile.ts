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
import { EMPTY_CAST_SETTING } from './types'
import type { FreeCharacter } from './types'

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
  const { id, createdAt, updatedAt, ...rest } = c
  void id; void createdAt; void updatedAt
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

  const name = isStr(card.name) ? card.name.trim() : ''
  if (!name) return { ok: false, error: '角色卡没有名字' }

  const warnings: string[] = []
  const profile = (card.profile && typeof card.profile === 'object' ? card.profile : {}) as Record<string, unknown>
  const conduct = (card.conduct && typeof card.conduct === 'object' ? card.conduct : {}) as Record<string, unknown>
  const s = (v: unknown) => (isStr(v) ? v : '')

  const world = s(card.world)
  const examples = s(card.examples)
  if (!world.trim()) warnings.push('缺「第 1 章 · 世界」')
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

  const avatar = s(card.avatar)
  return {
    ok: true,
    warnings,
    card: {
      name,
      avatar: avatar || undefined,
      world,
      profile: profileOut,
      conduct: conductOut,
      examples,
      // 溯源：导入也记一笔来源（便于以后追「这张卡从哪来」）
      importedFrom: { projectId: '', cardId: `import:${uid()}`, at: Date.now() },
    },
  }
}

/** 生成一张空白的导入结果提示（供 UI 复用文案，避免两处措辞不一致） */
export function describeWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '结构完整，四章齐全'
  return `结构有缺：${warnings.join('、')}`
}

export { EMPTY_CAST_SETTING }
