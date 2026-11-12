// Isolated encrypted backup and loopback-only alert integration checks.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createBackup, verifyBackup } from '../../server/lib/communityBackup.mjs'
import { encryptBackup, decryptBackup, sendBackupAlert } from '../../server/lib/communityOffsite.mjs'

const root = mkdtempSync(resolve('.workbuddy/tmp/community-offsite-'))
const source = join(root, 'source'), backup = join(root, 'backup'), key = join(root, 'key'), wrong = join(root, 'wrong-key')
mkdirSync(source)
writeFileSync(key, randomBytes(32), { mode: 0o600 })
writeFileSync(wrong, randomBytes(32), { mode: 0o600 })
assert.equal(createBackup({ root: source, dest: backup, stopConfirmed: true }).ok, true)
const archive = join(root, 'copy.enc')
assert.equal(encryptBackup({ backupDir: backup, outputFile: archive, keyFile: key }).ok, true)
const cipher = readFileSync(archive)
assert.equal(cipher.includes(Buffer.from('posts.json')), false)
assert.throws(() => encryptBackup({ backupDir: backup, outputFile: archive, keyFile: key }))
assert.deepEqual(readFileSync(archive), cipher)
const restored = join(root, 'restore')
assert.equal(decryptBackup({ inputFile: archive, outputDir: restored, keyFile: key }).ok, true)
assert.equal(verifyBackup(restored).ok, true)
assert.throws(() => decryptBackup({ inputFile: archive, outputDir: join(root, 'wrong-restore'), keyFile: wrong }))
assert.equal(existsSync(join(root, 'wrong-restore')), false)
const damaged = Buffer.from(cipher); damaged[damaged.length - 1] ^= 1
writeFileSync(join(root, 'damaged.enc'), damaged)
assert.throws(() => decryptBackup({ inputFile: join(root, 'damaged.enc'), outputDir: join(root, 'damaged-restore'), keyFile: key }))
assert.equal(existsSync(join(root, 'damaged-restore')), false)
assert.throws(() => decryptBackup({ inputFile: archive, outputDir: restored, keyFile: key }))
writeFileSync(join(backup, 'posts.json'), 'corrupted')
assert.throws(() => encryptBackup({ backupDir: backup, outputFile: join(root, 'invalid.enc'), keyFile: key }))

let received = null
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => { received = JSON.parse(body); res.writeHead(req.url.endsWith('/fail') ? 503 : 204).end() })
})
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
try {
  const url = `http://127.0.0.1:${server.address().port}/alert`
  await assert.rejects(sendBackupAlert({ url, message: 'test' }))
  assert.equal((await sendBackupAlert({ url, message: '隔离测试告警', allowLoopbackHttp: true })).ok, true)
  assert.deepEqual(received, { text: '隔离测试告警' })
  await assert.rejects(sendBackupAlert({ url: `${url}/fail`, message: 'test', allowLoopbackHttp: true }), /503/)
  await assert.rejects(sendBackupAlert({ url: 'http://example.com/', message: 'test', allowLoopbackHttp: true }))
} finally { await new Promise((resolveClose) => server.close(resolveClose)) }
console.log(`PASS encrypted backup, recovery, tamper, collision and loopback alert checks: ${root}`)
