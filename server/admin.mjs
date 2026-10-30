#!/usr/bin/env node
// ============ 运维命令行（直接在服务器上跑） ============
//
//   cd /opt/yfe/server
//   node admin.mjs list                    列出全部用户与配额占用
//   node admin.mjs invites                 列出邀请码及使用情况
//   node admin.mjs invite [次数] [张数]     生成邀请码（默认 1 次 / 1 张）
//   node admin.mjs quota <用户名> <MB>      调整配额
//   node admin.mjs passwd <用户名> <新密码>  重置密码
//   node admin.mjs delete <用户名>          删除账号（连带数据，不可恢复）
//
// 🔴 本工具直接改 users.json。服务端对此是「按 mtime 失效缓存」的（见 lib/users.mjs），
//    所以改完**不需要重启** yfe-web —— 下一次请求就会读到新表。
import { existsSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './lib/config.mjs'
import { readLegacyGate, blockLegacyWrites, unblockLegacyWrites } from './lib/legacyGate.mjs'
import {
  loadUsers, listUsers, findByName, createInvite, listInvites, deleteUser, saveUsers, markIssued,
} from './lib/users.mjs'
import { hashPassword, validatePassword } from './lib/auth.mjs'
import { usageOf, userDir } from './lib/userdata.mjs'

/**
 * 停用一张邀请码（把上限压到「已用次数」）。
 * 用途：码发错人、发多了、或怀疑泄露。**不删除记录** —— 删掉就再也查不到它曾被谁用过。
 */
function cmdRevoke(code) {
  const db = loadUsers()
  const key = String(code || '').trim().toUpperCase()
  const inv = db.invites[key]
  if (!inv) return console.error(`找不到邀请码：${key}`)
  if (inv.uses >= inv.maxUses) return console.log(`${key} 本来就已用完（${inv.uses}/${inv.maxUses}）`)
  inv.maxUses = inv.uses
  saveUsers()
  console.log(`已停用 ${key}（现为 ${inv.uses}/${inv.maxUses}，不能再注册）`)
}

/**
 * 彻底删除一张邀请码。
 * ⚠️ 与 `revoke` 的区别：revoke 只停用（保留「谁用过」的记录），delete 是连记录一起抹掉。
 *    只在「这张码本来就不该存在」（生成多了、手滑、测试码）时用。
 */
function cmdDelInvite(code) {
  const db = loadUsers()
  const key = String(code || '').trim().toUpperCase()
  const inv = db.invites[key]
  if (!inv) return console.error(`找不到邀请码：${key}`)
  if (inv.uses > 0) {
    console.log(`注意：${key} 已被使用 ${inv.uses} 次，删除后「谁用过」的记录会一并消失。`)
  }
  delete db.invites[key]
  saveUsers()
  console.log(`已删除邀请码 ${key}`)
}

const fmt = (b) => (b >= 1048576
  ? `${(b / 1048576).toFixed(1)} MB`
  : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`)
const when = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—')

function cmdList() {
  const users = listUsers()
  if (!users.length) return console.log('（还没有任何用户）')
  console.log(`共 ${users.length} 个账号（均为云端存储）\n`)
  console.log('用户名'.padEnd(14) + '配额'.padEnd(11) + '已用'.padEnd(11) + '来源邀请码'.padEnd(13) + '最后登录'.padEnd(21) + 'ID')
  console.log('-'.repeat(96))
  for (const u of users) {
    // 用磁盘真实占用而不是 users.json 里记的数：它可能落后于最后一次写入
    let used = 0
    try { used = usageOf(u.id) } catch { used = u.usedBytes || 0 }
    console.log(
      String(u.name).padEnd(14) + fmt(u.quotaBytes).padEnd(11) + fmt(used).padEnd(11)
      + String(u.invite || '—').padEnd(13) + when(u.lastLoginAt).padEnd(21) + u.id,
    )
  }
}

/** 三态：已用（对方注册了）/ 已发放（给了人但还没注册）/ 未发放（还在手里） */
function inviteState(i) {
  if (i.uses >= i.maxUses) return '已用'
  return i.issuedAt ? '已发放' : '未发放'
}

function cmdInvites() {
  const list = listInvites()
  if (!list.length) return console.log('（没有邀请码）')
  console.log('邀请码'.padEnd(12) + '状态'.padEnd(10) + '已用/上限'.padEnd(12) + '备注')
  console.log('-'.repeat(64))
  for (const i of list) {
    console.log(
      String(i.code).padEnd(12) + inviteState(i).padEnd(10)
      + `${i.uses}/${i.maxUses}`.padEnd(12) + (i.note || '—'),
    )
    for (const u of i.usedBy) {
      console.log(`   ↳ ${u.name}（${u.id}）  ${when(u.at)}`)
    }
  }
  const free = list.filter((i) => i.uses < i.maxUses && !i.issuedAt)
  if (free.length) {
    console.log(`\n未发放 ${free.length} 张 —— ${free.map((i) => i.code).join(' ')}`)
  }
  const pending = list.filter((i) => i.uses < i.maxUses && i.issuedAt)
  if (pending.length) {
    console.log(`已发放待注册 ${pending.length} 张 —— ${pending.map((i) => i.code).join(' ')}`)
  }
}

/** 登记发放：把某张码标成「已发放」，可附备注（发给谁） */
function cmdIssue(code, note) {
  const r = markIssued(code, note)
  if (!r.ok) return console.error(r.error)
  console.log(`已登记发放：${String(code).toUpperCase()}${note ? '  →  ' + note : ''}`)
}

function cmdInvite(maxUses = 1, count = 1) {
  const per = Math.max(1, Number(maxUses) || 1)
  const n = Math.min(30, Math.max(1, Number(count) || 1))
  const codes = []
  for (let i = 0; i < n; i++) {
    const r = createInvite({ maxUses: per, note: 'admin 生成' })
    if (!r.ok) { console.error('生成失败：' + r.error); break }
    codes.push(r.code)
  }
  if (!codes.length) return
  console.log(`已生成 ${codes.length} 张邀请码（每张可用 ${per} 次，已自动与历史码去重）：`)
  for (const c of codes) console.log('  ' + c)
  console.log('\n一次性复制全部：')
  console.log(codes.join(' '))
}

/** 只列「还没被用完」的码 —— 发码前看这一条就不会发出重复的 */
function cmdFree() {
  // ⚠️ 判据是「未用 **且** 未登记发放」：只判未用会把「已发出去但对方还没注册」的码也列进来，
  //    那正是发重的主要来源。
  const free = listInvites().filter((i) => i.uses < i.maxUses && !i.issuedAt)
  if (!free.length) {
    return console.log('（当前没有未发放的邀请码；用 `node admin.mjs invite 1 10` 生成一批）')
  }
  console.log(`未发放的邀请码 ${free.length} 张（可直接发给打赏用户）：\n`)
  for (const i of free) {
    console.log(`  ${i.code}   剩余 ${i.maxUses - i.uses} 次`)
  }
  console.log('\n一次性复制：')
  console.log(free.map((i) => i.code).join(' '))
}

function cmdQuota(name, mb) {
  const u = findByName(name)
  if (!u) return console.error(`找不到用户：${name}`)
  const n = Number(mb)
  if (!Number.isFinite(n) || n <= 0) return console.error('配额需为正数（单位 MB）')
  u.quotaBytes = Math.floor(n * 1024 * 1024)
  saveUsers()
  console.log(`${u.name} 的配额已设为 ${fmt(u.quotaBytes)}`)
}

function cmdPasswd(name, pwd) {
  const u = findByName(name)
  if (!u) return console.error(`找不到用户：${name}`)
  const v = validatePassword(pwd)
  if (!v.ok) return console.error(v.error)
  u.pwd = hashPassword(v.value)
  saveUsers()
  console.log(`${u.name} 的密码已重置`)
}

function cmdDelete(name) {
  const u = findByName(name)
  if (!u) return console.error(`找不到用户：${name}`)
  const dir = userDir(u.id)
  deleteUser(u.id)
  // 数据目录逐个文件删（不整目录 rm -rf，避免误伤）
  if (existsSync(dir)) {
    const rm = (d) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name)
        if (ent.isDirectory()) rm(p)
        else { try { unlinkSync(p) } catch { /* 略 */ } }
      }
      // 🔴 文件删完还要把目录本身也销掉：只删内容会留下一串空目录，
      //    `ls /opt/yfe/data/users/` 会显示一堆已不存在的账号 ID，看着像幽灵用户。
      try { rmdirSync(d) } catch { /* 目录非空或已被删 */ }
    }
    rm(dir)
  }
  console.log(`已删除账号 ${u.name}（${u.id}）及其数据目录`)
}

/**
 * 旧路径门禁：迁移完成后按账号停掉 /api/data 与 /api/blob 的写入。
 *
 * 🔴 为什么要按账号而不是全站：还没迁移完成的账号被停写就是事故。
 *    另可用 YFE_LEGACY_WRITE=block 做全局急停（事故时先把所有旧写停住）。
 */
function cmdGate(name, action, note) {
  const u = findByName(name)
  if (!u) return console.error(`找不到用户：${name}`)
  const v2Root = join(DATA_DIR, 'v2')
  const act = String(action || '').toLowerCase()
  if (act === 'on' || act === 'block') {
    blockLegacyWrites(v2Root, u.id, { note })
    console.log(`已停用 ${u.name}（${u.id}）的旧版写入：/api/data 与 /api/blob 写将返回 409 LEGACY_WRITE_BLOCKED（读与导出不受影响）`)
    return
  }
  if (act === 'off' || act === 'unblock') {
    unblockLegacyWrites(v2Root, u.id, { note: note || '运维手动解除' })
    console.log(`已恢复 ${u.name}（${u.id}）的旧版写入`)
    return
  }
  console.log(`当前状态：${JSON.stringify(readLegacyGate(v2Root, u.id))}`)
}

const [cmd, a1, a2] = process.argv.slice(2)
switch (cmd) {
  case 'list': loadUsers(); cmdList(); break
  case 'invites': cmdInvites(); break
  case 'free': cmdFree(); break
  case 'invite': cmdInvite(a1, a2); break
  case 'issue': cmdIssue(a1, a2); break
  case 'revoke': cmdRevoke(a1); break
  case 'delinvite': cmdDelInvite(a1); break
  case 'quota': cmdQuota(a1, a2); break
  case 'passwd': cmdPasswd(a1, a2); break
  case 'delete': cmdDelete(a1); break
  case 'gate': cmdGate(a1, a2, process.argv.slice(5).join(' ')); break
  default:
    console.log(`用法：
  node admin.mjs list                    列出全部账号（含来源邀请码、配额占用）
  node admin.mjs free                    列出「还没发出去」的邀请码（发码前看这条，防发重）
  node admin.mjs invites                 列出全部邀请码 + 三态 + 谁用的
  node admin.mjs issue <码> [备注]        登记「已发放」（可写发给谁），状态变为「已发放」
  node admin.mjs invite [可用次数] [张数]  生成邀请码（默认 1 次 / 1 张，自动去重）
  node admin.mjs revoke <邀请码>          停用一张码（发错/泄露时用，保留使用记录）
  node admin.mjs delinvite <邀请码>       彻底删除一张码（含使用记录，仅用于多余的码）
  node admin.mjs quota <用户名> <MB>      调整配额
  node admin.mjs passwd <用户名> <新密码>  重置密码
  node admin.mjs delete <用户名>          删除账号（连带数据，不可恢复）
  node admin.mjs gate <用户名> [on|off] [备注]  旧路径门禁：迁移完成后停用旧版写入（不填动作=查状态）`)
}
