// Isolated corrupt-file regression; never uses live project data.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commitProjectSnapshot, deleteProject, restoreProject, purgeProject, getProjectState, readEpoch, readManifest, bumpEpoch } from '../../server/lib/projectStore.mjs'
import { readIndex, indexFile } from '../../server/lib/v2Index.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-read-safety-'))
try {
  const dir = path.join(root, 'projects', 'p')
  fs.mkdirSync(path.join(dir, 'manifests'), { recursive: true })
  const state = path.join(dir, 'state.json')
  fs.writeFileSync(state, '{broken')
  const calls = [
    () => getProjectState(root, 'p', 'a'),
    () => commitProjectSnapshot({ root, pid: 'p', accountId: 'a', opId: 'x', baseRevision: 0, manifest: { protocol: 1 } }),
    () => deleteProject({ root, pid: 'p', accountId: 'a', opId: 'x' }),
    () => restoreProject({ root, pid: 'p', accountId: 'a', opId: 'x' }),
    () => purgeProject({ root, pid: 'p', accountId: 'a' }),
  ]
  for (const call of calls) {
    assert.throws(call, { code: 'PROJECT_DATA_INVALID' })
    assert.equal(fs.readFileSync(state, 'utf8'), '{broken')
    assert.deepEqual(fs.readdirSync(path.join(dir, 'manifests')), [])
  }
  assert.equal(fs.existsSync(path.join(root, 'locks', 'p.lock')), false)
  fs.writeFileSync(path.join(root, 'epoch.json'), 'null')
  assert.throws(() => readEpoch(root), { code: 'PROJECT_DATA_INVALID' })
  fs.writeFileSync(state, JSON.stringify({ protocol: 1, accountId: 'a', revision: 0, snapshotId: '', epoch: 1, tombs: [], ops: {} }))
  const before = fs.readFileSync(state, 'utf8')
  assert.throws(() => deleteProject({ root, pid: 'p', accountId: 'a', opId: 'delete' }), { code: 'PROJECT_DATA_INVALID' })
  assert.equal(fs.readFileSync(state, 'utf8'), before)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'manifests')), [])
  fs.writeFileSync(path.join(dir, 'manifests', '1.json'), '[')
  assert.throws(() => readManifest(root, 'p', 1), { code: 'PROJECT_DATA_INVALID' })
  fs.writeFileSync(path.join(dir, 'manifests', '1.json'), JSON.stringify({ protocol: 1, revision: 99, snapshotId: 's' }))
  assert.throws(() => readManifest(root, 'p', 1), { code: 'PROJECT_DATA_INVALID' })
  fs.writeFileSync(path.join(dir, 'manifests', '1.json'), '[')
  assert.equal(readManifest(root, 'p', 2), null)
  fs.unlinkSync(state)
  for (const call of calls) assert.throws(call, { code: 'PROJECT_DATA_MISSING' })
  assert.equal(fs.readFileSync(path.join(dir, 'manifests', '1.json'), 'utf8'), '[')
  fs.writeFileSync(state, JSON.stringify({ revision: '1', epoch: 1 }))
  assert.throws(() => getProjectState(root, 'p', 'a'), { code: 'PROJECT_DATA_INVALID' })
  fs.writeFileSync(state, JSON.stringify({ revision: 1, epoch: 1, snapshotId: 'original' }))
  fs.writeFileSync(path.join(dir, 'manifests', '1.json'), JSON.stringify({ protocol: 1, revision: 1, snapshotId: 'other' }))
  assert.throws(() => getProjectState(root, 'p', 'a'), { code: 'PROJECT_DATA_INVALID' })
  fs.unlinkSync(path.join(dir, 'manifests', '1.json'))
  assert.throws(() => getProjectState(root, 'p', 'a'), { code: 'PROJECT_DATA_MISSING' })
  assert.deepEqual(readIndex(root, 'fresh'), { projects: {} })
  const index = indexFile(root, 'a')
  fs.mkdirSync(path.dirname(index), { recursive: true })
  for (const broken of ['{', '{"projects":null}', '{"projects":[]}']) {
    fs.writeFileSync(index, broken)
    assert.throws(() => readIndex(root, 'a'), { code: 'PROJECT_DATA_INVALID' })
    assert.equal(fs.readFileSync(index, 'utf8'), broken)
  }
  fs.unlinkSync(index)
  fs.mkdirSync(path.join(root, 'accounts', 'a', 'projects', 'existing'), { recursive: true })
  assert.throws(() => readIndex(root, 'a'), { code: 'PROJECT_DATA_MISSING' })
  const epochRoot = path.join(root, 'epoch-fixture')
  fs.mkdirSync(epochRoot, { recursive: true })
  const manifest = { protocol: 1, objects: [], assets: [], tombstones: [] }
  assert.equal(commitProjectSnapshot({ root: epochRoot, pid: 'p', accountId: 'a', opId: 'commit', baseRevision: 0, manifest }).ok, true)
  assert.equal(deleteProject({ root: epochRoot, pid: 'p', accountId: 'a', opId: 'delete' }).ok, true)
  bumpEpoch(epochRoot, 'test')
  const deletedState = fs.readFileSync(path.join(epochRoot, 'projects', 'p', 'state.json'), 'utf8')
  assert.equal(restoreProject({ root: epochRoot, pid: 'p', accountId: 'a', opId: 'restore' }).code, 'EPOCH_STALE')
  assert.equal(deleteProject({ root: epochRoot, pid: 'p', accountId: 'a', opId: 'delete-again' }).code, 'EPOCH_STALE')
  assert.equal(fs.readFileSync(path.join(epochRoot, 'projects', 'p', 'state.json'), 'utf8'), deletedState)
  const missingEpochRoot = path.join(root, 'missing-epoch-fixture')
  fs.mkdirSync(missingEpochRoot, { recursive: true })
  bumpEpoch(missingEpochRoot, 'test')
  assert.equal(commitProjectSnapshot({ root: missingEpochRoot, pid: 'p', accountId: 'a', opId: 'commit', baseRevision: 0, manifest }).ok, true)
  fs.unlinkSync(path.join(missingEpochRoot, 'epoch.json'))
  assert.equal(deleteProject({ root: missingEpochRoot, pid: 'p', accountId: 'a', opId: 'delete' }).code, 'EPOCH_STALE')
  console.log('PASS corrupt state, epoch and manifest fail closed; missing manifest remains optional')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
