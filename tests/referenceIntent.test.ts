import assert from 'node:assert/strict'
import { pageNavigationIntent, referenceNavigationIntent, commitNavigationHistory, type PageNavigationIntent } from '../src/lib/app/referenceIntent'
import { createNavigationHistory } from '../src/lib/app/navigationHistory'
import { createNavigationGate } from '../src/lib/app/navigation'
import { createPositionOwnership, scrollTopForOffset } from '../src/components/editor/useEditorOpenOffset'
import { resolveNavigationDestination, type NavigationDestinationReader } from '../src/lib/app/navigationDestination'

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
    validate: v => state.visible ? v : null, dirty: () => state.dirty, flush: () => save.promise.then(result => { if (result.ok) state.dirty = false; return result }),
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
const readers = (overrides: Partial<NavigationDestinationReader> = {}): NavigationDestinationReader => ({
  available: () => true, recordKind: () => 'card', chapterExists: async () => true,
  recordExists: async () => true, ...overrides,
})
await check('ordinary routes and project exit stay synchronous and never query records', () => {
  const read = readers({ chapterExists: () => { throw Error('unexpected read') }, recordExists: () => { throw Error('unexpected read') } })
  const v = pageNavigationIntent('editor')!
  assert.equal(resolveNavigationDestination(v, read), v)
  const exit = { kind: 'exit' } as const
  assert.equal(resolveNavigationDestination(exit, read), exit)
})
await check('missing chapters and records fall back without old position metadata', async () => {
  const chapter = intent(12), record = { kind: 'page', target: from } as const
  for (const [v, read, notice] of [
    [chapter, readers({ chapterExists: async () => false }), 'missing-chapter'],
    [record, readers({ recordExists: async () => false }), 'missing-record'],
    [record, readers({ available: () => false }), 'unavailable-page'],
    [record, readers({ recordKind: () => null }), 'unsupported-record'],
  ] as const) {
    const result = await resolveNavigationDestination(v, read)
    assert.equal(result.kind, 'page'); if (result.kind !== 'page') throw Error('page')
    assert.deepEqual(result.target, { tabId: 'dashboard' }); assert.equal(result.position, undefined)
    assert.equal(result.notice, notice)
  }
})
await check('storage read rejection stays distinct from deletion and preserves back history', async () => {
  for (const sync of [false, true]) {
    const history = createNavigationHistory(); history.push(from, '甲')
    const v: PageNavigationIntent = { kind: 'page', target: from, back: history.top()! }
    const failures: string[] = [], commits: unknown[] = [], busy = { current: false }
    const gate = createNavigationGate({ context: () => 'a', busy, capture: () => {}, dirty: () => false,
      flush: async () => ({ ok: true }),
      validate: (value: PageNavigationIntent) => {
        if (sync) throw Error('read denied')
        return resolveNavigationDestination(value, readers({ recordExists: async () => { throw Error('read denied') } })) as Promise<PageNavigationIntent>
      },
      commit: value => { commits.push(value); commitNavigationHistory(history, value) },
      invalid: () => { throw Error('read failure is not an invalid destination') }, failed: (_v, phase) => { failures.push(phase) },
    })
    gate.request(v); await settle()
    assert.deepEqual(failures, ['target']); assert.equal(history.size(), 1); assert.equal(commits.length, 0)
    assert.equal(busy.current, false)
  }
})
await check('record removal during save is rechecked before the commit', async () => {
  let exists = true, dirty = true
  const history = createNavigationHistory(); history.push(from, '甲')
  const save = deferred<Result>(), commits: PageNavigationIntent[] = []
  const read = readers({ recordExists: async () => exists })
  const gate = createNavigationGate<PageNavigationIntent>({ context: () => 'a', busy: { current: false }, capture: () => {},
    validate: v => resolveNavigationDestination(v, read) as PageNavigationIntent | Promise<PageNavigationIntent>,
    dirty: () => dirty, flush: () => save.promise,
    commit: v => { commits.push(v); commitNavigationHistory(history, v) }, invalid: () => {}, failed: () => {},
  })
  gate.request({ kind: 'page', target: from, back: history.top()! }); await settle()
  exists = false; dirty = false; save.resolve({ ok: true }); await settle()
  assert.equal(commits.length, 1); assert.equal(commits[0].notice, 'missing-record')
  assert.deepEqual(commits[0].target, { tabId: 'dashboard' }); assert.equal(history.size(), 0)
})
await check('an old asynchronous existence read cannot navigate after context changes', async () => {
  let owner = 'a'; const read = deferred<boolean>(), commits: unknown[] = [], failures: unknown[] = []
  const gate = createNavigationGate<PageNavigationIntent>({ context: () => owner, busy: { current: false }, capture: () => {},
    validate: v => resolveNavigationDestination(v, readers({ chapterExists: () => read.promise })) as Promise<PageNavigationIntent>,
    dirty: () => false, flush: async () => ({ ok: true }), commit: v => commits.push(v), invalid: () => {}, failed: v => failures.push(v),
  })
  gate.request(intent(12)); owner = 'b'; read.resolve(false); await settle()
  assert.equal(commits.length, 0); assert.equal(failures.length, 0)
})
await check('typing during the final destination read is saved before leaving', async () => {
  const finalRead = deferred<PageNavigationIntent>(), save = deferred<Result>()
  let dirty = false, reads = 0, saves = 0
  const commits: unknown[] = []
  const gate = createNavigationGate<PageNavigationIntent>({ context: () => 'a', busy: {current:false}, capture: () => {},
    validate: v => ++reads === 2 ? finalRead.promise : Promise.resolve(v), dirty: () => dirty,
    flush: async () => { saves++; const result = await save.promise; if(result.ok) dirty=false; return result },
    commit: v => commits.push(v), invalid: () => {}, failed: () => { throw Error('unexpected failure') },
  })
  const v = intent(12); gate.request(v); await settle(); assert.equal(reads, 2)
  dirty = true; finalRead.resolve(v); await settle()
  assert.equal(commits.length, 0); assert.equal(saves, 1)
  save.resolve({ok:true}); await settle(); assert.equal(commits.length, 1); assert.equal(reads, 3)
})
await check('continuous typing during repeated reads is bounded and keeps the page', async () => {
  let dirty = false, saves = 0, reads = 0
  const busy = {current:false}, commits: unknown[] = [], failures: string[] = []
  const gate = createNavigationGate<PageNavigationIntent>({ context: () => 'a', busy, capture: () => {},
    validate: async v => { if (++reads > 1) dirty=true; return v }, dirty: () => dirty,
    flush: async () => { saves++; dirty=false; return {ok:true} }, commit: v => commits.push(v), invalid: () => {},
    failed: (_v, phase) => failures.push(phase),
  })
  gate.request(intent(12)); await settle(); await settle()
  assert.equal(commits.length, 0); assert.deepEqual(failures, ['content']); assert.equal(busy.current, false)
  assert.equal(reads, 4); assert.equal(saves, 2)
})
console.log('referenceIntent '+count+' passed')
