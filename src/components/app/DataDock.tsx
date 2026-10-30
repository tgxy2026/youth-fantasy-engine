import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import CloudFileSyncBar from '@/components/app/CloudFileSyncBar'
import { DesktopDataBar } from '@/components/app/Desktop'
import { PortableDataBar } from '@/components/app/Portable'
import { GuestDataBar } from '@/components/app/Guest'
import { WebDataBar } from '@/components/app/Web'
import { DESKTOP } from '@/lib/app/desktop'
import { decideDataDockView } from '@/lib/app/dataDockView'
import { PORTABLE } from '@/lib/storage/fileBackend'
import { GUEST } from '@/lib/db/guestData'
import { WEB } from '@/lib/app/platform'
import { CLOUD_FILE_SYNC } from '@/lib/sync/desktopCloudSync'
import { currentUiZoom, foldVh } from '@/lib/settings/theme'
import { Z } from '@/lib/app/zLayer'
import { usePersistedBool } from '@/lib/settings/uiPrefs'
import DensityControl from '@/components/settings/DensityControl'

/**
 * 左下角统一「数据坞」—— 全应用**唯一允许**的全局浮层（#032 布局规范化）。
 *
 * 背景：此前左下角是三拨各自为政的 fixed 浮层（定位差 1px、层级差 10、圆角与间距各异），
 * 桌面版直接叠成一团互相遮挡。现在收编为一个等宽面板：统一位置、统一控件高度、统一圆角与分隔线。
 *
 * 自 2026-09-15 起本应用只发布桌面版，区块只剩两块：
 *   ① 本机存储 `DesktopDataBar` —— 数据文件位置、保存状态、导出 / 导入
 *   ② 云盘文件同步 `CloudFileSyncBar` —— 无服务器、无凭据，选目录即可
 *
 * 注意：项目内（有侧栏）不使用本浮层——全局 fixed 浮层会压住侧栏底部控件，
 * 因此项目内的本机存储行与云同步行改为内嵌进 Sidebar Footer。
 *
 * ⚠️ 关于 dev 环境：`DESKTOP` 是**运行时探测**（读 `window.electronStore`），
 * 在 dev 浏览器里恒为 false。若严格按它门控，开发预览下整块不渲染 ——
 * 界面改动就没法在浏览器里验证（曾排查过一次"左下角同步设置消失"，根因正是它）。
 * 所以 dev 环境也渲染，代价是其中的按钮会走 electron 分支失败，故顶部给一条提示。
 */
const DEV = import.meta.env.DEV

function Divider() {
  return <div className="my-2 h-px bg-ink-700/70" />
}

export default function DataDock() {
  // 🔴 B6（2026-09-22 老大新增）：折叠状态与项目内的 Sidebar Footer **共用同一个键**
  //   （`dock-collapsed`）—— 两者是同一块「左下角工具栏」在"无侧栏 / 有侧栏"两种形态下的呈现。
  //   ⚠️ hook 必须写在 early return **之前**（否则违反 hooks 规则）。
  const [collapsed, setCollapsed] = usePersistedBool('dock-collapsed', false)

  /**
   * 🔴 3.3.1 · P5 遮挡修复（主人 2026-10-30 定「留底部空间」）：
   *    把工具栏的实测高度发布成 `--dock-height`，项目管理页据此在内容底部留白 ——
   *    手动 130% 缩放时这块浮层会压住卡片上的「打开项目」按钮（实测 272×346，鼠标点不到）。
   *
   * 写进去的是**布局单位**（`rect.height ÷ 界面缩放`）：CSS 长度会随 zoom 一起缩放，
   * 混着写会放大两次（同一类坑见 GuideOverlay 的高亮框）。
   * 高度随「收起 / 展开 / 云同步块出现」变化，所以用 ResizeObserver，不能只量一次。
   */
  const dockRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const element = dockRef.current
    const root = document.documentElement
    if (!element) return
    const publish = () => {
      const height = element.getBoundingClientRect().height / currentUiZoom()
      root.style.setProperty('--dock-height', `${Math.round(height)}px`)
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--dock-height')
    }
  }, [])

  // 桌面版 / 便携版 / 网页云端 / 网页游客 / dev 预览五态判定（判定落在 lib/app/dataDockView，便于单测）
  // 🔴 网页版的云端模式同时带 PORTABLE 标记（复用它那套 HTTP StoreOps），
  //    所以必须把 `web` 传进去并**优先于便携判定** —— 否则会显示成便携版的「数据文件 ./data/xxx.json」。
  const view = decideDataDockView({ desktop: DESKTOP, portable: PORTABLE, web: WEB, guest: GUEST, dev: DEV })

  if (!view.render) return null

  // #036 宽度改「视口比例 + 上限」：原 `w-[15rem]`（240px）是绝对值，在 1280 逻辑宽的小屏上占 18.8%，
  // 比 2560 屏的 12.4% 显眼得多。min(240px, 17vw) 经 foldVh 折算（vw 不随 zoom 缩，必须折）后
  // 小屏自动收窄、大屏仍走 240px 上限 —— 大屏观感不变。下限靠内容自身撑开，故不再设 min-width。
  return (
    <div
      ref={dockRef}
      data-data-dock
      className={`fixed left-4 flex flex-col rounded-xl border border-ink-700/70 bg-ink-900/85 px-2.5 shadow-xl backdrop-blur transition-all duration-200 ${
        // 收起＝贴到屏幕底边（bottom-0）+ 去掉下圆角，视觉上"缩进底边"；只留把手那一条
        collapsed ? 'bottom-0 py-0.5 rounded-b-none' : 'bottom-4 py-2'
      }`}
      style={{ zIndex: Z.dock, width: foldVh('min(240px, 17vw)') }}
    >
      {/* 🔴 B6 折叠把手：收起时贴屏底、只显示这一条，箭头朝上提示「可展开」 */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed
          ? `展开左下角工具栏（${view.storageBar === 'web' ? '云端存储' : view.storageBar === 'guest' ? '本地存储' : '本机存储'}）`
          : '收起到底边（只留这条箭头）'}
        aria-label={collapsed ? '展开左下角工具栏' : '收起左下角工具栏'}
        aria-expanded={!collapsed}
        className="flex items-center justify-center py-0.5 -mx-1 rounded text-ink-500 hover:text-amber transition-colors"
      >
        {collapsed ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>

      {!collapsed && (
        <>
          {view.showDevHint && (
            <div className="mb-1.5 rounded-md border border-amber/30 bg-amber/10 px-2 py-1 text-11 leading-snug text-amber">
              开发预览环境：桌面版专属功能需在打包版中使用
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <DensityControl />
            <div className="flex items-center gap-1.5 text-xs text-ink-300">
              {/* 标题随形态变：桌面/便携说「本机」，云端说「云端」，游客说「本地」 */}
              <span className="font-medium">
                {view.storageBar === 'web' ? '云端存储' : view.storageBar === 'guest' ? '本地存储' : '本机存储'}
              </span>
            </div>
            {view.storageBar === 'web'
              ? <WebDataBar />
              : view.storageBar === 'portable'
                ? <PortableDataBar />
                : view.storageBar === 'guest'
                  ? <GuestDataBar />
                  : <DesktopDataBar />}
          </div>

          {CLOUD_FILE_SYNC && (
            <>
              <Divider />
              <CloudFileSyncBar variant="panel" />
            </>
          )}
        </>
      )}
    </div>
  )
}
