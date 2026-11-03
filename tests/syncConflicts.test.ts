// 3.1 同步冲突中心：本机副本、恢复前保护与“冲突后又编辑”防覆盖。
import * as db from '../src/lib/db'
import type { Chapter, Project, Volume } from '../src/lib/types'
import type { StoredSyncConflict } from '../src/lib/db/syncConflicts'
import { memoryOps, __resetMockStores } from './mock-memory'
import { __setFlushDesktopResult } from './mock-desktop'
import {
  CONFLICT_PAGE, CONFLICT_RETENTION_DAYS, CONFLICT_SIZE_WARN_BYTES, CONFLICT_TOTAL_WARN_BYTES,
  conflictBytes, conflictStats, conflictStoreLabel, conflictStores, filterConflicts, formatConflictBytes, isConflictExpired,
} from '../src/lib/sync/conflictView'

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
const firstResult = await db.restoreServerChapterFromConflict(key)
check('恢复结果明确确认本机落盘', firstResult.persisted)
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

async function prepareConflict(suffix: string) {
  db.setStoreOps(memoryOps)
  db.setCurrentProject(pid)
  await memoryOps.put('chapters', chapter)
  const metaKey = `syncConflict:${suffix}:chapters:c1`
  await memoryOps.put('meta', { key: metaKey, value: {
    store: 'chapters', key: 'c1', at: now, local: chapter,
    server: { ...chapter, content: '待恢复云稿', summary: '云端摘要' },
  } })
  return metaKey
}

// 所有会被覆盖的字段均需检查，不只正文/标题/状态。
for (const patch of [{ summary: '新摘要' }, { order: 7 }, { volumeId: 'new-volume' },
  { excludeFromNumbering: true }, { updatedAt: now + 100 }]) {
  const metaKey = await prepareConflict(Object.keys(patch)[0])
  const edited = { ...chapter, ...patch }
  await memoryOps.put('chapters', edited)
  let blocked = false
  try { await db.restoreServerChapterFromConflict(metaKey) } catch { blocked = true }
  check(`后续修改 ${Object.keys(patch)[0]} 时拒绝覆盖`, blocked)
  check(`保留 ${Object.keys(patch)[0]} 的修改`, JSON.stringify(await memoryOps.get('chapters', 'c1')) === JSON.stringify(edited))
}

for (const changeBackend of [false, true]) {
  const metaKey = await prepareConflict(`context-${changeBackend}`)
  db.setStoreOps({ ...memoryOps, put: async (store, value) => {
    await memoryOps.put(store, value)
    if (store === 'backupPayloads') {
      if (changeBackend) db.setStoreOps(memoryOps)
      else db.setCurrentProject('other-project')
    }
  } })
  let blocked = false
  try { await db.restoreServerChapterFromConflict(metaKey) } catch { blocked = true }
  check(`备份期间切换${changeBackend ? '后端' : '项目'}时中止`, blocked)
  check('切换后章节归属与正文保持正确', (await memoryOps.get<Chapter>('chapters', 'c1'))?.projectId === pid
    && (await memoryOps.get<Chapter>('chapters', 'c1'))?.content === chapter.content)
}

const failedSaveKey = await prepareConflict('disk-failure')
__setFlushDesktopResult(false)
try {
  const result = await db.restoreServerChapterFromConflict(failedSaveKey)
  check('写盘失败时不确认持久化', !result.persisted)
  check('写盘失败时明确提示不要刷新', result.warnings.some(w => w.includes('请勿刷新')))
  check('写盘失败保留待处理冲突', !(await db.listSyncConflicts()).find(c => c.metaKey === failedSaveKey)?.resolvedAt)
} finally { __setFlushDesktopResult(true) }

// 离线包装层读取本机，恢复仅写入选中记录，不能删除离线新章。
const offlineKey = await prepareConflict('offline')
await memoryOps.put('chapters', { ...chapter, id: 'offline-new', content: '离线新增稿件' })
db.setStoreOps(db.makeCloudStoreWrapper(memoryOps, memoryOps, () => true))
const offlineResult = await db.restoreServerChapterFromConflict(offlineKey)
check('离线恢复也确认本机持久化', offlineResult.persisted)
check('离线新增章节保留', (await memoryOps.get<Chapter>('chapters', 'offline-new'))?.content === '离线新增稿件')
check('离线恢复正文不被旧缓存回滚', (await memoryOps.get<Chapter>('chapters', 'c1'))?.content === '待恢复云稿')
db.setStoreOps(memoryOps)

