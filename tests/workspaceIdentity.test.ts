import assert from 'node:assert/strict'
import { createWorkspaceIdentityResolver, digestWorkspaceIdentity, type WorkspaceIdentitySource } from '../src/lib/settings/workspaceIdentity'
import { getStorageContextEpoch, invalidateStorageContext, subscribeStorageContext } from '../src/lib/storage/contextEpoch'

const base: WorkspaceIdentitySource = { platform: 'desktop', spaceSource: 'C:\\PrivateUser\\Library\\data.json', identity: 'account-id', generation: 0, ready: true }
let count = 0
const check = async (name: string, run: () => Promise<void> | void) => { await run(); count++; console.log('PASS ' + name) }
await check('private root identity becomes an opaque key and repeated reads share one digest', async () => {
  let calls = 0
  const resolver = createWorkspaceIdentityResolver(() => base, async input => { calls++; return digestWorkspaceIdentity(input) }, () => { throw new Error('initial identity must not invalidate') })
  const first = await resolver.resolve(), second = await resolver.resolve()
  assert.equal(first, second)
  assert.equal(calls, 1)
  assert.match(first!.space, /^space-[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(first).includes('PrivateUser') && !JSON.stringify(first).includes('data.json'))
  assert.equal(resolver.current(), first)
})
await check('account root platform and generation changes invalidate the previous identity', async () => {
  let current = { ...base }, invalidations = 0
  const resolver = createWorkspaceIdentityResolver(() => current, digestWorkspaceIdentity, () => invalidations++)
  let previous = await resolver.resolve()
  for (const patch of [{ identity: 'another-account' }, { spaceSource: 'D:\\Other\\data.json' }, { platform: 'portable' as const }, { generation: 1 }]) {
    current = { ...current, ...patch }
    assert.equal(resolver.current(), null)
    const next = await resolver.resolve()
    assert.notEqual(next?.space, previous?.space)
    previous = next
  }
  assert.equal(invalidations, 4)
})
await check('late asynchronous identity cannot resurrect a switched account or data root', async () => {
  let current = { ...base }, release: (value: string) => void = () => {}
  const resolver = createWorkspaceIdentityResolver(() => current, () => new Promise(resolve => { release = resolve }), () => {})
  const old = resolver.resolve()
  await Promise.resolve()
  current = { ...base, identity: 'new-account' }
  const oldRelease = release, next = resolver.resolve()
  await Promise.resolve()
  oldRelease('a'.repeat(64))
  assert.equal(await old, null)
  release('b'.repeat(64))
  assert.equal((await next)?.identity, 'new-account')
})
await check('unavailable corrupt or rejected identities degrade without throwing or fallback aliases', async () => {
  let current = { ...base }, invalidations = 0
  const resolver = createWorkspaceIdentityResolver(() => current, digestWorkspaceIdentity, () => invalidations++)
  await resolver.resolve()
  current = { ...base, ready: false }
  assert.equal(await resolver.resolve(), null)
  assert.equal(resolver.current(), null)
  assert.equal(invalidations, 1)
  for (const invalid of [{ ...base, generation: NaN }, { ...base, identity: 'login name with spaces' }, { ...base, spaceSource: 'x'.repeat(16385) }]) {
    assert.equal(await createWorkspaceIdentityResolver(() => invalid, digestWorkspaceIdentity, () => {}).resolve(), null)
  }
  assert.equal(await createWorkspaceIdentityResolver(() => base, async () => { throw new Error('digest unavailable') }, () => {}).resolve(), null)
})
await check('A to B to A still rejects the first A request', async () => {
  let current = { ...base }
  const releases: Array<(value: string) => void> = []
  const resolver = createWorkspaceIdentityResolver(() => current, () => new Promise(resolve => releases.push(resolve)), () => {})
  const firstA = resolver.resolve(); await Promise.resolve()
  current = { ...base, identity: 'B' }; const b = resolver.resolve(); await Promise.resolve()
  current = { ...base }; const lastA = resolver.resolve(); await Promise.resolve()
  releases[0]('a'.repeat(64)); releases[1]('b'.repeat(64)); releases[2]('c'.repeat(64))
  assert.equal(await firstA, null); assert.equal(await b, null)
  assert.equal((await lastA)?.space, 'space-' + 'c'.repeat(64))
})
await check('storage replacement epochs are monotonic and listener errors cannot block invalidation', () => {
  const before = getStorageContextEpoch()
  let notified = 0
  const bad = subscribeStorageContext(() => { throw new Error('view failure') })
  const good = subscribeStorageContext(() => notified++)
  invalidateStorageContext(); invalidateStorageContext()
  assert.equal(getStorageContextEpoch(), before + 2)
  assert.equal(notified, 2)
  bad(); good(); invalidateStorageContext(); assert.equal(notified, 2)
})
console.log(`${count} workspace identity groups passed`)
