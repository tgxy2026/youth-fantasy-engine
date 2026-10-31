// ============ 3.3.2 · B1 同步装配（应用启动时装一次）============
//
// 【它做什么】把默认实现接上，让界面只需要 `bootSync()` + `getSyncController()`：
//   · 队列与墓碑后端 → 独立 IDB `-syncq`（打不开降级内存）
//   · 项目包 → `exportProject()`（P0 盘点已确认它就是成熟的项目级载荷）
//   · 传输 → `createHttpTransport()`（Cookie 同源）
//   · 绑定 → 项目级 `settingsKV`
//
// 🔴 **只在网页云端版 / 桌面登录态下装配**。游客版与未登录的桌面版装它没有意义
//    （没有账号就没有云端项目），反而会白白起一个定时器。
//
// 🔴 定时器**必须在页面隐藏时停**（`visibilitychange`）：笔记本合盖、切到别的程序时
//    还在每 20 秒打一次网络，是纯粹的电量与流量浪费。
import type { ProjectBundle } from '@/lib/db/projects'
import { exportProject } from '@/lib/db/projects'
import { getCurrentProjectId, ops } from '@/lib/db/core'
import type { Project } from '@/lib/types'
import { createHttpTransport } from '@/lib/sync/syncClient'
import { createSyncStateStores } from '@/lib/sync/syncQueueIdb'
import type { SyncController } from '@/lib/sync/syncController'
import { installSyncController, getSyncController } from '@/lib/sync/syncController'
import { createSettingBindingStore } from '@/lib/sync/projectBindingStore'
import { nextBindingAfterCommit } from '@/lib/sync/projectBinding'
import { fetchRemoteRevision, fetchManifest, configureCloudTransport } from '@/lib/cloud/syncApi'
import { createDesktopCloudFetch } from '@/lib/cloud/cloudTransport'
import { desktopAuthStatus, desktopOrigin } from '@/lib/cloud/desktopLogin'
import { DESKTOP } from '@/lib/app/desktop'
import { autoSyncTick, type AutoSyncDeps, type TickDecision } from '@/lib/app/syncAuto'

/** 默认轮询间隔：用户在写稿，20 秒足够把改动送上去，又不至于太吵 */
export const AUTO_SYNC_INTERVAL_MS = 20_000

let timer: ReturnType<typeof setInterval> | null = null
let booting: Promise<SyncController> | null = null
let onTick: ((d: TickDecision) => void) | null = null
let visibilityBound = false

/** 当前账号 id（网页版由 App 在登录后提供；未登录返回 undefined） */
let accountId: string | undefined
export function setSyncAccountId(id: string | undefined) { accountId = id }
/** 当前账号 id（建立绑定时要写进绑定记录，用于"换账号后绑定作废"的判定） */
export function getSyncAccountId(): string | undefined { return accountId }

/**
 * 桌面登录态：把同步请求切到主进程 Bearer 通道。
 * 🔴 未登录 / 拿不到 origin 时**复原默认通道**（网页同源 Cookie）—— 登出后不能继续用旧通道。
 * @returns 是否装上了 Bearer 通道
 */
export async function configureDesktopTransportIfSignedIn(): Promise<boolean> {
  if (!DESKTOP) return false
  try {
    const st = await desktopAuthStatus()
    const origin = st.signedIn ? await desktopOrigin() : ''
    const transport = origin ? createDesktopCloudFetch(origin) : null
    if (origin && transport) {
      configureCloudTransport({ base: origin, fetch: transport })
      return true
    }
    configureCloudTransport(null)
  } catch (e) {
    console.warn('[sync] 桌面账号通道装配失败，保持默认通道：', e)
  }
  return false
}

/**
 * 装好同步能力（幂等）。
 * @returns 控制器；任何一步失败都返回可用的降级版（内存队列），**不抛**。
 */
