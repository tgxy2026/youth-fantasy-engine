// ============ 一次性找回码（3.5.0 · 无邀请码账号的找回路径） ============
//
// 守四件事：
//   ① 明文码**不落盘**（users 表只存 sha256）；
//   ② 只能用一次、24 小时过期；
//   ③ 用户名不存在与码不对返回**同一句**错误（防账号枚举）；
//   ④ 重置成功即撤销全部会话（与邀请码路径一致）。
//
// ?? 这是模块级单测：用临时 YFE_DATA 目录真实读写用户表，不启 HTTP 服务。
//    真实部署下的限流/页面流程仍属未验收。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let pass = 0
function ok(name: string, cond: boolean) {
  assert.ok(cond, name)
  pass++
  console.log('PASS ' + name)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-recovery-'))
process.env.YFE_DATA = root
process.env.YFE_WWW = root

// 动态导入（路径为变量）：让 Node 原生加载服务端的 .mjs，而不是被测试打包器内联；
// 这样 config.mjs 会在**设置了 YFE_DATA 之后**求值。
const mod = await import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), 'server/lib/users.mjs')).href)
const users = mod as {
  loadUsers(): unknown
  createUser(input: { id: string; name: string; passwordHash: string }): { id: string }
  issueRecoveryCode(id: string): { ok: boolean; code?: string; expiresAt?: number }
  recoveryStatus(id: string, now?: number): string
  resetPasswordByRecoveryCode(name: string, code: string, hash: string, now?: number): { ok: boolean; error?: string }
  resetPasswordByInvite(name: string, code: string, hash: string): { ok: boolean; error?: string }
}

try {
  users.loadUsers()
  users.createUser({ id: 'u_rc_1', name: 'alice', passwordHash: 'scrypt$seed' })

  const issued = users.issueRecoveryCode('u_rc_1')
  ok('可签发找回码且带有效期', issued.ok && !!issued.code && (issued.expiresAt || 0) > Date.now())
  const code = String(issued.code)
  ok('签发后状态为 active', users.recoveryStatus('u_rc_1') === 'active')

  const onDisk = fs.readFileSync(path.join(root, 'users.json'), 'utf8')
  ok('明文码不写入用户表（只存哈希）', !onDisk.includes(code))
  ok('用户表记录的是 sha256 哈希', /"hash":\s*"[0-9a-f]{64}"/.test(onDisk))

  const wrong = users.resetPasswordByRecoveryCode('alice', 'RC-0000000000', 'scrypt$new')
  ok('错误找回码被拒', !wrong.ok)
  const noUser = users.resetPasswordByRecoveryCode('nobody', code, 'scrypt$new')
  ok('用户名不存在与码错误返回同一句错误', !noUser.ok && noUser.error === wrong.error)

  const good = users.resetPasswordByRecoveryCode('alice', code, 'scrypt$new')
  ok('正确找回码重置成功', good.ok)
  ok('使用后状态变为 used', users.recoveryStatus('u_rc_1') === 'used')
  const reuse = users.resetPasswordByRecoveryCode('alice', code, 'scrypt$other')
  ok('同一找回码不能重复使用', !reuse.ok)

  const second = users.issueRecoveryCode('u_rc_1')
  ok('可重新签发', second.ok)
  const future = Date.now() + 25 * 3600 * 1000
  const expired = users.resetPasswordByRecoveryCode('alice', String(second.code), 'scrypt$x', future)
  ok('超过 24 小时即失效', !expired.ok && users.recoveryStatus('u_rc_1', future) === 'expired')

  ok('邀请码路径仍保留（老用户不受影响）', typeof users.resetPasswordByInvite === 'function')

  console.log(`communityRecovery: ${pass} passed, 0 failed`)
} finally {
  const target = fs.realpathSync(root)
  if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('yfe-recovery-')) {
    throw new Error('拒绝清理不安全的测试目录')
  }
  fs.rmSync(target, { recursive: true, force: true })
}