import assert from 'node:assert/strict'
import { createManualDraftSaver, type ManualDraftSaveState } from '../src/lib/editor/manualDraftSave'

const deferred = () => {
  let resolve!: () => void, reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  let value = { text: 'first' }, dirty = true, current = true, calls = 0
  const states: ManualDraftSaveState[] = [], writes: typeof value[] = []
  let gate = deferred()
  const save = createManualDraftSaver({
    current: () => current, read: () => ({ value, dirty }),
    write: async record => { calls++; writes.push(record); await gate.promise },
    committed: record => { if (value !== record) return false; dirty = false; return true }, state: state => states.push(state),
  })
  return { save, states, writes, edit: (text: string) => { value = { text }; dirty = true },
    dirty: () => dirty, calls: () => calls, context: (valid: boolean) => { current = valid },
    succeed: () => gate.resolve(), fail: () => gate.reject(new Error('isolated backend error')),
    reset: () => { gate = deferred() } }
}
let passed = 0
async function test(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('PASS ' + name) }
await test('duplicate clicks and hotkeys share one in-flight write and one receipt', async () => {
  const f = fixture(), first = f.save(), second = f.save()
  assert.equal(first, second); assert.equal(f.calls(), 1)
  f.succeed(); assert.equal(await first, true); assert.equal(f.dirty(), false)
  assert.deepEqual(f.states.at(-1), { saving: false, submitted: true, error: '' })
  assert.equal(await f.save(), true); assert.equal(f.calls(), 1)
})
await test('edits made during submission remain dirty and block a page/layer switch', async () => {
  const f = fixture(), pending = f.save(); f.edit('newer'); f.succeed()
  assert.equal(await pending, false); assert.equal(f.dirty(), true)
  assert.equal(f.writes[0].text, 'first'); assert.equal(f.states.at(-1)?.submitted, false)
  f.reset(); const retry = f.save(); f.succeed()
  assert.equal(await retry, true); assert.equal(f.writes[1].text, 'newer'); assert.equal(f.dirty(), false)
})
await test('repeated failures preserve the draft and visible error until a successful explicit retry', async () => {
  const f = fixture()
  for (let i = 0; i < 2; i++) {
    const pending = f.save(); f.fail(); assert.equal(await pending, false)
    assert.equal(f.dirty(), true); assert.ok(f.states.at(-1)?.error); f.reset()
  }
  const retry = f.save(); assert.ok(f.states.at(-1)?.error)
  f.succeed(); assert.equal(await retry, true); assert.equal(f.states.at(-1)?.error, '')
})
for (const failure of [false, true]) await test(`context replacement drops a late ${failure ? 'failure' : 'success'} receipt`, async () => {
  const f = fixture(), pending = f.save(), count = f.states.length
  f.context(false); if (failure) f.fail(); else f.succeed()
  assert.equal(await pending, false); assert.equal(f.states.length, count); assert.equal(f.dirty(), true)
})
await test('an obsolete owner cannot start a write', async () => {
  const f = fixture(); f.context(false)
  assert.equal(await f.save(), false); assert.equal(f.calls(), 0); assert.equal(f.states.length, 0)
})
await test('a different clean target cannot inherit an old target receipt', async () => {
  const gate = deferred(), states: ManualDraftSaveState[] = []
  let target = 'old', dirty = true
  const save = createManualDraftSaver({ current: () => true,
    read: () => ({ value: target, dirty }), write: () => gate.promise,
    committed: value => { if (value !== target) return false; dirty = false; return true },
    state: state => states.push(state) })
  const pending = save(); target = 'new'; dirty = false; gate.resolve()
  assert.equal(await pending, false); assert.equal(states.at(-1)?.submitted, false)
})
console.log(`${passed} groups passed`)
