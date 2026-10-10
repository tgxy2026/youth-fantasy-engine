// 3.0 · W3-2 · §11.1 L3 —— 同步文件路径闸 + **真机桌面（node）路径**覆盖
//
// 背景（§11.1 L3 原文）：`.corrupt` 备份此前只修了路径校验、**没有补测试**。
// `syncTransport.test.ts` 用的是 FSA 句柄（浏览器分支），**根本不经 `main.cjs` 的
// `assertSyncPath`** —— 真机桌面走的是 IPC 桥 → 主进程 fs 那条路，一直没被覆盖。
//
// 本文件补两条：
//   ① **源码闸**：路径闸抽成 `electron/syncPath.cjs` 且 main.cjs require 它（规则只有一处）；
//      quarantine 的 `.corrupt-` 派生名确实落在放行集内。
//   ② **行为用例**：注入 `window.electronStore` 桩（模拟主进程 IPC），用**字符串目录句柄**
//      走 `nodeRead`/`nodeWrite` 分支 —— 验证正常写盘、以及损坏隔离都以
//      「绝对路径 + .yfe(.派生名)」落盘，且原文件不被覆盖。
import fs from 'node:fs'
import { createFileTransport, type ElectronStoreBridge } from '../src/lib/syncTransport'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (rel: string): string => {
  try { return fs.readFileSync(rel, 'utf8') } catch { return '' }
}

console.log('\n—— syncPath 用例开始 ——')

// ---------- ① 源码闸：规则抽成模块、main.cjs 用它、与 quarantine 命名对得上 ----------
{
  const guard = read('electron/syncPath.cjs')
  const main = read('electron/main.cjs')
  const transport = read('src/lib/syncTransport.ts')

  ok('① electron/syncPath.cjs 存在且导出 assertSyncPath',
    /\bfunction assertSyncPath\b/.test(guard) && /module\.exports\s*=\s*\{\s*assertSyncPath\s*\}/.test(guard))
  ok('① 规则含「绝对路径 + .yfe（或派生名 .yfe.*）」',
    /path\.isAbsolute\(s\)/.test(guard) && /\\\.yfe\(\\\.\[\\w\.\-\]\+\)\?\$/i.test(guard))
  ok('① main.cjs 顶部 require 该模块（规则只有一处）',
    /require\('\.\/syncPath\.cjs'\)/.test(main))
  ok('① main.cjs 不再内联定义 assertSyncPath（防两处规则漂移）',
    !/const assertSyncPath = \(p\) =>/.test(main))
  ok('① main.cjs 仍在两处 IPC 上用 assertSyncPath',
    (main.match(/assertSyncPath\(/g) || []).length >= 2)
  ok('① quarantine 写的是 `.corrupt-<时间戳>` 派生名（应落在放行集内）',
    /\.corrupt-\$\{Date\.now\(\)\}/.test(transport))
}

// ---------- ② 真机桌面（node）分支：注入 IPC 桩，用字符串目录句柄 ----------
{
  const DIR = 'C:/tmp/yfe-sync-node-test'
  const files = new Map<string, string>()
  const writes: { p: string; text: string }[] = []

  /** 复刻主进程行为：先过同步路径闸（同 electron/syncPath.cjs 的规则），再落盘 */
  const pathGuardOk = (p: string): boolean =>
    !!p && /^([A-Za-z]:[\\/]|\/)/.test(p) && /\.yfe(\.[\w.-]+)?$/i.test(p)

  const stub: ElectronStoreBridge = {
    async syncRead(p: string) {
      // ENOENT = 首次同步尚无文件 → 空库（与 main.cjs 的 sync:readFile 一致）
      if (!files.has(p)) return { ok: true, text: null }
      return { ok: true, text: files.get(p) }
    },
    async syncWrite(p: string, text: string) {
      if (!pathGuardOk(p)) return { ok: false, error: '同步文件路径非法' }
      writes.push({ p, text })
      files.set(p, text)
      return { ok: true, error: null }
    },
  }
  // 🔴 必须在本文件任何 transport 读写之前注入 —— getElectronBackend 有闭包内缓存
  ;(globalThis as unknown as { window?: { electronStore?: ElectronStoreBridge } }).window = { electronStore: stub }

  const t = createFileTransport(DIR, '青春幻想引擎-同步数据.yfe')
  t.setCode('K')

  // ②-1 空目录首推：写盘必须走 nodeWrite（IPC 桩），路径为「绝对路径 + .yfe」
  const pushOk = await t.push(0, 'PAYLOAD-1')
  ok('② 首推成功（200, rev=1）', pushOk.status === 200 && pushOk.rev === 1, JSON.stringify(pushOk))
  ok('② 走的是 IPC 写盘（nodeWrite 分支）', writes.length === 1, `writes=${writes.length}`)
  ok('② 写盘路径以 .yfe 结尾且过路径闸', writes[0]?.p.endsWith('.yfe') && pathGuardOk(writes[0]?.p ?? ''))

  // ②-2 把磁盘内容改成损坏 —— 模拟网盘客户端截断 / 半写
  const slot = writes[0].p
  files.set(slot, '{ 这不是合法 JSON')

  // ②-3 pull 必须 status 0（绝不当空库），且损坏内容另存 `.corrupt-*`（经 nodeWrite 落盘）
  const beforeWrites = writes.length
  const pullCorrupt = await t.pull()
  ok('② 损坏文件 pull → status 0（不是 rev=0 空库）', pullCorrupt.status === 0, JSON.stringify(pullCorrupt))
  const corruptWrites = writes.slice(beforeWrites)
  ok('② 损坏内容已另存 .corrupt 备份（经 nodeWrite）', corruptWrites.length === 1, `新增写=${corruptWrites.length}`)
  const cpath = corruptWrites[0]?.p ?? ''
  ok('🔴 .corrupt 派生名通过真机路径闸（L3 命门）', /\.yfe\.corrupt-\d+$/i.test(cpath) && pathGuardOk(cpath), cpath)
  ok('② 备份内容与原损坏内容一致（原样留证据）', corruptWrites[0]?.text === '{ 这不是合法 JSON')

  // ②-4 原文件不得被覆盖 —— quarantine 只写备份
  ok('🔴 原同步文件未被覆盖（仍是那份损坏内容）', files.get(slot) === '{ 这不是合法 JSON')

  // ②-5 push 遇损坏也必须拒绝写（不覆盖云端）
  const pushCorrupt = await t.push(1, 'PAYLOAD-2')
  ok('② 损坏时 push → status 0（拒绝覆盖）', pushCorrupt.status === 0, JSON.stringify(pushCorrupt))
  ok('② 且没有新的写盘发生', writes.length - beforeWrites - 1 === 0, `后续写=${writes.length - beforeWrites - 1}`)

  // ②-6 重复 pull 只隔离一次（不把目录塞满）
  await t.pull()
  await t.pull()
  const corruptCount = writes.filter(w => /\.corrupt-/.test(w.p)).length
  ok('② 重复 pull 只产生一份 .corrupt 备份', corruptCount === 1, `实际=${corruptCount}`)
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
