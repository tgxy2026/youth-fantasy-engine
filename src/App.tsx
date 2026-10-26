import FailureNotice from '@/components/common/FailureNotice'
import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react'
import { Z } from '@/lib/app/zLayer'
import WorkspaceSidebar from '@/components/app/WorkspaceSidebar'
import Dashboard from '@/components/app/Dashboard'
import NovelEditor from '@/components/editor/NovelEditor'
import FormSheet from '@/components/sheets/FormSheet'
import WorldSetSheet from '@/components/sheets/WorldSetSheet'
import ParallelSetSheet from '@/components/sheets/ParallelSetSheet'
import TableSheet from '@/components/sheets/TableSheet'
import ChangelogHealthNote from '@/components/app/ChangelogHealthNote'
import CharacterSheet from '@/components/world/CharacterSheet'
import OutlineSheet from '@/components/outline/OutlineSheet'
import ProjectHub from '@/components/app/ProjectHub'
import AboutPage from '@/components/app/AboutPage'
import UpdateDialog from '@/components/app/UpdateDialog'
import { checkUpdate, isAutoCheckOn, type LatestRelease } from '@/lib/app/versionCheck'
import { abortRunIfProjectChanged } from '@/lib/creative/creativeSession'
import { getTab, tabVisible, refreshVolumeTabs, LOCKED_IDS, type VisCtx } from '@/lib/schema'
import { migrateAliasesToFieldDefinitions } from '@/lib/templates/fieldDefinition'
import { DEFAULT_PACK, normalizeGenrePack, setActivePack } from '@/lib/schemaTemplates/index'
import { isWorldSetTab, isParallelSetTab } from '@/lib/world/worldSets'
import * as db from '@/lib/db'
import { ensureDailyBackup, startAutoBackup, takeBackupFailure } from '@/lib/sync/backup'
import { DESKTOP, initDesktopStore, flushDesktopSync, getDesktopState, subscribeDesktop, installFullscreenShortcuts } from '@/lib/app/desktop'
import { flushEditorDraftNow } from '@/lib/editor/draftFlush'
import { leaveGuardDirty, runLeaveGuard } from '@/lib/editor/leaveBarrier'
import { useNavigationGate } from '@/lib/app/useNavigationGate'
import { type ReferenceJump, type WorkspaceTarget } from '@/lib/app/navigation'
import { useNavigationHistory } from '@/lib/app/useNavigationHistory'
import { pageNavigationIntent, referenceNavigationIntent, commitNavigationHistory, type EditorPosition, type NavigationIntent } from '@/lib/app/referenceIntent'
import BackToSource from '@/components/app/BackToSource'
import { getStorageContextEpoch, subscribeStorageContext } from '@/lib/storage/contextEpoch'
import { captureWorkspaceView, observeWorkspaceLifecycle } from '@/lib/settings/workspaceRuntime'
import { PORTABLE, initPortableStore, flushPortableBeacon, flushPortableOnLeave, getPortableState, subscribePortable } from '@/lib/storage/fileBackend'
import { installPortableVecKb } from '@/lib/storage/portableVecKb'
import { DesktopWriteLockBanner } from '@/components/app/DesktopWriteLockBanner'
import { PortableWriteLockBanner } from '@/components/app/PortableWriteLockBanner'
import { MigrationLockBanner } from '@/components/templates/MigrationLockBanner'
import DataDock from '@/components/app/DataDock'
import BackupReminder from '@/components/app/BackupReminder'
import { markExported } from '@/lib/sync/backupReminder'
import WelcomeWizard from '@/components/app/WelcomeWizard'
import MigrationWizard from '@/components/app/MigrationWizard'
import { probeLegacy, type LegacyProbe } from '@/lib/storage/legacyMigration'
import FullTextSearch from '@/components/editor/FullTextSearch'
import JieWenJiSprite from '@/components/jiewenji/JieWenJiSprite'
import GeoMapEditor from '@/components/world/GeoMapEditor'
import PlotCanvas from '@/components/outline/PlotCanvas'
import { showToast } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'
import { abortAllTasks, resetTaskCenter, takeUnnotifiedRunning } from '@/lib/ai/aiTaskCenter'
import { applyZoom, foldVh, getStoredZoom, isZoomAuto } from '@/lib/settings/theme'
import { saveFailureMessage } from '@/lib/app/saveFailureHint'
import { applyStoredNetProxy } from '@/lib/settings/netPrefs'
import { loadPromptOverrides } from '@/lib/ai/promptSettings'
import { LS_SPRITE_ENABLED } from '@/lib/constants'
import { downloadBlob } from '@/lib/storage/zip'
import workbenchBg from '@/assets/workbench-bg.png'
import { usePersistedBool } from '@/lib/settings/uiPrefs'

// 次级页签按需懒加载：把向导页 / 灵感启发·检查工具（含 AI 组件与大量交互）从首屏主包拆出去，
// 仅在用户切到对应页签时才加载对应 chunk。Sidebar/仪表盘/编辑器保持常驻以保证首屏速度。
const GuidePage = lazy(() => import('@/components/app/GuidePage'))
const InspireTools = lazy(() => import('@/components/creative/InspireTools'))
const ModelSettingsPanel = lazy(() => import('@/components/settings/ModelSettingsPanel'))
const CheckTools = lazy(() => import('@/components/audit/CheckTools'))
const MaterialLibrary = lazy(() => import('@/components/library/MaterialLibrary'))
const BookBreakPanel = lazy(() => import('@/components/bookbreak/BookBreakPanel'))
const CreativeWritingPanel = lazy(() => import('@/components/creative/CreativeWritingPanel'))
// 酒馆模式四页：剧情推演 / 推演报告 / 角色卡 / 自由对话（各自含 AI 交互，按需懒加载）
const TavernPlot = lazy(() => import('@/components/tavern/TavernPlot'))
const TavernReport = lazy(() => import('@/components/tavern/TavernReport'))
const TavernCard = lazy(() => import('@/components/tavern/TavernCard'))
const TavernFree = lazy(() => import('@/components/tavern/TavernFree'))
const RunPanel = lazy(() => import('@/components/tavern/RunPanel'))
const TavernControl = lazy(() => import('@/components/tavern/TavernControl'))
const TavernScript = lazy(() => import('@/components/tavern/TavernScript'))
const TavernWorld = lazy(() => import('@/components/tavern/TavernWorld'))
// 创作轨迹（创作管理组，2.4.0 A4）：含轨迹时间线与证据包导出，按需懒加载
const TrajectoryPanel = lazy(() => import('@/components/audit/TrajectoryPanel'))
const WorldLibraryPanel = lazy(() => import('@/components/world/WorldLibraryPanel'))



