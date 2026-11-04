// 3.4.0 · A.3 隔离夹具：规划板卡片的「细纲绑定 / 固定条数」三态
// 直接走真实链路：buildChapterContextIndex(现有章节, 批量读到的 settings) → WritingWorkflow 卡片。
// 不渲染整个 Dashboard（它会读全库），但数据形态与 Dashboard 传入的完全一致。
import { createRoot } from 'react-dom/client'
import WritingWorkflow from '../../src/components/app/WritingWorkflow'
import { setCurrentProject } from '../../src/lib/db'
import { buildChapterContextIndex } from '../../src/lib/app/chapterBoardContext'
import type { CardRecord, Chapter, Volume } from '../../src/lib/types'
import '../../src/index.css'

const projectId = 'board-fixture'
setCurrentProject(projectId)
const now = Date.now()

const volume: Volume = { id: 'v1', projectId, order: 0, title: '第一卷', description: '', createdAt: now }
const mkChapter = (id: string, order: number, title: string): Chapter => ({
  id, projectId, volumeId: 'v1', order, title, content: `${title}的正文`, summary: '摘要',
  status: '草稿', wordCount: 4, createdAt: now, updatedAt: now,
})
const chapters = [mkChapter('c1', 0, '第一章'), mkChapter('c2', 1, '第二章'), mkChapter('c3', 2, '第三章')]

const outlines: CardRecord[] = [
  { id: 'o1', projectId, tabId: 'chapter-outline', name: '第一章细纲', data: {}, order: 0, createdAt: now },
]

// 真实设置形态：c1 有绑定+1 条固定；c2 绑定的卡已不存在；c3 没写过设置；
// 另外塞一条已删除章节的旧设置，验证它不会出现在索引里。
const raw = new Map<string, unknown>([
  ['c1', { schema: 1, outlineId: 'o1', pinnedRefs: [{ kind: 'row', projectId, tabId: 'characters', id: 'r1' }] }],
  ['c2', { schema: 1, outlineId: 'o-gone', pinnedRefs: [] }],
  ['deleted-chapter', { schema: 1, outlineId: 'o1', pinnedRefs: [] }],
])
const chapterContexts = buildChapterContextIndex(chapters, raw)

createRoot(document.getElementById('fixture')!).render(
  <div style={{ height: 1400, padding: 16 }}>
    <WritingWorkflow
      projectId={projectId}
      chapters={chapters}
      chapterOutlines={outlines}
      volumes={[volume]}
      ideas={[]}
      foreshadows={[]}
      ctx={{ type: 'full', features: [] }}
      chapterContexts={chapterContexts}
      onNavigate={() => {}}
      onExport={() => {}}
    />
  </div>,
)
