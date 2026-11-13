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
import { gcObjects, purgeDeletedProjects, listTrash } from './lib/objectGc.mjs'
import { accountRoot, acquireAccountWriteLock } from './lib/v2Index.mjs'
import { auditAccount, recoverAccount } from './lib/projectRecovery.mjs'
import {
loadUsers, listUsers, findByName, createInvite, listInvites, deleteUser, saveUsers, markIssued,
  setUserFlag, issueRecoveryCode, recoveryStatus,
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

/**
 * 回收无人引用的对象 + 清理过期回收站。
 *
 * 🔴 只在**运维手动执行**时跑，不做定时任务：3.3.2 刚上，先让人看着输出跑几次，
 *    确认 `keptRecent`（宽限期保护住的）数量合理，再考虑上定时。
 * 🔴 默认先 dry-run，`--apply` 才真删。清理空间是不可逆动作，不该一个手滑就执行。
 */
function cmdGc(name) {
  const u = name ? findByName(name) : null
  if (name && !u) return console.error(`找不到用户：${name}`)
  if (!u) return console.error('用法：node admin.mjs gc <用户名> [--apply] [--purge-trash]')
  const apply = process.argv.includes('--apply')
  const root = accountRoot(join(DATA_DIR, 'v2'), u.id)
  if (!existsSync(root)) return console.log(`${u.name} 还没有 v2 数据目录`)

  const accountLock = acquireAccountWriteLock(join(DATA_DIR, 'v2'), u.id)
  if (!accountLock) return console.error('账号正在处理，请稍后重试')
  try {

  const r = gcObjects(root, { dryRun: !apply })
  console.log(`对象回收${apply ? '' : '（预演）'}：扫描 ${r.scanned} 个，被引用 ${r.referenced} 个，`
    + `可回收 ${r.removed} 个 / ${(r.freedBytes / 1048576).toFixed(2)} MiB，`
    + `宽限期内暂留 ${r.keptRecent} 个`)
  if (r.keptRecent > 0) {
    console.log('  ↑ 这些可能是「已上传但还没提交」的对象，24 小时内不会动')
  }

  const trash = listTrash(root)
  if (trash.length) {
    console.log(`回收站 ${trash.length} 项：`)
    for (const t of trash) {
      console.log(`  ${t.pid}  ${t.name || '(无名)'}  ${(t.bytes / 1048576).toFixed(2)} MiB  `
        + `${t.expiresInMs > 0 ? `${Math.ceil(t.expiresInMs / 86400000)} 天后清理` : '已过期，下次清理'}`)
    }
  }
  if (process.argv.includes('--purge-trash')) {
    const p = purgeDeletedProjects(root, { dryRun: !apply })
    console.log(`回收站清理${apply ? '' : '（预演）'}：清掉 ${p.purged.length} 项，保留 ${p.kept} 项未到期`)
  }
  if (!apply) console.log('\n这只是预演。确认无误后加 --apply 真正执行。')
  } finally { accountLock.release() }
}

const [cmd, a1, a2] = process.argv.slice(2)

/**
 * 3.5.3 · P0 数据审计（只读）。报告索引/状态/隔离区/账号锁的不一致，不写任何文件。
 */
function cmdAudit(name) {
  const u = findByName(name)
  if (!u) return console.error(`找不到账号：${name}`)
  const v2Root = join(DATA_DIR, 'v2')
  const root = accountRoot(v2Root, u.id)
  if (!existsSync(root)) return console.log(`${u.name} 还没有 v2 数据目录`)
  const report = auditAccount(v2Root, u.id)
  console.log(`\n=== ${u.name}（${u.id}）数据审计（只读）===`)
  console.log(`索引：${report.index.status}${report.index.blockedByPending ? '（被 purge-pending 阻断）' : ''}`)
  console.log(`世代：${report.epoch.present ? `存在（${report.epoch.value}）` : '缺失（按历史初始世代 1）'}`)
  console.log(`账号锁：${report.accountLock.present ? `残留 pid=${report.accountLock.pid ?? '?'} host=${report.accountLock.host || '?'} 存活=${report.accountLock.holderAlive}` : '无'}`)
  console.log(`隔离区：${report.purgePending.length} 项；项目：${report.projects.length} 个`)
  if (!report.findings.length) { console.log('未发现不一致。'); return }
  console.log(`\n发现 ${report.findings.length} 项：`)
  for (const f of report.findings) {
    console.log(`  [${f.severity}] ${f.kind}${f.pid ? ` pid=${f.pid}` : ''}：${f.detail}`)
  }
  const plan = report.findings.filter((f) => f.recoverable)
  if (plan.length) {
    console.log('\n可恢复动作（recover 命令预览/执行）：')
    for (const f of plan) console.log(`  ${f.recoverable}${f.pid ? `:${f.pid}` : ''}`)
  }
  console.log('\n这只是只读审计，不会修改任何数据。')
}

/**
 * 3.5.3 · P0 受控恢复。默认只预览；--apply 执行安全动作；破坏性/重建动作须 --action 显式选择。
 *   node admin.mjs recover <用户名>                       预览
 *   node admin.mjs recover <用户名> --apply               执行安全动作（修复落后条目、移回隔离目录）
 *   node admin.mjs recover <用户名> --apply --action remove-pending:<pid>   显式执行破坏性动作
 */
function cmdRecover(name) {
  const u = findByName(name)
  if (!u) return console.error(`找不到账号：${name}`)
  const v2Root = join(DATA_DIR, 'v2')
  const root = accountRoot(v2Root, u.id)
  if (!existsSync(root)) return console.log(`${u.name} 还没有 v2 数据目录`)
  const apply = process.argv.includes('--apply')
  const actions = []
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--action' && process.argv[i + 1]) {
      const [kind, pid] = process.argv[i + 1].split(':')
      actions.push({ kind, pid: pid || undefined })
    }
  }
  const r = recoverAccount({ v2Root, accountId: u.id, apply, actions })
  console.log(`\n=== ${u.name}（${u.id}）受控恢复${apply ? '' : '（预览，未写入）'} ===`)
  if (!r.plan.length) { console.log('没有可恢复的动作。'); return }
  console.log('计划动作：')
  for (const a of r.plan) console.log(`  ${a.kind}${a.pid ? `:${a.pid}` : ''}${a.safe ? '（安全）' : '（需显式 --action）'}`)
  if (!apply) {
    console.log('\n这只是预览。加 --apply 执行安全动作；破坏性/重建动作另加 --action <种类>[:<pid>]。')
    return
  }
  console.log('\n执行结果：')
  for (const res of r.results) console.log(`  ${res.ok ? '✓' : '✗'} ${res.kind}${res.pid ? `:${res.pid}` : ''}：${res.detail}`)
  if (r.journalFile) console.log(`\n留痕：${r.journalFile}（改索引前已备份到 recovery-backups/）`)
}