export default function App() {
  useEffect(observeWorkspaceLifecycle, [])
  const [projectId, setProjectId] = useState<string | null>(null)
  // 内置背景开关（2.6.1）：必须在所有早退 return 之前调（rules-of-hooks）
  const [bgHidden] = usePersistedBool('workbench-bg-hidden', false)
  const [projectName, setProjectName] = useState('')
  const [visCtx, setVisCtx] = useState<VisCtx>({ type: 'full', features: [], pack: DEFAULT_PACK })
  const [activeTab, setActiveTab] = useState('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const [booted, setBooted] = useState(false)
  // 2.6.3 · 启动自动检查到的更新（有则弹一次说明）
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateLatest, setUpdateLatest] = useState<LatestRelease | null>(null)
  /** 启动流程抛出的错误（非空则渲染错误页，而不是永远卡在黑屏上） */
  const [bootError, setBootError] = useState<{ cause: unknown } | null>(null)
  /**
   * 首启向导开关（2.4.0 · A1）：仅在「从没走过向导」且「库里一个项目都没有」时为 true。
   * 走过一次即写全局 meta `welcomeDone`，此后不再出现。
   */
  const [needWelcome, setNeedWelcome] = useState(false)
  /**
   * 3.0 · W0-2：首启探测到的旧版（novel-studio）数据 —— 非空则弹迁移向导。
   * 只在首启探测一次；导入或跳过即清空。
   */
  const [migrationProbe, setMigrationProbe] = useState<LegacyProbe | null>(null)
  // 从其他页签（如章节总表）跳转正文编辑时，要直达打开的章节 id
  const [editorTarget, setEditorTarget] = useState<string | null>(null)
  // 数据体检 / 地图等跨组件跳转时，要直达高亮的具体行 id（detail 携带 rowId 时下发）
  const [focusRowId, setFocusRowId] = useState<string | null>(null)
  /** 段落级定位：跳到正文时要落的字符偏移（只在显式跳转那一次有效） */
  const [editorOffset, setEditorOffset] = useState<EditorPosition | null>(null)
  const requestSequence = useRef(0)
  const [editorRequestId, setEditorRequestId] = useState(0)
  /**
   * 跨页签跳转聚焦的「已消费」回调。
   * 🔴 必须用 useCallback 钉住引用：它是 TableSheet 滚动高亮 effect 的依赖之一，
   *    若写成内联箭头（每次渲染新建），该 effect 会在每次渲染重跑，
   *    2.6 秒后清除高亮的定时器被反复重置 —— 高亮将永不消失。
   */
  const clearFocusRow = useCallback(() => {
    if (requestSequence.current === editorRequestId) setFocusRowId(null)
  }, [editorRequestId])
  const resetNavigationTargets = useCallback(() => {
    setEditorRequestId(++requestSequence.current)
    setEditorTarget(null); setEditorOffset(null); setFocusRowId(null)
  }, [])
  // 全文检索命令面板（v1.3）：Ctrl/Cmd+K 唤起
  const [searchOpen, setSearchOpen] = useState(false)
  // 颉文姬 Q 版精灵开关（面板内可切换，localStorage 持久化）
  const [spriteEnabled, setSpriteEnabled] = useState(() => localStorage.getItem(LS_SPRITE_ENABLED) !== '0')
  useEffect(() => {
    const onSetting = (e: Event) => {
      const v = (e as CustomEvent<boolean>).detail
      setSpriteEnabled(v)
    }
    window.addEventListener('jiewenji:sprite-setting', onSetting)
    return () => window.removeEventListener('jiewenji:sprite-setting', onSetting)
  }, [])
  // 自动备份定时器句柄（打开项目时启动，退出时停止）
  const backupStop = useRef<(() => void) | null>(null)
  // 本地数据文件加载完成状态（未加载完不出主界面，避免闪一下空库）
  // 🔴 便携模式同样要等（数据经本地服务装载，未就绪时内存是空库）—— 2026-10-10 便携版 WP-2b
  const [fileReady, setFileReady] = useState(!DESKTOP && !PORTABLE)
  /**
   * 当前页签的 ref 镜像（2.6.3 · 跨页签任务存活）：
   * `navigate` 里要判断「是不是真的换了页签」，但把 `activeTab` 放进 useCallback 依赖
   * 会让 `navigate` 每次切页签都换引用（下发给 Sidebar 与各页签，徒增重渲染）。
   * 用 ref 镜像读最新值，依赖数组保持 `[visCtx]` 不变。
   */
  const activeTabRef = useRef(activeTab)
  useEffect(() => { activeTabRef.current = activeTab }, [activeTab])
  /**
   * 上一个打开过的项目 id（用于「换项目才清后台任务」）。
   * 退出项目**不清**任务：被中止的拆书任务带着断点留在内存里，重新打开同一个项目即可「继续抽取」；
   * 只有打开了**另一个项目**才清（那些任务属于上一个项目，留着会串味）。
   */
  const lastProjectRef = useRef<string | null>(null)
  /**
   * 离页屏障在途标记（3.3.0 · UX06）：换页签 / 退出项目要先等编辑器把脏稿写完，
   * 这段时间里再点别的入口一律忽略 —— 否则「点 A 等写盘 → 又点 B」会走出两条导航，
   * 后到的那条会在前一条保存成功后把作者带到意料之外的页面。
   */
  const navPending = useRef(false)
  const navEpoch = useRef(0)
  const navContext = useCallback(() => JSON.stringify([db.getCurrentProjectId(), navEpoch.current, getStorageContextEpoch(),
    (window as unknown as { __YFE_USER__?: { id?: string } }).__YFE_USER__?.id ?? 'local']), [])
  const navHistory = useNavigationHistory(navContext())
  const clearHistory = navHistory.clear

  // 从本地用户数据目录加载数据（桌面版）/ 从本地服务加载（便携版）
  useEffect(() => {
    if (DESKTOP) {
      let alive = true
      void initDesktopStore().then(() => { if (alive) setFileReady(true) })
      return () => { alive = false }
    }
    if (PORTABLE) {
      let alive = true
      void initPortableStore().then(() => {
        // 🔴 顺序关键：必须在整库数据装载完之后再切两库后端 —— 桥读写的是 portableStore 的
        //    内存 cache，早于装载会把语义向量 / 参考资料当成空库，切项目时清空它们。
        //    （2026-10-10 方案 A：便携版把 `-vec` / `-kb` 两独立 IDB 库并入整库 JSON）
        installPortableVecKb()
        if (alive) setFileReady(true)
      })
      return () => { alive = false }
    }
  }, [])

  // 关闭页面前确保未保存的修改写盘
  //  · 桌面版走同步阻塞写（saveSync），保证窗口关闭前数据落盘；
  //  · 便携版在浏览器里**没有同步阻塞写**（桌面版有 saveSync），改用
  //    sendBeacon → 同步 XHR 两级兜底；仍写不出时由 beforeunload 弹原生确认拦一道。
  //    见 flushPortableBeacon / flushPortableOnLeave。
  useEffect(() => {
    if (DESKTOP) {
      // 🔴 关窗前先落编辑器草稿、再写盘（2026-10-17 全量审计 P1）：
      //    正文是 2s 防抖，原先只 `flushDesktopSync()` 刷 store —— 草稿还没进 store，
      //    「写完一句立刻关窗」就丢最后 ≤2 秒。微任务会在当前任务结束前跑完（桌面 store 是内存实现），
      //    故这条链来得及；即便某次来不及，pagehide 还会再兜一次（上面编辑器侧也挂了同名处理）。
      const onLeave = () => {
        flushDesktopSync()
        void flushEditorDraftNow().finally(() => flushDesktopSync())
      }
      window.addEventListener('beforeunload', onLeave)
      return () => { window.removeEventListener('beforeunload', onLeave) }
    }
    if (PORTABLE) {
      // 🔴 两个事件都挂：pagehide 覆盖 bfcache / 移动端（那边可能不发 beforeunload），
      //    beforeunload 则**唯一能拦住用户**的时机。
      //    `flushPortableBeacon` 内部幂等（dirty 才发），两边都调不会重复写。
      const onHide = () => {
        // 便携版：beacon 只能发一次，必须等草稿先进 store 再发（同 P1：防抖窗口内的正文不能丢）
        void flushEditorDraftNow().finally(() => flushPortableBeacon())
      }
      // 🔴 关页前写不出去时**必须拦一道**：便携版关页即等于"服务还在但客户端没了"，
      //    没写出去的改动就真没了。让浏览器弹原生「确定要离开吗」—— 作者至少能回页面点保存。
      const onUnload = (e: BeforeUnloadEvent) => {
        if (!flushPortableOnLeave()) {
          e.preventDefault()
          e.returnValue = '' // 旧浏览器需要这个才弹
        }
      }
      window.addEventListener('pagehide', onHide)
      window.addEventListener('beforeunload', onUnload)
      return () => {
        window.removeEventListener('pagehide', onHide)
        window.removeEventListener('beforeunload', onUnload)
      }
    }
  }, [])

  // 真·全屏快捷键（2.5.1 · B2）：F11 进出无边框全屏、全屏态下 ESC 退出。仅桌面版安装；返回卸载函数。
  useEffect(() => installFullscreenShortcuts(), [])

  // 磁盘写盘失败时把原本静默吞掉的错误暴露给用户，避免无提示丢稿
  useEffect(() => {
    if (!DESKTOP && !PORTABLE) return
    let lastErr = ''
    const onStore = () => {
      const e = DESKTOP ? getDesktopState().lastError : getPortableState().lastError
      if (e && e !== lastErr) { lastErr = e; showToast('数据保存失败：' + e, 'error', 4500) }
      else if (!e) lastErr = ''
    }
    onStore()
    return DESKTOP ? subscribeDesktop(onStore) : subscribePortable(onStore)
  }, [])

  // 启动引导（便携模式需等数据文件连接后执行）
  //
  // 2026-09-19 前这里会**自动打开上次的项目**；老大要求启动默认停在「项目管理首页」，
  // 所以现在只做三件与「有没有项目」无关的事：结构归一 → 首次使用播示范项目 → 装载提示词覆写。
  useEffect(() => {
    if (!fileReady) return
    ;(async () => {
      // 🔴 整段兜底：旧实现没有 try/catch，任何一步 reject（IndexedDB 打不开、
      //    迁移抛错、读 meta 失败）都会让 setBooted(true) 执行不到 —— 界面永远黑屏，
      //    既不报错也没有重试入口。finally 保证一定会离开黑屏。
      try {
      await db.migrateProjectTypes() // 清理历史遗留的 lite/minimal 项目形态（全局、幂等）
      // 🆕 2.8.0：把**必选模块**（FEATURE_TIER 的 locked 项）同步进已有项目的 features ——
      //    覆盖安装后首次启动时，此前在自定义项目里取消过的必选页签（如「关于打赏」）自动补回。
      //    与「打开哪个项目」无关、遍历全库、幂等，故与上面几条一样放在启动期（项目守卫之前）。
      await db.migrateLockedFeatures(LOCKED_IDS)
      // 🔴 2026-10-02 六维审计 P0（存储同步）：老库 `tavern.settings.search` 里的检索密钥残留
      //    必须**启动就清**。`runMigrations()` 里也有这一步，但它唯一的调用点是 `openProject()` ——
      //    而云盘同步在**没打开任何项目**的项目管理首页就能开（`CloudFileSyncBar` 就在那个分支）。
      //    于是「从没点进过项目」的用户一旦开启同步，这个 key 就会随 `.yfe` 落到网盘，
      //    而检索设置面板明确承诺「只存本机、不上传」。该步骤与当前项目无关、幂等，放这里最稳。
      await db.migrateLegacySearchKey()
      // 🆕 2.4.0 · A1：这里原先会**静默自动创建**示范项目「吞天神脉」—— 软件替新用户做了决定，
      //    他既看不到「还有别的选择」，也不知道那本不是自己的书。现在改为首启向导里的显式三选一
      //    （写我的第一本书 / 先看看示例 / 我有备份），播种动作移到用户点选之后执行。
      // 🔴 写盘被锁（数据文件没读出来）时**不弹向导**：此刻内存是空库，
      //    「库里一个项目都没有」是假象，弹向导只会误导用户去建第二本书、还可能覆盖原文件。
      const desktopWriteLocked = DESKTOP && getDesktopState().writeLocked
      if (!desktopWriteLocked) {
        const [welcomed, existing] = await Promise.all([
          db.getMeta('welcomeDone', '').catch(() => '1'), // 读失败按「已走过」处理，不拿一次异常当首次
          db.getAllProjects().catch(() => []),
        ])
        if (!welcomed && existing.length === 0) {
          setNeedWelcome(true)
          // 🆕 3.0 · W0-2：首启探测旧版（novel-studio）数据 —— 有则弹迁移向导（叠在欢迎向导之上）
          try {
            const pr = await probeLegacy()
            if (pr.exists && (pr.jsonExists || pr.idbExists)) setMigrationProbe(pr)
          } catch { /* 探测失败不打扰首启 */ }
        }
      }
      // AI 提示词的作者覆写要在任何 AI 调用之前生效（登记在各 lib 模块顶层，import 即完成）。
      // 它存在**全局 meta**（`ai.promptOverrides`，不是项目级 —— 与 lastProject 同一个 meta 区），
      // 所以放在这里调用、与「有没有打开项目」无关。
      await loadPromptOverrides()

      // 2.6.3 · 启动后自动检查更新：**延迟 3 秒 + 完全静默**（失败不弹任何东西），
      // 只有真的查到更高版本才弹一次更新说明。开关默认开，关于页可关。
      // 🔴 2026-10-13 · **便携版直接跳过**：
      //    ① 便携版跑在浏览器里、没有安装器 ⇒ 查到新版本也**无法自动更新**，
      //       弹出来只会让作者做一件做不到的事；
      //    ② 「使用说明」早已写明便携版没有自动更新检查 —— 原先没分支，文档与实现不符；
      //    ③ 附带好处：不再消耗 Gitee 匿名配额（实测密集调用会 403 限流，
      //       而限流会让「检查更新」看起来像坏了，见 memory/2026-10-13.md）。
      if (!PORTABLE) void (async () => {
        try {
          await new Promise(r => setTimeout(r, 3000))
          if (!isAutoCheckOn()) return
          const r = await checkUpdate(false)
          if (r.hasUpdate && r.latest) {
            setUpdateLatest(r.latest)
            setUpdateOpen(true)
          }
        } catch { /* 🔴 静默：断网 / 限流 / 解析失败都不打扰作者 */ }
      })()
      // 🔴 2026-09-19 老大要求：**启动后默认停在「项目管理首页」**，不再自动打开上次的项目。
      //    于是现在进项目只有一条路径 —— 作者在首页挑一个 → `openProject()`，
      //    那里的 runMigrations / refreshVolumeTabs / 自动备份 / setActiveTab('dashboard')
      //    本来就是主路径（点项目卡片走的就是它），不会漏步骤。
      //    `lastProject` 保留写入（退出项目时清空），但 2.4.0 起**不再**用它判断「是不是首次使用」——
      //    那件事已交给首启向导与 `welcomeDone`。
      } catch (e) {
        console.error('[boot] 启动流程失败：', e)
        setBootError({ cause: e })
      } finally {
        setBooted(true)
      }
    })()
  }, [fileReady])

  // 外观已在 main.tsx 挂载 React 前应用；主进程代理仍在应用生命周期内同步。
  useEffect(() => {
    void applyStoredNetProxy()   // 2026-09-28 · 网络代理：主进程 session 代理每次启动由渲染层重推（仅桌面）
  }, [])

  // 🔴 自动备份失败必须让用户看见（2026-09-19 六维审计修复）
  // 此前备份失败只 console.warn：作者会以为「每 5 分钟一份、留 30 份」还在保护他，
  // 实际可能一份都没存成功（磁盘满 / 数据文件只读 / 桌面写盘失败）。等要恢复时才发现没有。
  // lib 侧负责记录（takeBackupFailure 取走即清空 ⇒ 同一条最多提示一次），此处只负责展示。
  useEffect(() => {
    const timer = setInterval(() => {
      const f = takeBackupFailure()
      if (!f) return
      const label = f.kind === 'daily' ? '每日备份' : '自动备份'
      showToast(
        `${label}失败：${f.message}。请尽快用「导出备份」另存到外部文件，避免数据丢失`,
        'error',
        8000,
      )
    }, 30_000)
    return () => clearInterval(timer)
  }, [])

  // 「跟随窗口」模式下，窗口尺寸变化时重算缩放（防抖 300ms）。
  // 例：窗口化 ↔ 全屏切换、把窗口拖到另一块屏 —— 字号自动适配，不必手动调。
  // 🔴 3.0 修复（2026-10-10）：原先这里有一句**挂载时**的 `if (!isZoomAuto()) return` ——
  //    若本次启动是「手动」，监听**再也不会挂上**；此后点「自动」只按当时的宽度算一次，
  //    再改窗口大小就不跟了（实测：启动 manual=1 → 点自动 → 改窗口宽 → 缩放纹丝不动）。
  //    改为**常驻监听**，模式判定放进回调里（非跟随模式直接早退，开销可忽略）。
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        if (isZoomAuto()) applyZoom(getStoredZoom())
      }, 300)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (t) clearTimeout(t)
    }
  }, [])

  // 全局快捷键：Ctrl/Cmd+K 唤起全文检索命令面板（v1.3）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visCtx])

  const openProject = useCallback(async (id: string) => {
    const p = await db.getProject(id)
    if (!p) return
    // 2.6.3 · 跨页签任务存活：换项目才清后台任务（同项目重开则保留 —— 被中止的任务可「继续」）
    if (lastProjectRef.current !== id) resetTaskCenter()
    // 🔴 3.2.2：创意写作**不走任务中心**（它有自己的一条通道），必须单独判 ——
    //    它的读写全走 db.*（隐式取当前项目），切过去就会把上个项目的产出写进这个项目。
    //    放在 setCurrentProject **之前**：比较的是"即将切到的项目"，没有时间窗。
    //    同项目重开（lastProjectRef 相同）不会触发，与上面 resetTaskCenter 的语义一致。
    abortRunIfProjectChanged(id)
    lastProjectRef.current = id
    navEpoch.current++
    db.setCurrentProject(id)
    // 结构迁移统一入口（幂等），与「启动恢复上次项目」共用同一个入口，
    // 杜绝两条路径跑的迁移集合不一致（审计 P1-7）。
    // 内部顺序：项目形态归一化 → ledger 拆表 → 全局连续编号（numbering 依赖 ledger 的结果）
    await db.runMigrations()
    await refreshVolumeTabs() // UI 侧缓存刷新，db 层不引用 schema 以免循环依赖
    // 3.2.0 · T3：把历史「字段名」幂等迁移成轻量定义（默认待确认）。
    // 🔴 放后台跑，不拖慢进项目；迁移每写完一个页签都会 emit，已挂载的字段名按钮 / 确认清单自行刷新。
    //    失败不阻断打开（下次打开会重试），但也不会把未迁移的改名当成「含义已确认」。
    void migrateAliasesToFieldDefinitions(id).catch(() => { /* 下次打开重试 */ })
    // 题材包（2.7.1）：决定「世界设定 / 力量体系 / 四个制度页签」用哪套模板、哪些页签可见。
    // 🔴 必须在任何页签渲染之前设好 —— TABS 里那六个页签的 name/modules 是 getter，读的就是这里。
    //    （故在 setVisCtx / setActiveTab 之前调用，避开「renderContent 先跑、包还没设」的竞态。）
    const pack = normalizeGenrePack(p.genre)
    setActivePack(pack)
    db.setMeta('lastProject', id)
    setProjectId(id)
    setProjectName(p.name)
    setVisCtx({ type: p.projectType ?? 'full', features: p.features ?? [], pack })
    setActiveTab('dashboard')
    setRefreshKey(k => k + 1)
    // 备份策略加固：每天首次打开自动备一份；打开期间每 5 分钟滚动备一份
    void ensureDailyBackup(id)
    backupStop.current?.()
    backupStop.current = startAutoBackup(id)
  }, [])

  /**
   * 真正退出项目（调用前必须已经确认编辑器没有未落库的稿）。
   * 3.3.0 · UX06：原实现直接在这里清 `projectId`，编辑器随即卸载 —— 而脏稿只能靠卸载时的
   * 异步冲刷兜底，那条链**故意吞失败**且界面已经消失，作者既看不到提示也没法重试。
   * 所以拆成「先过屏障 → 再调它」，屏障失败就根本不走这里。
   */
  const doExitProject = useCallback(() => {
    // 2.6.3 · 跨页签任务存活：退出项目 → **中止**所有在跑的后台任务
    //（🔴 不中止就会在项目已关闭后继续烧额度；任务记录保留，重开同项目能接着「继续」）
    abortAllTasks()
    // 🔴 3.2.2：创意写作不在任务中心里，单独停 —— 退出后 currentProjectId 变 ''，
    //    再往下走它的落库会带着空 projectId 写进库。
    abortRunIfProjectChanged('')
    backupStop.current?.()
    backupStop.current = null
    db.setMeta('lastProject', '')
    navEpoch.current++
    db.setCurrentProject('')
    // 题材包归位（2.7.1）：退回项目管理首页后，TABS 的 getter 应回到默认包，
    // 免得「上个项目的题材」还挂在模块级状态上（首页若渲染任何页签名会露馅）。
    setActivePack(DEFAULT_PACK)
    setVisCtx(c => ({ ...c, pack: DEFAULT_PACK }))
    setProjectId(null)
    setProjectName('')
  }, [])

  /** 首启向导收尾：选定/导入了项目就直接进项目；跳过一次则留在项目管理页 */
  const onWelcomeDone = useCallback((id: string | null) => {
    setNeedWelcome(false)
    if (id) void openProject(id)
  }, [openProject])

  const exportCurrent = useCallback(async () => {
    if (!projectId) return
    const bundle = await db.exportProject(projectId)
    downloadBlob(
      `青春幻想引擎备份-${projectName}-${new Date().toISOString().slice(0, 10)}.json`,
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
    )
    markExported() // 记录「已导出到外部文件」，#031 提醒据此重新计时
  }, [projectId, projectName])

  /** 真正执行换页签（可见性校验 + 后台任务轻提示 + 落到目标页） */
  const applyNav = useCallback((id: string, chapterId?: string, rowId?: string, position?: EditorPosition) => {
    const t = getTab(id)
    if (t && !tabVisible(t.id, visCtx)) return
    /**
     * 2.6.3 · 跨页签任务存活：真的换了页签、且还有后台任务在跑 → **轻提示一次**。
     * 🔴 三条纪律：不阻断切页签（只是 toast）；同一任务只提示一次（`takeUnnotifiedRunning`
     *    取走即标记）；没有任务时不提示。
     */
    if (id !== activeTabRef.current) {
      const pending = takeUnnotifiedRunning()
      if (pending.length === 1) {
        showToast(`「${pending[0].title}」仍在后台进行 —— 可从左下角「后台任务」查看或中止`, 'info')
      } else if (pending.length > 1) {
        showToast(`还有 ${pending.length} 个任务在后台进行 —— 可从左下角「后台任务」查看或中止`, 'info')
      }
    }
    setActiveTab(id)
    activeTabRef.current = id
    setFocusRowId(rowId ?? null)
    // 🔴 必须**连清空一起**处理（2026-10-16 全量审计）：旧实现只在 chapterId 非空时写、
    //    全仓没有任何清空点 ⇒ 从章节规划板跳到第 3 章之后，作者在编辑器里切到第 8 章、
    //    再点侧栏「正文编辑」，打开的仍是**第 3 章**（陈旧目标压过了「上次编辑章」）。
    setEditorRequestId(++requestSequence.current)
    setEditorTarget(id === 'editor' ? chapterId ?? null : null)
    setEditorOffset(id === 'editor' && chapterId && position ? { ...position } : null)
  }, [visCtx])

  /**
   * 3.3.0 · UX06：换页签前的**离页屏障**。
   * 干净时（没有编辑器 guard / 没有脏稿）走原来的同步路径，一次 await 都不加；
   * 只有真的有待落库的正文或标题摘要，才先等编辑器写盘：写成功才换页，失败就留在原页
   * —— 原 DOM、原草稿、原滚动位置全部不动，作者可以直接重试。
   */
  const navGate = useNavigationGate<NavigationIntent>({
    context: navContext, busy: navPending, capture: captureWorkspaceView,
    dirty: leaveGuardDirty, flush: runLeaveGuard,
    validate: intent => {
      if (intent.kind === 'exit') return intent
      const tab = getTab(intent.target.tabId)
      return tab && !tabVisible(tab.id, visCtx) ? null : intent
    },
    commit: intent => {
      if (intent.kind === 'exit') { clearHistory(); doExitProject() }
      else {
        applyNav(intent.target.tabId, intent.target.chapterId, intent.target.rowId, intent.position)
        commitNavigationHistory(navHistory.history, intent)
      }
    },
    invalid: intent => {
      if (intent.kind === 'page' && intent.back) commitNavigationHistory(navHistory.history, intent)
      showToast('目标页面当前不可见，已留在当前页面', 'info')
    },
    failed: (intent, scope, error) => { showToast(saveFailureMessage(
      (intent.kind === 'exit' ? '还没退出项目：' : '已留在当前页面：')
        + (scope === 'meta' ? '本章标题或摘要没存上 —— ' : '本章正文没存上 —— '), error), 'error') },
  })
  useEffect(() => {
    navGate.invalidate(); resetNavigationTargets(); clearHistory()
  }, [navGate, projectId, resetNavigationTargets, clearHistory])
  useEffect(() => subscribeStorageContext(() => {
    navGate.invalidate(); resetNavigationTargets(); clearHistory()
  }), [navGate, resetNavigationTargets, clearHistory])
  useEffect(() => {
    const owner = navContext()
    const checkOwner = () => {
      if (owner !== navContext()) { navGate.invalidate(); resetNavigationTargets(); clearHistory() }
    }
    window.addEventListener('storage', checkOwner)
    return () => window.removeEventListener('storage', checkOwner)
  }, [navGate, navContext, clearHistory, resetNavigationTargets])
  const navigate = useCallback((id: string, chapterId?: string, rowId?: string) => {
    const intent = pageNavigationIntent({ tabId: id, chapterId, rowId })
    if (intent) navGate.request(intent)
  }, [navGate])

  /**
   * 3.3.0 · UX05：**关联跳转**才记来源（正文→提及章节、角色/设定→正文…）。
   * 普通侧栏切换不记 —— 否则返回栈会变成浏览器历史，作者点两下侧栏就回不到"该回的地方"。
   * 只存路由 ID 与一行短标签；`scopeKey` 一变（切项目/换存储上下文）整个栈作废。
   */
  const navigateToReference = useCallback((jump: ReferenceJump) => {
    // 源位置：正文用「当前章」，表格/卡片页用「当前记录」（优先显式传入的那条，其次是高亮目标）
    const fromRow = jump.sourceId ?? focusRowId ?? undefined
    const from: WorkspaceTarget = {
      tabId: activeTab,
      ...(activeTab === 'editor' && editorTarget ? { chapterId: editorTarget } : {}),
      ...(activeTab !== 'editor' && fromRow ? { rowId: fromRow } : {}),
    }
    const intent = referenceNavigationIntent(jump, from)
    if (intent) navGate.request(intent)
    else showToast('关联定位信息无效，已留在当前页面', 'info')
  }, [activeTab, editorTarget, focusRowId, navGate])
  /** Return history is consumed only by a successful commit; save failure preserves the retry entry. */
  const goBackToSource = useCallback(() => {
    const entry = navHistory.top
    if (entry) navGate.request({ kind: 'page', target: { ...entry.target }, back: entry })
  }, [navHistory, navGate])

  const exitProject = useCallback(() => navGate.request({ kind: 'exit' }), [navGate])

  // 跨组件跳转事件（地图详情「跳到地理风物」、数据体检「跳转修复」等场景派发 yfe:navigate）
  // detail 兼容两种形式：字符串 tabId，或 { tabId, rowId } 对象（直达并高亮具体行）
  useEffect(() => {
    const onNav = (e: Event) => {
      const intent = pageNavigationIntent((e as CustomEvent).detail)
      if (intent) navGate.request(intent)
    }
    window.addEventListener('yfe:navigate', onNav as EventListener)
    return () => window.removeEventListener('yfe:navigate', onNav as EventListener)
  }, [navGate])

  // 🔴 2.7.2 移除了两个事件监听（原先都还有派发方，现在都没有了）：
  //   ① `yfe:pack-changed` —— 由《世界设定》页头的「切换题材」控件派发；
  //      题材改在**新建项目**时选，页签内不再提供切换 ⇒ 该控件（`GenrePackSwitcher`）已删。
  //   ② `yfe:tabs-changed` —— 由《世界设定》页头的「页签补开」控件（`TabVisibilityControl`）派发；
  //      **完整项目现在全部页签一律显示**、自定义项目按建项目时勾选的「功能模块」显示，
  //      页签内不再有显隐控件 ⇒ 该组件已删。
  // 题材与项目类型在 `openProject` 时一次性算好写进 `visCtx`（见上面 :290-295）。

  const onStatsChange = useCallback(() => {
    setRefreshKey(k => k + 1)
  }, [])


  // 启动失败：给一页能读懂的错误 + 一个重试入口，而不是永远停在黑屏上
  if (bootError) {
    return (
      <>
        <DesktopWriteLockBanner />
        <PortableWriteLockBanner />
        <FailureNotice title="启动失败" error={bootError.cause}
          description="工作台尚未完成初始化。请保留技术摘要，再尝试重新加载。"
          actions={<Button variant="primary" size="md" onClick={() => location.reload()}>重新加载工作台</Button>}>
          {DESKTOP || PORTABLE
            ? '当前页面尚未载入数据管理工具。需要排障时，请先通过系统文件管理器复制已有数据文件和备份，避免覆盖原文件。'
            : '请保留当前站点数据，避免直接清理浏览器存储。此时数据管理工具尚未载入，请勿依赖库内导出入口。'}
        </FailureNotice>
      </>
    )
  }

  if (!booted) {
    return (
      <>
        <DesktopWriteLockBanner />
        <PortableWriteLockBanner />
        <main role="status" aria-label="正在打开创作工作台" className="flex flex-col items-center justify-center gap-2 bg-surface-app p-6 text-center" style={{ minHeight: foldVh('100vh') }}>
          <p className="text-14 font-semibold text-content-primary">正在打开创作工作台…</p>
          <p className="text-12 text-content-muted">正在读取工作台数据与设置，请稍候。</p>
        </main>
      </>
    )
  }

  // 项目未打开：首次使用先走首启向导（2.4.0 · A1），其余情况进项目管理页
  if (!projectId) {
    return (
      <>
        <DesktopWriteLockBanner />
        <PortableWriteLockBanner />
        {needWelcome ? <WelcomeWizard onDone={onWelcomeDone} /> : <ProjectHub onOpen={openProject} onReplayWelcome={() => setNeedWelcome(true)} />}
        {/* 3.0 · W0-2：首启迁移向导（叠在最上层；关闭后回到欢迎向导 / 项目首页） */}
        {migrationProbe && <MigrationWizard probe={migrationProbe} onClose={() => setMigrationProbe(null)} />}
        {/* 2.6.3 · 启动自动检查到的新版本（在首页这一支挂载即可：启动默认停在这里） */}
        <UpdateDialog open={updateOpen} latest={updateLatest} onClose={() => setUpdateOpen(false)} />
        {/* 左下角统一「数据坞」：本机存储 + 云盘文件同步 + 网页版同步三合一（#032）。
            此前三者各画一个 fixed 浮层，定位/层级/圆角都不一致，桌面版会互相遮挡。 */}
        <DataDock />
      </>
    )
  }

  const renderContent = () => {
    if (activeTab === 'dashboard') {
      return <Dashboard key={projectId} onNavigate={navigate} projectId={projectId} projectName={projectName} onExport={exportCurrent} refreshKey={refreshKey} ctx={visCtx} />
    }
    const guardTab = getTab(activeTab)
    if (guardTab && !tabVisible(guardTab.id, visCtx)) {
      return <Dashboard key={projectId} onNavigate={navigate} projectId={projectId} projectName={projectName} onExport={exportCurrent} refreshKey={refreshKey} ctx={visCtx} />
    }
    if (activeTab === 'editor') {
      return <NovelEditor onStatsChange={onStatsChange} onNavigate={navigate} onOpenSearch={() => setSearchOpen(true)} projectName={projectName} openChapterId={editorTarget} openRequestId={editorRequestId} openOffset={editorOffset} ctx={visCtx} />
    }
    if (activeTab === 'model-settings') {
      return <ModelSettingsPanel />
    }
    if (activeTab === 'inspire-tools') {
      return <InspireTools />
    }
    if (activeTab === 'check-tools') {
      return <CheckTools />
    }
    if (activeTab === 'material-library') {
      return <MaterialLibrary />
    }
    if (activeTab === 'bookbreak') {
      return <BookBreakPanel />
    }
    if (activeTab === 'creative-writing') {
      return <CreativeWritingPanel />
    }
    if (activeTab === 'trajectory') {
      return <TrajectoryPanel />
    }
    if (activeTab === 'worlds') {
      return <WorldLibraryPanel />
    }
    if (activeTab === 'tavern-world') {
      return <TavernWorld />
    }
    if (activeTab === 'tavern-plot') {
      return <TavernPlot />
    }
    if (activeTab === 'tavern-report') {
      return <TavernReport />
    }
    if (activeTab === 'tavern-card') {
      return <TavernCard />
    }
    if (activeTab === 'tavern-script') {
      return <TavernScript />
    }
    if (activeTab === 'tavern-free') {
      return <TavernFree />
    }
    if (activeTab === 'tavern-run') {
      return <RunPanel />
    }
    if (activeTab === 'tavern-control') {
      return <div className="p-6"><TavernControl /></div>
    }
    if (activeTab === 'guide') {
      return <GuidePage onNavigate={navigate} ctx={visCtx} />
    }
    const tab = getTab(activeTab)
    if (!tab) return <div className="p-8">页签不存在</div>
    switch (tab.type) {
      case 'form':
        // 2.7.2 分两种结构（主人定案）：
        // · 母子结构（世界设定 / 力量体系）：母级「全书统一」+ 可多建的子项。
        // · 并列结构（政治 / 经济 / 信仰 / 司法 2.7.2 起）：**没有母级**，直接一条条平铺，
        //   每条带「活跃 / 已完结」开关（见 ParallelSetSheet）。
        // 其余表单型页签仍然是一页一份的 FormSheet。
        return isWorldSetTab(tab.id)
          ? <WorldSetSheet key={tab.id} tab={tab} />
          : isParallelSetTab(tab.id)
            ? <ParallelSetSheet key={tab.id} tab={tab} />
            : <FormSheet key={tab.id} tab={tab} />
      case 'table':
        // 2.9.2（③ · 方案 C）：「设定变更」页额外挂一条只读的数据体检提示 ——
        // 该页是「改设定先登记」的闸口，dataHealth 查的正是改设定最容易产生的那类问题。
        // 🔴 **不常驻区块**：只在检出「冲突」级问题时才渲染那一行，无问题时与改动前一字不差。
        return tab.id === 'changelog'
          ? <ChangelogHealthNote key={tab.id}>
              <TableSheet tab={tab} onNavigate={navigate} ctx={visCtx} focusRowId={focusRowId} onFocusConsumed={clearFocusRow} />
            </ChangelogHealthNote>
          : <TableSheet key={tab.id} tab={tab} onNavigate={navigate} ctx={visCtx} focusRowId={focusRowId} onFocusConsumed={clearFocusRow} />
      case 'card':
        // 大纲规划下的卡片页签（分卷大纲/章节细纲）使用多记录目录管理组件
        return tab.group === '大纲规划'
          ? <OutlineSheet key={tab.id} tab={tab} focusRowId={focusRowId} onFocusConsumed={clearFocusRow} />
          // focusRowId 也要下发：card 类页签（主要/次要/NPC 角色）同样会被报告指向（审计 P1-5）
          : <CharacterSheet key={tab.id} tab={tab} focusRowId={focusRowId} onFocusConsumed={clearFocusRow} onNavigate={navigate} onNavigateReference={navigateToReference} ctx={visCtx} />
      case 'about':
        return <AboutPage />
      case 'map':
        return <GeoMapEditor tab={tab} />
      case 'canvas':
        return <PlotCanvas tab={tab} />
      default:
        return <div className="p-8">未知页签类型</div>
    }
  }

  const isEditor = activeTab === 'editor'

  return (
    <div key={`proj-${projectId}`} className="relative flex h-screen overflow-hidden bg-transparent">
      <DesktopWriteLockBanner />
      <PortableWriteLockBanner />
      {/* 3.2.1：某页签正在换模板时点名告知（写入拦截早就在 planTabWrite 层，这里补可见性） */}
      <MigrationLockBanner projectId={projectId} />
      {/* v1.3 幻想工作台背景：纯线条浅金线稿，透明底、若隐若现。
          负 z-index 子元素绘制于 body 背景之上、半透明面板之下，故可从面板后透出；
          父容器设为 bg-transparent，避免不透明背景把装饰层盖住；
          主题色由 CSS 变量驱动，切换主题时底色随变；pointer-events-none 不挡交互，层号走 Z.pageBackdrop */}
      {/* 内置背景（2.6.1）：金色书本与房子线条图案 —— 侧栏弹窗「背景」开关可整体隐藏（跨实例同步的 usePersistedBool） */}
      {!bgHidden && (
      <div
        className="absolute inset-0 pointer-events-none bg-cover bg-center bg-no-repeat opacity-100"
        style={{ backgroundImage: `url(${workbenchBg})`, zIndex: Z.pageBackdrop }}
        aria-hidden
      />
      )}
      <WorkspaceSidebar
        activeTab={activeTab}
        onNavigate={navigate}
        collapsed={false}
        projectName={projectName}
        onExitProject={exitProject}
        onExport={exportCurrent}
        ctx={visCtx}
      />
      {/* 🔴 2026-09-22：padding 必须放在**内层**，不能放在滚动容器 main 上 ——
          滚动容器一旦自带 padding-top，sticky 表头只会贴到 padding 的**内边缘**（实测停在 32px 处），
          那一段就成了「卡片 / 表格从页头上面穿过去」的通道。挪到内层后表头才贴得住 main 顶部（gap=0）。
          ⚠️ 改 header 的负 margin 是没用的 —— margin 不参与 sticky 的约束计算（这轮先猜错过一次）。
          🔴🔴 2026-09-23：内层 div **必须带 `h-full`**。包了这一层之后父高对子元素不再「确定」，
          `renderContent()` 里那些 `flex h-full` 的页面（编辑器 / 剧情推演 / 自由对话 / 角色卡 / 地图…）
          的 `h-full` 会退化成 auto ⇒ 撑不满：短内容的页面**下方留一大块空白**（实测剧情推演/自由对话
          各留 ~490px），长内容的页面则**高出窗口被 main 裁掉且滚不到**（实测编辑器根高 1391 而可用仅 926）。
          补 `h-full` 后与「padding 还在 main 上」时的几何完全一致（内容高 = main 高 − 上下 padding）。 */}
      <main className={`@container/workspace min-w-0 flex-1 overflow-y-auto ${isEditor ? '!overflow-hidden' : ''}`}>
        {/* UX05 返回来源：sticky + 零高度容器 ⇒ 常驻可见但不占布局（避免再压短窗正文区） */}
        {navHistory.canGoBack && navHistory.top && (
          <div className="pointer-events-none sticky top-0 z-30 h-0">
            <BackToSource label={navHistory.top.label} onBack={goBackToSource} />
          </div>
        )}
        <div className={`workspace-content h-full ${isEditor ? '' : 'p-3 @min-[40rem]/workspace:p-6 @min-[64rem]/workspace:p-8'}`}>
          {/* fallback 用 min-h-* 而不是 h-full：它是**加载占位**，只需撑住视觉高度；
              用 min-h 可避免在某些中间态下被压成 0 */}
          {/* 🔴 2026-09-22 六维审计 P2：`50vh` 走 foldVh（界面缩放后 vh 不随 zoom 缩，
              132% 时会溢出视口）；这也是全项目唯一残留的内联 vh 任意值类。 */}
          <Suspense fallback={<div className="w-full flex items-center justify-center text-ink-500 text-sm" style={{ minHeight: foldVh('50vh') }}>加载中…</div>}>
            {renderContent()}
          </Suspense>
        </div>
      </main>
      {/* 本机存储 / 云盘同步状态在「项目内」由 Sidebar Footer 内嵌承载，
          不再使用全局 fixed 浮层——避免压住侧栏底部的「界面缩放 / 主题」等控件。 */}
      {/* 颉文姬桌面精灵：全局右缘驻留（可在 AI 编辑面板底部开关关闭） */}
      {spriteEnabled && <JieWenJiSprite isEditor={activeTab === 'editor'} onNavigate={navigate} />}
      {searchOpen && (
        <FullTextSearch
          onClose={() => setSearchOpen(false)}
          onOpenChapter={(id) => { setSearchOpen(false); navigate('editor', id) }}
          onNavigateTab={(tabId) => { setSearchOpen(false); navigate(tabId) }}
          ctx={visCtx}
        />
      )}
      {/* #031 定期提醒把数据导出到外部文件。 */}
      <BackupReminder hasProject={!!projectId} onExport={exportCurrent} />
    </div>
  )
}
