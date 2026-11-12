// Local synthetic cases; no production accounts or files are accessed.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createCommunityStore } from '../../server/lib/communityStore.mjs'
import { BEAST_NAMES, BEAST_DICTIONARY_SHA256, anonymousWeekKey, allocateAnonymousHandle } from '../../server/lib/communityAnon.mjs'
import { diffVisibility, emptyCommunityData } from '../../server/lib/communityBackup.mjs'

const root = mkdtempSync(path.resolve('.workbuddy/tmp/community-nickname-anon-'))
writeFileSync(path.join(root, 'posts.json'), JSON.stringify({ version: 1, items: {} }))
const store = createCommunityStore({ root })
const originalNow = Date.now
let now = 1794499200000
Date.now = () => now
try {
  const first = store.putProfile('new', { nickname: '青灯' })
  assert.equal(first.nicknameChangedAt, now)
  assert.throws(() => store.putProfile('new', { nickname: '白露' }), (e) => e.code === 'NICKNAME_COOLDOWN' && e.retryAfter > 0)
  assert.equal(store.putProfile('new', { nickname: '青灯' }).nicknameChangedAt, now)
  store.putProfile('new', { postDisplay: 'nickname' })
  assert.equal(store.getProfile('new').nicknameChangedAt, now)
  now += 7 * 86400000 - 1
  assert.throws(() => store.putProfile('new', { nickname: '白露' }), (e) => e.code === 'NICKNAME_COOLDOWN')
  now++
  assert.equal(store.putProfile('new', { nickname: '白露' }).nicknameChangedAt, now)
  const file = path.join(root, 'profiles.json')
  const db = JSON.parse(readFileSync(file, 'utf8'))
  db.items.legacy = { nickname: '旧名', updatedAt: 123 }
  db.items.broken = { nickname: '坏时间', nicknameChangedAt: 'bad' }
  writeFileSync(file, JSON.stringify(db))
  const restart = createCommunityStore({ root })
  assert.equal(restart.putProfile('legacy', { nickname: '新名' }).nicknameChangedAt, now)
  assert.throws(() => restart.putProfile('broken', { nickname: '换名' }), (e) => e.code === 'NICKNAME_TIME_INVALID')
  const a = emptyCommunityData(), b = emptyCommunityData()
  a['profiles.json'].items.u = { nickname: '同名', nicknameChangedAt: 1 }
  b['profiles.json'].items.u = { nickname: '同名', nicknameChangedAt: 2 }
  assert.equal(diffVisibility(a, b).summary.profilesChanged, 1)
} finally { Date.now = originalNow }

assert.equal(BEAST_NAMES.length, 1672)
assert.equal(createHash('sha256').update(BEAST_NAMES.join('\n') + '\n').digest('hex'), BEAST_DICTIONARY_SHA256)
assert.equal(anonymousWeekKey(Date.parse('2026-11-08T15:59:00Z')), '2026-11-02')
assert.equal(anonymousWeekKey(Date.parse('2026-11-08T16:00:00Z')), '2026-11-09')
const key = randomBytes(32), source = {}
const one = allocateAnonymousHandle(source, 'u1', '2026-11-09', key, ['麒麟'])
const two = allocateAnonymousHandle(one.mapping, 'u2', '2026-11-09', key, ['麒麟'])
assert.equal(one.handle, '麒麟')
assert.equal(two.handle, '麒麟-02')
assert.equal(allocateAnonymousHandle(two.mapping, 'u1', '2026-11-09', key, ['麒麟']).handle, '麒麟')
assert.deepEqual(source, {})
let many = {}
for (let i = 1; i <= 101; i++) {
  const result = allocateAnonymousHandle(many, `u${i}`, '2026-11-09', key, ['麒麟'])
  many = result.mapping
  if (i === 100) assert.equal(result.handle, '麒麟-100')
}
assert.throws(() => allocateAnonymousHandle({}, 'u1', '2026-11-10', key, ['麒麟']))
assert.throws(() => allocateAnonymousHandle({}, 'u1', '2026-11-09', Buffer.alloc(1), ['麒麟']))
console.log(`PASS 昵称冷却、旧账号、恢复差异、词表与周边界/碰撞：${root}`)
