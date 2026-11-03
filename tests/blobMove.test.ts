// 3.2.2 · 审计 C2 —— 换数据位置时「资料集」搬迁内核（electron/blobMove.cjs）
//
// 背景：`store:setDataPath` 原先只搬主 JSON，外置目录（`<数据文件目录>/blobs`）留在旧位置
// ⇒ 换完位置后「备份列表还在、点恢复说载荷缺失」。审计实测就是这个症状。
//
// 本文件用**真实临时目录**验四件事（不 mock fs —— 这条路径的价值全在真实文件系统行为上）：
//   ① 没有外置数据 ⇒ 什么都不做，不能报错（全新库/从未备份的用户不该被卡住）
//   ② 有外置数据（含子目录）⇒ 全部复制、内容逐字节一致、回报份数
//   ③ 源目录不可读 ⇒ `ok:false`（调用方据此**不切配置**，原位置保持可用）
//   ④ 复制中途失败（目标位置被同名目录占位）⇒ `ok:false`，不允许"部分成功"
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

/**
 * 🔴 为什么要绕这一下：
 *    `electron/blobMove.cjs` 是 **CJS**（主进程要 `require` 它），而测试被打包成 ESM。
 *    直接 `import { copyBlobsAlong } from '../electron/blobMove.cjs'` 时 esbuild 会把它
 *    内联进 ESM 产物，于是它内部的 `require('path')` 变成
 *    `Dynamic require of "path" is not supported`（实测踩过）。
 *    ⇒ 用**运行期** `createRequire` 加载真实 CJS 文件；路径用数组拼，避免被 esbuild 静态解析。
 */
const nodeRequire = createRequire(import.meta.url)
const blobMovePath = ['..', 'electron', 'blobMove.cjs'].join(path.sep)
const { copyBlobsAlong } = nodeRequire(blobMovePath) as {
  copyBlobsAlong: (oldFile: string, newFile: string) => Promise<{ ok: boolean; copied: number; error: string | null }>
}

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-blobmove-'))
/** 造一个「数据文件 + blobs 目录」的资料集 */
function mkSet(name: string, files: Record<string, string>): { dir: string; file: string } {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'youth-fantasy-engine-data.json')
  fs.writeFileSync(file, '{"kind":"portable-data"}', 'utf8')
  if (files && Object.keys(files).length) {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(dir, 'blobs', rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body, 'utf8')
    }
  }
  return { dir, file }
}

// ---------- ① 没有外置数据 ----------
{
  const a = mkSet('empty-src', {})
  const b = mkSet('empty-dst', {})
  const r = await copyBlobsAlong(a.file, path.join(b.dir, 'youth-fantasy-engine-data.json'))
  ok('① 无 blobs ⇒ ok:true', r.ok === true, JSON.stringify(r))
  ok('① 无 blobs ⇒ copied = 0', r.copied === 0, String(r.copied))
  ok('① 无 blobs ⇒ error 为 null', r.error === null)
}

// ---------- ② 有外置数据：全部复制且内容一致 ----------
{
  const files = {
    'backupPayloads/b1.json': '{"id":"b1","kind":"text"}',
    'backupPayloads/b2.json': '{"id":"b2","kind":"text"}',
    'vecRows/__all__.json': '[{"id":"v1"}]',
  }
  const a = mkSet('full-src', files)
  const b = mkSet('full-dst', {})
  const r = await copyBlobsAlong(a.file, path.join(b.dir, 'youth-fantasy-engine-data.json'))
  ok('② 复制成功', r.ok === true, JSON.stringify(r))
  ok('② 回报份数 = 源文件数', r.copied === 3, String(r.copied))
  let same = true
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(b.dir, 'blobs', rel)
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== body) same = false
  }
  ok('🔴 ② 每一份内容逐字节一致（含子目录层级）', same)
  // 源目录必须**原样保留**（迁移不是剪切；旧位置仍可用）
  ok('② 源目录不被删除', fs.existsSync(path.join(a.dir, 'blobs', 'backupPayloads', 'b1.json')))
}

// ---------- ③ 源 blobs 不是目录 ⇒ 失败而不是静默跳过 ----------
{
  const a = mkSet('bad-src', {})
  // 把 blobs 造成一个**文件**：readdir 会抛 ENOTDIR
  fs.writeFileSync(path.join(a.dir, 'blobs'), 'not a dir', 'utf8')
  const b = mkSet('bad-dst', {})
  const r = await copyBlobsAlong(a.file, path.join(b.dir, 'youth-fantasy-engine-data.json'))
  ok('🔴 ③ 源不可读 ⇒ ok:false（调用方据此不切配置）', r.ok === false, JSON.stringify(r))
  ok('③ 失败时带可读原因', typeof r.error === 'string' && r.error.length > 0, String(r.error))
  ok('③ 失败时 copied = 0（不许"部分成功"）', r.copied === 0, String(r.copied))
}

// ---------- ④ 复制中途失败（目标被同名目录占位）----------
{
  const a = mkSet('conflict-src', { 'backupPayloads/b1.json': '{"id":"b1"}' })
  const b = mkSet('conflict-dst', {})
  // 目标路径先放一个**目录**：copyFile 到它会失败（EISDIR/EPERM）
  fs.mkdirSync(path.join(b.dir, 'blobs', 'backupPayloads', 'b1.json'), { recursive: true })
  const r = await copyBlobsAlong(a.file, path.join(b.dir, 'youth-fantasy-engine-data.json'))
  ok('🔴 ④ 复制失败 ⇒ ok:false（绝不把截断当成搬完）', r.ok === false, JSON.stringify(r))
  ok('④ 失败时带可读原因', typeof r.error === 'string' && r.error.length > 0, String(r.error))
}

// ---------- ⑤ 同一目录（默认位置"迁移"到自身）----------
{
  const a = mkSet('same-dir', { 'backupPayloads/x.json': '{"id":"x"}' })
  const r = await copyBlobsAlong(a.file, a.file)
  ok('⑤ 同目录 ⇒ 直接成功、copied = 0（不做无谓复制）', r.ok === true && r.copied === 0, JSON.stringify(r))
}

// ---------- ⑥ 源码闸：main.cjs 必须复用该内核，不许再内联一份 ----------
{
  const mainSrc = fs.readFileSync('electron/main.cjs', 'utf8')
  ok('⑥ main.cjs 引入了 blobMove.cjs', /require\('\.\/blobMove\.cjs'\)/.test(mainSrc))
  ok('⑥ 🔴 main.cjs 不再内联 walk 复制实现（规则只许一处）',
    !/await fsp\.copyFile\(from, to\)/.test(mainSrc))
  ok('⑥ 迁移失败时不写位置配置（切配置一定在搬运之后）',
    /if \(!moved\.ok\)[\s\S]{0,400}return/.test(mainSrc))
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }

console.log(`\nblobMove: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
