import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createCommunityStore } from '../../server/lib/communityStore.mjs'
import { createCommunityApi } from '../../server/lib/communityApi.mjs'
import { anonymousWeekKey } from '../../server/lib/communityAnon.mjs'
import { createBackup, inspectCommunity, diffVisibility } from '../../server/lib/communityBackup.mjs'

const root = mkdtempSync(path.resolve('.workbuddy/tmp/community-anon-migrate-'))
const data = path.join(root, 'community'), backup = path.join(root, 'backup'), keyFile = path.join(root, 'key')
mkdirSync(data)
const secret = randomBytes(32)
writeFileSync(keyFile, secret)
const store = createCommunityStore({ root: data })
const now = Date.now() - 10000
store.putPost({ id: 'p1', uid: 'u1', status: 'published', display: 'anonymous', createdAt: now, updatedAt: now, versions: [{ vid: 'v1', title: '测试', body: '正文', tags: [], createdAt: now }], publishedVersionId: 'v1', pendingVersionId: '', counts: { up: 0, down: 0, comments: 0 } })
store.putComment({ id: 'c1', postId: 'p1', uid: 'u2', body: '测试评论', display: 'anonymous', status: 'visible', createdAt: now })
store.putPost({ ...store.getPost('p1'), counts: { up: 0, down: 0, comments: 1 } })
const args = ['server/community-anon-migrate.mjs', '--data', data, '--backup', backup, '--key-file', keyFile, '--confirm-stopped']
const migration = spawnSync(process.execPath, args, { encoding: 'utf8' })
assert.equal(migration.status, 0, migration.stderr)
const migrated = createCommunityStore({ root: data, anonSecret: secret })
migrated.assertAnonymousMappings()
const week = anonymousWeekKey(now)
assert.ok(migrated.getAnonymousHandle('u1', week))
assert.ok(migrated.getAnonymousHandle('u2', week))
const api = createCommunityApi({ store: migrated, authCheck: () => ({ user: null }), rateLimit: () => ({ ok: true }) })
const post = api._internal.publicPost(migrated, migrated.getPost('p1'))
assert.match(post.displayName, /（匿名用户）$/)
assert.equal(JSON.stringify(post).includes('u1'), false)
assert.throws(() => createCommunityStore({ root: data }).assertAnonymousMappings(), /密钥未配置/)
assert.throws(() => createCommunityStore({ root: data, anonSecret: randomBytes(32) }).assertAnonymousMappings(), /版本不匹配/)
const originalProfiles = readFileSync(path.join(data, 'profiles.json'), 'utf8')
const wrongKey = path.join(root, 'wrong-key')
writeFileSync(wrongKey, randomBytes(32))
const rejected = spawnSync(process.execPath, ['server/community-anon-migrate.mjs', '--data', data, '--backup', path.join(root, 'wrong-backup'), '--key-file', wrongKey, '--confirm-stopped'], { encoding: 'utf8' })
assert.notEqual(rejected.status, 0)
assert.equal(readFileSync(path.join(data, 'profiles.json'), 'utf8'), originalProfiles)
const inspect = inspectCommunity(data, { includeData: true })
assert.equal(inspect.ok, true)
const original = JSON.parse(readFileSync(path.join(backup, 'profiles.json'), 'utf8'))
assert.ok(diffVisibility({ 'profiles.json': original }, inspect.data).summary.profilesChanged > 0 || Object.keys(original.items).length === 0)
assert.equal(createBackup({ root: data, dest: path.join(root, 'after'), stopConfirmed: true }).ok, true)
console.log(`PASS 停写迁移、缺失密钥拒绝、公开匿名、备份与恢复差异：${root}`)
