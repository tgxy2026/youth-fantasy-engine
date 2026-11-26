// ============ WCP 本地 Agent 工作区 · 保鲜调度（3.7.4 · W3）============
//
// 三档策略（D5，见规划 §2.2）：
//   · `remind-on-open` —— 打开项目 / 回到 WCP 入口时探活，有新改动只提示、不静默覆盖；
//   · `auto-interval`  —— 按 5/10/15/30 分钟检查指纹，**有改动才**原位增量写盘；
//   · `manual`         —— 只响应「立即更新工作区」。
//
// 🔴 三项铁律：
//   ① 原位原子覆写，不产生任何历史副本；
//   ② 总指纹未变 ⇒ 零写盘（`planWcpWorkspace` 的 `skipped`）；
//   ③ 单项目串行写锁：定时刷新与手动刷新不会并发改同一目录。
// 🔴 本模块只返回结果，不弹 Toast、不碰 UI —— 提示交给调用方（App 调度 hook / 设置面板）。
import * as db from '@/lib/db'
import {
  collectWcpWorkspaceData,
  type WcpWorkspaceCollectedData,
  type WcpWorkspaceCollectInput,
} from '@/lib/wcp/wcpCollect'
import { wcpWorkspaceFolderName, planWcpWorkspace, buildWcpWorkspaceAgentPrompt, type WcpWorkspaceBuildInput } from '@/lib/wcp/wcpWorkspaceBuilder'
import {
  downloadWcpWorkspaceZip,
  hasWcpWorkspaceBridge,
  workspaceApplyPlan,
  workspaceDefaultRoot,
  workspaceDiagnose,
} from '@/lib/wcp/wcpWorkspaceClient'
import {
  loadWcpGlobalConfig,
  loadWcpProjectState,
  markWcpWorkspaceSynced,
} from '@/lib/wcp/wcpSettings'
import type { WcpGlobalConfig, WcpProjectState, WcpSceneId, WcpWorkspaceSyncMode } from '@/lib/wcp/wcpTypes'

export type WcpWorkspaceFreshness = 'unsupported' | 'never' | 'fresh' | 'stale'

export interface WcpWorkspaceStatus {
  freshness: WcpWorkspaceFreshness
  /** 徽标文案（「已最新 · 3 分钟前」/「有新改动待同步」/「尚未初始化」） */
  label: string
  projectId: string
  projectName: string
  root: string
  folder: string
  mode: WcpWorkspaceSyncMode
  intervalMin: number
  /** 只有「曾同步过」或用户显式启用才参与提醒 / 定时 */
  enabled: boolean
  writable: boolean
  lastSyncAt: number | null
  workspaceFingerprint: string
  /** 探活过程中的如实提示（读取失败 / 缺正文等） */
  notes: string[]
  error: string
}

export interface WcpWorkspaceSyncOptions {
  pid?: string
  reason: 'manual' | 'interval' | 'remind' | 'export'
  /** 指定场景（业务页导出时传入）；缺省沿用上次同步场景 */
  scene?: WcpSceneId
  chapterId?: string
  chapterNo?: number
  chapterTitle?: string
  draft?: string
  selectedText?: string
  focusCharacterId?: string
  focusCharacterName?: string
  extraInstruction?: string
  /** 无写盘桥接时是否下载 `.zip`（业务导出 / 设置页手动更新为 true） */
  allowZipFallback?: boolean
}

export interface WcpWorkspaceSyncResult {
  ok: boolean
  /** 总指纹未变、零写盘 */
  skipped: boolean
  /** desktop = 已写盘；zip = 无桥接、已打包下载；none = 未做任何事 */
  mode: 'desktop' | 'zip' | 'none'
  projectId: string
  projectName: string
  root: string
  folder: string
  workspaceFingerprint: string
  wrote: number
  deleted: number
  notes: string[]
  error: string
  /** 一键复制提示词（写盘成功后才有；zip 模式也给，便于作者自己解压后使用） */
  prompt: string
}

// ---------- 纯判定（单测可逐字钉住） ----------

/**
 * 新鲜度判定。
 * 🔴 只有「记录过指纹且与当前一致」才是 fresh —— 从未同步 ≠ 最新。
 */
