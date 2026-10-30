// 3.3.2 · P2 遗留自检：对象回收 + 回收站清理 + 配额去重
//
// 盯五件事：
//   ① 宽限期内的"孤儿"对象**不能删**（那是正在上传、还没提交的对象）；
//   ② 历史版本引用的对象**不能删**（否则历史版本变砖）；
//   ③ 回收站没到期不清（墓碑 30 天是协议承诺）；
//   ④ 配额按对象哈希去重（两本书共用一张封面不该算两份）；
//   ⑤ 已删除项目不计配额（用户不该为看不见的东西付费）。
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  gcObjects, collectReferenced, purgeDeletedProjects, listTrash,
  GC_GRACE_MS, TRASH_TTL_MS,
} from '../../server/lib/objectGc.mjs'
import {
  readIndex, writeIndex, accountUsedBytes, projectedUsedBytes, projectBytes, setProjectMeta,
} from '../../server/lib/v2Index.mjs'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ` :: ${extra}` : ''}`) }
}

const T0 = 1_700_000_000_000
/** 合法的对象哈希（必须是 64 位十六进制，否则会被当成非对象文件跳过） */
const H = (s) => createHash('sha256').update(String(s)).digest('hex')

/**
 * 造一个「账号根」。
 * 🔴 `objectGc` 收的是账号根（`<v2Root>/accounts/<acc>`），`v2Index` 收的是
 *    v2Root + accountId —— 两者必须指向同一个目录，第一次写这个自检时就混过一次。
 */
function fresh() {
  const v2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gc332-'))
  const root = path.join(v2, 'accounts', 'acc')
  fs.mkdirSync(path.join(root, 'objects'), { recursive: true })
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true })
  return { v2, root }
}

/** 造一个对象文件；mtime 可控 */
function putObject(root, hash, size = 100, mtimeMs = T0) {
  const f = path.join(root, 'objects', hash)
  fs.writeFileSync(f, Buffer.alloc(size, 1))
  const t = new Date(mtimeMs)
  fs.utimesSync(f, t, t)
  return f
}

/** 造一个项目的 manifest */
function putManifest(root, pid, rev, hashes, extra = {}) {
  const dir = path.join(root, 'projects', pid, 'manifests')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${rev}.json`), JSON.stringify({
    protocol: 1, createdAt: T0, project: { name: pid }, counts: {},
    objects: hashes.map((h) => ({ kind: 'chapters', hash: h, bytes: 100, records: 1 })),
    assets: [], tombstones: [], ...extra,
  }))
}

