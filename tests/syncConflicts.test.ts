// 3.1 同步冲突中心：本机副本、恢复前保护与“冲突后又编辑”防覆盖。
import * as db from '../src/lib/db'
import type { Chapter, Project, Volume } from '../src/lib/types'
import { memoryOps, __resetMockStores } from './mock-memory'

let failures = 0
function check(name: string, condition: boolean) {
  if (condition) console.log(`PASS ${name}`)
  else { failures++; console.error(`FAIL ${name}`) }
}

__resetMockStores()
db.setStoreOps(memoryOps)
const pid = 'sync-conflict-test-project'
const now = Date.now()
const project: Project = { id: pid, name: '冲突恢复用项目', genre: '东方修真', intro: '', createdAt: now, updatedAt: now }
const volume: Volume = { id: 'v1', projectId: pid, order: 0, title: '第一卷', description: '', createdAt: now }
const chapter: Chapter = {
  id: 'c1', projectId: pid, volumeId: 'v1', order: 0, title: '第一章',
  content: '本机内容', summary: '本机摘要', status: '草稿', wordCount: 4,
  createdAt: now, updatedAt: now,
}
await memoryOps.put('projects', project)
await memoryOps.put('volumes', volume)
await memoryOps.put('chapters', chapter)
db.setCurrentProject(pid)

const key = `syncConflict:${now}:chapters:c1`
await memoryOps.put('meta', { key, value: {
  store: 'chapters', key: 'c1', at: now, local: chapter,
  server: { ...chapter, content: '云端内容', summary: '云端摘要', wordCount: 4 },
} })

check('老格式冲突记录可列出', (await db.listSyncConflicts()).some(c => c.metaKey === key && !c.resolvedAt))
await db.restoreServerChapterFromConflict(key)
check('恢复后章节正文来自云端副本', (await memoryOps.get<Chapter>('chapters', 'c1'))?.content === '云端内容')
check('恢复前自动建立项目备份', (await db.listBackups(pid)).some(b => b.label.includes('恢复同步冲突前')))
check('恢复前保存本机章节快照', (await db.getSnapshots('c1')).some(s => s.content === '本机内容' && s.source === 'manual-restore'))
check('恢复成功后标记冲突已处理', !!(await db.listSyncConflicts()).find(c => c.metaKey === key)?.resolvedAt)

// 发生冲突后作者继续写作，恢复旧副本必须拒绝，避免覆盖新稿。
const changedKey = `syncConflict:${now + 1}:chapters:c1`
const latest = (await memoryOps.get<Chapter>('chapters', 'c1'))!
await memoryOps.put('meta', { key: changedKey, value: {
  store: 'chapters', key: 'c1', at: now + 1, local: latest,
  server: { ...latest, content: '另一版云端内容' },
} })
await memoryOps.put('chapters', { ...latest, content: '冲突后继续写作' })
let rejected = false
try { await db.restoreServerChapterFromConflict(changedKey) } catch { rejected = true }
check('冲突后的新写作阻止原位恢复', rejected)
check('拒绝恢复时保留新稿', (await memoryOps.get<Chapter>('chapters', 'c1'))?.content === '冲突后继续写作')

await db.markSyncConflictResolved(changedKey)
check('可单独标记已处理', !!(await db.listSyncConflicts()).find(c => c.metaKey === changedKey)?.resolvedAt)
await db.deleteSyncConflict(changedKey)
check('删除只移除选中的冲突副本', (await db.listSyncConflicts()).length === 1)

if (failures) process.exit(1)
