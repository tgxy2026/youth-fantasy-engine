import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { initializeAppearance } from '../../src/lib/settings/appearance'
import { writeStringPref } from '../../src/lib/settings/uiPrefs'
import WritingWorkflow from '../../src/components/app/WritingWorkflow'
import type { Chapter, Volume, TableRow } from '../../src/lib/types'

initializeAppearance()
const mode = new URLSearchParams(location.search).get('mode') || 'remembered'
const projectId = 'fixture-dashboard-' + mode
const now = Date.now()
const volumes: Volume[] = mode === 'empty' ? [] : [{ id: 'volume', projectId, order: 0, title: mode === 'extreme' ? 'VolumeWithoutSpaces'.repeat(30) : '第一卷', description: '', createdAt: now }]
const chapters: Chapter[] = mode === 'empty' ? [] : [
  { id: 'older', projectId, volumeId: 'volume', order: 0, title: mode === 'extreme' ? 'LongTitleWithoutSpaces'.repeat(80) : '上次打开的章节', content: '保留的稿件原文', summary: '章节摘要甲', status: '草稿', wordCount: mode === 'extreme' ? 0 : 8, createdAt: now - 10000, updatedAt: mode === 'extreme' ? NaN : now - 5000 },
  { id: 'newer', projectId, volumeId: 'volume', order: 1, title: '更新较新的章节', content: '未完成正文', summary: '章节摘要乙', status: '修改', wordCount: 5, createdAt: now - 10000, updatedAt: now },
]
const ideas: TableRow[] = [{ id: 'idea', projectId, tabId: 'ideas', order: 0, data: { 状态: '未用' } }]
const foreshadows: TableRow[] = Array.from({ length: 7 }, (_, index) => ({ id: 'foreshadow-' + index, projectId, tabId: 'foreshadow', order: index, data: { 状态: '未回收' } }))
writeStringPref(`editor-last-chapter:${projectId}`, mode === 'missing' ? 'deleted' : 'older')
declare global { interface Window { __workflowFixture: { chapters: Chapter[]; volumes: Volume[]; ideas: TableRow[]; foreshadows: TableRow[] } } }
window.__workflowFixture = { chapters, volumes, ideas, foreshadows }

function Fixture() {
  const [navigation, setNavigation] = useState('')
  return <main style={{ padding: 24 }}>
    <output aria-label="导航结果">{navigation}</output>
    <WritingWorkflow projectId={projectId} chapters={chapters} chapterOutlines={[]} volumes={volumes} ideas={ideas} foreshadows={foreshadows}
      ctx={mode === 'custom' ? { type: 'custom', features: [] } : { type: 'full', features: [] }}
      onNavigate={(id, chapterId) => setNavigation(JSON.stringify({ id, chapterId }))} onExport={() => {}} />
  </main>
}
createRoot(document.getElementById('fixture-root')!).render(<Fixture />)
