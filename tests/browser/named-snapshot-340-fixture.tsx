import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VersionHistory } from '../../src/components/editor/EditorModals'
import { setCurrentProject } from '../../src/lib/db'
import { ops } from '../../src/lib/db/core'
import '../../src/index.css'
setCurrentProject('fixture-snapshot')
await ops.put('chapters', { id: 'chapter', projectId: 'fixture-snapshot', title: '测试章', content: '已保存正文', wordCount: 5, volumeId: 'v', order: 0 })
const originalPut = ops.put.bind(ops)
;(window as unknown as { failWrites: (fail: boolean) => void }).failWrites = fail => {
  ops.put = fail ? async (store, value) => { if (store === 'snapshots') throw new Error('injected failure'); return originalPut(store, value) } : originalPut
}
function Fixture() {
  const [open, setOpen] = useState(true)
  return <><button onClick={() => setOpen(true)}>打开历史</button>{open && <VersionHistory projectId="fixture-snapshot" chapterId="chapter" current="尚未保存的草稿" onRestore={async () => ({ ok: false, message: 'fixture' })} onClose={() => setOpen(false)} />}</>
}
createRoot(document.getElementById('fixture')!).render(<Fixture />)
