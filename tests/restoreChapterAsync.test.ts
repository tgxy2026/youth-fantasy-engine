import { restoreChapter, type RestoreChapterHooks, type RestoreDependencies } from '../src/components/editor/restoreChapter'
import type { Chapter } from '../src/lib/types'
import type { OwnedOperation } from '../src/lib/storage/ownedOperation'

const chapter = { id: 'c1', projectId: 'p1', content: 'stored', wordCount: 6 } as Chapter
const owner = { projectId: 'p1', store: {}, assertCurrent: () => {} } as OwnedOperation
const snapshot = { id: 's1', projectId: 'p1', chapterId: 'c1', content: 'old', chapterTitle: '', wordCount: 3, createdAt: 1 }
let passed = 0
function assert(value: unknown, label: string) { if (!value) throw new Error(label); passed++; console.log(`PASS ${label}`) }
function setup() {
  let saved = snapshot
  let writes = 0, applied = 0
  const hooks: RestoreChapterHooks = {
    chapters: { current: [chapter] }, active: { current: chapter }, draft: { current: 'new draft' },
    autosaveTimer: { current: undefined }, enqueueSave: async (_id, fn) => fn(),
    locate: () => ({ volTitle: '', no: 1 }), syncChapterMaster: async () => {},
    applySaved: () => { applied++ }, setSaving: () => {},
  }
  const deps: RestoreDependencies = {
    capture: () => owner,
    getSnapshots: async () => [snapshot, saved],
    createSnapshot: async ch => { saved = { ...snapshot, id: 'new', content: ch.content }; return saved },
    patchChapter: async (_id, patch) => { writes++; return { ...chapter, ...patch } },
    persist: async () => true,
  }
  return { hooks, deps, counts: () => ({ writes, applied }) }
}
{
  const x = setup(); x.deps.persist = async () => false
  const result = await restoreChapter(x.hooks, 'c1', 's1', 'old', x.deps)
  assert(!result.ok && x.counts().writes === 0 && result.message.includes('未确认写入本机'), 'unconfirmed snapshot durability stops restore')
}
{
  const x = setup()
  const result = await restoreChapter(x.hooks, 'c1', 's1', 'old', x.deps)
  assert(result.ok && x.counts().writes === 1 && x.counts().applied === 1, 'success writes and applies once')
}
{
  const x = setup(); const original = x.deps.createSnapshot
  x.deps.createSnapshot = async (...args) => { const v = await original(...args); x.hooks.draft.current = 'newer'; return v }
  const result = await restoreChapter(x.hooks, 'c1', 's1', 'old', x.deps)
  assert(!result.ok && x.counts().writes === 0 && x.hooks.draft.current === 'newer', 'edit during snapshot prevents overwrite')
}
{
  const x = setup(); const original = x.deps.createSnapshot
  x.deps.createSnapshot = async (...args) => { const v = await original(...args); x.hooks.active.current = { ...chapter, id: 'c2' }; return v }
  const result = await restoreChapter(x.hooks, 'c1', 's1', 'old', x.deps)
  assert(!result.ok && x.counts().writes === 0 && x.counts().applied === 0, 'switch during snapshot prevents write')
}
{
  const x = setup(); x.deps.patchChapter = async () => { throw new Error('disk') }
  const result = await restoreChapter(x.hooks, 'c1', 's1', 'old', x.deps)
  assert(!result.ok && result.message.includes('可能已写入') && x.hooks.draft.current === 'new draft', 'write failure reports uncertain outcome and keeps draft')
}
{
  const x = setup(); let calls = 0
  x.deps.persist = async () => ++calls === 1
  const result = await restoreChapter(x.hooks, 'c1', 's1', 'old', x.deps)
  assert(!result.ok && x.counts().writes === 1 && x.counts().applied === 0 && result.message.includes('正文未确认写入本机'), 'unconfirmed chapter durability does not report success')
}
{
  const x = setup(); x.deps.patchChapter = async (_id, patch) => { x.hooks.draft.current = 'newer'; return { ...chapter, ...patch } }
  const result = await restoreChapter(x.hooks, 'c1', 's1', 'old', x.deps)
  assert(!result.ok && x.counts().applied === 0 && x.hooks.draft.current === 'newer', 'edit during write does not replace newer draft')
}
{
  const x = setup(); x.hooks.syncChapterMaster = async () => { throw new Error('ledger') }
  const result = await restoreChapter(x.hooks, 'c1', 's1', 'old', x.deps)
  assert(!result.ok && result.message.includes('可能已写入') && x.counts().applied === 0, 'derived write failure reports partial result')
}
console.log(`${passed} passed`)
