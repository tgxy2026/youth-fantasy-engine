import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { initializeAppearance } from '../../src/lib/settings/appearance'
import { useTaskRunner } from '../../src/lib/ai/aiTaskCenter'
import TaskIndicator from '../../src/components/common/TaskIndicator'
import { Button } from '../../src/components/common/Button'

initializeAppearance()

function TaskView() {
  const runner = useTaskRunner<string>({ ownerTab: 'fixture', kind: 'lifecycle', title: '生命周期回归' })
  return <section data-task-view data-status={runner.task?.status ?? 'idle'}>
    <Button onClick={() => runner.run(async ctx => {
      const controls = window as unknown as { taskRuns: number; finishTask?: (text: string) => void; taskSignal?: AbortSignal }
      controls.taskRuns = (controls.taskRuns ?? 0) + 1
      controls.taskSignal = ctx.signal
      ctx.progress({ message: '等待隔离任务回执' })
      return new Promise<string>(resolve => { controls.finishTask = resolve })
    })} disabled={runner.running}>启动隔离任务</Button>
    {runner.error && <div role="alert">{runner.error}</div>}
    {runner.result && <pre data-task-result className="whitespace-pre-wrap break-words">{runner.result}</pre>}
  </section>
}

function Fixture() {
  const [panel, setPanel] = useState(true)
  const [indicator, setIndicator] = useState(true)
  const [tab, setTab] = useState('fixture')
  return <main className="p-4 space-y-3">
    <Button onClick={() => setPanel(value => !value)}>开关任务面板</Button>
    <Button onClick={() => setIndicator(value => !value)}>开关任务指示器</Button>
    <Button onClick={() => setTab(value => value === 'fixture' ? 'other' : 'fixture')}>切换页签</Button>
    <output data-active-tab>{tab}</output>
    <div className="w-80">{indicator && <TaskIndicator activeTab={tab} onNavigate={setTab} />}</div>
    {panel && tab === 'fixture' && <TaskView />}
  </main>
}

createRoot(document.getElementById('fixture-root')!).render(<StrictMode><Fixture /></StrictMode>)
