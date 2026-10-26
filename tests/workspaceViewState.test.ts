import assert from 'node:assert/strict'
import { createWorkspaceViewStore, parseWorkspaceView, workspaceScopeKey, VIEW_LIMITS, type WorkspaceScope, type EditorView, type DetailView } from '../src/lib/settings/workspaceViewState'

const scope: WorkspaceScope = { platform: 'browser', space: 'opaque-space', identity: 'local', projectId: 'project-1', pageId: 'editor' }
const editor = (objectId = 'chapter-1'): EditorView => ({ version: 1, kind: 'editor', objectId, revision: 'content-digest', length: 100,
  selection: { start: 10, end: 20, direction: 'backward' }, scroll: { top: 50, ratio: .4, outerTop: 0, outerRatio: 0 },
  layout: { width: 600, height: 500, fontSize: 18, lineHeight: 34.2 }, focused: true })
const detail = (objectId: string, groups = ['group-1']): DetailView => ({ version: 1, kind: 'detail', objectId, groups,
  scroll: { top: 0, ratio: 0, outerTop: 0, outerRatio: 0 } })
let count = 0
const check = (name: string, run: () => void) => { run(); count++; console.log('PASS ' + name) }
check('identity project page and object all isolate views without delimiter ambiguity', () => {
  const store = createWorkspaceViewStore()
  assert.ok(store.put(scope, editor()))
  for (const field of ['platform', 'space', 'identity', 'projectId', 'pageId'] as const) {
    const other = { ...scope, [field]: field === 'platform' ? 'web-guest' : 'other' }
    assert.equal(store.get(other, 'chapter-1'), null)
  }
  assert.equal(store.get(scope, 'chapter-2'), null)
  assert.notEqual(workspaceScopeKey({ ...scope, projectId: 'a:b', pageId: 'c' }), workspaceScopeKey({ ...scope, projectId: 'a', pageId: 'b:c' }))
  assert.equal(workspaceScopeKey({ ...scope, space: 'C:\\private\\library.json' }), null)
})
check('validation rejects unknown versions invalid selection and non-finite geometry', () => {
  const store = createWorkspaceViewStore(), good = editor()
  for (const bad of [{ ...good, version: 2 }, { ...good, selection: { ...good.selection, end: 101 } },
    { ...good, selection: { start: 30, end: 20, direction: 'none' } }, { ...good, scroll: { ...good.scroll, ratio: 1.01 } },
    { ...good, layout: { ...good.layout, width: Infinity } }, { ...good, length: -1 }]) assert.equal(store.put(scope, bad), false)
  assert.equal(store.stats().objects, 0)
  assert.equal(parseWorkspaceView('{bad'), null)
  assert.equal(parseWorkspaceView(' '.repeat(VIEW_LIMITS.recordBytes + 1)), null)
  assert.equal(parseWorkspaceView(JSON.stringify({ ...good, content: '字'.repeat(6000) })), null, 'raw UTF-8 budget checked before accepting a parsed record')
})
check('allowlisted records do not retain business data or caller mutations', () => {
  const store = createWorkspaceViewStore(), original = detail('card-1')
  assert.ok(store.put(scope, { ...original, content: 'private manuscript', aiResult: 'private result' }))
  original.groups.push('caller-mutated')
  const got = store.get(scope, 'card-1') as DetailView
  assert.deepEqual(got.groups, ['group-1'])
  assert.ok(!JSON.stringify(got).includes('private'))
  got.groups.push('reader-mutated')
  assert.deepEqual((store.get(scope, 'card-1') as DetailView).groups, ['group-1'])
})
check('legacy group IDs keep punctuation and separators without becoming storage identities', () => {
  const store = createWorkspaceViewStore(), groups = ['一、基础信息', '三、能力/成长', '作者自定 · 分组']
  assert.ok(store.put(scope, detail('原始对象/ID', groups)))
  assert.deepEqual((store.get(scope, '原始对象/ID') as DetailView).groups, groups)
  assert.equal(store.put({ ...scope, identity: '显示姓名' }, detail('card')), false)
  assert.equal(store.put({ ...scope, space: 'C:/private/library.json' }, detail('card')), false)
})
check('recent project limit uses access order across identities', () => {
  const store = createWorkspaceViewStore()
  for (let i = 0; i < 10; i++) assert.ok(store.put({ ...scope, projectId: 'p' + i, identity: 'account-' + i }, editor()))
  const first = { ...scope, projectId: 'p0', identity: 'account-0' }
  assert.ok(store.get(first, 'chapter-1'))
  assert.ok(store.put({ ...scope, projectId: 'p10' }, editor()))
  assert.equal(store.stats().projects, 10)
  assert.equal(store.get({ ...scope, projectId: 'p1', identity: 'account-1' }, 'chapter-1'), null)
  assert.ok(store.get(first, 'chapter-1'))
})
check('object limit spans pages and keeps recently accessed objects', () => {
  const store = createWorkspaceViewStore()
  for (let i = 0; i < 50; i++) assert.ok(store.put({ ...scope, pageId: i % 2 ? 'editor' : 'characters' }, detail('o' + i)))
  assert.ok(store.get({ ...scope, pageId: 'characters' }, 'o0'))
  assert.ok(store.put(scope, editor('new')))
  assert.equal(store.stats().objects, 50)
  assert.equal(store.get(scope, 'o1'), null)
  assert.ok(store.get({ ...scope, pageId: 'characters' }, 'o0'))
})
check('record and total serialized budgets are real UTF-8 bounds with LRU eviction', () => {
  const store = createWorkspaceViewStore()
  const groups = Array.from({ length: 60 }, (_, i) => 'g' + i + 'x'.repeat(200))
  assert.ok(store.put(scope, detail('first', groups)))
  assert.equal(store.put(scope, detail('too-large', Array.from({ length: 100 }, (_, i) => 'g' + i + 'x'.repeat(200)))), false)
  assert.ok(store.get(scope, 'first'))
  for (let i = 0; i < 35; i++) assert.ok(store.put(scope, detail('large-' + i, groups)))
  assert.ok(store.stats().bytes <= VIEW_LIMITS.totalBytes)
  assert.equal(store.get(scope, 'first'), null)
  assert.ok(store.get(scope, 'large-34'))
})
check('deletion identity reset and generations reject stale asynchronous writes', () => {
  const store = createWorkspaceViewStore(), other = { ...scope, identity: 'other' }
  let invalidations = 0
  const off = store.subscribeInvalidation(() => invalidations++)
  const generation = store.generation()
  store.put(scope, editor()); store.put(other, editor())
  store.deleteProject(scope)
  assert.equal(store.get(scope, 'chapter-1'), null)
  assert.ok(store.get(other, 'chapter-1'))
  assert.equal(store.put(scope, editor(), generation), false)
  store.put(scope, editor()); store.clearIdentity(scope)
  assert.equal(store.get(scope, 'chapter-1'), null)
  assert.ok(store.get(other, 'chapter-1'))
  store.clear(); assert.deepEqual(store.stats(), { projects: 0, objects: 0, bytes: 0, generation: 3 })
  assert.equal(invalidations, 3); off(); store.clear(); assert.equal(invalidations, 3)
})
console.log(`${count} workspace view state groups passed`)
