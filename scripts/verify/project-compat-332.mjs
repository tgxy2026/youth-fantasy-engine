// 3.5.3 · P0-3 旧库与历史格式兼容专项（隔离目录 + 合成数据，不碰真实账号）
// 用法：node scripts/verify/project-compat-332.mjs
//
// 覆盖：
//   A. 手工构造 e984e15（3.3.2 首版存储层）形态的历史账号——state 带 epoch、manifest 带
//      protocol/revision/snapshotId、**没有 epoch.json**——跑当前完整生命周期：
//      读状态 → 提交 rev2 → 删除 rev3 → 恢复 rev4 → 永久删除 → GC，全程世代一致（=1），
//      不误报 EPOCH_STALE；旧索引条目缺 snapshotId/objectBytes 也能读能写并回填；
//      bumpEpoch 后旧基线如期失效（世代保护对历史账号同样生效）。
//   B. 真实迁移子进程把 3.3.1 整库迁成 v2 后，对迁移产物继续 提交/删除/恢复/列表/GC，
//      验证迁移账号无需 epoch.json 即可正常演进。
// 🔴 历史事实（git e984e15 核对）：state.epoch 与 manifest.snapshotId/protocol/revision 自首版即存在，
//    故当前更严的校验不会拒绝任何合法历史 v2 数据；缺失 epoch.json 仍按 1 处理（旧库兼容）。
//    本测试不证明强制互斥、断电持久性或网络文件系统安全。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  commitProjectSnapshot, deleteProject, restoreProject, purgeProject,
  getProjectState, readManifest, listRevisions, readEpoch, bumpEpoch,
} from '../../server/lib/projectStore.mjs'
import { readIndex, writeIndex, accountRoot, setProjectMeta } from '../../server/lib/v2Index.mjs'
import { gcObjects } from '../../server/lib/objectGc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const migrateEntry = path.join(repo, 'server/migrate-v2.mjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-compat-'))
let passed = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { fails.push({ name, extra }); console.log('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')) }
}
const emptyManifest = () => ({ protocol: 1, createdAt: Date.now(), objects: [], assets: [], tombstones: [] })

