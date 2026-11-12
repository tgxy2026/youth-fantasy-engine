#!/usr/bin/env node
// ============ 投稿广场 · 备份 / 校验 / 恢复 CLI（3.5.2） ============
//
// 用法：
//   node server/community-backup.mjs inspect [--data <dir>] [--json]
//   node server/community-backup.mjs backup  [--data <dir>] [--backup-root <dir>] [--out <dir>] [--keep 14] --confirm-stopped [--json]
//   node server/community-backup.mjs verify  <backupDir> [--users <users.json>] [--json]
//   node server/community-backup.mjs restore <backupDir> [--data <dir>] --confirm-stopped [--accept-visibility-changes] [--key-file <独立密钥文件>] [--json]
//   node server/community-backup.mjs adopt-empty-comments [--data <dir>] --confirm-adopt-empty [--json]
//   node server/community-backup.mjs unlock [--data <dir>] --confirm-stale [--json]
//
// 🔴 恢复前必须停掉社区写入（停服务）。工具无法验证进程是否真的停了，只认 `--confirm-stopped`。
// 🔴 输出只含文件、统计、哈希与不透明 id；不打印正文、账号 id、登录名或凭据。
// 🔴 生产备份目录、定时任务、异地副本与告警需另行授权；本命令只在被调用时执行一次。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { DATA_DIR } from './lib/config.mjs'
import {
  adoptEmptyComments, createBackup, inspectCommunity, restoreBackup, verifyBackup,
} from './lib/communityBackup.mjs'
import { readCommunityLock, unlockStaleCommunityLock } from './lib/communityLock.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]

function flag(name, fallback = '') {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = argv[i + 1]
  if (!next || next.startsWith('--')) return fallback
  return next
}
const has = (name) => argv.includes(`--${name}`)
const json = has('json')

function communityRoot() {
  return resolve(flag('data') || process.env.YFE_COMMUNITY_DIR || join(DATA_DIR, 'community'))
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function print(result, code = 0) {
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    if (result.ok) {
      const bits = [`OK ${cmd}`]
      if (result.dir) bits.push(`备份=${result.dir}`)
      if (result.restoredTo) bits.push(`恢复到=${result.restoredTo}`)
      if (result.preRestoreDir) bits.push(`恢复前副本=${result.preRestoreDir}`)
      if (result.counts) bits.push(`记录=${JSON.stringify(result.counts)}`)
      if (result.pruned?.length) bits.push(`清理旧备份=${result.pruned.length}`)
      console.log(bits.join('  '))
      if (result.repairs?.length) console.log(`  备份内已重算计数 ${result.repairs.length} 处（live 未改动）`)
      if (result.warnings?.length) {
        console.log(`  警告 ${result.warnings.length} 条：`)
        for (const w of result.warnings.slice(0, 20)) console.log(`   - ${w}`)
      }
    } else {
      console.error(`FAIL ${cmd}${result.code ? ` [${result.code}]` : ''}：${result.error || '未通过'}`)
      for (const p of (result.problems || []).slice(0, 20)) console.error(`   - ${p}`)
      if (result.summary) console.error(`  影响统计：${JSON.stringify(result.summary)}`)
      if (result.changes?.length) {
        console.error(`  恢复影响 ${result.changes.length} 项（只显示不透明 id、状态或计数）：`)
        for (const c of result.changes.slice(0, 20)) {
          const id = c.postId ? ` ${c.postId}` : ''
          const file = c.file ? ` ${c.file}` : ''
          const count = c.count !== undefined ? ` x${c.count}` : ''
          console.error(`   - ${c.type}${id}${file}${count} ${c.currentStatus || ''} -> ${c.backupStatus || ''}`)
        }
        console.error('   核对后如确认接受，再加 --accept-visibility-changes 重新执行。')
      }
    }
  }
  process.exitCode = code
}

try {
  if (cmd === 'inspect') {
    const r = inspectCommunity(communityRoot())
    print({ ...r, ok: r.ok }, r.ok ? 0 : 1)
  } else if (cmd === 'backup') {
    const root = communityRoot()
    const backupRoot = resolve(flag('backup-root') || join(DATA_DIR, 'backups'))
    const out = flag('out') ? resolve(flag('out')) : join(backupRoot, `community-${stamp()}`)
    if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true })
    const keep = Number(flag('keep', '14'))
    const r = createBackup({ root, dest: out, keep: Number.isFinite(keep) ? keep : 14, stopConfirmed: has('confirm-stopped') })
    print(r, r.ok ? 0 : (r.code === 'STOP_REQUIRED' ? 2 : 1))
  } else if (cmd === 'verify') {
    const dir = argv[1] && !argv[1].startsWith('--') ? resolve(argv[1]) : ''
    if (!dir) { print({ ok: false, error: '缺少备份目录' }, 1) }
    else {
      const r = verifyBackup(dir, { usersFile: flag('users') ? resolve(flag('users')) : '' })
      print(r, r.ok ? 0 : 1)
    }
  } else if (cmd === 'restore') {
    const dir = argv[1] && !argv[1].startsWith('--') ? resolve(argv[1]) : ''
    if (!dir) print({ ok: false, error: '缺少备份目录' }, 1)
    else {
      let anonKeyId = ''
      if (flag('key-file')) {
        const secret = readFileSync(resolve(flag('key-file')))
        if (secret.length < 32) throw new Error('匿名代号密钥至少需要 32 字节')
        anonKeyId = createHash('sha256').update(secret).digest('hex')
      }
      const r = restoreBackup({
        backupDir: dir,
        root: communityRoot(),
        stopConfirmed: has('confirm-stopped'),
        acceptVisibilityChanges: has('accept-visibility-changes'),
        anonKeyId,
      })
      const code = r.ok ? 0 : (r.code === 'VISIBILITY_CHANGES' || r.code === 'STOP_REQUIRED' ? 2 : 1)
      print(r, code)
    }
  } else if (cmd === 'adopt-empty-comments') {
    const r = adoptEmptyComments({ root: communityRoot(), confirm: has('confirm-adopt-empty') })
    print(r, r.ok ? 0 : (r.code === 'CONFIRM_REQUIRED' ? 2 : 1))
  } else if (cmd === 'unlock') {
    const root = communityRoot()
    const lock = readCommunityLock(root)
    const r = unlockStaleCommunityLock(root, { confirm: has('confirm-stale') })
    if (r.ok && !lock) print({ ok: true, released: false, note: '当前没有备份锁' }, 0)
    else print(r, r.ok ? 0 : (r.code === 'CONFIRM_REQUIRED' ? 2 : 1))
  } else {
    console.log('用法：node server/community-backup.mjs <inspect|backup|verify|restore|adopt-empty-comments|unlock> ...（见文件头注释）')
    process.exitCode = 2
  }
} catch (e) {
  print({ ok: false, error: e instanceof Error ? e.message : String(e) }, 1)
}