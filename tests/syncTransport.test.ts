// ============ 文件传输层（云盘中转）数据安全回归 ============
// 锁定 2026-09-14 审计 P0-2 的修复：**「读取失败 / 内容损坏」绝不能被当成「空库」**。
//
// 旧实现在这两条路径上都返回 rev=0，等于对外宣称「云端是空的」，随后一次 push 就会
// 用本地内容整体覆盖云端的真实快照。本文件把三态（不存在 / 正常 / 读不到或损坏）逐一固化，
// 任何人以后想把 parseRev 的 corrupt 分支改回 rev=0，都会在这里被拦下。
import { createFileTransport } from '../src/lib/sync/syncTransport'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

type Files = Record<string, string>

function notFound(): Error {
  const e = new Error('A requested file or directory could not be found')
  e.name = 'NotFoundError'
  return e
}
function notReadable(msg = 'The file is locked by another process'): Error {
  const e = new Error(msg)
  e.name = 'NotReadableError'
  return e
}

/**
 * 内存版 FSA 目录句柄：
 * - getFileHandle 未指定 create 且文件不存在 → 抛 NotFoundError（= 首次同步的正常情形）
 * - readError 置位时，getFile().text() 抛 NotReadableError（= 云盘客户端占用/权限被拒）
 * - 记录每次写入，便于断言「有没有被覆盖」
 */
function makeHandle(files: Files, opts: { readError?: boolean } = {}) {
  const writes: { name: string; text: string }[] = []
  const state = { readError: !!opts.readError }
  const handle = {
    async requestPermission() { return 'granted' },
    async getFileHandle(name: string, o?: { create?: boolean }) {
      if (!(name in files)) {
        if (o?.create) files[name] = ''
        else throw notFound()
      }
      return {
        async getFile() {
          return { async text() { if (state.readError) throw notReadable(); return files[name] } }
        },
        async createWritable() {
          return {
            async write(t: string) { files[name] = t; writes.push({ name, text: t }) },
            async close() { /* 模拟 swap 提交 */ },
          }
        },
      }
    },
  }
  return { handle, files, writes, state }
}

const SLOT = ['青春幻想引擎-同步数据.yfe']

// ---------- 1. 文件不存在 = 空库（这是唯一可安全视为空库的情形） ----------
{
  const { handle, writes } = makeHandle({})
  const t = createFileTransport(handle, SLOT[0])
  const r = await t.pull()
  ok('文件不存在时 pull 返回 200 且 rev=0（空库）', r.status === 200 && r.rev === 0, JSON.stringify(r))

  const p = await t.push(0, 'ENC-1')
  ok('空库上首次 push 成功并递增到 rev=1', p.status === 200 && p.rev === 1, JSON.stringify(p))
  ok('首次 push 确实写入了文件', writes.length === 1 && JSON.parse(writes[0].text).rev === 1)
}

// ---------- 2. 正常文件：rev 正确读出 ----------
{
  const { handle } = makeHandle({ [SLOT[0]]: JSON.stringify({ rev: 7, enc: 'ENC-7' }) })
  const t = createFileTransport(handle, SLOT[0])
  const r = await t.pull()
  ok('正常文件 pull 读出正确 rev 与载荷', r.status === 200 && r.rev === 7 && r.enc === 'ENC-7', JSON.stringify(r))
}

// ---------- 3. 【核心】内容损坏：pull 必须是 status 0，而不是 rev=0 ----------
{
  const { handle } = makeHandle({ [SLOT[0]]: '{ 这不是合法 JSON' })
  const t = createFileTransport(handle, SLOT[0])
  const r = await t.pull()
  ok('损坏文件 pull 返回 status 0（不可用），而非 200/rev=0', r.status === 0, JSON.stringify(r))
  ok('损坏文件 pull 不谎报空库 rev', r.rev !== 0, `rev=${r.rev}`)
}

// ---------- 4. 【核心】内容损坏：push 必须拒绝，且不得覆盖原文件 ----------
{
  const original = '{ 损坏但可能包含真实数据'
  const { handle, files, writes } = makeHandle({ [SLOT[0]]: original })
  const t = createFileTransport(handle, SLOT[0])
  const p = await t.push(0, 'ENC-LOCAL')
  ok('损坏文件上 push 返回 status 0（拒绝写入）', p.status === 0, JSON.stringify(p))
  ok('损坏文件原内容未被覆盖', files[SLOT[0]] === original, `实际=${JSON.stringify(files[SLOT[0]]).slice(0, 60)}`)
  ok('未向原槽位写入任何内容', writes.every(w => w.name !== SLOT[0]))

  const backedUp = Object.keys(files).filter(k => k.includes('.corrupt-'))
  ok('损坏文件已另存 .corrupt 备份（留证据供人工抢救）', backedUp.length === 1, `实际备份=${JSON.stringify(backedUp)}`)
  ok('备份内容与原损坏内容一致', backedUp.length === 1 && files[backedUp[0]] === original)
}

// ---------- 5. 【核心】读取失败（权限/占用）：push 拒绝，且不得覆盖 ----------
{
  const original = JSON.stringify({ rev: 9, enc: 'ENC-CLOUD' })
  const { handle, files, writes } = makeHandle({ [SLOT[0]]: original }, { readError: true })
  const t = createFileTransport(handle, SLOT[0])

  const r = await t.pull()
  ok('读取失败时 pull 返回 status 0（而非当成空库）', r.status === 0, JSON.stringify(r))

  const p = await t.push(0, 'ENC-LOCAL')
  ok('读取失败时 push 返回 status 0（拒绝盲写）', p.status === 0, JSON.stringify(p))
  ok('读取失败时未覆盖云端文件', files[SLOT[0]] === original && writes.length === 0)
}

// ---------- 6. 空文件 = 空库（写入被中断的残留，旧行为需保持） ----------
{
  const { handle } = makeHandle({ [SLOT[0]]: '   ' })
  const t = createFileTransport(handle, SLOT[0])
  const r = await t.pull()
  ok('空白文件仍视为空库（保持旧行为，避免误判损坏）', r.status === 200 && r.rev === 0, JSON.stringify(r))
}

// ---------- 7. 冲突：远端 rev 更高时返还 409 让上层合并 ----------
{
  const { handle } = makeHandle({ [SLOT[0]]: JSON.stringify({ rev: 5, enc: 'ENC-REMOTE' }) })
  const t = createFileTransport(handle, SLOT[0])
  const p = await t.push(3, 'ENC-LOCAL')
  ok('远端 rev 更新时 push 返还 409（交给上层合并，不覆盖）', p.status === 409 && p.rev === 5, JSON.stringify(p))
}

// ---------- 8. 损坏文件只隔离一次：轮询不应把目录塞满 ----------
{
  const { handle, files } = makeHandle({ [SLOT[0]]: 'BROKEN' })
  const t = createFileTransport(handle, SLOT[0])
  await t.pull()
  await t.pull()
  await t.pull()
  const backups = Object.keys(files).filter(k => k.includes('.corrupt-'))
  ok('重复 pull 只产生一份 .corrupt 备份', backups.length === 1, `实际=${backups.length} 份`)
}

console.log(`\nsyncTransport: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
