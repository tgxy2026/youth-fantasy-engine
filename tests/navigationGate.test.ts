import assert from 'node:assert/strict'
import { createNavigationGate, parseWorkspaceNavigation, type WorkspaceTarget } from '../src/lib/app/navigation'
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
type Result = { ok: true } | { ok: false; scope: 'content' | 'meta'; error: unknown }
let passed = 0
const test = async (name: string, run: () => void | Promise<void>) => { await run(); passed++; console.log('PASS '+name) }
const target: WorkspaceTarget = { tabId: 'char-main', rowId: 'character-1' }
const fixture = () => {
  const state = { owner: 'project-a:0', dirty: false, visible: true, busy: { current: false }, commits: [] as WorkspaceTarget[], failures: [] as string[], order: [] as string[], invalid: 0 }
  let flush: () => Promise<Result> = async () => ({ ok: true })
  const gate = createNavigationGate<WorkspaceTarget>({
    context: () => state.owner, busy: state.busy, capture: () => { state.order.push('capture') },
    validate: intent => { state.order.push('validate'); return state.visible ? intent : null },
    dirty: () => { state.order.push('dirty'); return state.dirty }, flush: () => flush(),
    commit: intent => { state.order.push('commit'); state.commits.push(intent) },
    invalid: () => { state.invalid++ }, failed: (_intent, scope) => { state.failures.push(scope) },
  })
  return { state, gate, flush: (next: () => Promise<Result>) => { flush = next } }
}
await test('legacy events are copied through an ID allowlist', () => {
  assert.deepEqual(parseWorkspaceNavigation('editor'), { tabId: 'editor' })
  assert.deepEqual(parseWorkspaceNavigation({ ...target, draft: 'must not be retained' }), target)
  for (const value of [null, {}, [], { tabId: '' }, { tabId: 'editor', rowId: 'x' }, { tabId: 'char-main', chapterId: 'x' }, { tabId: 'editor', chapterId: 1 }, { tabId: 'x\n' }]) assert.equal(parseWorkspaceNavigation(value), null)
})
await test('clean navigation is synchronous and captures before checking dirtiness', () => {
  const { state, gate } = fixture(); gate.request(target)
  assert.deepEqual(state.commits, [target]); assert.ok(state.order.indexOf('capture') < state.order.indexOf('dirty')); assert.equal(state.busy.current, false)
})
await test('a failed save commits neither tab nor row target', async () => {
  const { state, gate, flush } = fixture(); state.dirty = true
  flush(async () => ({ ok: false, scope: 'meta', error: 'disk full' })); gate.request(target); await settle()
  assert.deepEqual(state.commits, []); assert.deepEqual(state.failures, ['meta']); assert.equal(state.busy.current, false)
})
await test('pending saves reject duplicate navigation and commit the original target once', async () => {
  const { state, gate, flush } = fixture(); state.dirty = true
  const save = deferred<Result>(); flush(() => save.promise)
  gate.request(target); gate.request({ tabId: 'dashboard' }); await settle(); assert.equal(state.commits.length, 0)
  save.resolve({ ok: true }); await settle(); assert.deepEqual(state.commits, [target]); assert.equal(state.busy.current, false)
})
await test('changed project or identity suppresses stale completion and failure UI', async () => {
  for (const result of [{ ok: true }, { ok: false, scope: 'content', error: 'late' }] as Result[]) {
    const { state, gate, flush } = fixture(); state.dirty = true
    const save = deferred<Result>(); flush(() => save.promise)
    gate.request(target); await settle(); state.owner = 'project-b:1'; save.resolve(result); await settle()
    assert.deepEqual(state.commits, []); assert.deepEqual(state.failures, []); assert.equal(state.busy.current, false)
  }
})
await test('invalidation handles ABA and old finally cannot unlock a newer request', async () => {
  const { state, gate, flush } = fixture(); state.dirty = true
  const old = deferred<Result>(), next = deferred<Result>(); flush(() => old.promise)
  gate.request(target); await settle(); gate.invalidate(); state.owner = 'project-a:0'
  flush(() => next.promise); gate.request({ tabId: 'dashboard' }); await settle()
  old.resolve({ ok: true }); await settle(); assert.equal(state.busy.current, true); assert.equal(state.commits.length, 0)
  next.resolve({ ok: true }); await settle(); assert.deepEqual(state.commits, [{ tabId: 'dashboard' }])
})
await test('visibility is checked again after saving', async () => {
  const { state, gate, flush } = fixture(); state.dirty = true
  const save = deferred<Result>(); flush(() => save.promise)
  gate.request(target); await settle(); state.visible = false; save.resolve({ ok: true }); await settle()
  assert.equal(state.commits.length, 0); assert.equal(state.invalid, 1)
})
await test('a thrown flush leaves page and target untouched', async () => {
  const { state, gate, flush } = fixture(); state.dirty = true
  flush(async () => { throw new Error('failure') }); gate.request(target); await settle()
  assert.equal(state.commits.length, 0); assert.deepEqual(state.failures, ['content'])
})
console.log('navigationGate '+passed+' passed')
