/**
 * 跑团互动 · 存储封装（索引 ＋ 分条）
 *
 * 【归属】D1=A —— 跑团局**随项目**：走项目级 `settingsKV`
 *   （`db.getSetting/setSetting` 会自动拼 `${projectId}::` 前缀），跟着某本书走、导出项目一并带走。
 *   与「剧情推演」同类；自由对话是全局 meta（那是「陪伴」，不绑书），跑团**不是**。
 *
 * 【为什么索引与分条分开】与 `tavern/store.ts` 同因：一局的 `messages` / `actions` 可能很长，
 *   若把列表也塞进一个 key，列清单就要把全部正文读进内存、云同步载荷也会失控。
 *
 * 【铁律】索引与分条**必须成对读写** —— 只写一边会出现「列表里有、点开是空的」幽灵条目。
 *   （2026-09-22 六维审计那条「同一个病的所有路径要一次找齐」就是这类。）
 *
 * 本文件是纯逻辑，不含 React。
 */
import * as db from '@/lib/db'
import { uid } from '@/lib/id'
import { emptyVars } from '@/lib/tavern/vars'
import type {
  RunSession, RunIndexItem, RunCompanion, RunAction,
  RunCheckpoint, RunClue, RunSecret, RunEnding,
} from '@/lib/run/runTypes'

// ==================== 存储键 ====================
// 项目级（会经 db.getSetting 自动加项目前缀）
const K = {
  runIndex: 'run.sessionIndex',
  run: (id: string) => `run.session.${id}`,
} as const

function now() { return Date.now() }

// ==================== 列表 / 读取 ====================