/**
 * 3.5.0 · 云同步资格与社区角色。
 * 🔴 这是「注册与同步资格分离」的运营入口：账号能登录、能投稿是默认能力，
 *    能不能同步作品由这里单独决定；角色决定能不能进审核工作台。
 */
function cmdSync(name, action) {
  const u = findByName(name)
  if (!u) return console.error(`找不到账号：${name}`)
  const mode = String(action || '').toLowerCase()
  if (!['on', 'off'].includes(mode)) return console.error('用法：node admin.mjs sync <用户名> on|off')
  const r = setUserFlag(u.id, 'cloudSync', mode === 'on')
  if (!r.ok) return console.error(r.error)
  console.log(`已${mode === 'on' ? '开通' : '停用'} ${u.name} 的云端同步资格`)
}

/**
 * 资格盘点（只读）。
 * 🔴 「缺字段 = 已授予」是迁移口径，不是数据现状：这里把三种来源分开数出来，
 *    运营才能判断要不要收紧、以及收紧会影响多少人；不在命令里做任何写入。
 */
function cmdSyncAudit() {
  const users = listUsers()
  const legacy = users.filter((u) => u.cloudSync === undefined)
  const granted = users.filter((u) => u.cloudSync === true)
  const denied = users.filter((u) => u.cloudSync === false)
  console.log(`账号总数 ${users.length}`)
  console.log(`· 缺字段（升级前注册，按已授予处理）${legacy.length}`)
  console.log(`· 显式授予 ${granted.length}`)
  console.log(`· 显式未授予（新注册默认）${denied.length}`)
  if (legacy.length) {
    console.log('\n缺字段账号（前 50）：')
    for (const u of legacy.slice(0, 50)) console.log(`  ${u.name}  ${u.id}  注册于 ${new Date(u.createdAt).toLocaleDateString()}`)
  }
  console.log('\n这只是盘点，不会修改任何账号；如需统一收紧，请逐个执行 sync <用户名> off。')
}

/** 签发一次性找回码（明文只打印一次；用户表只存哈希） */
function cmdRecovery(name) {
  const u = findByName(name)
  if (!u) return console.error(`找不到账号：${name}`)
  const r = issueRecoveryCode(u.id)
  if (!r.ok) return console.error(r.error)
  const status = recoveryStatus(u.id)
  console.log(`账号 ${u.name}（${u.id}）找回码：${r.code}`)
  console.log(`有效期至 ${new Date(r.expiresAt).toLocaleString()}（24 小时，只能使用一次，当前状态 ${status}）`)
  console.log('⚠️ 该码只在这里显示一次；请通过可信渠道交给本人，不要写入群聊或日志。')
}

function cmdRole(name, role) {
  const u = findByName(name)
  if (!u) return console.error(`找不到账号：${name}`)
  if (!role) {
    const db = loadUsers()
    console.log(`${u.name} 当前角色：${db.users[u.id].role || 'user'}`)
    return
  }
  const r = setUserFlag(u.id, 'role', role)
  if (!r.ok) return console.error(r.error)
  console.log(`已把 ${u.name} 的角色设为 ${role}（user / moderator / admin）`)
}

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
  case 'gc': cmdGc(a1); break
  case 'audit': cmdAudit(a1); break
  case 'recover': cmdRecover(a1); break
case 'sync': cmdSync(a1, a2); break
  case 'sync-audit': cmdSyncAudit(); break
  case 'recovery': cmdRecovery(a1); break
  case 'role': cmdRole(a1, a2); break
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
  node admin.mjs gate <用户名> [on|off] [备注]  旧路径门禁：迁移完成后停用旧版写入（不填动作=查状态）
  node admin.mjs sync <用户名> on|off      开通/停用云端作品同步资格（与能否参与社区无关）
  node admin.mjs sync-audit               只读盘点同步资格来源（缺字段/已授予/未授予）
  node admin.mjs recovery <用户名>         签发一次性找回码（人工核实后使用；明文只显示一次）
  node admin.mjs role <用户名> [角色]      查看或设置社区角色（user / moderator / admin）
  node admin.mjs gc <用户名> [--apply] [--purge-trash]  回收无人引用的对象 / 清理过期回收站（默认预演）
  node admin.mjs audit <用户名>           只读审计索引/状态/隔离区/账号锁的不一致（不写数据）
  node admin.mjs recover <用户名> [--apply] [--action <种类>[:<pid>]]  受控恢复（默认预览；破坏性动作须显式 --action）`)
}
