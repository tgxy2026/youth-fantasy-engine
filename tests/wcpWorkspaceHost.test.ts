// ============ 3.7.4 · W2 Electron 工作区宿主（node 直测，不启动 Electron） ============
//
// 盯六件事：
//   ① 默认根 = 数据文件同级 `wcp-workspaces/`；
//   ② 路径穿越（`../` / 绝对路径 / 跨盘）一律拒绝；
//   ③ 原子写：temp + rename，无残留 .tmp；outbox 自动建立；
//   ④ 过期清理只删托管只读文件，**outbox/ 永不受影响**；
//   ⑤ 收件箱扫描按同名配对；读取只允许 outbox 内的 .wcp.json / .md；
//   ⑥ 成对归档到 outbox/imported/，重名自动追加序号，绝不覆盖。
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface OutboxEntry { base: string; jsonName: string; mdName: string; size: number; mtimeMs: number }
interface ApplyResult { ok: boolean; error: string; written: number; deleted: number; errors: string[] }
interface HostApi {
  defaultWorkspaceRoot(dataFile: string): string
  isInsideInstallDir(target: string, installDirs: string[]): boolean
  resolveInside(root: string, rel: string): string | null
  isManagedReadonly(rel: string): boolean
  diagnoseRoot(root: string, installDirs?: string[]): Promise<{ ok: boolean; writable: boolean; error: string }>
  applyPlan(payload: { root: string; folder: string; files: { path: string; content: string }[]; deletions: string[] }, installDirs?: string[]): Promise<ApplyResult>
  scanOutbox(payload: { root: string; folder: string }): Promise<{ ok: boolean; entries: OutboxEntry[] }>
  readOutboxFile(payload: { root: string; folder: string; name: string }): Promise<{ ok: boolean; text: string; error: string }>
  archiveOutbox(payload: { root: string; folder: string; jsonName?: string; mdName?: string }): Promise<{ ok: boolean; archived: string[]; error: string }>
}

const requireCjs = createRequire(import.meta.url)
const host = requireCjs('../electron/wcpWorkspace.cjs') as HostApi

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-wcp-ws-'))
const FOLDER = '吞天神脉-a1b2c3'

function folderAbs(): string { return path.join(ROOT, FOLDER) }

