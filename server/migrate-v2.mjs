#!/usr/bin/env node
// ============ 3.3.2 · 整库 → 项目级快照迁移（P2-8）============
//
//   node migrate-v2.mjs <用户名>            迁移一个账号并开启旧路径门禁
//   node migrate-v2.mjs --all               迁移全部账号
//   node migrate-v2.mjs <用户名> --dry-run   只看会做什么，不写任何东西
//
// 【为什么需要它】3.3.1 的云端是「一个账号一个整库 JSON」。项目级协议要的是「一本作品一个快照」。
//   这份脚本把旧整库按 projectId 拆成若干 bundle，逐本生成快照并提交，最后把旧写路径关掉。
//
// 🔴 五条安全约束：
//   1. **只读旧库**：本脚本不修改 `users/<uid>/data.json`，迁移失败时旧数据一处未动。
//   2. **幂等**：索引里已有该作品且 revision>0 ⇒ 跳过。重复执行不会产生新版本。
//   3. **先提交、后关门禁**：任何一本没迁成功就不关门禁（否则用户既不能写新也不能写旧）。
//   4. **图片同样抽出来**：与客户端 `projectSnapshot` 同口径（dataURL → sha256 引用），
//      否则迁移出的第一版就是 40 MiB 级，后续客户端提交会把它整本重传一遍。
//   5. **dry-run 必须真的不写**：连对象都不落盘，只打印计划。
//
// ⚠️ 本脚本产出的快照与客户端 `buildProjectSnapshot` 不是逐字节同源（那边是 TS/DOM 环境）。
//    哈希口径相同（JSON.stringify + sha256），但记录顺序规则若将来分歧，客户端首次提交会产生
//    一个新 revision —— 这**不是**数据错误，只是多一个版本；真要严格一致需要共享同一份实现。
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { DATA_DIR } from './lib/config.mjs'
import { findByName, listUsers } from './lib/users.mjs'
import { readUserData } from './lib/userdata.mjs'
import { stageObject, commitProjectSnapshot, PROTOCOL_VERSION } from './lib/projectStore.mjs'
import { readIndex, setProjectMeta } from './lib/v2Index.mjs'
import { blockLegacyWrites } from './lib/legacyGate.mjs'

const V2_ROOT = join(DATA_DIR, 'v2')
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

const KEY_OF = {
  chapters: (r) => String(r.id ?? ''),
  volumes: (r) => String(r.id ?? ''),
  tableRows: (r) => String(r.id ?? ''),
  cardRecords: (r) => String(r.id ?? ''),
  formData: (r) => String(r.tabId ?? ''),
  settings: (r) => String(r.key ?? ''),
  dailyStats: (r) => String(r.key ?? r.date ?? ''),
  aiRuns: (r) => String(r.id ?? ''),
  tavernReports: (r) => String(r.id ?? ''),
  snapshots: (r) => String(r.id ?? ''),
}

function sortByKey(kind, rows) {
  const keyOf = KEY_OF[kind] ?? ((r) => String(r.id ?? ''))
  return rows.slice().sort((a, b) => {
    const ka = keyOf(a), kb = keyOf(b)
    if (ka !== kb) return ka < kb ? -1 : 1
    const ja = JSON.stringify(a), jb = JSON.stringify(b)
    return ja < jb ? -1 : ja > jb ? 1 : 0
  })
}

