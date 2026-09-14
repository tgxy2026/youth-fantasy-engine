/**
 * 酒馆模式 · 存储封装（索引 + 分条）
 *
 * 设计依据：方案 §3.2 / §4.4。
 *
 * 【为什么索引与分条分开】
 * 会话与角色卡都可能很长（含 messages[]）。若把列表也塞进一个 key，
 * 每次列个清单都要把全部会话正文读进内存、云同步载荷也会失控。
 *
 * 【两条线的存储归属完全不同（方案 §3.1）】
 *   · 剧情模式 → 项目级 settingsKV（`db.getSetting/setSetting` 会自动拼 `${projectId}::` 前缀）
 *     —— 跟着小说项目走，导出项目时一并带走
 *   · 自由模式 → **全局 meta**（`db.getMeta/setMeta`，无前缀）
 *     —— 不绑任何项目，删项目也不会跟着没。这是刻意的：先例是 AI 模型配置从项目级迁到全局。
 *
 * 【铁律】索引与分条必须成对读写。只写一边就会出现「列表里有、点开是空的」幽灵条目，
 *        故本文件所有增删改都成对操作，并额外提供 audit/prune 自检（方案 §11.8）。
 *
 * 注意：本文件是纯逻辑，不含 React。
 */
import * as db from '../db'
import { uid } from '../id'
import { EMPTY_CAST_SETTING } from './types'
import type {
  TavernSession, TavernSessionIndexItem, TavernCast, CastSetting,
  TavernReport, TavernReportIndexItem,
  FreeCharacter, FreeSession, FreeMemory, DailyState,
  TavernCharIndexItem, FreeSessionIndexItem,
} from './types'

// ==================== 存储键 ====================
// 剧情模式（会经 db.getSetting 自动加项目前缀）
const K = {
  sessionIndex: 'tavern.sessionIndex',
  session: (id: string) => `tavern.session.${id}`,
  cast: (cardId: string) => `tavern.cast.${cardId}`,
} as const

// 自由模式（全局，无前缀）
const G = {
  charIndex: 'tavern.charIndex',
  freeChar: (id: string) => `tavern.free.char.${id}`,
  freeSessionIndex: 'tavern.free.sessionIndex',
  freeSession: (id: string) => `tavern.free.session.${id}`,
  memory: (charId: string) => `tavern.free.mem.${charId}`,
  daily: (charId: string) => `tavern.free.daily.${charId}`,
  greeting: (charId: string) => `tavern.free.greeting.${charId}`,
} as const

// ==================== 工具 ====================
function now() { return Date.now() }

function castBrief(cast: TavernCast[]): string {
  return cast.map(c => c.name).filter(Boolean).join('、')
}

// ==================== 剧情模式 · 会话 ====================

