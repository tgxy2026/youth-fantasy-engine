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
import { autoSyncTick, nextTickDelay, SYNC_TICK_FAST_MS, SYNC_TICK_MAX_MS, type AutoSyncDeps, type TickDecision } from '@/lib/app/syncAuto'

/** 默认轮询间隔：用户在写稿，20 秒足够把改动送上去，又不至于太吵 */
export const AUTO_SYNC_INTERVAL_MS = 20_000

let timer: ReturnType<typeof setTimeout> | null = null
let booting: Promise<SyncController> | null = null
let onTick: ((d: TickDecision) => void) | null = null
let visibilityBound = false

/** 当前账号 id（网页版由 App 在登录后提供；未登录返回 undefined） */
let accountId: string | undefined
export function setSyncAccountId(id: string | undefined) { accountId = id }
/**
 * 每个云端作品「最近一次提交那一版包含的对象集合」。
 * 🔴 只用来省一次清单下载；对不上就照常问服务端，**不能**当"云端一定有这些对象"的承诺
 *    —— 对象可能被 GC 掉，那时服务端回 OBJECT_MISSING，上传器会自动补传一轮。
 */
const knownHashCache = new Map<string, { revision: number; hashes: ReadonlySet<string> }>()

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
        /**
         * 先看"我上一次提交的那一版"：`baseRevision` 对得上就直接复用，**不发请求**。
         *
         * 🔴 每次推送前都要 `GET manifest?rev=base` 才知道"哪些对象云端已有"，
         *    而刚提交的那份清单就是上一次推送自己传上去的。含图作品的清单几十 KB，
         *    连续写作时每 20 秒下一份 —— 这是可省的纯浪费（主人 2026-10-31 提流量）。
         */
        const cached = knownHashCache.get(job.cloudProjectId)
        if (cached && cached.revision === job.baseRevision) return cached.hashes
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
        // 服务端回来的清单也存一份：同一 base 上如果再推一次（网络抖动重试）就不必再问
        knownHashCache.set(job.cloudProjectId, { revision: job.baseRevision, hashes: out })
        if (knownHashCache.size > 32) {
          const first = knownHashCache.keys().next().value
          if (typeof first === 'string') knownHashCache.delete(first)
        }
        return out
      },
      rememberHashes: (job, revision, hashes) => {
        knownHashCache.set(job.cloudProjectId, { revision, hashes })
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
  /**
   * 当前这一轮的等待间隔。起手用最快档，之后由 `nextTickDelay` 按结果退避。
   * 🔴 用 setTimeout 链而不是 setInterval：间隔要能变（空闲退避到 5 分钟），
   *    setInterval 改不了周期，只能清掉重建，反而更容易漏清。
   */
  let delayMs: number = SYNC_TICK_FAST_MS
  let lastRunAt = 0

  const schedule = (ms: number) => {
    if (!timer) return
    delayMs = ms
    timer = setTimeout(() => { void run() }, ms)
  }

  const run = async () => {
    // 页面不可见时跳过：合盖/切走不该继续打网络
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      schedule(SYNC_TICK_MAX_MS)
      return
    }
    let d: TickDecision | null = null
    try {
      d = await autoSyncTick(deps)
      onTick?.(d)
    } catch (e) {
      console.warn('[sync] 自动同步这一轮失败（不影响本地保存）：', e)
    }
    lastRunAt = Date.now()
    // 出错也退避：断网时每 20 秒撞一次没有任何意义
    schedule(d ? nextTickDelay(delayMs, d) : SYNC_TICK_MAX_MS)
  }

  // 占位，让 schedule 里 `if (!timer) return` 在首次调度时成立
  timer = setTimeout(() => {}, 0)
  schedule(SYNC_TICK_FAST_MS)

  /**
   * 用户一动手就把节拍拉回最快档。
   *
   * 🔴 没有这一条，退避就会伤害体验：写到第 6 分钟时下一轮在 5 分钟后，
   *    云端要过 5 分钟才看到新内容，「换设备接着写」直接废掉。
   * 🔴 用 `input` 而不是 `keydown`：粘贴、IME 上屏、拖拽插入都会发 input；
   *    也不去订阅保存状态（那要动写盘路径，本项目红线）。
   */
  const poke = () => {
    if (!timer) return
    if (delayMs <= SYNC_TICK_FAST_MS) return
    if (Date.now() - lastRunAt < 2_000) return
    schedule(SYNC_TICK_FAST_MS)
  }

  // 切回前台立刻跑一轮：用户切回来时最想看到"刚写的东西已经上去了"
  if (!visibilityBound && typeof document !== 'undefined') {
    visibilityBound = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        lastRunAt = 0
        schedule(0)
      }
    })
    document.addEventListener('input', poke, true)
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
