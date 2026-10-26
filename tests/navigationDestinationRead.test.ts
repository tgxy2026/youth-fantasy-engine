import assert from 'node:assert/strict'
import * as db from '../src/lib/db'
import type { StoreOps } from '../src/lib/storage/storeOps'
import { memoryOps } from './mock-memory'

const request = { kind: 'card' as const, projectId: 'project-a', tabId: 'char-main', recordId: 'record-1' }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { resolve, promise } }
let count = 0
const check = async (name: string, run: () => void | Promise<void>) => { await run(); count++; console.log('PASS ' + name) }
function fixture(read: (store: string, id: string) => Promise<unknown>) {
  const calls: Array<{ store: string; id: string }> = []
  const store: StoreOps = { ...memoryOps,
    get: async <T>(name: string, id: string) => { calls.push({ store: name, id }); return await read(name, id) as T | undefined },
    getAll: async () => { throw Error('unexpected full scan') },
    getAllByIndex: async () => { throw Error('unexpected list scan') },
    put: async () => { throw Error('existence checks cannot write') },
  }
  db.setStoreOps(store)
  return calls
}
await check('card and table checks issue one exact-key read and never materialize a list or body', async () => {
  for (const kind of ['card', 'table'] as const) {
    const calls = fixture(async () => ({ projectId: request.projectId, tabId: request.tabId,
      get data() { throw Error('body must not be inspected') } }))
    assert.equal(await db.tabRecordExistsFor({ ...request, kind }), true)
    assert.deepEqual(calls, [{ store: kind === 'card' ? 'cardRecords' : 'tableRows', id: request.recordId }])
  }
})
await check('identical ids in another project or tab do not authorize a destination', async () => {
  for (const record of [undefined, { projectId: 'project-b', tabId: request.tabId }, { projectId: request.projectId, tabId: 'char-secondary' }]) {
    fixture(async () => record)
    assert.equal(await db.tabRecordExistsFor(request), false)
  }
})
await check('record kind selects the correct store even when another store has that id', async () => {
  fixture(async name => name === 'tableRows' ? { projectId: request.projectId, tabId: request.tabId } : undefined)
  assert.equal(await db.tabRecordExistsFor(request), false)
  assert.equal(await db.tabRecordExistsFor({ ...request, kind: 'table' }), true)
})
await check('empty routing fields or unsupported kinds perform no reads', async () => {
  const calls = fixture(async () => { throw Error('not reached') })
  for (const field of ['projectId', 'tabId', 'recordId'] as const) assert.equal(await db.tabRecordExistsFor({ ...request, [field]: '' }), false)
  assert.equal(await db.tabRecordExistsFor({ ...request, kind: 'form' as 'card' }), false)
  assert.equal(calls.length, 0)
})
await check('storage rejection stays an error rather than being disguised as a missing record', async () => {
  fixture(async () => { throw Error('read fixture failure') })
  await assert.rejects(db.tabRecordExistsFor(request), /read fixture failure/)
})
await check('pending reads keep explicit owner values instead of following mutable current project or caller objects', async () => {
  const pending = deferred<unknown>(), input = { ...request }
  fixture(() => pending.promise); db.setCurrentProject('project-a')
  const result = db.tabRecordExistsFor(input)
  input.projectId = 'project-b'; input.tabId = 'another-tab'; db.setCurrentProject('project-b')
  pending.resolve({ projectId: request.projectId, tabId: request.tabId })
  assert.equal(await result, true)
})
await check('an in-flight lookup does not issue another read or write into a replacement backend', async () => {
  const pending = deferred<unknown>(), old = fixture(() => pending.promise)
  const result = db.tabRecordExistsFor(request)
  const next = fixture(async () => { throw Error('replacement backend must not be queried') })
  pending.resolve({ projectId: request.projectId, tabId: request.tabId })
  assert.equal(await result, true); assert.equal(old.length, 1); assert.equal(next.length, 0)
})
console.log('navigationDestinationRead ' + count + ' passed')