async function main() {
  // ---------- ① 默认根 ----------
  ok('默认根 = 数据文件同级 wcp-workspaces/',
    host.defaultWorkspaceRoot(path.join('D:\\data', 'youth-fantasy-engine-data.json'))
      === path.join('D:\\data', 'wcp-workspaces'))

  // ---------- ② 路径穿越 ----------
  ok('拒绝 ../ 穿越', host.resolveInside(ROOT, '../evil.txt') === null)
  ok('拒绝绝对路径', host.resolveInside(ROOT, 'C:\\Windows\\evil.txt') === null)
  ok('拒绝中间 .. 段', host.resolveInside(ROOT, 'a/../../evil.txt') === null)
  ok('接受普通相对路径', host.resolveInside(ROOT, '01-base/01-overview.md') !== null)
  ok('outbox 不是托管只读区', !host.isManagedReadonly('outbox/agent.wcp.json'))
  ok('manifest / 只读目录属于托管区',
    host.isManagedReadonly('manifest.json') && host.isManagedReadonly('04-chapters/vol-01/ch-001.md'))

  // ---------- ③ 原子增量写 ----------
  fs.mkdirSync(path.join(folderAbs(), '01-base'), { recursive: true })
  fs.writeFileSync(path.join(folderAbs(), '01-base', 'old.md'), '旧文件', 'utf-8')
  const applied = await host.applyPlan({
    root: ROOT,
    folder: FOLDER,
    files: [
      { path: 'AGENTS.md', content: 'agent' },
      { path: 'manifest.json', content: '{}' },
      { path: '01-base/01-overview.md', content: '概览' },
    ],
    deletions: ['01-base/old.md'],
  })
  ok('原子写成功', applied.ok && applied.written === 3 && applied.deleted === 1, applied.error)
  ok('写入内容可读回',
    fs.readFileSync(path.join(folderAbs(), 'AGENTS.md'), 'utf-8') === 'agent'
    && fs.readFileSync(path.join(folderAbs(), '01-base/01-overview.md'), 'utf-8') === '概览')
  ok('过期只读文件已清理', !fs.existsSync(path.join(folderAbs(), '01-base/old.md')))
  ok('无残留 .tmp',
    !fs.readdirSync(folderAbs()).some(n => n.endsWith('.tmp'))
    && !fs.readdirSync(path.join(folderAbs(), '01-base')).some(n => n.endsWith('.tmp')))
  ok('outbox/ 自动建立', fs.existsSync(path.join(folderAbs(), 'outbox')))

  // ---------- ④ outbox 免删 / 越界写入拦截 ----------
  const keep = path.join(folderAbs(), 'outbox', 'keep.md')
  fs.writeFileSync(keep, 'keep', 'utf-8')
  const protectedRun = await host.applyPlan({
    root: ROOT,
    folder: FOLDER,
    files: [{ path: 'outbox/hack.md', content: 'x' }],
    deletions: ['outbox/keep.md'],
  })
  ok('outbox 文件不在写入白名单（拒绝）', protectedRun.errors.some(e => e.includes('outbox/hack.md')))
  ok('outbox 文件绝不会被清理', fs.existsSync(keep) && fs.readFileSync(keep, 'utf-8') === 'keep')
  ok('越界路径写入被拒绝',
    (await host.applyPlan({ root: ROOT, folder: FOLDER, files: [{ path: '../evil.md', content: 'x' }], deletions: [] }))
      .errors.some(e => e.includes('evil')))

  // ---------- ⑤ 收件箱扫描 / 读取 ----------
  fs.writeFileSync(path.join(folderAbs(), 'outbox', 'a.wcp.json'), '{"ok":1}', 'utf-8')
  fs.writeFileSync(path.join(folderAbs(), 'outbox', 'a.md'), '正文', 'utf-8')
  await new Promise(resolve => setTimeout(resolve, 30))
  fs.writeFileSync(path.join(folderAbs(), 'outbox', 'b.md'), '只有 md', 'utf-8')
  fs.writeFileSync(path.join(folderAbs(), 'outbox', 'ignore.txt'), 'x', 'utf-8')
  const scanned = await host.scanOutbox({ root: ROOT, folder: FOLDER })
  ok('扫描只收 .wcp.json / .md（a 配对 + b + 之前保留的 keep.md）', scanned.ok && scanned.entries.length === 3)
  const a = scanned.entries.find(e => e.base === 'a')
  ok('同名双文件自动配对', !!a && a.jsonName === 'a.wcp.json' && a.mdName === 'a.md')
  const b = scanned.entries.find(e => e.base === 'b')
  ok('只有 .md 也能列出', !!b && b.jsonName === '' && b.mdName === 'b.md')
  ok('扫描按时间倒序（后写的 b 在前）', scanned.entries[0].base === 'b')

  const readOk = await host.readOutboxFile({ root: ROOT, folder: FOLDER, name: 'a.wcp.json' })
  ok('读取 outbox 文件成功', readOk.ok && readOk.text === '{"ok":1}')
  ok('拒绝穿越型文件名',
    !(await host.readOutboxFile({ root: ROOT, folder: FOLDER, name: '../AGENTS.md' })).ok)
  ok('拒绝非 json/md 文件名',
    !(await host.readOutboxFile({ root: ROOT, folder: FOLDER, name: 'ignore.txt' })).ok)

  // ---------- ⑥ 成对归档 ----------
  const archived = await host.archiveOutbox({ root: ROOT, folder: FOLDER, jsonName: 'a.wcp.json', mdName: 'a.md' })
  ok('成对归档成功', archived.ok && archived.archived.length === 2, archived.error)
  ok('原件已移出 outbox',
    !fs.existsSync(path.join(folderAbs(), 'outbox', 'a.wcp.json'))
    && !fs.existsSync(path.join(folderAbs(), 'outbox', 'a.md')))
  ok('归档目录留有同名副本',
    fs.existsSync(path.join(folderAbs(), 'outbox', 'imported', 'a.wcp.json'))
    && fs.existsSync(path.join(folderAbs(), 'outbox', 'imported', 'a.md')))
  const afterScan = await host.scanOutbox({ root: ROOT, folder: FOLDER })
  ok('归档后收件箱只剩 b 与 keep.md', afterScan.entries.length === 2 && afterScan.entries.some(e => e.base === 'b'))

  fs.writeFileSync(path.join(folderAbs(), 'outbox', 'a.md'), '第二份', 'utf-8')
  const archived2 = await host.archiveOutbox({ root: ROOT, folder: FOLDER, mdName: 'a.md' })
  ok('再次归档不覆盖历史（自动加序号）',
    archived2.ok && fs.existsSync(path.join(folderAbs(), 'outbox', 'imported', 'a-2.md')))
  ok('找不到文件时如实报错',
    !(await host.archiveOutbox({ root: ROOT, folder: FOLDER, jsonName: 'missing.wcp.json' })).ok)

  // ---------- ⑦ 可写探活 ----------
  const diag = await host.diagnoseRoot(ROOT)
  ok('可写目录探活通过且不留探针文件', diag.ok && diag.writable
    && !fs.readdirSync(ROOT).some(n => n.startsWith('.wcp-write-probe')))

  // ---------- ⑧ 安装目录拦截（P3-7） ----------
  {
    const installRoot = ROOT
    const inside = path.join(ROOT, 'ProgramFilesLike', 'wcp-workspaces')
    ok('安装目录判定：自身及其子目录在范围内',
      host.isInsideInstallDir(installRoot, [installRoot]) && host.isInsideInstallDir(inside, [installRoot]))
    ok('安装目录判定：同前缀的兄弟目录不算',
      !host.isInsideInstallDir(path.join(ROOT + '-other', 'ws'), [installRoot]))
    ok('安装目录判定：空目录清单不拦截', !host.isInsideInstallDir(inside, []))
    const blockedDiag = await host.diagnoseRoot(inside, [installRoot])
    ok('可写探活直接拒绝安装目录并给中文提示',
      !blockedDiag.ok && !blockedDiag.writable && blockedDiag.error.includes('安装目录'))
    ok('拒绝时不会在安装目录下创建任何东西', !fs.existsSync(path.join(ROOT, 'ProgramFilesLike')))
    const blockedApply = await host.applyPlan({
      root: ROOT,
      folder: 'install-dir-workspace',
      files: [{ path: 'AGENTS.md', content: 'x' }],
      deletions: [],
    }, [installRoot])
    ok('增量写盘同样拒绝安装目录', !blockedApply.ok && blockedApply.error.includes('安装目录'))
    ok('拒绝后零写入', !fs.existsSync(path.join(ROOT, 'install-dir-workspace')))
  }

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`\nwcpWorkspaceHost: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exitCode = 1 })
