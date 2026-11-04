import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import ExportFormatDialog from '../../src/components/dialogs/ExportFormatDialog'
import { setCurrentProject } from '../../src/lib/db'
import '../../src/index.css'
setCurrentProject('fixture-export')
const volumes = [{ id: 'v1', projectId: 'fixture-export', title: '第一卷', order: 0 }]
const chapters = [{ id: 'c1', projectId: 'fixture-export', volumeId: 'v1', title: '第一章', content: '正文', wordCount: 2, order: 0, status: '草稿', summary: '' }]
function Fixture() {
  const [rows, setRows] = useState(chapters)
  ;(window as unknown as { removeChapter: () => void }).removeChapter = () => setRows([])
  return <ExportFormatDialog open onClose={() => {}} projectId="fixture-export" projectName="测试" volumes={volumes as never} chapters={rows as never} initialTab="platform" />
}
createRoot(document.getElementById('fixture')!).render(<Fixture />)