// ============ 3.1.1 · 冲突中心展示层纯逻辑（conflictView）============
// 体积口径 / 类型标签 / 筛选 / 统计 / 保留期判定 —— 全是纯函数，这里逐条钉住。
// 🔴 尤其体积：作者看到的占用数一旦与数据文件增量对不上，界面上是看不出来的。

const sample = (over: Partial<StoredSyncConflict> = {}): StoredSyncConflict => ({
  metaKey: `syncConflict:${now}:chapters:c1`, store: 'chapters', key: 'c1', at: now,
  local: { title: '第一章', content: '本机' }, server: { title: '第一章', content: '云端' },
  ...over,
})

check('分页粒度与「资料提及」面板同范式（50）', CONFLICT_PAGE === 50)
check('告警线关系：单条线 < 合计线', CONFLICT_SIZE_WARN_BYTES < CONFLICT_TOTAL_WARN_BYTES)

check('类型标签：已知 store 译成中文', conflictStoreLabel('chapters') === '章节' && conflictStoreLabel('cardRecords') === '角色卡')
check('类型标签：未知 store 原样显示（不静默吞成「未知」）', conflictStoreLabel('brandNewStore') === 'brandNewStore')
check('类型标签：空 store 兜底为「未知类型」', conflictStoreLabel('') === '未知类型')

const one = sample()
const expectedBytes = new TextEncoder().encode(JSON.stringify({
  key: one.metaKey,
  value: { store: one.store, key: one.key, at: one.at, local: one.local, server: one.server },
})).length
check('体积口径：= meta 行紧凑 JSON 的 UTF-8 字节数', conflictBytes(one) === expectedBytes)
check('体积口径：正文变长则体积变大', conflictBytes(sample({ local: { content: 'x'.repeat(5000) } })) > conflictBytes(one))
check('体积口径：已处理标记也计入', conflictBytes({ ...one, resolvedAt: now }) > conflictBytes(one))

check('体积格式化：B / KB / MB 三档',
  formatConflictBytes(0) === '0 B' && formatConflictBytes(900) === '900 B'
  && formatConflictBytes(2048) === '2.0 KB' && formatConflictBytes(2 * 1024 * 1024) === '2.00 MB')
check('体积格式化：非法值兜底 0 B', formatConflictBytes(-1) === '0 B' && formatConflictBytes(Number.NaN) === '0 B')

const vList: StoredSyncConflict[] = [
  sample({ metaKey: 'k1', store: 'chapters' }),
  sample({ metaKey: 'k2', store: 'chapters', resolvedAt: now }),
  sample({ metaKey: 'k3', store: 'projects' }),
  sample({ metaKey: 'k4', store: 'cardRecords', resolvedAt: now }),
]
const stores = conflictStores(vList)
check('类型下拉：去重（4 条 → 3 个类型）', stores.length === 3)
check('类型下拉：只含实际出现过的 store',
  stores.includes('chapters') && stores.includes('projects') && stores.includes('cardRecords') && !stores.includes('volumes'))

check('筛选：按类型', filterConflicts(vList, { store: 'chapters', status: 'all' }).length === 2)
check('筛选：待处理', filterConflicts(vList, { store: 'all', status: 'open' }).length === 2)
check('筛选：已处理', filterConflicts(vList, { store: 'all', status: 'resolved' }).length === 2)
check('筛选：类型 + 状态叠加', filterConflicts(vList, { store: 'chapters', status: 'open' }).map(c => c.metaKey).join(',') === 'k1')
check('筛选：全部 = 原集合', filterConflicts(vList, { store: 'all', status: 'all' }).length === vList.length)

const st = conflictStats(vList)
check('统计：总数 / 待处理 / 已处理', st.total === 4 && st.unresolved === 2 && st.resolved === 2)
check('统计：合计体积 = 各条之和', st.bytes === vList.reduce((s, c) => s + conflictBytes(c), 0))
check('统计：sizes 覆盖每一条', vList.every(c => st.sizes.has(c.metaKey)))

const day = 86_400_000
check('保留期：未处理不计超期', !isConflictExpired(sample(), now))
check('保留期：刚处理不算超期', !isConflictExpired(sample({ resolvedAt: now }), now))
check('保留期：恰好在保留期内不算超期', !isConflictExpired(sample({ resolvedAt: now - CONFLICT_RETENTION_DAYS * day }), now))
check('保留期：超过保留期才算超期', isConflictExpired(sample({ resolvedAt: now - (CONFLICT_RETENTION_DAYS + 1) * day }), now))
check('保留期：统计里的 expired 与逐条判定一致', conflictStats([sample({ resolvedAt: now - 200 * day })], now).expired === 1)

if (failures) process.exit(1)