export async function listRuns(): Promise<RunIndexItem[]> {
  const list = await db.getSetting<RunIndexItem[]>(K.runIndex, [])
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getRun(id: string): Promise<RunSession | null> {
  return db.getSetting<RunSession | null>(K.run(id), null)
}

// ==================== 索引项拼装 ====================

function companionBrief(companions: RunCompanion[]): string {
  return companions.map(c => c.name).filter(Boolean).join('、')
}

function indexItemOf(s: RunSession): RunIndexItem {
  const acquired = s.clues.filter(c => c.acquired).length
  const reached = s.endings.find(e => e.reached)
  return {
    id: s.id,
    title: s.title,
    storyId: s.storyId,
    worldBrief: s.worldRef ? `${s.worldRef.worldName ?? '世界'} v${s.worldRef.version}` : undefined,
    companionBrief: companionBrief(s.companions),
    clueCount: acquired,
    reachedEnding: reached?.name,
    updatedAt: s.updatedAt,
  }
}

// ==================== 保存 / 删除 ====================

/**
 * 保存一局（**索引与分条成对写**）。调用方传完整对象；`updatedAt` 由本函数统一刷新。
 * 返回刷新过 updatedAt 的会话，便于调用方继续持有最新副本。
 */
export async function saveRun(s: RunSession): Promise<RunSession> {
  const next: RunSession = { ...s, updatedAt: now() }
  await db.setSetting(K.run(next.id), next)
  const idx = await db.getSetting<RunIndexItem[]>(K.runIndex, [])
  const item = indexItemOf(next)
  const i = idx.findIndex(x => x.id === next.id)
  if (i >= 0) idx[i] = item
  else idx.push(item)
  await db.setSetting(K.runIndex, idx)
  return next
}

export async function deleteRun(id: string): Promise<void> {
  const idx = await db.getSetting<RunIndexItem[]>(K.runIndex, [])
  await db.setSetting(K.runIndex, idx.filter(x => x.id !== id))
  // 分条置空（KV 无 delete 语义时的等价做法：置空后不再被读取）
  await db.setSetting(K.run(id), null)
}

export async function renameRun(id: string, title: string): Promise<void> {
  const s = await getRun(id)
  if (!s) return
  await saveRun({ ...s, title: title.trim() || s.title })
}

// ==================== 新建 ====================

/**
 * 新建一局（**尚未落库** —— 由调用方决定何时 `saveRun`）。
 *
 * @param model  模型引用（复用项目 provider 列表里的 id，不复制模型配置）
 * @param params 参数（沿用酒馆那套；缺省空对象，跑时再取）
 */
export function newRun(
  title: string,
  model: RunSession['model'],
  params: RunSession['params'] = {},
): RunSession {
  const t = now()
  return {
    id: uid(),
    schema: 1,
    title: title.trim() || '未命名跑团',
    companions: [],
    clues: [],
    secrets: [],
    endings: [],
    actions: [],
    messages: [],
    vars: emptyVars(),
    model,
    params,
    createdAt: t,
    updatedAt: t,
  }
}

// ==================== 检查点 / 回滚（存档）====================
//
// 复用 `tavern/types` 的 `TavernCheckpoint` 形状。语义与剧情推演那套一致：
//   打点 = 连「记忆 + 水位线」一起存（回滚要还原的是「那一刻的完整状态」）；
//   回滚 = 消息截回那一刻，并**先把当前进度存进 undoSnapshot** ⇒ 回滚本身可撤销。
//
// 🔴 为什么对跑团还要额外存 actions / clues：跑团里「行动流水」与「已获线索」也是进度的一部分 ——
//    只截 messages 会让「回到那一刻」变成「话少了但线索还在」的错位状态。

export interface RunRollbackUndo {
  messages: RunSession['messages']
  actions: RunAction[]
  clues: RunClue[]
  secrets: RunSecret[]
  endings: RunEnding[]
  flags: string[]
  memory?: string
  watermark?: RunSession['watermark']
  at: number
}

/** 存档之前先把当前进度留下一份，供「撤销上次回滚」 */
export interface RunSessionWithUndo extends RunSession {
  undoSnapshot?: RunRollbackUndo
}

function snapshotOf(s: RunSessionWithUndo): RunRollbackUndo {
  return {
    messages: s.messages,
    actions: s.actions,
    clues: s.clues,
    secrets: s.secrets,
    endings: s.endings,
    flags: [...(s.flags ?? [])],
    memory: s.memory,
    watermark: s.watermark,
    at: now(),
  }
}

/** 深拷贝一小段（线索 / 秘密 / 结局都是浅对象，够用；避免快照与现役共享引用） */
function cloneClues(list: RunClue[]): RunClue[] { return list.map(c => ({ ...c })) }
function cloneSecrets(list: RunSecret[]): RunSecret[] {
  return list.map(x => ({ ...x, revealOn: x.revealOn ? { ...x.revealOn, clueIds: x.revealOn.clueIds ? [...x.revealOn.clueIds] : undefined, flags: x.revealOn.flags ? [...x.revealOn.flags] : undefined } : undefined }))
}
function cloneEndings(list: RunEnding[]): RunEnding[] {
  return list.map(x => ({ ...x, condition: { ...x.condition, secretIds: x.condition.secretIds ? [...x.condition.secretIds] : undefined, clueIds: x.condition.clueIds ? [...x.condition.clueIds] : undefined, varMin: x.condition.varMin ? { ...x.condition.varMin } : undefined } }))
}

/** 打一个检查点（连记忆、行动、线索、秘密、结局一起存） */
export function addRunCheckpoint(s: RunSessionWithUndo, label = ''): RunSessionWithUndo {
  const cp: RunCheckpoint = {
    id: uid(),
    label: label.trim(),
    messageCount: s.messages.length,
    watermark: s.watermark,
    memory: s.memory,
    at: now(),
    actionCount: s.actions.length,
    clues: cloneClues(s.clues),
    secrets: cloneSecrets(s.secrets),
    endings: cloneEndings(s.endings),
    flags: [...(s.flags ?? [])],
  }
  return { ...s, checkpoints: [...(s.checkpoints ?? []), cp], updatedAt: now() }
}

export function dropRunCheckpoint(s: RunSessionWithUndo, cpId: string): RunSessionWithUndo {
  return { ...s, checkpoints: (s.checkpoints ?? []).filter(c => c.id !== cpId), updatedAt: now() }
}

/**
 * 回到某个检查点。**会把当前进度先存进 `undoSnapshot`**（只留一层，不做无限套娃）。
 * 找不到该检查点返回 null（调用方据此提示「存档不存在」）。
 */
export function rollbackRunToCheckpoint(s: RunSessionWithUndo, cpId: string): RunSessionWithUndo | null {
  const cp = (s.checkpoints ?? []).find(c => c.id === cpId)
  if (!cp) return null
  return {
    ...s,
    messages: s.messages.slice(0, cp.messageCount),
    // 行动流水按「当时条数」截回 —— 每条 action 与一轮 AI 回复成对，条数即进度水位
    actions: s.actions.slice(0, cp.actionCount),
    clues: cloneClues(cp.clues),
    secrets: cloneSecrets(cp.secrets),
    endings: cloneEndings(cp.endings),
    flags: [...(cp.flags ?? [])],
    memory: cp.memory,
    watermark: cp.watermark,
    undoSnapshot: snapshotOf(s),
    updatedAt: now(),
  }
}

/** 撤销上一次回滚（没有快照时原样返回；调用方按 `undoSnapshot` 决定按钮显不显示） */
export function undoRunRollback(s: RunSessionWithUndo): RunSessionWithUndo {
  const u = s.undoSnapshot
  if (!u) return s
  return {
    ...s,
    messages: u.messages,
    actions: u.actions,
    clues: u.clues,
    secrets: u.secrets,
    endings: u.endings,
    flags: [...(u.flags ?? [])],
    memory: u.memory,
    watermark: u.watermark,
    undoSnapshot: undefined,
    updatedAt: now(),
  }
}