export function evaluateWcpWorkspaceFreshness(
  lastFingerprint: string,
  currentFingerprint: string,
  lastSyncAt: number | null,
): WcpWorkspaceFreshness {
  if (!lastSyncAt && !lastFingerprint) return 'never'
  if (!lastFingerprint || !currentFingerprint) return lastSyncAt ? 'stale' : 'never'
  return lastFingerprint === currentFingerprint ? 'fresh' : 'stale'
}

/** 定时刷新是否到点（首次立即检查一次） */
export function isWcpAutoSyncDue(
  mode: WcpWorkspaceSyncMode,
  intervalMin: number,
  lastAttemptAt: number,
  now = Date.now(),
): boolean {
  if (mode !== 'auto-interval') return false
  const minutes = Number.isFinite(intervalMin) && intervalMin > 0 ? intervalMin : 10
  if (!Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0) return true
  return now - lastAttemptAt >= minutes * 60_000
}

/** 徽标里的相对时间（「刚刚」/「N 分钟前」/「N 小时前」/「N 天前」） */
function syncAgeLabel(at: number | null, now: number): string {
  if (!at) return ''
  const diff = Math.max(0, now - at)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function statusLabel(freshness: WcpWorkspaceFreshness, lastSyncAt: number | null): string {
  if (freshness === 'unsupported') return '当前形态不支持本地工作区'
  if (freshness === 'never') return '尚未初始化'
  if (freshness === 'stale') return '有新改动待同步'
  const age = syncAgeLabel(lastSyncAt, Date.now())
  return age ? `已最新 · ${age}` : '已最新'
}

// ---------- 探活缓存 ----------

interface ProbeCacheEntry {
  key: string
  at: number
  value: WcpWorkspaceStatus
}
let probeCache: ProbeCacheEntry | null = null
const PROBE_TTL_MS = 15_000

/** 设置页保存配置 / 手动同步后强制下次重新探活 */
export function invalidateWcpWorkspaceProbe(): void {
  probeCache = null
}

async function readState(pid: string): Promise<{ cfg: WcpGlobalConfig; ps: WcpProjectState; projectName: string }> {
  const [cfg, ps] = await Promise.all([loadWcpGlobalConfig(), loadWcpProjectState(pid)])
  let projectName = '未命名作品'
  try {
    projectName = (await db.getProject(pid))?.name?.trim() || '未命名作品'
  } catch { /* 书名读不到不影响状态展示 */ }
  return { cfg, ps, projectName }
}

async function resolveRoot(cfg: WcpGlobalConfig): Promise<string> {
  if (cfg.workspaceRoot) return cfg.workspaceRoot
  return workspaceDefaultRoot()
}

function emptyStatus(projectId: string, projectName: string, cfg: WcpGlobalConfig, enabled: boolean): WcpWorkspaceStatus {
  return {
    freshness: hasWcpWorkspaceBridge() ? 'never' : 'unsupported',
    label: hasWcpWorkspaceBridge() ? '尚未初始化' : '当前形态不支持本地工作区',
    projectId,
    projectName,
    root: cfg.workspaceRoot,
    folder: projectId ? wcpWorkspaceFolderName(projectName, projectId) : '',
    mode: cfg.workspaceSyncMode,
    intervalMin: cfg.workspaceSyncIntervalMin,
    enabled,
    writable: false,
    lastSyncAt: null,
    workspaceFingerprint: '',
    notes: [],
    error: '',
  }
}

/**
 * 探活当前项目的工作区状态（新鲜度 / 路径 / 可写性）。
 *
 * 🔴 会做一次完整取材（与真正同步同一口径）才能得出总指纹；结果缓存 15 秒，
 *    避免设置页每次渲染都打一遍库。
 */
export async function probeWcpWorkspace(
  pid = db.getCurrentProjectId(),
  options: { force?: boolean; scene?: WcpSceneId } = {},
): Promise<WcpWorkspaceStatus> {
  if (!pid) return {
    freshness: 'never', label: '尚未初始化', projectId: '', projectName: '', root: '', folder: '',
    mode: 'remind-on-open', intervalMin: 10, enabled: false, writable: false, lastSyncAt: null,
    workspaceFingerprint: '', notes: [], error: '当前没有打开任何作品。',
  }
  const { cfg, ps, projectName } = await readState(pid)
  if (!hasWcpWorkspaceBridge()) {
    const st = emptyStatus(pid, projectName, cfg, ps.workspaceEnabled || !!ps.lastWorkspaceSyncAt)
    return { ...st, root: cfg.workspaceRoot, notes: ['网页版 / 便携版没有本地写盘桥接；可用「下载离线工作区 .zip」。'] }
  }
  const root = await resolveRoot(cfg)
  const folder = wcpWorkspaceFolderName(projectName, pid)
  const scene = options.scene ?? (ps.lastWorkspaceScene || 'chapter-continue')
  const cacheKey = `${pid}|${scene}|${cfg.syncFullChapters}|${root}|${folder}`
  if (!options.force && probeCache && probeCache.key === cacheKey && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return probeCache.value
  }

  try {
    const collected = await collectWcpWorkspaceData({
      scene,
      includeFullChapters: cfg.syncFullChapters,
      baseModules: ps.baseModules,
    })
    const input: WcpWorkspaceBuildInput = {
      projectId: pid,
      projectName: collected.projectName,
      scene,
      sections: collected.sections,
      ...(collected.activeChapterId ? { activeChapterId: collected.activeChapterId } : {}),
      ...(collected.activeChapterNo ? { activeChapterNo: collected.activeChapterNo } : {}),
      ...(collected.activeChapterTitle ? { activeChapterTitle: collected.activeChapterTitle } : {}),
      ...(collected.volumeTitle ? { volumeTitle: collected.volumeTitle } : {}),
      includeFullChapters: cfg.syncFullChapters,
      fullChapters: collected.chapters,
      baseFingerprint: collected.baseFingerprint,
      previous: {
        fingerprint: ps.lastWorkspaceFingerprint,
        hashes: ps.lastWorkspaceFileHashes,
        syncedAt: ps.lastWorkspaceSyncAt,
      },
    }
    const plan = planWcpWorkspace(input)
    const diag = await workspaceDiagnose(root)
    const freshness = evaluateWcpWorkspaceFreshness(ps.lastWorkspaceFingerprint, plan.workspaceFingerprint, ps.lastWorkspaceSyncAt)
    const status: WcpWorkspaceStatus = {
      freshness,
      label: statusLabel(freshness, ps.lastWorkspaceSyncAt),
      projectId: pid,
      projectName: collected.projectName,
      root,
      folder,
      mode: cfg.workspaceSyncMode,
      intervalMin: cfg.workspaceSyncIntervalMin,
      enabled: ps.workspaceEnabled || !!ps.lastWorkspaceSyncAt,
      writable: diag.writable,
      lastSyncAt: ps.lastWorkspaceSyncAt,
      workspaceFingerprint: plan.workspaceFingerprint,
      notes: collected.notes.slice(0, 6),
      error: diag.writable ? '' : diag.error,
    }
    probeCache = { key: cacheKey, at: Date.now(), value: status }
    return status
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return {
      ...emptyStatus(pid, projectName, cfg, ps.workspaceEnabled || !!ps.lastWorkspaceSyncAt),
      root,
      folder,
      error: `工作区探活失败：${message}`,
      notes: [],
    }
  }
}

// ---------- 串行写锁 ----------

const projectChains = new Map<string, Promise<unknown>>()

function withProjectLock<T>(pid: string, task: () => Promise<T>): Promise<T> {
  const prev = projectChains.get(pid) ?? Promise.resolve()
  const run = prev.then(task, task)
  projectChains.set(pid, run.then(() => undefined, () => undefined))
  return run
}

// ---------- 同步 ----------

function emptyResult(pid: string, projectName: string, root: string, folder: string, error: string): WcpWorkspaceSyncResult {
  return {
    ok: false, skipped: false, mode: 'none', projectId: pid, projectName, root, folder,
    workspaceFingerprint: '', wrote: 0, deleted: 0, notes: [], error, prompt: '',
  }
}

/** 切书安全中止：不写盘、不改原书状态，并如实告诉调用方原因 */
function projectChangedResult(pid: string, projectName: string, root: string, folder: string): WcpWorkspaceSyncResult {
  return emptyResult(pid, projectName, root, folder, '作品已切换，本次工作区更新已安全中止（未写盘、未改任何书的状态）。')
}

function collectOptionsFor(
  opts: WcpWorkspaceSyncOptions,
  scene: WcpSceneId,
  cfg: WcpGlobalConfig,
  ps: WcpProjectState,
): WcpWorkspaceCollectInput {
  return {
    scene,
    includeFullChapters: cfg.syncFullChapters,
    baseModules: ps.baseModules,
    ...(opts.chapterId ? { chapterId: opts.chapterId } : {}),
    ...(opts.chapterNo ? { chapterNo: opts.chapterNo } : {}),
    ...(opts.chapterTitle ? { chapterTitle: opts.chapterTitle } : {}),
    ...(opts.draft != null ? { draft: opts.draft } : {}),
    ...(opts.selectedText != null ? { selectedText: opts.selectedText } : {}),
    ...(opts.focusCharacterId ? { focusCharacterId: opts.focusCharacterId } : {}),
    ...(opts.focusCharacterName ? { focusCharacterName: opts.focusCharacterName } : {}),
    ...(opts.extraInstruction ? { extraInstruction: opts.extraInstruction } : {}),
  }
}

/**
 * 由采集结果构造 `WcpWorkspaceBuildInput`（桌面写盘与 `.zip` 兜底共用）。
 *
 * 🔴 复核修复 P2-4：zip 分支也必须带 `activeContext` 的四项坐标 ——
 *    否则 manifest / task.md 与桌面版不一致，Agent 拿到的“当前章”是空的。
 */
export function buildWcpWorkspacePlanInput(args: {
  projectId: string
  scene: WcpSceneId
  collected: WcpWorkspaceCollectedData
  includeFullChapters: boolean
  extraInstruction?: string
  previous?: WcpWorkspaceBuildInput['previous']
}): WcpWorkspaceBuildInput {
  const { projectId, scene, collected } = args
  return {
    projectId,
    projectName: collected.projectName,
    scene,
    sections: collected.sections,
    includeFullChapters: args.includeFullChapters,
    fullChapters: collected.chapters,
    baseFingerprint: collected.baseFingerprint,
    ...(collected.activeChapterId ? { activeChapterId: collected.activeChapterId } : {}),
    ...(collected.activeChapterNo ? { activeChapterNo: collected.activeChapterNo } : {}),
    ...(collected.activeChapterTitle ? { activeChapterTitle: collected.activeChapterTitle } : {}),
    ...(collected.volumeTitle ? { volumeTitle: collected.volumeTitle } : {}),
    ...(args.extraInstruction ? { extraInstruction: args.extraInstruction } : {}),
    ...(args.previous ? { previous: args.previous } : {}),
  }
}

/**
 * 立即同步工作区（单项目串行）。
 *
 * @param opts.reason 仅用于调用方语义；本函数行为完全由配置决定。
 */
export async function syncWcpWorkspace(opts: WcpWorkspaceSyncOptions): Promise<WcpWorkspaceSyncResult> {
  const pid = opts.pid ?? db.getCurrentProjectId()
  if (!pid) return emptyResult('', '', '', '', '当前没有打开任何作品。')
  const { cfg, ps, projectName } = await readState(pid)
  const scene = opts.scene ?? (ps.lastWorkspaceScene || 'chapter-continue')

  const stillCurrent = () => db.getCurrentProjectId() === pid

  return withProjectLock(pid, async () => {
    let folder = wcpWorkspaceFolderName(projectName, pid)
    let root = ''
    try {
      // 复核修复 P2-5：取材前先校验。用户已切书时绝不能拿 A 书的 pid 去读 B 书的库。
      if (!stillCurrent()) return projectChangedResult(pid, projectName, '', folder)

      root = await resolveRoot(cfg)
      const zipFallback = !root && !!opts.allowZipFallback
      if (!root && !zipFallback) {
        return emptyResult(pid, projectName, '', folder, '尚未取得工作区根目录；请到「模型设置 → WCP 模式」重新选择目录。')
      }

      const collected = await collectWcpWorkspaceData(collectOptionsFor(opts, scene, cfg, ps))
      // 取材期间可能发生切书：返回的 projectId 不是本书就立即中止
      if (!stillCurrent() || (collected.projectId && collected.projectId !== pid)) {
        return projectChangedResult(pid, projectName, root, folder)
      }
      folder = wcpWorkspaceFolderName(collected.projectName, pid)
      const previous = zipFallback
        ? undefined
        : {
          fingerprint: ps.lastWorkspaceFingerprint,
          hashes: ps.lastWorkspaceFileHashes,
          syncedAt: ps.lastWorkspaceSyncAt,
        }
      const plan = planWcpWorkspace(buildWcpWorkspacePlanInput({
        projectId: pid,
        scene,
        collected,
        includeFullChapters: cfg.syncFullChapters,
        ...(opts.extraInstruction ? { extraInstruction: opts.extraInstruction } : {}),
        ...(previous ? { previous } : {}),
      }))

      // 网页 / 便携：无写盘桥接，打包同结构 `.zip`（与桌面版共用同一份 activeContext）
      if (zipFallback) {
        if (!stillCurrent()) return projectChangedResult(pid, collected.projectName, '', folder)
        downloadWcpWorkspaceZip(plan.files, collected.projectName, pid)
        return {
          ok: true, skipped: false, mode: 'zip', projectId: pid, projectName: collected.projectName,
          root: '', folder, workspaceFingerprint: plan.workspaceFingerprint,
          wrote: plan.files.length, deleted: 0, notes: collected.notes,
          error: '', prompt: buildWcpWorkspaceAgentPrompt(`（解压后的工作区目录）${folder}`, collected.projectName),
        }
      }

      const prompt = buildWcpWorkspaceAgentPrompt(`${root.replace(/[\\/]+$/, '')}${root.includes('\\') ? '\\' : '/'}${folder}`, collected.projectName)
      const base = {
        projectId: pid, projectName: collected.projectName, root, folder,
        workspaceFingerprint: plan.workspaceFingerprint, notes: collected.notes, prompt,
      }

      if (plan.skipped) {
        if (!stillCurrent()) return projectChangedResult(pid, collected.projectName, root, folder)
        await markWcpWorkspaceSynced(plan.workspaceFingerprint, Object.fromEntries(plan.files.map(f => [f.path, f.hash])), scene, pid)
        invalidateWcpWorkspaceProbe()
        return { ok: true, skipped: true, mode: 'desktop', wrote: 0, deleted: 0, error: '', ...base }
      }

      // 写盘前最后一道闸：切书后绝不把新状态记到原作品上
      if (!stillCurrent()) return projectChangedResult(pid, collected.projectName, root, folder)
      const applied = await workspaceApplyPlan(root, folder, plan)
      if (!applied.ok) {
        return { ...base, ok: false, skipped: false, mode: 'desktop', wrote: applied.written ?? 0, deleted: applied.deleted ?? 0, error: applied.error || '写入工作区失败。' }
      }
      if (!stillCurrent()) {
        return emptyResult(pid, collected.projectName, root, folder,
          '作品已切换：已停止记录同步状态；本次已完成的文件写入属于原作品工作区。')
      }
      await markWcpWorkspaceSynced(plan.workspaceFingerprint, Object.fromEntries(plan.files.map(f => [f.path, f.hash])), scene, pid)
      invalidateWcpWorkspaceProbe()
      return {
        ...base, ok: true, skipped: false, mode: 'desktop',
        wrote: applied.written ?? 0, deleted: applied.deleted ?? 0, error: '',
      }
    } catch (e) {
      return emptyResult(pid, projectName, root, folder, e instanceof Error ? e.message : String(e))
    }
  })
}

// ---------- 定时 / 打开提醒 ----------

const lastAttemptAt = new Map<string, number>()

/**
 * 定时自动刷新（`auto-interval`）。
 * 🔴 未启用 / 未到点 / 指纹已最新 ⇒ 直接返回 null，零写盘。
 */
export async function maybeAutoSyncWcpWorkspace(
  pid = db.getCurrentProjectId(),
  options: { force?: boolean } = {},
): Promise<WcpWorkspaceSyncResult | null> {
  if (!pid) return null
  const { cfg, ps } = await readState(pid)
  if (cfg.workspaceSyncMode !== 'auto-interval') return null
  if (!ps.workspaceEnabled && !ps.lastWorkspaceSyncAt) return null
  if (!options.force && !isWcpAutoSyncDue(cfg.workspaceSyncMode, cfg.workspaceSyncIntervalMin, lastAttemptAt.get(pid) ?? 0)) return null
  lastAttemptAt.set(pid, Date.now())
  const status = await probeWcpWorkspace(pid, { force: true })
  // never = 已启用但还没初始化过：定时模式第一次也要把工作区建起来
  if (status.freshness !== 'stale' && status.freshness !== 'never') return null
  return syncWcpWorkspace({ pid, reason: 'interval', ...(ps.lastWorkspaceScene ? { scene: ps.lastWorkspaceScene } : {}) })
}
