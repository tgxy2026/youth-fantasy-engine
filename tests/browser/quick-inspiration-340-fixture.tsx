import { createRoot } from 'react-dom/client'
import QuickInspiration from '../../src/components/app/QuickInspiration'
import { setCurrentProject } from '../../src/lib/db'
import { ops } from '../../src/lib/db/core'
import { runAuxiliaryLeaveGuards } from '../../src/lib/editor/leaveBarrier'
import '../../src/index.css'
setCurrentProject('fixture-idea')
await ops.put('chapters', { id: 'fixture-chapter', projectId: 'fixture-idea', title: '示例章', volumeId: 'v', order: 0 })
const originalPut = ops.put.bind(ops)
;(window as unknown as { failWrites: (fail: boolean) => void; tryLeave: () => Promise<boolean> }).failWrites = fail => { ops.put = fail ? async () => { throw new Error('write failure') } : originalPut }
;(window as unknown as { tryLeave: () => Promise<boolean> }).tryLeave = async () => (await runAuxiliaryLeaveGuards()).ok
createRoot(document.getElementById('fixture')!).render(<QuickInspiration projectId="fixture-idea" chapters={[{ id: 'fixture-chapter', projectId: 'fixture-idea', title: '示例章' }] as never} onOpen={() => {}} />)