/** 把 stores 拆成「一本作品一份」的切片 */
function splitByProject(stores) {
  const projects = Object.values(stores.projects || {})
  const out = new Map()
  const bucket = (pid) => {
    if (!out.has(pid)) {
      out.set(pid, {
        chapters: [], volumes: [], tableRows: [], cardRecords: [], formData: [],
        settings: [], dailyStats: [], aiRuns: [], tavernReports: [], snapshots: [],
      })
    }
    return out.get(pid)
  }

  for (const p of projects) bucket(String(p.id))
  for (const v of Object.values(stores.volumes || {})) if (v?.projectId) bucket(v.projectId).volumes.push(v)
  for (const c of Object.values(stores.chapters || {})) if (c?.projectId) bucket(c.projectId).chapters.push(c)
  for (const r of Object.values(stores.tableRows || {})) if (r?.projectId) bucket(r.projectId).tableRows.push(r)
  for (const r of Object.values(stores.cardRecords || {})) if (r?.projectId) bucket(r.projectId).cardRecords.push(r)
  for (const s of Object.values(stores.snapshots || {})) if (s?.projectId) bucket(s.projectId).snapshots.push(s)
  for (const r of Object.values(stores.tavernReports || {})) if (r?.projectId) bucket(r.projectId).tavernReports.push(r)
  for (const a of Object.values(stores.aiRuns || {})) if (a?.projectId) bucket(a.projectId).aiRuns.push(a)
  for (const d of Object.values(stores.dailyStats || {})) if (d?.projectId) bucket(d.projectId).dailyStats.push(d)

  // 以 key 为标识的三类要剥前缀（与 exportProject 同口径）
  for (const f of Object.values(stores.formData || {})) {
    const tabId = String(f?.tabId || '')
    const i = tabId.indexOf('::')
    if (i < 0) continue
    const pid = tabId.slice(0, i)
    if (!out.has(pid)) continue
    bucket(pid).formData.push({ tabId: tabId.slice(i + 2), data: f.data })
  }
  for (const s of Object.values(stores.settingsKV || {})) {
    const key = String(s?.key || '')
    if (key.startsWith('customOption::')) {
      const rest = key.slice('customOption::'.length)
      const i = rest.indexOf('::')
      if (i < 0 || !out.has(rest.slice(0, i))) continue
      bucket(rest.slice(0, i)).settings.push({ key: `customOption::${rest.slice(i + 2)}`, value: s.value })
      continue
    }
    const i = key.indexOf('::')
    if (i < 0 || !out.has(key.slice(0, i))) continue
    bucket(key.slice(0, i)).settings.push({ key: key.slice(i + 2), value: s.value })
  }
  return { projects, out }
}

/** 抽出内嵌图片，换成 sha256 引用（与客户端同口径） */
function extractAssets(cardRecords, tableRows) {
  const assets = new Map()
  const take = (dataUrl) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null
    const m = /^data:([^;,]+)?(;base64)?,/.exec(dataUrl)
    if (!m || !m[2]) return null
    const bytes = Buffer.from(dataUrl.slice(m[0].length), 'base64')
    const hash = sha(bytes)
    if (!assets.has(hash)) assets.set(hash, { bytes, mime: m[1] || 'image/webp' })
    return `sha256:${hash}`
  }
  const cards = cardRecords.map((r) => {
    const next = { ...r }
    for (const f of ['portrait', 'portrait2']) {
      const ref = take(next[f])
      if (ref) next[f] = ref
      else if (next[f] !== undefined) delete next[f]
    }
    return next
  })
  const rows = tableRows.map((r) => {
    const next = { ...r }
    if (next.atlasImage && typeof next.atlasImage === 'object') {
      const ref = take(next.atlasImage.dataUrl)
      if (ref) next.atlasImage = { ...next.atlasImage, dataUrl: ref }
    }
    return next
  })
  return { cards, rows, assets: [...assets.entries()].map(([hash, v]) => ({ hash, ...v })) }
}

async function migrateProject({ uid, project, slices, dryRun }) {
  const { cards, rows, assets } = extractAssets(slices.cardRecords, slices.tableRows)
  const data = { ...slices, cardRecords: cards, tableRows: rows }

  const objects = []
  const counts = {}
  for (const [kind, rowsOrCards] of Object.entries(data)) {
    const sorted = sortByKey(kind, rowsOrCards)
    const payload = JSON.stringify(sorted)
    const buf = Buffer.from(payload, 'utf8')
    objects.push({ kind, hash: sha(buf), bytes: buf.length, payload: buf })
    counts[kind] = sorted.length
  }

  const manifest = {
    protocol: PROTOCOL_VERSION,
    createdAt: Date.now(),
    project: { name: project.name, genre: project.genre, projectType: project.projectType },
    counts,
    objects: objects.map((o) => ({ kind: o.kind, hash: o.hash, bytes: o.bytes, records: counts[o.kind] })),
    assets: assets.map((a) => ({ hash: a.hash, bytes: a.bytes.length, mime: a.mime })),
    tombstones: [],
  }

  const totalBytes = objects.reduce((n, o) => n + o.bytes, 0) + assets.reduce((n, a) => n + a.bytes.length, 0)
  if (dryRun) return { dryRun: true, revision: 0, objects: objects.length, assets: assets.length, bytes: totalBytes }

  for (const a of assets) {
    await stageObject({ root: join(V2_ROOT, 'accounts', uid), pid: project.id, hash: a.hash, stream: Readable.from([a.bytes]) })
  }
  for (const o of objects) {
    await stageObject({ root: join(V2_ROOT, 'accounts', uid), pid: project.id, hash: o.hash, stream: Readable.from([o.payload]) })
  }
  const r = commitProjectSnapshot({
    root: join(V2_ROOT, 'accounts', uid), pid: project.id, accountId: uid,
    opId: `migrate:${uid}:${project.id}:${Date.now()}`, baseRevision: 0, manifest,
  })
  if (!r.ok) throw new Error(`提交失败：${r.code}`)
  setProjectMeta(V2_ROOT, uid, project.id, {
    name: project.name, revision: r.revision, snapshotId: r.snapshotId, objectBytes: totalBytes,
  })
  return { revision: r.revision, objects: objects.length, assets: assets.length, bytes: totalBytes }
}