export async function listSessions(): Promise<TavernSessionIndexItem[]> {
  const list = await db.getSetting<TavernSessionIndexItem[]>(K.sessionIndex, [])
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getSession(id: string): Promise<TavernSession | null> {
  return db.getSetting<TavernSession | null>(K.session(id), null)
}

/**
 * 保存会话（**索引与分条成对写**）。
 * 调用方传入完整会话对象；updatedAt 由本函数统一刷新，避免各处不一致。
 */
export async function saveSession(s: TavernSession): Promise<TavernSession> {
  const next: TavernSession = { ...s, updatedAt: now() }
  await db.setSetting(K.session(next.id), next)
  const idx = await db.getSetting<TavernSessionIndexItem[]>(K.sessionIndex, [])
  const item: TavernSessionIndexItem = {
    id: next.id,
    title: next.title,
    mode: next.mode,
    castBrief: castBrief(next.cast),
    anchorTitle: next.anchorChapterLabel,
    updatedAt: next.updatedAt,
  }
  const i = idx.findIndex(x => x.id === next.id)
  if (i >= 0) idx[i] = item
  else idx.push(item)
  await db.setSetting(K.sessionIndex, idx)
  return next
}

export async function createSession(init: Omit<TavernSession, 'id' | 'createdAt' | 'updatedAt' | 'messages'> & { messages?: TavernSession['messages'] }): Promise<TavernSession> {
  const s: TavernSession = {
    ...init,
    id: uid(),
    messages: init.messages ?? [],
    createdAt: now(),
    updatedAt: now(),
  }
  return saveSession(s)
}

/** 删除会话（索引与分条同时删，避免幽灵条目） */
export async function deleteSession(id: string): Promise<void> {
  const idx = await db.getSetting<TavernSessionIndexItem[]>(K.sessionIndex, [])
  await db.setSetting(K.sessionIndex, idx.filter(x => x.id !== id))
  // 分条直接覆盖为空对象（KV 无 delete 语义时的等价做法：置空后不再被读取）
  await db.setSetting(K.session(id), null)
}

export async function renameSession(id: string, title: string): Promise<void> {
  const s = await getSession(id)
  if (!s) return
  await saveSession({ ...s, title })
}

// ==================== 剧情模式 · 扮演设定 ====================

export async function getCastSetting(cardId: string): Promise<CastSetting> {
  // 空值兜底走 types 的单一真源（UI 表单初值也用同一个，避免两处写空对象而慢慢漂移）
  return db.getSetting<CastSetting>(K.cast(cardId), EMPTY_CAST_SETTING)
}

export async function saveCastSetting(cardId: string, cs: CastSetting): Promise<void> {
  await db.setSetting(K.cast(cardId), cs)
}

// ==================== 剧情模式 · 推演报告 ====================
// 报告归属 `tavernReports` 表（方案 §3.4 四处登记，P1 随表落地）。
// 在表就绪之前，本组函数会抛错——调用方（报告页）需据此显示空态。

export async function listReports(): Promise<TavernReportIndexItem[]> {
  const rows = await db.listProjectReports(db.getCurrentProjectId())
  return rows
    .map(r => ({
      id: r.id,
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      anchorChapterLabel: r.anchorChapterLabel,
      counts: {
        矛盾: r.findings.filter(f => f.level === '矛盾').length,
        漏洞: r.findings.filter(f => f.level === '漏洞').length,
        存疑: r.findings.filter(f => f.level === '存疑').length,
      },
      createdAt: r.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function getReport(id: string): Promise<TavernReport | null> {
  return (await db.getReport(id)) ?? null
}

export async function saveReport(r: TavernReport): Promise<void> {
  await db.saveReport(r)
}

export async function deleteReport(id: string): Promise<void> {
  await db.deleteReport(id)
}

// ==================== 自由模式 · 角色卡（全局） ====================

export async function listFreeChars(): Promise<TavernCharIndexItem[]> {
  const list = await db.getMeta<TavernCharIndexItem[]>(G.charIndex, [])
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getFreeChar(id: string): Promise<FreeCharacter | null> {
  return db.getMeta<FreeCharacter | null>(G.freeChar(id), null)
}

export function emptyFreeCharacter(): Omit<FreeCharacter, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: '',
    world: '',
    profile: { externals: '', core: '', speech: '', relations: '', cannot: '', knowledge: '' },
    conduct: { perspective: '', bottomLine: '', paceLock: '', rating: '' },
    examples: '',
  }
}

export async function createFreeChar(init: Omit<FreeCharacter, 'id' | 'createdAt' | 'updatedAt'>): Promise<FreeCharacter> {
  const c: FreeCharacter = { ...init, id: uid(), createdAt: now(), updatedAt: now() }
  return saveFreeChar(c)
}

/** 保存角色卡（索引与分条成对写） */
export async function saveFreeChar(c: FreeCharacter): Promise<FreeCharacter> {
  const next: FreeCharacter = { ...c, updatedAt: now() }
  await db.setMeta(G.freeChar(next.id), next)
  const idx = await db.getMeta<TavernCharIndexItem[]>(G.charIndex, [])
  const item: TavernCharIndexItem = { id: next.id, name: next.name, avatar: next.avatar, updatedAt: next.updatedAt }
  const i = idx.findIndex(x => x.id === next.id)
  if (i >= 0) idx[i] = item
  else idx.push(item)
  await db.setMeta(G.charIndex, idx)
  return next
}

/**
 * 删除角色卡：级联清掉它的记忆 / 日常 / 待发留言（这些都以 charId 为键），
 * 并把该角色从各会话的 charIds 里摘掉；会话因此变空则一并删除（避免出现无参演角色的空会话）。
 */
export async function deleteFreeChar(id: string): Promise<void> {
  const idx = await db.getMeta<TavernCharIndexItem[]>(G.charIndex, [])
  await db.setMeta(G.charIndex, idx.filter(x => x.id !== id))
  await db.setMeta(G.freeChar(id), null)
  await db.setMeta(G.memory(id), null)
  await db.setMeta(G.daily(id), null)
  await db.setMeta(G.greeting(id), null)

  const sessions = await listFreeSessions()
  for (const s of sessions) {
    if (!s.charIds.includes(id)) continue
    const full = await getFreeSession(s.id)
    if (!full) { await deleteFreeSession(s.id); continue }
    const rest = full.charIds.filter(x => x !== id)
    if (rest.length === 0) await deleteFreeSession(s.id)
    else await saveFreeSession({ ...full, charIds: rest })
  }
}

// ==================== 自由模式 · 会话（全局） ====================

export async function listFreeSessions(): Promise<FreeSessionIndexItem[]> {
  const list = await db.getMeta<FreeSessionIndexItem[]>(G.freeSessionIndex, [])
  return [...list].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

export async function getFreeSession(id: string): Promise<FreeSession | null> {
  return db.getMeta<FreeSession | null>(G.freeSession(id), null)
}

export async function saveFreeSession(s: FreeSession): Promise<FreeSession> {
  const next: FreeSession = { ...s, updatedAt: now() }
  await db.setMeta(G.freeSession(next.id), next)
  const idx = await db.getMeta<FreeSessionIndexItem[]>(G.freeSessionIndex, [])
  const item: FreeSessionIndexItem = {
    id: next.id, title: next.title, charIds: next.charIds,
    lastActiveAt: next.lastActiveAt, updatedAt: next.updatedAt,
  }
  const i = idx.findIndex(x => x.id === next.id)
  if (i >= 0) idx[i] = item
  else idx.push(item)
  await db.setMeta(G.freeSessionIndex, idx)
  return next
}

export async function createFreeSession(charIds: string[], title: string, model: FreeSession['model'], params: FreeSession['params']): Promise<FreeSession> {
  const s: FreeSession = {
    id: uid(), charIds, title, messages: [], model, params,
    lastActiveAt: now(), createdAt: now(), updatedAt: now(),
  }
  return saveFreeSession(s)
}

export async function deleteFreeSession(id: string): Promise<void> {
  const idx = await db.getMeta<FreeSessionIndexItem[]>(G.freeSessionIndex, [])
  await db.setMeta(G.freeSessionIndex, idx.filter(x => x.id !== id))
  await db.setMeta(G.freeSession(id), null)
}

// ==================== 自由模式 · 记忆 / 日常 / 留言（均按 charId） ====================

export function emptyMemory(charId: string): FreeMemory {
  return {
    charId,
    longTerm: '', facts: '', relation: '', mines: '', anniversaries: '', diaries: '',
    updatedAt: now(),
  }
}

export async function getMemory(charId: string): Promise<FreeMemory> {
  return db.getMeta<FreeMemory>(G.memory(charId), emptyMemory(charId))
}

export async function saveMemory(m: FreeMemory): Promise<void> {
  await db.setMeta(G.memory(m.charId), { ...m, updatedAt: now() })
}

export function emptyDaily(charId: string): DailyState {
  return { charId, lastActiveAt: now(), log: [] }
}

export async function getDaily(charId: string): Promise<DailyState> {
  return db.getMeta<DailyState>(G.daily(charId), emptyDaily(charId))
}

export async function saveDaily(d: DailyState): Promise<void> {
  await db.setMeta(G.daily(d.charId), d)
}

export async function setGreeting(charId: string, text: string): Promise<void> {
  await db.setMeta(G.greeting(charId), text)
}

/** 取出待投递的主动留言并清除（展示一次即消费掉） */
export async function takeGreeting(charId: string): Promise<string | null> {
  const g = await db.getMeta<string | null>(G.greeting(charId), null)
  if (g) await db.setMeta(G.greeting(charId), null)
  return g
}

export async function hasGreeting(charId: string): Promise<boolean> {
  return !!(await db.getMeta<string | null>(G.greeting(charId), null))
}

// ==================== 自检（方案 §11.8） ====================
// 「索引里有、分条缺失」= 幽灵条目（列表能看见、点开是空的）→ 可清理。
// 反向（分条在、索引缺）只是占点存储，危害小，v1 只报告不清理。

export async function auditSessions(): Promise<{ ghosts: TavernSessionIndexItem[] }> {
  const idx = await listSessions()
  const ghosts: TavernSessionIndexItem[] = []
  for (const it of idx) if (!(await getSession(it.id))) ghosts.push(it)
  return { ghosts }
}

export async function auditFreeChars(): Promise<{ ghosts: TavernCharIndexItem[] }> {
  const idx = await listFreeChars()
  const ghosts: TavernCharIndexItem[] = []
  for (const it of idx) if (!(await getFreeChar(it.id))) ghosts.push(it)
  return { ghosts }
}

export async function auditFreeSessions(): Promise<{ ghosts: FreeSessionIndexItem[] }> {
  const idx = await listFreeSessions()
  const ghosts: FreeSessionIndexItem[] = []
  for (const it of idx) if (!(await getFreeSession(it.id))) ghosts.push(it)
  return { ghosts }
}

/** 清掉幽灵会话索引项，返回清理条数 */
export async function pruneGhostSessions(): Promise<number> {
  const { ghosts } = await auditSessions()
  if (ghosts.length === 0) return 0
  const idx = await listSessions()
  await db.setSetting(K.sessionIndex, idx.filter(it => !ghosts.some(g => g.id === it.id)))
  return ghosts.length
}

export async function pruneGhostFreeChars(): Promise<number> {
  const { ghosts } = await auditFreeChars()
  if (ghosts.length === 0) return 0
  const idx = await listFreeChars()
  await db.setMeta(G.charIndex, idx.filter(it => !ghosts.some(g => g.id === it.id)))
  return ghosts.length
}

export async function pruneGhostFreeSessions(): Promise<number> {
  const { ghosts } = await auditFreeSessions()
  if (ghosts.length === 0) return 0
  const idx = await listFreeSessions()
  await db.setMeta(G.freeSessionIndex, idx.filter(it => !ghosts.some(g => g.id === it.id)))
  return ghosts.length
}
