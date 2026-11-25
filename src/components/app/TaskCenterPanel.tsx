import { Activity } from 'lucide-react'
import HelpPopover from '@/components/common/HelpPopover'
import { PAGE_DESCRIPTION_CLASS, PAGE_HEADER_STICKY_CLASS, PAGE_TITLE_CLASS } from '@/components/common/PageHeader'
import Panel from '@/components/common/Panel'
import TaskIndicator from '@/components/common/TaskIndicator'
import { runningTaskCount, useAiTasks } from '@/lib/ai/aiTaskCenter'

/**
 * 「后台任务」页签（3.5.6 · 主人要求从侧栏工具栏拆出）。
 *
 * 【为什么拆】原先任务列表内嵌在左下角「界面与数据」工具栏里；那块工具栏为了给左侧菜单让空间
 * 常被折叠，一折叠任务就彻底看不见 —— 等于把「跨页签任务存活」的唯一可见入口藏起来了。
 *
 * 【档位】`FEATURE_TIER['task-center'] = 'locked'`：创建项目时默认勾选、自定义项目里置灰不可取消。
 *
 * 【数据层没变】仍用 `lib/ai/aiTaskCenter` 的内存任务表：任务与发起页签解绑，切页签不中断。
 * 完成提示的 toast 由 App 顶层的 `TaskNoticeBridge` 统一弹（本页可能没打开，不能只靠这里）。
 */
export default function TaskCenterPanel({ onNavigate }: { onNavigate: (id: string) => void }) {
  const tasks = useAiTasks()
  const running = runningTaskCount()
  const finished = tasks.length - running

  return (
    <div className="w-full page-enter">
      <header className={`${PAGE_HEADER_STICKY_CLASS} mb-5`} data-guide="task-center-header">
        <div className="flex items-center gap-2">
          <h1 className={PAGE_TITLE_CLASS}>后台任务</h1>
          <HelpPopover title="后台任务是什么" width="22rem" size={14}>
            {'切到别的页签时，正在跑的 AI 任务不会被中断——它在这里继续跑，完成后结果留在发起它的页签里，切回去就能接着看 / 写入。\n\n· 运行中：可以随时点「中止」（只有你点才会停，切页签不会）；\n· 已完成 / 失败：点「查看」直接跳回那个页签；\n· 多个任务可以同时跑，各自独立；\n· 已结束的记录保留最近 5 条，用来回看失败原因或中途取消的任务。'}
          </HelpPopover>
        </div>
        <p className={PAGE_DESCRIPTION_CLASS}>
          跨页签任务进度 · 中止 · 完成后跳回发起页签
        </p>
      </header>

      <div className="space-y-4">
        <Panel>
          <div className="flex items-center gap-2 mb-3">
            <Activity size={13} className="text-amber" />
            <h2 className="text-13 font-semibold text-ink-100">任务列表</h2>
            <span className="text-11 text-ink-400 ws-num">
              {running > 0 ? `运行中 ${running}` : '当前没有运行中的任务'}
              {finished > 0 ? ` · 已结束 ${finished}` : ''}
            </span>
          </div>

          {tasks.length > 0 ? (
            <TaskIndicator onNavigate={onNavigate} activeTab="task-center" scroll={false} maxFinished={5} />
          ) : (
            <div className="rounded-lg border border-ink-700 bg-ink-800/30 px-4 py-6 text-center">
              <p className="text-12 text-ink-300">现在没有后台任务。</p>
              <p className="mt-1.5 text-11 text-ink-500">
                发起长任务（续写、校对、拆书、优化工单、推演这类）后，可以在这里看进度、中止；
                切到别的页签不会打断它。
              </p>
            </div>
          )}
        </Panel>

        <Panel>
          <h2 className="text-13 font-semibold text-ink-100 mb-2">什么时候会出现在这里</h2>
          <ul className="space-y-1.5 text-11 leading-relaxed text-ink-400">
            <li>· 耗时可能超过十几秒的 AI 任务才会进列表：整章改写、文字 / 逻辑校对、拆书抽取、优化工单生成与执行、情节推演、批量摘要等。</li>
            <li>· 几秒就能返回的短任务（取名、选区润色）不占列表，结果直接回到原面板。</li>
            <li>· 任务结果始终留在「发起它的页签」里；本页只负责看进度、中止和跳转，不保存任务产物。</li>
          </ul>
        </Panel>
      </div>
    </div>
  )
}
