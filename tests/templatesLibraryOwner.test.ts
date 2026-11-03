import assert from 'node:assert/strict'
import * as db from '../src/lib/db'
import { memoryOps } from './mock-memory'
import type { StoreOps } from '../src/lib/storage/storeOps'
import { publishTemplateDef, loadLibraryIndex, loadLibraryVersion, LIBRARY_INDEX_KEY } from '../src/lib/templates/library'
import { saveTemplateDef } from '../src/lib/templates/store'
import { exportTemplatePack, importPackToLibrary } from '../src/lib/templates/packIO'
import { TEMPLATE_DEF_VERSION, TEMPLATE_LIMITS, libraryKeyOf, type TemplateDef } from '../src/lib/templates/definition'
import { bytesOfDef } from '../src/lib/templates/limits'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
const wait = async (ready: () => boolean) => { for (let i = 0; i < 100 && !ready(); i++) await Promise.resolve(); assert.ok(ready(), 'actual preparation reached the pause') }
function backend() {
  const rows = new Map<string, unknown>(), writes: string[] = []
  let pause: { when: (store: string, key: string) => boolean; promise: Promise<void> } | null = null, started = false, failIndex = false
  const ops: StoreOps = { ...memoryOps,
    get: async <T>(store: string, key: string) => { if (pause?.when(store, key)) { started = true; await pause.promise }; return rows.get(store + ':' + key) as T | undefined },
    put: async (store, value) => {
      const record = value as { key: string }
      if (failIndex && store === 'meta' && record.key === LIBRARY_INDEX_KEY) throw Error('private path/token must not be shown')
      writes.push(store + ':' + record.key); rows.set(store + ':' + record.key, structuredClone(value))
    },
    del: async (store, key) => { rows.delete(store + ':' + key) },
  }
  return { rows, writes, ops, get started() { return started }, hold: (when: (s: string, k: string) => boolean, promise: Promise<void>) => { pause = { when, promise } }, fail: (v: boolean) => { failIndex = v } }
}
function definition(id = 'tpl_owned', tabId = 'races'): TemplateDef {
  return { formatVersion: TEMPLATE_DEF_VERSION, templateId: id, name: '原模板名称', tabId,
    origin: { kind: 'library', templateId: id, version: 1, fromName: '原模板名称' }, groups: [{ id: 'g1', label: '分组', order: 0 }],
    fields: [{ id: 'cf_owned', sourceKey: 'cf_owned', source: 'custom', label: '原字段', type: 'text', groupId: 'g1', order: 0, appliesTo: '*', archived: false, permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: true } }],
    nameFieldId: 'cf_owned', semanticDigest: 'd1', revision: 0, updatedAt: 1 }
}
let count = 0
async function test(name: string, run: () => Promise<void>) { await run(); count++; console.log('PASS ' + name) }
function prepare() { const source = backend(); db.setStoreOps(source.ops); db.setCurrentProject('owner-project'); return source }
await test('queued publications capture the original backend before their first read', async () => {
  const old = prepare(), replacement = backend(), gate = deferred(); old.hold((s, k) => s === 'meta' && k === LIBRARY_INDEX_KEY, gate.promise)
  const first = publishTemplateDef(definition('tpl_a')), second = publishTemplateDef(definition('tpl_b'))
  const results = Promise.allSettled([first, second]); await wait(() => old.started); db.setStoreOps(replacement.ops); gate.resolve()
  assert.ok((await results).every(r => r.status === 'rejected')); assert.equal(old.writes.length + replacement.writes.length, 0)
})
await test('queued payloads and explicit versions are immutable snapshots', async () => {
  const source = prepare(), gate = deferred(); source.hold((s, k) => s === 'meta' && k === LIBRARY_INDEX_KEY, gate.promise)
  const first = publishTemplateDef(definition('tpl_first')); await wait(() => source.started)
  const def = definition('tpl_second'), options = { version: 1 }, second = publishTemplateDef(def, options)
  def.name = '后来修改的名称'; def.fields[0].label = '后来修改的字段'; def.origin = { kind: 'builtin' }; options.version = 8
  gate.resolve(); assert.equal((await first).ok, true); assert.equal((await second).ok, true)
  const saved = await loadLibraryVersion('tpl_second', 1)
  assert.equal(saved?.def.name, '原模板名称'); assert.equal(saved?.def.fields[0].label, '原字段'); assert.equal(saved?.def.origin.kind, 'library')
  assert.equal(await loadLibraryVersion('tpl_second', 8), null)
})
await test('an index-write failure retries without overwriting the accepted immutable version', async () => {
  const source = prepare(), def = definition(); source.fail(true)
  await assert.rejects(publishTemplateDef(def)); const accepted = structuredClone(source.rows.get('meta:' + libraryKeyOf(def.templateId, 1)))
  assert.ok(accepted); source.fail(false)
  const repaired = await publishTemplateDef(def); assert.ok(repaired.ok && !repaired.created)
  assert.deepEqual(source.rows.get('meta:' + libraryKeyOf(def.templateId, 1)), accepted)
  assert.equal((await loadLibraryIndex()).entries.length, 1)
  source.rows.delete('meta:' + LIBRARY_INDEX_KEY)
  const changed = { ...def, name: '不同内容' }, conflict = await publishTemplateDef(changed)
  assert.ok(!conflict.ok && conflict.code === 'version-conflict'); assert.deepEqual(source.rows.get('meta:' + libraryKeyOf(def.templateId, 1)), accepted)
  assert.equal((await loadLibraryIndex()).entries[0].latestVersion, 1)
  const next = await publishTemplateDef(changed); assert.ok(next.ok && next.version === 2)
})
await test('project template preparation cannot continue writing into a replacement backend', async () => {
  const old = prepare(), replacement = backend(), gate = deferred(); old.hold(s => s === 'settingsKV', gate.promise)
  const job = saveTemplateDef('owner-project', definition()); const result = Promise.allSettled([job])
  await wait(() => old.started); db.setStoreOps(replacement.ops); gate.resolve()
  assert.equal((await result)[0].status, 'rejected'); assert.equal(old.writes.length + replacement.writes.length, 0)
})
await test('multi-template import stops at its original boundary and reports partial uncertainty safely', async () => {
  const old = prepare(), replacement = backend(), gate = deferred(); let reads = 0
  old.hold((s, k) => s === 'meta' && k === LIBRARY_INDEX_KEY && ++reads === 2, gate.promise)
  const pack = exportTemplatePack([definition('tpl_one'), definition('tpl_two')]); assert.ok(pack.ok)
  const job = importPackToLibrary(pack.text); await wait(() => old.started); db.setStoreOps(replacement.ops); gate.resolve()
  const result = await job; assert.ok(!result.ok && result.code === 'write-incomplete' && result.detail.includes('已确认处理 1 份') && !result.detail.includes('private'))
  assert.equal(replacement.writes.length, 0); assert.ok(old.rows.has('meta:' + libraryKeyOf('tpl_one', 1))); assert.ok(!old.rows.has('meta:' + libraryKeyOf('tpl_two', 1)))
})
await test('queued project quota checks observe earlier accepted definitions', async () => {
  prepare(); const limit = TEMPLATE_LIMITS.PROJECT_MAX_BYTES, a = definition('tpl_quota_a', 'races'), b = definition('tpl_quota_b', 'nations')
  try {
    Object.assign(TEMPLATE_LIMITS, { PROJECT_MAX_BYTES: Math.max(bytesOfDef(a), bytesOfDef(b)) + 10 })
    const [first, second] = await Promise.all([saveTemplateDef('owner-project', a), saveTemplateDef('owner-project', b)])
    assert.equal(first.ok, true); assert.ok(!second.ok && second.violations.some(v => v.code === 'project-defs-too-large'))
  } finally { Object.assign(TEMPLATE_LIMITS, { PROJECT_MAX_BYTES: limit }) }
})
await test('unreadable occupied version slots, including null payloads, are never overwritten', async () => {
  for (const payload of [null, false, 'broken-record', { formatVersion: 99, evidence: 'retain this original payload' }]) {
    const source = prepare(), def = definition(), key = libraryKeyOf(def.templateId, 1)
    const evidence = { key, value: payload }; source.rows.set('meta:' + key, evidence)
    const result = await publishTemplateDef(def)
    assert.ok(!result.ok && result.code === 'version-conflict'); assert.deepEqual(source.rows.get('meta:' + key), evidence); assert.equal(source.writes.length, 0)
  }
})
await test('repairing an older version index preserves the latest title and timestamp', async () => {
  const source = prepare(), def = definition(), newer = { ...def, name: '较新模板名称' }
  await publishTemplateDef(def); await publishTemplateDef(newer)
  const index = await loadLibraryIndex(), latestTime = index.entries[0].updatedAt + 10000
  index.entries[0].versions = [2]; index.entries[0].updatedAt = latestTime
  source.rows.set('meta:' + LIBRARY_INDEX_KEY, { key: LIBRARY_INDEX_KEY, value: index })
  const result = await publishTemplateDef(def, { version: 1 }); assert.ok(result.ok && !result.created)
  const repaired = (await loadLibraryIndex()).entries[0]
  assert.equal(repaired.name, newer.name); assert.equal(repaired.updatedAt, latestTime); assert.equal(repaired.latestVersion, 2); assert.deepEqual(repaired.versions, [1, 2])
})
console.log(`${count} template-library ownership/recovery groups passed`)
