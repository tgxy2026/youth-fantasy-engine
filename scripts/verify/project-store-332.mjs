// P2 · 项目版本服务存储层自检（不连 HTTP、不碰真实账号）
// 用法：node scripts/verify/project-store-332.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  PROTOCOL_VERSION, TOMBSTONE_TTL_MS, stageObject, commitProjectSnapshot, readManifest,
  getProjectState, effectiveTombstones, deleteProject, bumpEpoch, hasObject, objectPath,
} from '../../server/lib/projectStore.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0)

let passed = 0
const fails = []
function ok(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name) }
  catch (e) { fails.push({ name, message: e.message }); console.log('FAIL ' + name + ' — ' + e.message) }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name) }
  catch (e) { fails.push({ name, message: e.message }); console.log('FAIL ' + name + ' — ' + e.message) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-pstore-'))
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const buff = (s) => Buffer.from(s, 'utf8')

async function putObject(pid, text) {
  const buf = buff(text)
  const hash = sha(buf)
  const r = await stageObject({ root, pid, hash, stream: Readable.from([buf]) })
  assert.equal(r.ok, true, 'stageObject 失败：' + JSON.stringify(r))
  return { hash, buf }
}

const baseManifest = (objects, extra = {}) => ({
  protocol: PROTOCOL_VERSION, createdAt: T0, objects, assets: [], tombstones: [], ...extra,
})

try {
  // 1. 正常提交
  const pid = 'prj_a'
  const o1 = await putObject(pid, 'chapters-v1')
  const c1 = commitProjectSnapshot({
    root, pid, accountId: 'acc_1', opId: 'op-1', baseRevision: 0,
    manifest: baseManifest([{ kind: 'chapters', hash: o1.hash, bytes: o1.buf.length }]), now: T0,
  })
  ok('首次提交生成 revision 1', () => {
    assert.equal(c1.ok, true)
    assert.equal(c1.revision, 1)
    assert.equal(getProjectState(root, pid, 'acc_1').revision, 1)
    assert.equal(readManifest(root, pid, 1).revision, 1)
  })

  // 2. 幂等
  const replay = commitProjectSnapshot({
    root, pid, accountId: 'acc_1', opId: 'op-1', baseRevision: 0,
    manifest: baseManifest([{ kind: 'chapters', hash: o1.hash, bytes: o1.buf.length }]), now: T0 + 1,
  })
  ok('同 opId 重放返回同一 revision（replayed）', () => {
    assert.equal(replay.ok, true)
    assert.equal(replay.replayed, true)
    assert.equal(replay.revision, 1)
  })

  // 3. 基线不符
  const stale = commitProjectSnapshot({
    root, pid, accountId: 'acc_1', opId: 'op-stale', baseRevision: 0,
    manifest: baseManifest([{ kind: 'chapters', hash: o1.hash, bytes: o1.buf.length }]), now: T0 + 2,
  })
  ok('旧基线提交被拒（BASELINE_MISMATCH）', () => {
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'BASELINE_MISMATCH')
    assert.equal(stale.revision, 1)
  })

  // 4. 对象缺失
  ok('引用未上传对象被拒（OBJECT_MISSING）', () => {
    const r = commitProjectSnapshot({
      root, pid, accountId: 'acc_1', opId: 'op-miss', baseRevision: 1,
      manifest: baseManifest([{ kind: 'chapters', hash: sha(buff('never-uploaded')), bytes: 9 }]), now: T0 + 3,
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'OBJECT_MISSING')
    assert.equal(r.missing.length, 1)
  })

  // 5. 哈希不符的流被拒，且不落进对象库
  await okAsync('哈希不符的流被拒且不留对象', async () => {
    const bad = buff('tampered-content')
    const declared = sha(buff('what-client-claimed'))
    const r = await stageObject({ root, pid, hash: declared, stream: Readable.from([bad]) })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'HASH_MISMATCH')
    assert.equal(hasObject(root, declared), false)
    assert.equal(fs.existsSync(objectPath(root, declared)), false)
  })

  // 6. 大对象流式落盘：内存峰值必须远低于「全量缓冲」的 5.5×
  await okAsync('40 MiB 流式落盘的内存峰值受控', async () => {
    const size = 40 * 1024 * 1024
    const chunk = crypto.randomBytes(1024 * 1024)
    const h = crypto.createHash('sha256')
    for (let i = 0; i < 40; i++) h.update(chunk)
    const hash = h.digest('hex')
    const rss0 = process.memoryUsage().rss
    const stream = Readable.from((async function* () { for (let i = 0; i < 40; i++) yield chunk })())
    const r = await stageObject({ root, pid, hash, stream })
    const delta = process.memoryUsage().rss - rss0
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.bytes, size)
    // 全量缓冲方案实测 +220 MiB；流式应当只有一个 chunk 级别的增量
    assert.ok(delta < 60 * 1024 * 1024, `内存增量过大：${(delta / 1048576).toFixed(1)} MiB`)
    console.log(`     （内存增量 ${(delta / 1048576).toFixed(1)} MiB / 载荷 40 MiB）`)
  })

  // 7. 墓碑合并：第二次提交只带新墓碑，旧墓碑不能丢
  const o2 = await putObject(pid, 'chapters-v2')
  const c2 = commitProjectSnapshot({
    root, pid, accountId: 'acc_1', opId: 'op-2', baseRevision: 1,
    manifest: baseManifest([{ kind: 'chapters', hash: o2.hash, bytes: o2.buf.length }], {
      tombstones: [{ kind: 'chapters', id: 'ch_7', deletedAt: T0 + 10 }],
    }), now: T0 + 10,
  })
  const c3 = commitProjectSnapshot({
    root, pid, accountId: 'acc_1', opId: 'op-3', baseRevision: 2,
    manifest: baseManifest([{ kind: 'chapters', hash: o2.hash, bytes: o2.buf.length }], {
      tombstones: [{ kind: 'tableRows', id: 'row_9', deletedAt: T0 + 20 }],
    }), now: T0 + 20,
  })
  ok('墓碑按并集累积（不是替换）', () => {
    assert.equal(c2.ok, true)
    assert.equal(c3.ok, true)
    const tombs = effectiveTombstones(root, pid, T0 + 21)
    assert.equal(tombs.length, 2)
    assert.deepEqual(tombs.map((t) => `${t.kind}:${t.id}`).sort(), ['chapters:ch_7', 'tableRows:row_9'])
  })

  // 8. 墓碑 TTL
  ok('墓碑超过 30 天后不再参与', () => {
    const later = T0 + TOMBSTONE_TTL_MS + 2 * DAY
    assert.equal(effectiveTombstones(root, pid, later).length, 0)
  })

  // 9. 归属：别的账号不能写
  ok('跨账号提交被拒（FORBIDDEN）', () => {
    const r = commitProjectSnapshot({
      root, pid, accountId: 'acc_other', opId: 'op-x', baseRevision: 3,
      manifest: baseManifest([{ kind: 'chapters', hash: o2.hash, bytes: o2.buf.length }]), now: T0 + 30,
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'FORBIDDEN')
  })

  // 10. 删除项目 → 写墓碑；旧基线回来被拒（不能复活）
  const del = deleteProject({ root, pid, accountId: 'acc_1', opId: 'op-del', now: T0 + 40 })
  ok('删除写墓碑并推进 revision', () => {
    assert.equal(del.ok, true)
    assert.equal(del.revision, 4)
    const tombs = effectiveTombstones(root, pid, T0 + 41)
    assert.ok(tombs.some((t) => t.kind === 'project' && t.id === pid))
    assert.equal(readManifest(root, pid, 4).deleted, true)
  })
  ok('删除后离线旧基线不能复活', () => {
    const r = commitProjectSnapshot({
      root, pid, accountId: 'acc_1', opId: 'op-old-device', baseRevision: 3,
      manifest: baseManifest([{ kind: 'chapters', hash: o2.hash, bytes: o2.buf.length }]), now: T0 + 50,
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'BASELINE_MISMATCH')
  })

  // 11. 世代失效
  const pid2 = 'prj_b'
  const o3 = await putObject(pid2, 'other-project')
  const cb1 = commitProjectSnapshot({
    root, pid: pid2, accountId: 'acc_1', opId: 'b-1', baseRevision: 0,
    manifest: baseManifest([{ kind: 'chapters', hash: o3.hash, bytes: o3.buf.length }]), now: T0,
  })
  bumpEpoch(root, 'restore-from-backup')
  const afterEpoch = commitProjectSnapshot({
    root, pid: pid2, accountId: 'acc_1', opId: 'b-2', baseRevision: 1,
    manifest: baseManifest([{ kind: 'chapters', hash: o3.hash, bytes: o3.buf.length }]), now: T0 + 5,
  })
  ok('世代提升后旧基线被判 EPOCH_STALE', () => {
    assert.equal(cb1.ok, true)
    assert.equal(afterEpoch.ok, false)
    assert.equal(afterEpoch.code, 'EPOCH_STALE')
  })

  // 12. 跨进程并发：同一基线只有一个成功
  await okAsync('两进程并发同基线只有一个提交成功', async () => {
    const pid3 = 'prj_c'
    const o4 = await putObject(pid3, 'concurrent-body')
    commitProjectSnapshot({
      root, pid: pid3, accountId: 'acc_1', opId: 'c-0', baseRevision: 0,
      manifest: baseManifest([{ kind: 'chapters', hash: o4.hash, bytes: o4.buf.length }]), now: T0,
    })
    const worker = path.join(here, 'project-store-worker.mjs')
    const run = (opId) => new Promise((resolve) => {
      const cp = spawn(process.execPath, [worker, root, pid3, opId, '1', o4.hash], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      cp.stdout.on('data', (d) => { out += d })
      cp.on('close', () => { try { resolve(JSON.parse(out)) } catch { resolve({ ok: false, code: 'BAD_OUTPUT', raw: out }) } })
    })
    const [r1, r2] = await Promise.all([run('c-a'), run('c-b')])
    const wins = [r1, r2].filter((r) => r.ok).length
    assert.equal(wins, 1, JSON.stringify([r1, r2]))
    assert.equal(getProjectState(root, pid3, 'acc_1').revision, 2)
  })
} catch (e) {
  fails.push({ name: '未预期异常', message: e instanceof Error ? e.stack : String(e) })
  console.log('FAIL 未预期异常 — ' + (e instanceof Error ? e.message : String(e)))
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* F 盘删除慢，失败不影响结论 */ }
}

console.log('')
if (fails.length) {
  console.log(`FAILED ${fails.length} / ${passed + fails.length}`)
  console.log(JSON.stringify(fails, null, 2))
  process.exit(1)
}
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)
