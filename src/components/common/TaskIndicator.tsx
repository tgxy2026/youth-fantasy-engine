/**
 * 「后台任务」列表（2.6.3 · 跨页签任务存活）。
 *
 * 挂载位置（3.5.6 起变更）：
 *   · **主位置**：`components/app/TaskCenterPanel.tsx`（独立页签「工作面板 → 后台任务」）。
 *   · 旧位置（已移除）：Sidebar Footer 内嵌。原因：那块工具栏为给菜单让空间常被折叠，
 *     一折叠就看不见任务了；本项目「左下角只准一个浮层」的红线仍然有效，只是任务不再占这个位置。
 *   · `tests/browser/task-center.tsx` 仍把它当独立列表渲染，用于可视化回归。
 *
 * 它同时承担两件事：
 *   ① **一眼可见**：还有几个任务在后台跑、有几个完成但没看；
 *   ② **完成提示的唯一出口**：作者很可能已经切到别的页签，发起它的面板此刻没挂载 ——
 *      store 把提示写进 `notice`，由 `TaskNoticeBridge`（App 顶层，无 UI）订阅后 toast。
 *      ⚠️ 页签里的这份只在打开页签时存在，所以不能由它承担全站提示。
 */
import { Activity, Loader2, X } from 'lucide-react'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import {
  abortTask, clearFinishedTasks, dismissTask,
  runningTaskCount, unreadTaskCount, useAiTasks,
} from '@/lib/ai/aiTaskCenter'
import type { AiTaskStatus } from '@/lib/ai/aiTaskCenter'

/** 进度快照的形状由各任务自定义 —— 这里只安全地取出可显示的那行说明（不假设具体类型） */
function progressMessage(p: unknown): string {
  if (p && typeof p === 'object') {
    const m = (p as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return ''
}

const STATUS_TEXT: Record<AiTaskStatus, string> = {
  running: '进行中', done: '已完成', failed: '失败', aborted: '已中止',
}
const STATUS_CLASS: Record<AiTaskStatus, string> = {
  running: 'text-amber', done: 'text-success', failed: 'text-danger', aborted: 'text-ink-500',
}

export default function TaskIndicator({ onNavigate, activeTab, scroll = true, maxFinished }: {
  onNavigate: (id: string) => void
  activeTab: string
  /** 侧栏内嵌时自带滚动条；放进页签时由页面整体滚动 → 传 false（3.5.6） */
  scroll?: boolean
  /** 只显示最近 N 条已结束任务（页签用 5；不传＝全显示） */
  maxFinished?: number
}) {
  const tasks = useAiTasks()
  // 没有任务时整节不渲染（不给界面添乱）
  if (tasks.length === 0) return null

  const running = runningTaskCount()
  const unread = unreadTaskCount()
  const finishedTotal = tasks.length - running
  // 页签模式下只保留最近 maxFinished 条已结束任务（运行中的永不隐藏）
  let finishedSeen = 0
  const shown = tasks.filter(t => {
    if (t.status === 'running') return true
    finishedSeen += 1
    return maxFinished == null || finishedSeen <= maxFinished
  })

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Activity size={11} />
        <span>后台任务</span>
        {/* 🔴 问号紧跟标题（项目 UI 约定：不甩到行尾） */}
        <HelpPopover title="后台任务是什么" width="21rem" size={11}>
          {'切到别的页签时，正在跑的 AI 任务不会被中断——它在这里继续跑，完成后结果留在发起它的页签里，切回去就能接着看 / 写入。\n\n· 运行中：可以随时点「中止」（只有你点才会停，切页签不会）；\n· 已完成 / 失败：点「查看」直接跳回那个页签；\n· 多个任务可以同时跑，各自独立。'}
        </HelpPopover>
        <span className="ml-auto text-10 text-ink-500 tabular-nums">
          {running > 0 ? `运行中 ${running}` : ''}
          {running > 0 && unread > 0 ? ' · ' : ''}
          {unread > 0 ? `待查看 ${unread}` : ''}
          {running === 0 && unread === 0 ? `共 ${tasks.length}` : ''}
        </span>
      </div>

      {/* 🔴 自己带滚动条（2026-10-01 六维审计 P2）：这一节内嵌在 Sidebar Footer 的
          `overflow-hidden + max-h-[30rem]` 内容层里，任务一行行累积后会**被裁掉且不可见/不可点**
          （连下面的「清空已结束的记录」一起消失）。给自己加 max-height + overflow-y-auto
          就能在固定高度里滚，不动 Footer 的展开/收起动画。 */}
      <div className={scroll ? "space-y-1 max-h-[7.5rem] overflow-y-auto pr-0.5" : "space-y-1"}>
        {shown.map(t => {
          const msg = t.status === 'running' ? progressMessage(t.progress) : ''
          const showJump = t.status !== 'running' && (t.ownerTab !== activeTab || t.unread)
          return (
            <div
              key={t.id}
              data-task-id={t.id}
              data-task-status={t.status}
              className="flex items-center gap-1.5 rounded border border-ink-700/70 bg-ink-800/40 px-1.5 py-1"
              title={t.error || undefined}
            >
              {t.status === 'running'
                ? <Loader2 size={11} className="shrink-0 animate-spin text-amber" />
                : <span className={`shrink-0 text-[10px] ${STATUS_CLASS[t.status]}`}>●</span>}
              <span className="min-w-0 flex-1 truncate text-11 text-ink-200">
                {t.title}
                <span className={`ml-1 ${STATUS_CLASS[t.status]}`}>
                  {t.status === 'running' && msg ? msg : STATUS_TEXT[t.status]}
                </span>
              </span>
              {t.status === 'running' ? (
                <Button size="xs" variant="secondary" onClick={() => abortTask(t.id)} title="中止这个任务">中止</Button>
              ) : (
                <>
                  {showJump && (
                    <Button size="xs" variant="secondary" onClick={() => onNavigate(t.ownerTab)} title={`回到「${t.title}」所在页签查看结果`}>
                      查看
                    </Button>
                  )}
                  <Button iconOnly size="xs" variant="ghost" onClick={() => dismissTask(t.id)} title="移除这条任务及其内存结果（已写入的内容保留）">
                    <X size={10} />
                  </Button>
                </>
              )}
            </div>
          )
        })}
      </div>

      {finishedTotal > 1 && (
        <div className="mt-1">
          <Button size="xs" variant="secondary" onClick={clearFinishedTasks} title="清除已结束的任务及其内存结果；已写入的内容保留">清空已结束的记录</Button>
        </div>
      )}
    </div>
  )
}