async function migrateUser(user, { dryRun }) {
  const rd = readUserData(user.id)
  if (rd.missing) return { skipped: '没有云端数据', projects: 0 }
  let parsed
  try { parsed = JSON.parse(rd.text) } catch { return { error: '整库 JSON 无法解析，已跳过（未做任何修改）' } }
  const stores = parsed?.stores
  if (!stores || typeof stores !== 'object') return { error: '整库结构缺少 stores，已跳过' }

  const { projects, out } = splitByProject(stores)
  const idx = readIndex(V2_ROOT, user.id)
  const results = []
  let failed = 0

  for (const project of projects) {
    const pid = String(project.id)
    if ((idx.projects?.[pid]?.revision || 0) > 0) {
      results.push({ pid, name: project.name, skipped: '已迁移过' })
      continue
    }
    try {
      const r = await migrateProject({ uid: user.id, project, slices: out.get(pid), dryRun })
      results.push({ pid, name: project.name, ...r })
    } catch (e) {
      failed++
      results.push({ pid, name: project.name, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 🔴 只有「一本都没失败」才关门禁：否则用户新写不进、旧也写不了
  const blocked = failed === 0 && !dryRun
  if (blocked) {
    blockLegacyWrites(V2_ROOT, user.id, {
      note: '你的云端数据已升级到项目级同步，旧版写入已停用。请更新到新版客户端继续编辑；数据仍可导出。',
    })
  }
  return { projects: projects.length, failed, blocked, results }
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const all = args.includes('--all')
const name = args.find((a) => !a.startsWith('--'))

if (!all && !name) {
  console.log(`用法：
  node migrate-v2.mjs <用户名> [--dry-run]   迁移一个账号并在成功后关闭旧路径写入
  node migrate-v2.mjs --all [--dry-run]      迁移全部账号
🔴 建议先 --dry-run 看计划；本脚本只读旧库，失败时旧数据一处未动。`)
  process.exit(1)
}

const targets = all ? listUsers() : [findByName(name)].filter(Boolean)
if (!targets.length) {
  console.error(`找不到账号：${name}`)
  process.exit(1)
}

let exitCode = 0
for (const u of targets) {
  console.log(`\n=== ${u.name}（${u.id}）${dryRun ? ' [dry-run]' : ''} ===`)
  const r = await migrateUser(u, { dryRun })
  if (r.error) { console.error(`  ✗ ${r.error}`); exitCode = 1; continue }
  if (r.skipped) { console.log(`  · ${r.skipped}`); continue }
  for (const p of r.results) {
    if (p.error) console.error(`  ✗ ${p.name}: ${p.error}`)
    else if (p.skipped) console.log(`  · ${p.name}: ${p.skipped}`)
    else console.log(`  ✓ ${p.name}: rev ${p.revision}${p.dryRun ? '（仅计划）' : ''}，对象 ${p.objects} / 图片 ${p.assets}，${(p.bytes / 1048576).toFixed(2)} MiB`)
  }
  console.log(`  合计 ${r.projects} 本，失败 ${r.failed}；旧路径门禁：${r.blocked ? '已关闭写入' : '未开启（dry-run 或有失败）'}`)
  if (r.failed) exitCode = 1
}
process.exit(exitCode)
