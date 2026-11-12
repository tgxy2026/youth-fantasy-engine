#!/usr/bin/env node
// Explicit stopped-service migration; no production path is chosen by default.
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path'
import { createBackup, inspectCommunity, verifyBackup, COMMUNITY_FILES } from './lib/communityBackup.mjs'
import { acquireCommunityLock, releaseCommunityLock } from './lib/communityLock.mjs'
import { writeTextAtomicSync } from './lib/atomic.mjs'
import { allocateAnonymousHandlesBatch, anonymousWeekKey, anonymousRankWeeks, BEAST_DICTIONARY_SHA256 } from './lib/communityAnon.mjs'

const args = process.argv.slice(2)
function option(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : '' }
const root = option('--data'), backupDir = option('--backup'), keyFile = option('--key-file')
if (!root || !backupDir || !keyFile || !args.includes('--confirm-stopped')) {
  console.error('用法：--data 社区目录 --backup 新备份目录 --key-file 独立密钥文件 --confirm-stopped')
  process.exit(2)
}
const resolvedRoot = realpathSync(root)
const resolvedKey = realpathSync(keyFile)
const resolvedBackup = join(realpathSync(dirname(resolve(backupDir))), basename(resolve(backupDir)))
const inside = (parent, child) => { const r = relative(parent, child); return !r || (r !== '..' && !r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(r)) }
if (inside(resolvedRoot, resolvedBackup) || inside(resolvedRoot, resolvedKey)) throw new Error('备份和密钥不得放在社区数据目录内')
const secret = readFileSync(keyFile)
if (secret.length < 32) throw new Error('匿名代号密钥至少需要 32 字节')
const keyId = createHash('sha256').update(secret).digest('hex')
const backup = createBackup({ root: resolve(root), dest: resolve(backupDir), stopConfirmed: true })
if (!backup.ok) throw new Error(`迁移前备份失败：${backup.error || backup.code}`)
const lock = acquireCommunityLock(resolve(root), { tool: 'anon-migration' })
if (!lock.ok) throw new Error('迁移锁不可用；备份已保留，请核查后重试')
try {
  const live = inspectCommunity(resolve(root), { includeData: true })
  const saved = verifyBackup(resolve(backupDir), { includeData: true })
  if (!live.ok || !saved.ok || COMMUNITY_FILES.some((file) => JSON.stringify(live.normalized[file]) !== JSON.stringify(saved.data[file]))) throw new Error('迁移前数据与备份不一致，拒绝修改')
  const profiles = structuredClone(live.data['profiles.json'])
  const mapping = {}
  for (const [uid, p] of Object.entries(profiles.items)) {
    if (!p.anonHandles) continue
    if (p.anonKeyId !== keyId || p.anonDict !== BEAST_DICTIONARY_SHA256 || typeof p.anonHandles !== 'object' || Array.isArray(p.anonHandles)) throw new Error('已有匿名代号版本不匹配')
    for (const [week, handle] of Object.entries(p.anonHandles)) {
      mapping[week] ||= {}
      mapping[week][uid] = handle
    }
  }
  const required = new Set()
  function add(uid, week) { if (typeof uid !== 'string' || !uid) throw new Error('存在缺少账号的社区记录'); required.add(JSON.stringify([week, uid])) }
  function validTime(value) { if (!Number.isSafeInteger(value) || value <= 0 || value > Date.now()) throw new Error('存在无效或未来的内容创建时间'); return value }
  for (const p of Object.values(live.data['posts.json'].items)) if (!p.isExample) add(p.uid, anonymousWeekKey(validTime(p.createdAt)))
  for (const c of Object.values(live.data['comments.json'].items)) add(c.uid, anonymousWeekKey(validTime(c.createdAt)))
  for (const row of Object.values(live.data['rank.json'].items)) for (const week of anonymousRankWeeks(row.date)) add(row.uid, week)
  // 批量分配：映射与占用表只构建一次，避免逐条复制映射的二次方开销；已有映射幂等保留
  const pairs = [...required].sort().map((pair) => JSON.parse(pair))
  const allocated = allocateAnonymousHandlesBatch(mapping, pairs, secret)
  const byUid = new Map()
  for (const { uid, week, handle } of allocated.created) {
    if (!byUid.has(uid)) byUid.set(uid, {})
    byUid.get(uid)[week] = handle
  }
  for (const [uid, weeks] of byUid) {
    const p = profiles.items[uid] || { nickname: '', postDisplay: 'anonymous', commentDisplay: 'anonymous', rankDisplay: 'anonymous', rankOptIn: false, updatedAt: 0 }
    profiles.items[uid] = { ...p, anonKeyId: keyId, anonDict: BEAST_DICTIONARY_SHA256, anonHandles: { ...p.anonHandles, ...weeks } }
  }
  const beforeWrite = inspectCommunity(resolve(root), { includeData: true })
  if (!beforeWrite.ok || COMMUNITY_FILES.some((file) => JSON.stringify(beforeWrite.normalized[file]) !== JSON.stringify(saved.data[file]))) throw new Error('迁移准备期间数据发生变化，拒绝修改')
  writeTextAtomicSync(join(resolve(root), 'profiles.json'), JSON.stringify(profiles, null, 2))
  console.log(JSON.stringify({ ok: true, mappings: required.size, created: allocated.created.length, backup: resolve(backupDir) }))
} finally { releaseCommunityLock(resolve(root)) }
