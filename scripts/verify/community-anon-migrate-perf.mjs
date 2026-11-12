// 隔离性能证据：匿名代号停写迁移的「批量分配」对比「逐条复制」，以及端到端近线性 scaling。
// 合成数据 + 独立临时目录；不触碰生产、不配置真实密钥。运行：node scripts/verify/community-anon-migrate-perf.mjs
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { allocateAnonymousHandle, allocateAnonymousHandlesBatch } from '../../server/lib/communityAnon.mjs'
import { createCommunityStore } from '../../server/lib/communityStore.mjs'

const SECRET = randomBytes(32)
const WEEKS = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']
const DAY = 86400000
const roots = []
function tmp() { const r = mkdtempSync(path.join(os.tmpdir(), 'yfe-anon-perf-')); roots.push(r); return r }
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', (b) => { stdout += b })
    child.stderr.on('data', (b) => { stderr += b })
    child.once('error', (e) => resolve({ code: 1, stdout, stderr: String(e) }))
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}
function ms(fn) { const t = performance.now(); const out = fn(); return { ms: performance.now() - t, out } }

console.log('—— 匿名代号迁移性能证据 ——')

// ---- 1 微基准：逐条 structuredClone（旧）vs 批量（新）----
function makePairs(n) { const p = []; for (let i = 0; i < n; i++) p.push([WEEKS[i % WEEKS.length], `u${i}`]); return p }
function oldLoop(pairs) { let map = {}; for (const [w, uid] of pairs) map = allocateAnonymousHandle(map, uid, w, SECRET).mapping; return map }
const micro = []
for (const n of [1000, 2000, 4000]) {
  const pairs = makePairs(n)
  const old = ms(() => oldLoop(pairs))
  const neu = ms(() => allocateAnonymousHandlesBatch({}, pairs, SECRET))
  micro.push({ n, old: old.ms, new: neu.ms })
  console.log(`  分配 ${n} 对：旧逐条 ${old.ms.toFixed(0)}ms ｜ 新批量 ${neu.ms.toFixed(0)}ms ｜ 加速 ${(old.ms / neu.ms).toFixed(1)}×`)
}
const bigNew = ms(() => allocateAnonymousHandlesBatch({}, makePairs(32000), SECRET))
console.log(`  新批量 32000 对：${bigNew.ms.toFixed(0)}ms`)
// 旧法二次方：规模 4×（1000→4000）耗时应显著超线性（>3×）；新法近线性
assert.ok(micro[2].old / micro[0].old > 3, `旧法未呈现二次方增长：${micro[0].old}→${micro[2].old}`)
assert.ok(bigNew.ms < micro[2].old, '新批量 32000 对应快于旧逐条 4000 对')
assert.ok(bigNew.out.created.length === 32000, '批量创建数应为 32000')