export async function bootSync(): Promise<SyncController> {
  const existing = getSyncController()
  if (existing) return existing
  if (booting) return booting

  booting = (async () => {
    // 桌面登录态：同步请求要走主进程的 Bearer 通道（本机页面没有 `/api/v2` 路由，也没有 Cookie）。
    await configureDesktopTransportIfSignedIn()
    // 🔴 队列打不开就降级内存：同步可以退让，编辑器不能因为同步起不来而卡住
    const { queue, tombstones } = await createSyncStateStores((reason) => {
      console.warn('[sync] 本机同步状态库打不开，已降级为内存队列（重启会丢任务）：', reason)
    })
    // 🔴 提交成功后必须回写绑定：不回写就会出现「本机基于第 0 版」+ 下一轮假冲突
    //    （2026-10-31 实机验证抓到的阻断问题，见 `nextBindingAfterCommit` 注释）
    const bindingStore = createSettingBindingStore()
    const controller = installSyncController({
      store: queue,
      tombstones,
      transport: createHttpTransport(),
      /**
       * 云端基线已有的对象不必重传。
       *
       * 🔴 没有这段就等于「每 20 秒重传整本书」：自动同步一跳，改一个字就把
       *    40 MiB 的含图作品再上行一次（2026-10-31 实机验证发现：一次推送
       *    12 个对象、其中 6 个是同一个空数组哈希）。
       * 清单拿不到就返回空集 ⇒ 退回全量上传（慢但正确）。
       */
      loadKnownHashes: async (job) => {
        const out = new Set<string>()
        if (job.baseRevision <= 0) return out
        const man = await fetchManifest(job.cloudProjectId, job.baseRevision)
        if (!man) return out
        const take = (arr: unknown) => {
          if (!Array.isArray(arr)) return
          for (const x of arr) {
            const h = x && typeof x === 'object' ? (x as { hash?: unknown }).hash : null
            if (typeof h === 'string' && h) out.add(h)
          }
        }
        take((man as { objects?: unknown }).objects)
        take((man as { assets?: unknown }).assets)
        return out
      },
      onCommitted: async ({ projectId, cloudProjectId, revision }) => {
        try {
          const cur = await bindingStore.get(projectId)
          const next = nextBindingAfterCommit(cur, cloudProjectId, revision, Date.now())
          if (next) await bindingStore.set(projectId, next)
        } catch (e) {
          // 回写失败不该让"已提交"变成失败：下一次 tick 会用云端 revision 兜回来
          console.warn('[sync] 回写绑定失败（不影响本次提交）：', e)
        }
      },
      loadBundle: async (pid: string) => {
        try { return (await exportProject(pid)) as unknown as ProjectBundle } catch { return null }
      },
    })
    // 启动准备：崩溃恢复 + 清理超期任务。失败不影响后续（下次启动再来）
    try { await controller.init() } catch { /* ignore */ }
    return controller
  })()

  return booting
}

/** 装配真实依赖给调度器 */
function makeAutoDeps(controller: SyncController): AutoSyncDeps {
  const bindingStore = createSettingBindingStore()
  return {
    getCurrentProject: async () => {
      const id = getCurrentProjectId()
      if (!id) return null
      try {
        const p = await ops.get<Project>('projects', id)
        return p ? { id: p.id, updatedAt: Number(p.updatedAt) || 0 } : null
      } catch {
        return null
      }
    },
    getBinding: (pid: string) => bindingStore.get(pid),
    getRemoteRevision: (cloudPid: string) => fetchRemoteRevision(cloudPid),
    controller,
    getAccountId: () => accountId,
  }
}

/**
 * 起自动同步。
 * @param cb 每轮结果的回调（界面据此更新徽标；不传就纯后台跑）
 */
export async function startAutoSync(cb?: (d: TickDecision) => void): Promise<void> {
  const controller = await bootSync()
  onTick = cb ?? null
  if (timer) return

  const deps = makeAutoDeps(controller)
  const run = async () => {
    // 页面不可见时跳过：合盖/切走不该继续打网络
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      const d = await autoSyncTick(deps)
      onTick?.(d)
    } catch (e) {
      console.warn('[sync] 自动同步这一轮失败（不影响本地保存）：', e)
    }
  }

  timer = setInterval(() => { void run() }, AUTO_SYNC_INTERVAL_MS)

  // 切回前台立刻跑一轮：用户切回来时最想看到"刚写的东西已经上去了"
  if (!visibilityBound && typeof document !== 'undefined') {
    visibilityBound = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void run()
    })
  }
  void run()
}

/** 停掉定时器（退出登录 / 关闭云端模式 / 组件卸载到不该同步的页面） */
export function stopAutoSync(): void {
  if (timer) { clearInterval(timer); timer = null }
  onTick = null
}

/** 现在是否在自动同步（界面显示开关状态用） */
export function isAutoSyncRunning(): boolean {
  return timer !== null
}