try {
  // ---------- A. 历史形态账号（无 epoch.json）----------
  const v2Root = path.join(root, 'A', 'v2')
  const acc = 'u_hist'
  const store = accountRoot(v2Root, acc)
  const pid = 'p_hist'
  const dir = path.join(store, 'projects', pid)
  fs.mkdirSync(path.join(dir, 'manifests'), { recursive: true })
  fs.mkdirSync(path.join(store, 'objects'), { recursive: true })
  // e984e15 形态：state 带 epoch=1，manifest 带 snapshotId/protocol/revision；不写 epoch.json
  const histSnap = 'hist-snapshot-1'
  fs.writeFileSync(path.join(dir, 'manifests', '1.json'), JSON.stringify({
    protocol: 1, revision: 1, snapshotId: histSnap, objects: [], assets: [], tombstones: [], createdAt: 1,
  }))
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    protocol: 1, accountId: acc, revision: 1, snapshotId: histSnap, epoch: 1, tombs: [], ops: {},
  }))
  // 旧索引条目：故意缺 snapshotId/objectBytes/deletedAt（早期写法）
  fs.writeFileSync(path.join(store, 'index.json'), JSON.stringify({
    projects: { [pid]: { name: '旧书', revision: 1, updatedAt: 1 } },
  }))

  ok('A 历史账号无 epoch.json 时 readEpoch=1', readEpoch(store) === 1 && !fs.existsSync(path.join(store, 'epoch.json')))
  const st0 = getProjectState(store, pid, acc)
  ok('A 历史状态可读且 epoch=1 revision=1', st0.epoch === 1 && st0.revision === 1 && st0.snapshotId === histSnap, st0)
  ok('A 旧索引条目（缺可选字段）可读', readIndex(v2Root, acc).projects[pid].revision === 1)

  const c2 = commitProjectSnapshot({ root: store, pid, accountId: acc, opId: 'hist-c2', baseRevision: 1, manifest: emptyManifest() })
  ok('A 历史账号提交 rev2 不误报 EPOCH_STALE', c2.ok === true && c2.revision === 2, c2)
  ok('A 提交后仍无 epoch.json 且 readEpoch=1', !fs.existsSync(path.join(store, 'epoch.json')) && readEpoch(store) === 1)
  ok('A 提交后 state.epoch 仍=1', getProjectState(store, pid, acc).epoch === 1)
  // 回填索引（迁移/提交后路由会做）：旧条目补上 snapshotId/objectBytes
  setProjectMeta(v2Root, acc, pid, { name: '旧书', revision: c2.revision, snapshotId: c2.snapshotId, objectBytes: 0 })
  const idxA = readIndex(v2Root, acc)
  ok('A 旧索引条目回填 snapshotId/objectBytes', idxA.projects[pid].snapshotId === c2.snapshotId && idxA.projects[pid].objectBytes === 0, idxA.projects[pid])

  const d3 = deleteProject({ root: store, pid, accountId: acc, opId: 'hist-d3' })
  ok('A 历史账号删除 rev3', d3.ok === true && d3.revision === 3, d3)
  ok('A 删除后状态带 deleted 标记', getProjectState(store, pid, acc).deleted === true)
  const r4 = restoreProject({ root: store, pid, accountId: acc, opId: 'hist-r4' })
  ok('A 历史账号恢复 rev4（不倒退）', r4.ok === true && r4.revision === 4 && r4.restoredFrom === 2, r4)
  ok('A 恢复后 deleted 清除', getProjectState(store, pid, acc).deleted === false)
  const revs = listRevisions(store, pid).map((r) => r.revision)
  ok('A 版本列表含 1..4', [1, 2, 3, 4].every((r) => revs.includes(r)), revs)
  ok('A 恢复版 manifest 标记 restoredFrom', readManifest(store, pid, 4).restoredFrom === 2)

  // 世代保护对历史账号同样生效：bumpEpoch 后旧基线失效
  bumpEpoch(store, 'compat-test')
  ok('A bumpEpoch 后 readEpoch=2', readEpoch(store) === 2)
  const stale = commitProjectSnapshot({ root: store, pid, accountId: acc, opId: 'hist-stale', baseRevision: 4, manifest: emptyManifest() })
  ok('A bumpEpoch 后旧 state 提交 EPOCH_STALE', stale.ok === false && stale.code === 'EPOCH_STALE', stale)
  const staleDel = deleteProject({ root: store, pid, accountId: acc, opId: 'hist-stale-del' })
  ok('A bumpEpoch 后删除 EPOCH_STALE', staleDel.ok === false && staleDel.code === 'EPOCH_STALE', staleDel)

  // 永久删除：先恢复世代一致（重建 state.epoch=2），再删→purge
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    protocol: 1, accountId: acc, revision: 4, snapshotId: readManifest(store, pid, 4).snapshotId,
    epoch: 2, tombs: [], ops: {}, deletedAt: 0,
  }))
  const d5 = deleteProject({ root: store, pid, accountId: acc, opId: 'hist-d5' })
  ok('A 世代对齐后再删除 rev5', d5.ok === true && d5.revision === 5, d5)
  // 与路由层一致：先读索引，回调里只改这份已读对象再 writeIndex（purge-pending 存在时 readIndex 会拒读）
  const idxBeforePurge = readIndex(v2Root, acc)
  const purge = purgeProject({ root: store, pid, accountId: acc, updateIndex: () => {
    delete idxBeforePurge.projects[pid]
    writeIndex(v2Root, acc, idxBeforePurge)
  } })
  ok('A 历史账号永久删除成功', purge.ok === true, purge)
  ok('A 永久删除后索引条目移除', !readIndex(v2Root, acc).projects[pid])
  ok('A 永久删除后无 purge-pending 残留', !fs.existsSync(path.join(store, 'purge-pending', pid)))
  const gcA = gcObjects(store, { dryRun: true })
  ok('A 历史账号 GC 预演不抛错', typeof gcA.scanned === 'number', gcA)

  // ---------- B. 真实迁移产物继续演进 ----------
  const dataDir = path.join(root, 'B', 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.env.YFE_DATA = dataDir
  const { createUser } = await import('../../server/lib/users.mjs')
  const user = createUser({ id: 'u_migcompat', name: '迁移兼容', passwordHash: 'x' })
  const uid = user.id
  const userDir = path.join(dataDir, 'users', uid)
  fs.mkdirSync(userDir, { recursive: true })
  const stores = {
    projects: { p1: { id: 'p1', name: '迁移书', genre: '东方玄幻', intro: '', createdAt: 1, updatedAt: 2 } },
    volumes: {}, chapters: { c1: { id: 'c1', projectId: 'p1', volumeId: '', order: 1, title: '第一章', content: '正文' } },
    tableRows: {}, cardRecords: {}, formData: {}, settingsKV: {}, dailyStats: {}, backups: {},
  }
  fs.writeFileSync(path.join(userDir, 'data.json'), JSON.stringify({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: 1, stores }))

  const run = (args) => new Promise((resolve) => {
    const cp = spawn(process.execPath, [migrateEntry, ...args], { cwd: repo, env: { ...process.env, YFE_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; cp.stdout.on('data', (d) => { out += d }); cp.stderr.on('data', (d) => { out += d })
    cp.on('close', (code) => resolve({ code, out }))
  })
  const mig = await run(['迁移兼容'])
  ok('B 迁移退出码 0', mig.code === 0, mig.out.slice(-400))
  const v2B = path.join(dataDir, 'v2')
  const storeB = accountRoot(v2B, uid)
  const idxB0 = readIndex(v2B, uid)
  ok('B 迁移产物 revision=1', idxB0.projects.p1?.revision === 1, idxB0.projects)
  ok('B 迁移账号无 epoch.json 且 readEpoch=1', !fs.existsSync(path.join(storeB, 'epoch.json')) && readEpoch(storeB) === 1)
  ok('B 迁移状态 epoch=1', getProjectState(storeB, 'p1', uid).epoch === 1)

  const bc2 = commitProjectSnapshot({ root: storeB, pid: 'p1', accountId: uid, opId: 'mig-c2', baseRevision: 1, manifest: emptyManifest() })
  ok('B 迁移账号提交 rev2 不误报 EPOCH_STALE', bc2.ok === true && bc2.revision === 2, bc2)
  setProjectMeta(v2B, uid, 'p1', { name: '迁移书', revision: 2, snapshotId: bc2.snapshotId, objectBytes: 0 })
  const bd3 = deleteProject({ root: storeB, pid: 'p1', accountId: uid, opId: 'mig-d3' })
  ok('B 迁移账号删除 rev3', bd3.ok === true && bd3.revision === 3, bd3)
  const br4 = restoreProject({ root: storeB, pid: 'p1', accountId: uid, opId: 'mig-r4' })
  ok('B 迁移账号恢复 rev4', br4.ok === true && br4.revision === 4, br4)
  ok('B 迁移账号列表版本含 1..4', [1, 2, 3, 4].every((r) => listRevisions(storeB, 'p1').some((x) => x.revision === r)))
  ok('B 全程仍无 epoch.json 且 readEpoch=1', !fs.existsSync(path.join(storeB, 'epoch.json')) && readEpoch(storeB) === 1)
  const gcB = gcObjects(storeB, { dryRun: true })
  ok('B 迁移账号 GC 预演不抛错', typeof gcB.scanned === 'number', gcB)
} catch (e) {
  fails.push({ name: '未预期异常', extra: e instanceof Error ? e.stack : String(e) })
  console.log('FAIL 未预期异常 — ' + (e instanceof Error ? e.message : String(e)))
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log('')
if (fails.length) {
  console.log(`FAILED ${fails.length} / ${passed + fails.length}`)
  console.log(JSON.stringify(fails, null, 2))
  process.exit(1)
}
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)
process.exit(0)