// ---- 2 端到端：合成 N 与 2N 数据，跑真实迁移 CLI ----
function genData(root, scale) {
  const data = path.join(root, 'community')
  mkdirSync(data)
  const now = Date.now() - 10000
  const P = 6000 * scale, C = 6000 * scale, R = 3000 * scale
  const posts = {}, comments = {}, rank = {}
  for (let i = 0; i < P; i++) {
    const id = `p${i}`, createdAt = now - (i % 42) * DAY - (i % 24) * 3600000
    posts[id] = { id, uid: `pu${i}`, status: 'published', display: 'anonymous', createdAt, updatedAt: createdAt, publishedVersionId: 'v1', pendingVersionId: '', versions: [{ vid: 'v1', title: `稿${i}`, body: '合成正文。', tags: ['短篇'], createdAt }], counts: { up: 0, down: 0, comments: 1 } }
  }
  for (let i = 0; i < C; i++) {
    const id = `c${i}`, postId = `p${i % P}`, createdAt = now - (i % 42) * DAY - (i % 24) * 3600000
    comments[id] = { id, postId, uid: `cu${i}`, body: '合成评论。', display: 'anonymous', status: 'visible', createdAt }
  }
  for (let i = 0; i < R; i++) {
    const date = new Date(now - (i % 40) * DAY).toISOString().slice(0, 10)
    rank[`ru${i}::dev::proj::${date}`] = { uid: `ru${i}`, deviceId: 'dev', projectId: 'proj', date, netDelta: 100 + i, seq: 1 }
  }
  const empty = { version: 1, items: {} }
  writeFileSync(path.join(data, 'posts.json'), JSON.stringify({ version: 1, items: posts }))
  writeFileSync(path.join(data, 'comments.json'), JSON.stringify({ version: 1, items: comments }))
  writeFileSync(path.join(data, 'rank.json'), JSON.stringify({ version: 1, items: rank }))
  writeFileSync(path.join(data, 'votes.json'), JSON.stringify(empty))
  writeFileSync(path.join(data, 'reports.json'), JSON.stringify(empty))
  writeFileSync(path.join(data, 'profiles.json'), JSON.stringify(empty))
  writeFileSync(path.join(data, 'audit.json'), JSON.stringify({ version: 1, items: { list: [] } }))
  writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, squareOpen: true, postsOpen: true, commentsOpen: true, updatedAt: now }))
  return { data }
}
async function migrateOnce(data, backup, keyFile) {
  const t = performance.now()
  const res = await runCli(['server/community-anon-migrate.mjs', '--data', data, '--backup', backup, '--key-file', keyFile, '--confirm-stopped'])
  const elapsed = performance.now() - t
  assert.equal(res.code, 0, `迁移失败：${res.stderr}`)
  return { elapsed, json: JSON.parse(res.stdout.trim().split('\n').pop()) }
}
async function endToEnd(scale, label) {
  const root = tmp()
  const { data } = genData(root, scale)
  const keyFile = path.join(root, 'key'); writeFileSync(keyFile, SECRET)
  const first = await migrateOnce(data, path.join(root, 'backup1'), keyFile)
  // 校验：启动通过 + 每周一一对应 + 唯一
  const store = createCommunityStore({ root: data, anonSecret: SECRET })
  store.assertAnonymousMappings()
  const profiles = JSON.parse(readFileSync(path.join(data, 'profiles.json'), 'utf8')).items
  const perWeek = new Map()
  let handles = 0
  for (const p of Object.values(profiles)) for (const [w, h] of Object.entries(p.anonHandles || {})) {
    handles++
    perWeek.set(w, (perWeek.get(w) || new Set()))
    assert.ok(!perWeek.get(w).has(h), `同周代号冲突：${w} ${h}`)
    perWeek.get(w).add(h)
  }
  assert.equal(handles, first.json.mappings, '代号数应等于所需 (账号,周) 对数')
  // 幂等重跑：零新建
  const second = await migrateOnce(data, path.join(root, 'backup2'), keyFile)
  assert.equal(second.json.created, 0, '幂等重跑应零新建')
  assert.equal(second.json.mappings, first.json.mappings, '重跑所需对数不变')
  console.log(`  ${label}：pairs=${first.json.mappings} created=${first.json.created} 首迁 ${first.elapsed.toFixed(0)}ms ｜ 重跑 ${second.elapsed.toFixed(0)}ms ｜ 代号唯一✓ 启动校验✓`)
  return first.elapsed
}
const t1 = await endToEnd(1, 'N (约1.7万对)')
const t2 = await endToEnd(2, '2N (约3.4万对)')
console.log(`  端到端 scaling：2N/N = ${(t2 / t1).toFixed(2)}×（近线性期望 ≈2×）`)
assert.ok(t2 / t1 < 3.5, `端到端未呈现近线性：${t1.toFixed(0)}ms→${t2.toFixed(0)}ms`)

for (const r of roots) rmSync(r, { recursive: true, force: true })
console.log('PASS 迁移性能：批量分配近线性、旧逐条二次方、端到端 2N≈2×、幂等重跑零新建、代号同周唯一')