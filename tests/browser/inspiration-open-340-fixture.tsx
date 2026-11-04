// 3.4.0 · F 关联章节「打开目标」夹具：
// 只渲染灵感夹本体，数据用真实 ops + 项目设置种入；点击后抓 yfe:navigate 的事件细节。
import { createRoot } from 'react-dom/client'
import InspirationBox from '../../src/components/creative/InspirationBox'
import { setCurrentProject } from '../../src/lib/db'
import * as db from '../../src/lib/db'
import { ops } from '../../src/lib/db/core'
import '../../src/index.css'

const projectId = 'insp-open-fixture'
setCurrentProject(projectId)
const now = Date.now()
const mkChapter = (id: string, order: number, title: string) => ({
  id, projectId, volumeId: 'v1', order, title, content: '', summary: '',
  status: '草稿', wordCount: 0, createdAt: now, updatedAt: now,
})
await ops.put('chapters', mkChapter('ch1', 0, '第一章 关联目标'))
await ops.put('chapters', mkChapter('ch2', 1, '第二章 另一章'))

await db.setSettingFor(projectId, 'inspirationBox', [
  { id: 'i1', text: '有章节的灵感', createdAt: now, chapterId: 'ch1' },
  { id: 'i2', text: '章节已删的灵感', createdAt: now, chapterId: 'ch-deleted' },
  { id: 'i3', text: '没关联的灵感', createdAt: now },
])

type NavDetail = { tabId?: string; chapterId?: string }
const captured: NavDetail[] = []
window.addEventListener('yfe:navigate', event => {
  captured.push((event as CustomEvent<NavDetail>).detail)
  ;(window as unknown as { __nav: NavDetail[] }).__nav = captured
})

createRoot(document.getElementById('fixture')!).render(
  <div style={{ height: 900, padding: 16 }}>
    <InspirationBox />
  </div>,
)
