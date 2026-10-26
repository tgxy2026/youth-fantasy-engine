import assert from 'node:assert/strict'
import { pageNavigationIntent, referenceNavigationIntent, commitNavigationHistory, type PageNavigationIntent } from '../src/lib/app/referenceIntent'
import { createNavigationHistory } from '../src/lib/app/navigationHistory'
import { createNavigationGate } from '../src/lib/app/navigation'
import { createPositionOwnership, scrollTopForOffset } from '../src/components/editor/useEditorOpenOffset'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { resolve, promise } }
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
type Result = { ok: true } | { ok: false; scope: 'content' | 'meta'; error: unknown }
const from = { tabId: 'char-main', rowId: 'card-a' }
const intent = (offset: number, label = '角色甲') => referenceNavigationIntent({ tabId: 'editor', chapterId: 'chapter-a', offset, matchLength: 2, revision: 'rev-1', label }, from)!
let count = 0
const check = async (name: string, run: () => void | Promise<void>) => { await run(); count++; console.log('PASS '+name) }
function fixture() {
  const history = createNavigationHistory(), state = { dirty: true, owner: 'account-a:0', visible: true }
  const save = deferred<Result>(), busy = { current: false }, commits: PageNavigationIntent[] = []
  const gate = createNavigationGate<PageNavigationIntent>({ context: () => state.owner, busy, capture: () => {},
    validate: v => state.visible ? v : null, dirty: () => state.dirty, flush: () => save.promise,
    commit: v => { commits.push(v); commitNavigationHistory(history, v) }, invalid: () => {}, failed: () => {},
  })
  return { history, state, save, gate, commits, busy }
}
await check('position and source metadata are normalized into independent allowlisted copies', () => {
  const source = { ...from }, jump = { tabId: 'editor', chapterId: 'chapter-a', offset: 0, matchLength: 2, revision: 'rev-1', label: '\n角色甲', prose: 'not retained' }
  const v = referenceNavigationIntent(jump, source)!
  source.rowId = 'changed'; jump.offset = 999
  assert.equal(v.source!.target.rowId, 'card-a'); assert.equal(v.position!.offset, 0); assert.equal(v.source!.label, '角色甲')
  assert.ok(!JSON.stringify(v).includes('not retained'))
})
await check('invalid numeric positions and chapter/row combinations are rejected', () => {
  for (const offset of [-1, NaN, Infinity, 1.2, 1e10]) assert.equal(pageNavigationIntent({ tabId: 'editor', chapterId: 'a', offset }), null)
  assert.equal(pageNavigationIntent({ tabId: 'char-main', offset: 0 }), null)
  assert.equal(pageNavigationIntent({ tabId: 'editor', rowId: 'a', offset: 0 }), null)
  assert.equal(pageNavigationIntent({ tabId: 'editor', chapterId: 'a', offset: 0, revision: 'raw/body' }), null)
  assert.deepEqual(pageNavigationIntent('dashboard'), { kind: 'page', target: { tabId: 'dashboard' } })
})
await check('a rejected or failed association never pushes a source', async () => {
  const f = fixture(); f.gate.request(intent(12)); assert.equal(f.history.size(), 0)
  f.save.resolve({ ok: false, scope: 'meta', error: 'failed' }); await settle()
  assert.equal(f.history.size(), 0); assert.equal(f.commits.length, 0)
  f.state.visible = false; f.gate.request(intent(22)); await settle(); assert.equal(f.history.size(), 0)
})
await check('a busy second request cannot replace the accepted request offset or source', async () => {
  const f = fixture(); f.gate.request(intent(12)); f.gate.request(intent(98, '角色乙'))
  f.save.resolve({ ok: true }); await settle()
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].position!.offset, 12)
  assert.equal(f.history.top()!.label, '角色甲')
})
await check('failed back navigation retains its retry entry, successful retry consumes once', async () => {
  const f = fixture(); f.history.push(from, '角色甲')
  const back = f.history.top()!, request: PageNavigationIntent = { kind: 'page', target: back.target, back }
  f.gate.request(request); assert.equal(f.history.size(), 1)
  f.save.resolve({ ok: false, scope: 'content', error: 'failed' }); await settle(); assert.equal(f.history.size(), 1)
  f.state.dirty = false; f.gate.request(request); assert.equal(f.history.size(), 0)
})
await check('an old back entry cannot pop a newer unrelated source', () => {
  const history = createNavigationHistory(); history.push(from, '甲'); const back = history.top()!
  history.push({ tabId: 'nations', rowId: 'country-b' }, '乙')
  commitNavigationHistory(history, { kind: 'page', target: back.target, back })
  assert.equal(history.size(), 2); assert.equal(history.top()!.label, '乙')
})
await check('identity or project changes discard pending source and position together', async () => {
  const f = fixture(); f.gate.request(intent(12)); f.state.owner = 'account-b:1'
  f.save.resolve({ ok: true }); await settle()
  assert.equal(f.commits.length, 0); assert.equal(f.history.size(), 0)
})
await check('self-navigation does not create a return loop', () => {
  assert.equal(referenceNavigationIntent({ tabId: 'char-main', rowId: 'card-a', label: '甲' }, from)!.source, undefined)
})
await check('fresh request generations win; manual chapter returns may restore their own view', () => {
  const own = createPositionOwnership()
  assert.equal(own('a', 'request-1'), true); assert.equal(own('a', 'request-1'), true)
  assert.equal(own('b', null), false); assert.equal(own('a', 'request-1'), false)
  assert.equal(own('a', 'request-2'), true); assert.equal(own('a', 'request-2'), true)
  assert.equal(own('a', null), false)
})
await check('soft-wrapped caret measurements override hard-newline approximations', () => {
  assert.equal(scrollTopForOffset('无换行段落', 5, 24, 300, 3000, 2100), 2000)
  assert.equal(scrollTopForOffset('x', 0, 24, 300, 3000, 0), 0)
})
console.log('referenceIntent '+count+' passed')