function main() {
  // ---------- 1. 引用收集 ----------
  {
    const { root } = fresh()
    putManifest(root, 'p1', 1, [H('a'), H('b')])
    putManifest(root, 'p1', 2, [H('b'), H('c')])
    const refs = collectReferenced(root)
    ok('收集到所有版本的引用', refs.size === 3 && refs.has(H('a')) && refs.has(H('c')), [...refs].length)
  }

  // ---------- 2. 回收：三种对象 ----------
  {
    const { root } = fresh()
    putManifest(root, 'p1', 1, [H('a')])
    putObject(root, H('a'), 100, T0 - GC_GRACE_MS * 2)        // 被引用 → 留
    putObject(root, H('b'), 200, T0 - GC_GRACE_MS * 2)        // 孤儿且老 → 删
    putObject(root, H('c'), 300, T0 - 1000)                   // 孤儿但新（正在上传）→ 留

    const r = gcObjects(root, { now: T0 })
    ok('只删掉「没人引用且超宽限期」的对象', r.removed === 1 && r.freedBytes === 200, JSON.stringify(r))
    // 🔴 这条是整套回收的安全阀
    ok('宽限期内的孤儿不删（正在上传的对象）', fs.existsSync(path.join(root, 'objects', H('c'))))
    ok('被引用的对象不删', fs.existsSync(path.join(root, 'objects', H('a'))))
    ok('被删的对象确实没了', !fs.existsSync(path.join(root, 'objects', H('b'))))
  }

  // ---------- 3. 历史版本引用要保护 ----------
  {
    const { root } = fresh()
    putManifest(root, 'p1', 1, [H('old')])
    putManifest(root, 'p1', 2, [H('new')])
    putObject(root, H('old'), 50, T0 - GC_GRACE_MS * 2)
    putObject(root, H('new'), 50, T0 - GC_GRACE_MS * 2)
    const r = gcObjects(root, { now: T0 })
    ok('历史版本引用的对象不删（否则历史变砖）', r.removed === 0
      && fs.existsSync(path.join(root, 'objects', H('old'))), JSON.stringify(r))
  }

  // ---------- 4. dryRun ----------
  {
    const { root } = fresh()
    putObject(root, H('x'), 400, T0 - GC_GRACE_MS * 2)
    const r = gcObjects(root, { now: T0, dryRun: true })
    ok('dryRun 报告会删多少但不真删', r.removed === 1 && r.freedBytes === 400
      && fs.existsSync(path.join(root, 'objects', H('x'))), JSON.stringify(r))
  }

  // ---------- 5. 回收站清理 ----------
  {
    const { v2, root } = fresh()
    putManifest(root, 'dead', 1, [H('d')])
    putObject(root, H('d'), 100, T0 - TRASH_TTL_MS * 2)
    writeIndex(v2, 'acc', {
      projects: {
        dead: { name: '过期', revision: 1, objectBytes: 100, objects: [{ hash: H('d'), bytes: 100 }], deletedAt: T0 - TRASH_TTL_MS - 1 },
        fresh: { name: '还没到期', revision: 1, objectBytes: 50, objects: [{ hash: H('e'), bytes: 50 }], deletedAt: T0 - 1000 },
        live: { name: '活着', revision: 1, objectBytes: 10, objects: [{ hash: H('f'), bytes: 10 }] },
      },
    })
    const before = listTrash(root, T0)
    ok('回收站列表只列已删除的', before.length === 2, String(before.length))

    const r = purgeDeletedProjects(root, { now: T0 })
    ok('过期项目被清掉', r.purged.length === 1 && r.purged[0] === 'dead', JSON.stringify(r))
    ok('未到期的留着', r.kept === 1, String(r.kept))
    ok('项目目录真的删了', !fs.existsSync(path.join(root, 'projects', 'dead')))
    ok('索引里也移除了', readIndex(v2, 'acc').projects.dead === undefined)
    ok('活着的项目不受影响', readIndex(v2, 'acc').projects.live !== undefined)
    // 🔴 清项目不动对象：对象可能被别的项目引用
    ok('清理回收站不删对象文件（交给 GC）', fs.existsSync(path.join(root, 'objects', H('d'))))
  }

  // ---------- 6. 回收站 dryRun ----------
  {
    const { v2, root } = fresh()
    writeIndex(v2, 'acc', {
      projects: { dead: { deletedAt: T0 - TRASH_TTL_MS - 1, objects: [] } },
    })
    const r = purgeDeletedProjects(root, { now: T0, dryRun: true })
    ok('dryRun 只报告不删', r.purged.length === 1 && readIndex(v2, 'acc').projects.dead !== undefined)
  }

  // ---------- 7. 配额：跨项目共享对象只算一次 ----------
  {
    const { v2 } = fresh()
    writeIndex(v2, 'acc', {
      projects: {
        p1: { objects: [{ hash: H('share'), bytes: 1000 }, { hash: H('only1'), bytes: 100 }] },
        p2: { objects: [{ hash: H('share'), bytes: 1000 }] },
      },
    })
    const idx = readIndex(v2, 'acc')
    // 🔴 老实现会把 share 的 1000 算两遍
    ok('共享对象只算一次', accountUsedBytes(idx) === 1100, String(accountUsedBytes(idx)))
    ok('单项目总量仍按自己看到的算', projectBytes(idx, 'p1') === 0)  // 没有 objectBytes 字段时为 0
  }

  // ---------- 8. 已删除项目不计配额 ----------
  {
    const { v2 } = fresh()
    writeIndex(v2, 'acc', {
      projects: {
        live: { objects: [{ hash: H('l'), bytes: 500 }] },
        trash: { objects: [{ hash: H('t'), bytes: 900 }], deletedAt: T0 },
      },
    })
    ok('回收站项目不计配额', accountUsedBytes(readIndex(v2, 'acc')) === 500)
  }

  // ---------- 9. 提交前预算：不能把共享对象减两次 ----------
  {
    const { v2 } = fresh()
    writeIndex(v2, 'acc', {
      projects: {
        p1: { objects: [{ hash: H('share'), bytes: 1000 }] },
        p2: { objects: [{ hash: H('x'), bytes: 200 }] },
      },
    })
    const idx = readIndex(v2, 'acc')
    // p1 换成只剩 share（不变）→ 总量还是 1200
    ok('预算：同内容不虚增', projectedUsedBytes(idx, 'p1', [{ hash: H('share'), bytes: 1000 }]) === 1200)
    // p1 换成全新对象 → 只剩 p2 的 200 + 新对象 300 = 500
    // （`objects` 是「本项目这一版的全部引用」，不是增量）
    ok('预算：替换后按新清单算', projectedUsedBytes(idx, 'p1', [{ hash: H('z'), bytes: 300 }]) === 500,
      String(projectedUsedBytes(idx, 'p1', [{ hash: H('z'), bytes: 300 }])))
    // 🔴 老写法「已用 - 本项目 + 新增」= 1200 - 1000 + 1000 = 1200 也对；
    //    但 p1 与 p2 共享时：已用 1200（去重后），减 p1 的 1000 会多减
    writeIndex(v2, 'acc', {
      projects: {
        p1: { objects: [{ hash: H('share'), bytes: 1000 }] },
        p2: { objects: [{ hash: H('share'), bytes: 1000 }, { hash: H('y'), bytes: 100 }] },
      },
    })
    const idx2 = readIndex(v2, 'acc')
    ok('两项目共享时新写法正确（1100）', projectedUsedBytes(idx2, 'p1', [{ hash: H('share'), bytes: 1000 }]) === 1100,
      String(projectedUsedBytes(idx2, 'p1', [{ hash: H('share'), bytes: 1000 }])))
  }

  // ---------- 10. 老索引（无 objects 字段）不能被静默当 0 ----------
  {
    const { v2 } = fresh()
    writeIndex(v2, 'acc', {
      projects: { legacy: { objectBytes: 777 } },
    })
    ok('老记录按 objectBytes 计入配额（否则配额突然放宽）', accountUsedBytes(readIndex(v2, 'acc')) === 777)
  }

  // ---------- 11. 索引写入合并字段 ----------
  {
    const { v2 } = fresh()
    setProjectMeta(v2, 'acc', 'p1', { name: '甲', revision: 1 })
    setProjectMeta(v2, 'acc', 'p1', { revision: 2 })
    const p = readIndex(v2, 'acc').projects.p1
    ok('更新索引是合并而非整体替换', p.name === '甲' && p.revision === 2, JSON.stringify(p))
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'} ${pass}/${pass + fail}（${new Date().toISOString()}，Node ${process.version}）`)
  if (fail) process.exit(1)
}

main()
