import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ChapterSetsPanel from '../../src/components/app/ChapterSetsPanel'
import { setCurrentProject } from '../../src/lib/db'
import { ops } from '../../src/lib/db/core'
import '../../src/index.css'

setCurrentProject('fixture-a')
const originalPut = ops.put.bind(ops)
;(window as unknown as { failWrites: (fail: boolean) => void }).failWrites = fail => {
  ops.put = fail ? async () => { throw new Error('injected failure') } : originalPut
}
function Fixture() {
  const [project, setProject] = useState('fixture-a')
  const switchProject = (id: string) => { setCurrentProject(id); setProject(id) }
  const chapters = [1, 2].map(n => ({ id: `${project}-c${n}`, projectId: project, title: `章节${n}`, content: '', wordCount: 0 }))
  return <><button onClick={() => switchProject('fixture-a')}>项目 A</button><button onClick={() => switchProject('fixture-b')}>项目 B</button><div style={{ height: 400 }}><ChapterSetsPanel key={project} projectId={project} chapters={chapters as never} onNavigate={() => {}} /></div></>
}
createRoot(document.getElementById('fixture')!).render(<Fixture />)
