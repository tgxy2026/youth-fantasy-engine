import assert from 'node:assert/strict'
import * as db from '../src/lib/db'
import { candidateApplyContext } from '../src/lib/ai/candidateContext'
import { createIndexedFieldWriter, type IndexedFieldWrite } from '../src/lib/settings/indexedFieldWriter'
import { memoryOps, KEY_PATHS } from './mock-memory'
import type { StoreOps } from '../src/lib/storage/storeOps'
import type { TableRow, CardRecord } from '../src/lib/types'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
type Row = TableRow | CardRecord
function backend() {
  const records = new Map<string, Row>(), writes: Row[] = []
  let pauseRead: Promise<void> | undefined, pauseWrite: Promise<void> | undefined, fail = false
  const read = async (store: string) => { if (pauseRead) await pauseRead; return [...records].filter(([key]) => key.startsWith(store + ':')).map(([, value]) => value) }
  const ops: StoreOps = { ...memoryOps,
    get: async <T>(store: string, key: string) => records.get(store + ':' + key) as T | undefined,
    getAll: async <T>(store: string) => await read(store) as T[],
    getAllByIndex: async <T>(store: string, index: string, value: IDBValidKey) => (await read(store)).filter(row => (row as unknown as Record<string, unknown>)[index] === value) as T[],
    put: async (store, input) => {
      if (store !== 'tableRows' && store !== 'cardRecords') return
      if (fail) throw new DOMException('private file path / request payload', 'QuotaExceededError')
      const value = input as Row; writes.push(value); records.set(store + ':' + String((value as unknown as Record<string, unknown>)[KEY_PATHS[store] ?? 'id']), value)
      if (pauseWrite) await pauseWrite
    },
  }
  return { records, writes, ops, readPause: (v?: Promise<void>) => { pauseRead = v }, writePause: (v?: Promise<void>) => { pauseWrite = v }, fail: (v: boolean) => { fail = v } }
}
let count = 0
async function test(name: string, run: () => Promise<void>) { await run(); count++; console.log('PASS ' + name) }
const field = (kind: 'table' | 'card'): IndexedFieldWrite => ({ kind, recordId: 'same-id', tabId: kind === 'table' ? 'nations' : 'char-main', dataKey: '正文', value: '新内容' })
function prepare(kind: 'table' | 'card') {
  const store = backend(), input = field(kind), key = (kind === 'table' ? 'tableRows:' : 'cardRecords:') + input.recordId
  const original: Row = { id: input.recordId, projectId: 'project-a', tabId: input.tabId, order: 1, createdAt: 1, name: '原记录', data: { 正文: '原内容', 保留字段: '不会丢' } }
  store.records.set(key, original); db.setStoreOps(store.ops); db.setCurrentProject('project-a')
  const context = candidateApplyContext(), write = createIndexedFieldWriter('project-a', () => context === candidateApplyContext(), () => ({ connected: true }))
  return { store, input, key, original, write }
}
for (const kind of ['table', 'card'] as const) {
  await test(`${kind}: actual DB facade writes a fresh record and preserves unrelated values`, async () => {
    const p = prepare(kind); assert.equal((await p.write(p.input)).ok, true)
    assert.equal(p.original.data.正文, '原内容'); assert.equal(p.store.records.get(p.key)?.data.正文, '新内容')
    assert.equal(p.store.records.get(p.key)?.data.保留字段, '不会丢')
  })
  await test(`${kind}: missing and foreign records never recreate an object`, async () => {
    for (const foreign of [false, true]) { const p = prepare(kind)
      if (foreign) p.store.records.set(p.key, { ...p.original, projectId: 'project-b' }); else p.store.records.delete(p.key)
      const outcome = await p.write(p.input); assert.ok(!outcome.ok && outcome.kind === 'missing'); assert.equal(p.store.writes.length, 0)
    }
  })
  await test(`${kind}: a delayed read rejects a replacement backend before any write`, async () => {
    const p = prepare(kind), pause = deferred(), replacement = backend(); p.store.readPause(pause.promise)
    const job = p.write(p.input); await settle(); db.setStoreOps(replacement.ops); pause.resolve()
    const outcome = await job; assert.ok(!outcome.ok && outcome.kind === 'stale'); assert.equal(p.store.writes.length + replacement.writes.length, 0)
  })
  await test(`${kind}: A-B-A project changes invalidate a retained callback`, async () => {
    const p = prepare(kind); db.setCurrentProject('project-b'); db.setCurrentProject('project-a')
    const outcome = await p.write(p.input); assert.ok(!outcome.ok && outcome.kind === 'stale'); assert.equal(p.store.writes.length, 0)
  })
  await test(`${kind}: a previously issued write stays with its owner and rejects the late receipt`, async () => {
    const p = prepare(kind), pause = deferred(), replacement = backend(); p.store.writePause(pause.promise)
    const job = p.write(p.input); await settle(); assert.equal(p.store.writes.length, 1)
    db.setStoreOps(replacement.ops); pause.resolve(); const outcome = await job
    assert.ok(!outcome.ok && outcome.kind === 'stale'); assert.equal(replacement.writes.length, 0)
  })
}
await test('same-payload double submit deduplicates; later values and fields serialize against fresh data', async () => {
  const p = prepare('table'), pause = deferred(); p.store.readPause(pause.promise)
  const first = p.write(p.input), duplicate = p.write(p.input)
  assert.equal(first, duplicate)
  const second = p.write({ ...p.input, value: '最新内容' }), third = p.write({ ...p.input, dataKey: '另一字段', value: '一起保留' })
  pause.resolve(); assert.equal((await first).ok, true); assert.equal((await second).ok, true); assert.equal((await third).ok, true)
  assert.equal(p.store.writes.length, 3); assert.equal(p.store.records.get(p.key)?.data.正文, '最新内容'); assert.equal(p.store.records.get(p.key)?.data.另一字段, '一起保留')
})
await test('a failed real put preserves the stored record and does not poison an explicit retry', async () => {
  const p = prepare('table'); p.store.fail(true); const outcome = await p.write(p.input)
  assert.ok(!outcome.ok && outcome.kind === 'failed' && !outcome.message.includes('private'))
  assert.equal(p.store.records.get(p.key), p.original); p.store.fail(false); assert.equal((await p.write(p.input)).ok, true)
})
await test('disconnected, locked and conflicted stores retain the draft without issuing a write', async () => {
  for (const state of [{ connected: false }, { connected: true, writeLocked: true }, { connected: true, saveConflict: true }]) {
    const p = prepare('table'), write = createIndexedFieldWriter('project-a', () => true, () => state)
    const result = await write(p.input)
    assert.ok(!result.ok && result.kind === 'blocked'); assert.equal(p.store.writes.length, 0)
    state.connected = true; Object.assign(state, { writeLocked: false, saveConflict: false })
    assert.equal((await write(p.input)).ok, true)
  }
})
await test('a lock acquired during preparation prevents a write; a late lock rejects the receipt', async () => {
  for (const phase of ['read', 'write']) {
    const p = prepare('table'), pause = deferred(), state = { connected: true, writeLocked: false }
    if (phase === 'read') p.store.readPause(pause.promise); else p.store.writePause(pause.promise)
    const write = createIndexedFieldWriter('project-a', () => true, () => state), job = write(p.input)
    await settle(); state.writeLocked = true; pause.resolve()
    const result = await job; assert.ok(!result.ok && result.kind === 'blocked')
    assert.equal(p.store.writes.length, phase === 'read' ? 0 : 1)
  }
})
console.log(`${count} indexed-field writer groups passed`)
