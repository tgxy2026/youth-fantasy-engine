import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { WEB } from '@/lib/app/platform'
import { dismissForToday, fetchLatestWebBuildId, readDismissedOn, shouldPrompt } from '@/lib/app/webVersionNotice'
import { foldVh } from '@/lib/settings/theme'

/**
 * 网页版「有新版本，刷新以应用」提示条（3.6.2 · W1）。
 *
 * 【为什么单独成组件】它有三个约束，混进 App.tsx 会同时踩到：
 *   ① 只在网页版跑（桌面/便携有自己的更新通道）；
 *   ② 带定时器 + 可见性监听，必须自己管生命周期；
 *   ③ App.tsx 已接近单文件行数上限（structureGates 1200 行硬线），不适合再塞逻辑。
 *
 * 🔴 行为口径：
 *   · **只提示，绝不自动刷新**（规划 §9.1 明确不做静默自动更新：用户可能正在写正文，
 *     自动刷新会把未保存的输入冲掉）；
 *   · 启动后先延迟几秒再查，避免和首屏抢带宽；
 *   · 取不到就静默（断网 / 清单没部署 / 字段缺失都不弹）；
 *   · 同一个构建不重复弹；点「今天不再提示」按本地日期记住，隔天才有机会再提醒。
 */
const CHECK_INTERVAL_MS = 30 * 60 * 1000
/** 首查延迟：让界面先跑起来（首屏还要抢带宽加载 chunk） */
const FIRST_DELAY_MS = 8000

export default function WebUpdateBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!WEB) return
    let alive = true
    /**
     * 🔴 baseline 的取法：页面是"不知道自己是哪一版"的（线上没有可读的 /BUILD_ID，
     *    见 lib/app/webVersionNotice.ts 顶部说明），所以**以第一次成功取到的 id 作为基线**。
     *    第一次取不到就留空，等下一次成功再定基线 —— 于是最坏情况是"这次会话不提示"，
     *    而不是"每次检查都弹一次"。
     */
    let baseline = ''
    let timer: ReturnType<typeof setInterval> | null = null

    const check = async () => {
      const latest = await fetchLatestWebBuildId()
      if (!alive || !latest) return
      if (!baseline) {
        baseline = latest
        return
      }
      if (shouldPrompt(baseline, latest, readDismissedOn())) setVisible(true)
    }

    const kick = setTimeout(() => { void check() }, FIRST_DELAY_MS)
    timer = setInterval(() => { void check() }, CHECK_INTERVAL_MS)
    // 回前台立刻查一次：用户切出去很久再回来，是最常见的"版本已经差了几天"场景
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      alive = false
      clearTimeout(kick)
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (!visible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl border border-amber/40 yfe-surface-4-soft px-3 py-2 shadow-lg backdrop-blur"
      style={{ maxWidth: foldVh('92vw') }}
    >
      <RefreshCw size={14} className="shrink-0 text-amber" />
      <span className="text-12 text-ink-200">网页版有新版本，刷新即可用上（当前页面不会自动刷新）</span>
      <Button size="xs" variant="primary" onClick={() => window.location.reload()}>
        刷新以应用
      </Button>
      <Button
        size="xs"
        variant="bare"
        className="text-11 text-ink-400 hover:text-ink-200"
        onClick={() => {
          dismissForToday()
          setVisible(false)
        }}
      >
        今天不再提示
      </Button>
    </div>
  )
}
