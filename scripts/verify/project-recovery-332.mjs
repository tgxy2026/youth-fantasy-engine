// 3.5.3 · P0 数据审计与受控恢复 · 隔离专项（合成数据，不碰真实账号）
// 用法：node scripts/verify/project-recovery-332.mjs
//
// 覆盖：健康账号、索引落后/领先、purge-pending 三类、残留锁（存活/已退出/跨主机）、
//   孤儿项目、索引条目缺目录、损坏索引重建（完整/不完整）、停写拒绝、备份与留痕、审计只读。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  commitProjectSnapshot, deleteProject, getProjectState,
} from '../../server/lib/projectStore.mjs'
import {
  readIndex, indexFile, accountRoot, acquireAccountWriteLock, setProjectMeta, initializeIndex,
} from '../../server/lib/v2Index.mjs'
import { auditAccount, recoverAccount, planRecovery } from '../../server/lib/projectRecovery.mjs'

const v2Root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-recovery-'))
let passed = 0
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { console.log('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); process.exitCode = 1 }
}

function seedProject(acc, pid, { deleted = false } = {}) {
  initializeIndex(v2Root, acc)
  const root = accountRoot(v2Root, acc)
  const manifest = { protocol: 1, createdAt: Date.now(), project: { name: `名-${pid}` }, objects: [], assets: [], tombstones: [] }
  const r = commitProjectSnapshot({ root, pid, accountId: acc, opId: `seed-${pid}`, baseRevision: 0, manifest })
  assert.ok(r.ok, 'seed commit')
  setProjectMeta(v2Root, acc, pid, { name: `名-${pid}`, revision: r.revision, snapshotId: r.snapshotId, objectBytes: 0 })
  if (deleted) {
    const d = deleteProject({ root, pid, accountId: acc, opId: `del-${pid}` })
    assert.ok(d.ok, 'seed delete')
    setProjectMeta(v2Root, acc, pid, { revision: d.revision, snapshotId: d.snapshotId, deletedAt: Date.now() })
  }
  return root
}
const idxOf = (acc) => JSON.parse(fs.readFileSync(indexFile(v2Root, acc), 'utf8'))
const writeIdx = (acc, idx) => fs.writeFileSync(indexFile(v2Root, acc), JSON.stringify(idx))
const hasFinding = (rep, kind, pid) => rep.findings.some((f) => f.kind === kind && (pid == null || f.pid === pid))
// epoch-missing 是 info 级（旧库正常现象）；"无发现"只统计需处理的 error/warn。
const problems = (rep) => rep.findings.filter((f) => f.severity !== 'info')

try {
  // ---- 1. 健康账号：无发现、无动作、审计只读 ----
  {
    const acc = 'u_healthy'
    seedProject(acc, 'prj_healthy01')
    const before = fs.readFileSync(indexFile(v2Root, acc), 'utf8')
    const rep = auditAccount(v2Root, acc)
    ok('健康账号无发现', problems(rep).length === 0, rep.findings)
    ok('健康账号无可恢复动作', planRecovery(rep).length === 0)
    ok('审计只读不改索引', fs.readFileSync(indexFile(v2Root, acc), 'utf8') === before)
    ok('审计不产生备份/留痕', !fs.existsSync(path.join(accountRoot(v2Root, acc), 'recovery-backups')) && !fs.existsSync(path.join(accountRoot(v2Root, acc), 'recovery-journal.jsonl')))
    const r = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('健康账号恢复无执行', r.executed.length === 0 && r.results.length === 0)
  }

  // ---- 2. 索引落后于状态：预览不写，apply 修复，备份+留痕 ----
  {
    const acc = 'u_behind'
    const root = seedProject(acc, 'prj_behind01')
    // 再提交一版，但索引不更新（模拟提交后索引写失败）
    const c2 = commitProjectSnapshot({ root, pid: 'prj_behind01', accountId: acc, opId: 'second', baseRevision: 1, manifest: { protocol: 1, objects: [], assets: [], tombstones: [] } })
    assert.ok(c2.ok)
    const state = getProjectState(root, 'prj_behind01', acc)
    ok('构造出索引落后', idxOf(acc).projects.prj_behind01.revision === 1 && state.revision === 2)
    const rep = auditAccount(v2Root, acc)
    ok('审计发现索引落后', hasFinding(rep, 'index-behind-state', 'prj_behind01'))
    const preview = recoverAccount({ v2Root, accountId: acc, apply: false })
    ok('预览不修改索引', preview.preview === true && idxOf(acc).projects.prj_behind01.revision === 1)
    const applied = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('apply 修复落后条目', applied.executed.some((a) => a.kind === 'repair-entry') && idxOf(acc).projects.prj_behind01.revision === 2)
    ok('修复后快照标识与状态一致', idxOf(acc).projects.prj_behind01.snapshotId === state.snapshotId)
    ok('修复产生索引备份', fs.readdirSync(path.join(root, 'recovery-backups')).length >= 1)
    ok('修复写入留痕', fs.readFileSync(path.join(root, 'recovery-journal.jsonl'), 'utf8').includes('repair-entry'))
    ok('修复后审计无发现', problems(auditAccount(v2Root, acc)).length === 0)
  }

  // ---- 3. 索引领先于状态：只报告，不自动修复 ----
  {
    const acc = 'u_ahead'
    seedProject(acc, 'prj_ahead001')
    const idx = idxOf(acc); idx.projects.prj_ahead001.revision = 99; writeIdx(acc, idx)
    const rep = auditAccount(v2Root, acc)
    ok('审计发现索引领先', hasFinding(rep, 'index-ahead-of-state', 'prj_ahead001'))
    ok('索引领先无自动动作', !planRecovery(rep).some((a) => a.pid === 'prj_ahead001'))
    const applied = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('索引领先 apply 不改动', applied.executed.length === 0 && idxOf(acc).projects.prj_ahead001.revision === 99)
  }

  // ---- 4. purge-pending 回滚：索引仍引用且状态一致 ----
  {
    const acc = 'u_pendingrb'
    const root = seedProject(acc, 'prj_pendrb01', { deleted: true })
    const src = path.join(root, 'projects', 'prj_pendrb01')
    const pending = path.join(root, 'purge-pending', 'prj_pendrb01')
    fs.mkdirSync(path.dirname(pending), { recursive: true })
    fs.renameSync(src, pending) // 模拟隔离后索引写失败、回滚也失败
    const rep = auditAccount(v2Root, acc)
    ok('审计识别可回滚隔离', hasFinding(rep, 'purge-pending-rollback', 'prj_pendrb01'))
    ok('隔离阻断索引读取', (() => { try { readIndex(v2Root, acc); return false } catch (e) { return e.code === 'PROJECT_DATA_RECOVERY_REQUIRED' } })())
    const applied = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('apply 移回隔离目录', applied.executed.some((a) => a.kind === 'rollback-pending') && fs.existsSync(src) && !fs.existsSync(pending))
    ok('回滚后索引可读且一致', readIndex(v2Root, acc).projects.prj_pendrb01.revision === 2)
    ok('回滚后审计无发现', problems(auditAccount(v2Root, acc)).length === 0)
  }

  // ---- 5. purge-pending 残留：索引已移除，须显式 remove-pending ----
  {
    const acc = 'u_pendingrm'
    const root = seedProject(acc, 'prj_pendrm01', { deleted: true })
    const src = path.join(root, 'projects', 'prj_pendrm01')
    const pending = path.join(root, 'purge-pending', 'prj_pendrm01')
    fs.mkdirSync(path.dirname(pending), { recursive: true })
    fs.renameSync(src, pending)
    const idx = idxOf(acc); delete idx.projects.prj_pendrm01; writeIdx(acc, idx) // 永久删除已提交
    const rep = auditAccount(v2Root, acc)
    ok('审计识别残留隔离', hasFinding(rep, 'purge-pending-leftover', 'prj_pendrm01'))
    const safeApply = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('安全 apply 不删隔离目录', !safeApply.executed.some((a) => a.kind === 'remove-pending') && fs.existsSync(pending))
    const explicit = recoverAccount({ v2Root, accountId: acc, apply: true, actions: [{ kind: 'remove-pending', pid: 'prj_pendrm01' }] })
    ok('显式 remove-pending 删除残留', explicit.executed.some((a) => a.kind === 'remove-pending') && !fs.existsSync(pending))
    ok('删除残留写入留痕', fs.readFileSync(path.join(root, 'recovery-journal.jsonl'), 'utf8').includes('remove-pending'))
  }

  // ---- 6. purge-pending 歧义：索引仍引用但状态损坏，只报告 ----
  {
    const acc = 'u_pendingamb'
    const root = seedProject(acc, 'prj_pendamb1', { deleted: true })
    const src = path.join(root, 'projects', 'prj_pendamb1')
    const pending = path.join(root, 'purge-pending', 'prj_pendamb1')
    fs.mkdirSync(path.dirname(pending), { recursive: true })
    fs.renameSync(src, pending)
    fs.writeFileSync(path.join(pending, 'state.json'), '{broken')
    const rep = auditAccount(v2Root, acc)
    ok('审计识别歧义隔离', hasFinding(rep, 'purge-pending-ambiguous', 'prj_pendamb1'))
    const applied = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('歧义隔离不自动处理', !applied.executed.some((a) => a.pid === 'prj_pendamb1') && fs.existsSync(pending))
  }

  // ---- 7. 残留锁：持有进程已退出，可显式清除 ----
  {
    const acc = 'u_lockdead'
    const root = seedProject(acc, 'prj_lockdead1')
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid = child.pid
    fs.writeFileSync(path.join(root, '.account-write.lock'), JSON.stringify({ pid: deadPid, host: os.hostname(), at: Date.now(), token: 'x' }))
    const rep = auditAccount(v2Root, acc)
    const lockFinding = rep.findings.find((f) => f.kind === 'residual-account-lock')
    ok('审计识别残留锁且判定已退出', !!lockFinding && lockFinding.canClear === true, rep.accountLock)
    const safeApply = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('安全 apply 不清锁', fs.existsSync(path.join(root, '.account-write.lock')))
    const explicit = recoverAccount({ v2Root, accountId: acc, apply: true, actions: [{ kind: 'clear-lock' }] })
    ok('显式 clear-lock 清除已退出锁', explicit.results.some((r) => r.kind === 'clear-lock' && r.ok) && !fs.existsSync(path.join(root, '.account-write.lock')))
  }

  // ---- 8. 残留锁：持有进程仍在运行，拒绝清除 ----
  {
    const acc = 'u_lockalive'
    const root = seedProject(acc, 'prj_lockaliv1')
    fs.writeFileSync(path.join(root, '.account-write.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), token: 'x' }))
    const rep = auditAccount(v2Root, acc)
    const lockFinding = rep.findings.find((f) => f.kind === 'residual-account-lock')
    ok('审计判定持有进程存活', lockFinding && lockFinding.canClear === false && rep.accountLock.holderAlive === true)
    const explicit = recoverAccount({ v2Root, accountId: acc, apply: true, actions: [{ kind: 'clear-lock' }] })
    ok('存活锁拒绝清除', explicit.results.some((r) => r.kind === 'clear-lock' && !r.ok) && fs.existsSync(path.join(root, '.account-write.lock')))
  }

  // ---- 9. 残留锁：跨主机，拒绝自动清除 ----
  {
    const acc = 'u_lockcross'
    const root = seedProject(acc, 'prj_lockcrs1')
    fs.writeFileSync(path.join(root, '.account-write.lock'), JSON.stringify({ pid: 12345, host: 'some-other-host', at: Date.now(), token: 'x' }))
    const rep = auditAccount(v2Root, acc)
    const lockFinding = rep.findings.find((f) => f.kind === 'residual-account-lock')
    ok('跨主机锁禁止自动清除', lockFinding && lockFinding.canClear === false)
    const explicit = recoverAccount({ v2Root, accountId: acc, apply: true, actions: [{ kind: 'clear-lock' }] })
    ok('跨主机锁清除被拒', explicit.results.some((r) => r.kind === 'clear-lock' && !r.ok) && fs.existsSync(path.join(root, '.account-write.lock')))
  }

  // ---- 10. 孤儿项目：状态有效但索引缺失，显式收编 ----
  {
    const acc = 'u_orphan'
    const root = seedProject(acc, 'prj_orphan01')
    const idx = idxOf(acc); delete idx.projects.prj_orphan01; writeIdx(acc, idx)
    const rep = auditAccount(v2Root, acc)
    ok('审计识别孤儿项目', hasFinding(rep, 'orphan-project', 'prj_orphan01'))
    const safeApply = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('安全 apply 不收编孤儿', !idxOf(acc).projects.prj_orphan01)
    const explicit = recoverAccount({ v2Root, accountId: acc, apply: true, actions: [{ kind: 'adopt-project', pid: 'prj_orphan01' }] })
    ok('显式收编孤儿项目', explicit.executed.some((a) => a.kind === 'adopt-project') && idxOf(acc).projects.prj_orphan01.revision === 1)
    ok('收编后审计无发现', problems(auditAccount(v2Root, acc)).length === 0)
  }

  // ---- 11. 索引条目缺目录：显式移除；目录仍在则拒绝 ----
  {
    const acc = 'u_nodir'
    const root = seedProject(acc, 'prj_nodir001')
    fs.rmSync(path.join(root, 'projects', 'prj_nodir001'), { recursive: true, force: true })
    const rep = auditAccount(v2Root, acc)
    ok('审计识别条目缺目录', hasFinding(rep, 'index-entry-no-dir', 'prj_nodir001'))
    const explicit = recoverAccount({ v2Root, accountId: acc, apply: true, actions: [{ kind: 'drop-entry', pid: 'prj_nodir001' }] })
    ok('显式移除缺目录条目', explicit.executed.some((a) => a.kind === 'drop-entry') && !idxOf(acc).projects.prj_nodir001)
    // 目录仍在时拒绝移除
    const acc2 = 'u_nodir2'
    seedProject(acc2, 'prj_nodir002')
    const refuse = recoverAccount({ v2Root, accountId: acc2, apply: true, actions: [{ kind: 'drop-entry', pid: 'prj_nodir002' }] })
    ok('目录仍在时拒绝移除条目', refuse.results.some((r) => r.kind === 'drop-entry' && !r.ok) && !!idxOf(acc2).projects.prj_nodir002)
  }

  // ---- 12. 损坏索引：全部项目有效时可显式重建并备份 ----
  {
    const acc = 'u_rebuild'
    const root = seedProject(acc, 'prj_rebuild1')
    seedProject(acc, 'prj_rebuild2')
    fs.writeFileSync(indexFile(v2Root, acc), '{corrupt-index')
    const rep = auditAccount(v2Root, acc)
    ok('审计识别损坏索引', hasFinding(rep, 'index-corrupt'))
    const safeApply = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('安全 apply 不重建索引', fs.readFileSync(indexFile(v2Root, acc), 'utf8') === '{corrupt-index')
    const explicit = recoverAccount({ v2Root, accountId: acc, apply: true, actions: [{ kind: 'rebuild-index' }] })
    ok('显式重建损坏索引', explicit.executed.some((a) => a.kind === 'rebuild-index') && readIndex(v2Root, acc).projects.prj_rebuild1.revision === 1 && readIndex(v2Root, acc).projects.prj_rebuild2.revision === 1)
    ok('重建保留损坏索引备份', fs.readdirSync(path.join(root, 'recovery-backups')).some((f) => f.startsWith('index-')))
    ok('重建后审计无发现', problems(auditAccount(v2Root, acc)).length === 0)
  }

  // ---- 13. 损坏索引但有不可读项目：拒绝凭不完整数据重建 ----
  {
    const acc = 'u_rebuildbad'
    const root = seedProject(acc, 'prj_rbad001')
    seedProject(acc, 'prj_rbad002')
    fs.writeFileSync(path.join(root, 'projects', 'prj_rbad002', 'state.json'), '{broken')
    fs.writeFileSync(indexFile(v2Root, acc), '{corrupt-index')
    const explicit = recoverAccount({ v2Root, accountId: acc, apply: true, actions: [{ kind: 'rebuild-index' }] })
    ok('不完整数据拒绝重建', explicit.results.some((r) => r.kind === 'rebuild-index' && !r.ok) && fs.readFileSync(indexFile(v2Root, acc), 'utf8') === '{corrupt-index')
  }

  // ---- 14. 停写：账号锁被占用时恢复拒绝执行 ----
  {
    const acc = 'u_busy'
    seedProject(acc, 'prj_busy0001')
    const idx = idxOf(acc); idx.projects.prj_busy0001.revision = 0; writeIdx(acc, idx) // 制造落后以便有安全动作
    const lock = acquireAccountWriteLock(v2Root, acc)
    assert.ok(lock)
    const applied = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('账号忙时恢复拒绝', applied.results.some((r) => r.kind === 'account-lock' && !r.ok) && idxOf(acc).projects.prj_busy0001.revision === 0)
    lock.release()
    const after = recoverAccount({ v2Root, accountId: acc, apply: true })
    ok('释放锁后恢复可执行', after.executed.some((a) => a.kind === 'repair-entry'))
  }

  // ---- 15. 未知动作拒绝 ----
  {
    const acc = 'u_badauth'
    seedProject(acc, 'prj_badauth1')
    let threw = false
    try { recoverAccount({ v2Root, accountId: acc, apply: true, actions: [{ kind: 'rm-everything' }] }) } catch (e) { threw = e.code === 'BAD_RECOVERY_ACTION' }
    ok('未知恢复动作被拒', threw)
  }
} catch (e) {
  console.log('FAIL 未预期异常 — ' + (e instanceof Error ? e.stack : String(e)))
  process.exitCode = 1
} finally {
  try { fs.rmSync(v2Root, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log('')
if (process.exitCode) { console.log(`FAILED（${passed} 通过）`); process.exit(1) }
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)