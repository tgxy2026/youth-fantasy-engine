/**
 * IndexedDB schema 迁移 · 单测（2026-10-06 补）
 *
 * 为什么补：`db/idbMigrations.ts`（253 行 / 11 段迁移）是**不可逆**的数据路径 ——
 * 写错或漏调一段，用户升级后表结构缺字段，症状是「某功能突然读不到数据」，
 * 而且**老用户才触发**（新装用户走 freshInstall，永远看不到问题）。长期零测试覆盖。
 *
 * 本文件测两类东西：
 *   ① **迁移链的元数据不变量**（编号连续 / DB_VERSION 对齐 / 每段都被 core.ts 调用）
 *      —— 这类「写了迁移却忘了接线」的漏洞，tsc 与运行时都不报，只有升级的老用户会遇到；
 *   ② **freshInstall 实际建了哪些 store 与索引**（用假 db 对象，零依赖）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { migrateFreshInstall } from '../src/lib/db/idbMigrations'

/** 假 db：只实现迁移真正用到的那一个方法（类型走推导，避免依赖未导出的 Vdb） */
type FakeDb = Parameters<typeof migrateFreshInstall>[0]

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const MIG_SRC = fs.readFileSync(path.join(process.cwd(), 'src/lib/db/idbMigrations.ts'), 'utf8')
const CORE_SRC = fs.readFileSync(path.join(process.cwd(), 'src/lib/db/core.ts'), 'utf8')

function main() {
  // ---------- 1) 迁移链编号必须连续（1→2, 2→3, … 不允许跳段） ----------
  {
    const segs = [...MIG_SRC.matchAll(/export\s+(?:async\s+)?function\s+migrateV(\d+)toV(\d+)\s*\(/g)]
      .map(m => [Number(m[1]), Number(m[2])] as [number, number])
      .sort((a, b) => a[0] - b[0])
    ok('1a 至少有一段迁移', segs.length > 0, String(segs.length))
    const bad = segs.filter(([a, b]) => b !== a + 1)
    ok('1b 每段的「从→到」都只进 1（无跳段）', bad.length === 0, JSON.stringify(bad))
    const gaps: string[] = []
    for (let i = 1; i < segs.length; i++) if (segs[i][0] !== segs[i - 1][1]) gaps.push(`${segs[i - 1][1]}→${segs[i][0]}`)
    ok('1c 相邻两段首尾相接（无缺口）', gaps.length === 0, gaps.join(','))
  }

  // ---------- 2) DB_VERSION 必须等于链尾 ----------
  {
    const ver = Number((CORE_SRC.match(/const\s+DB_VERSION\s*=\s*(\d+)/) || [])[1])
    const segs = [...MIG_SRC.matchAll(/migrateV(\d+)toV(\d+)\s*\(/g)].map(m => Number(m[2]))
    const maxVer = Math.max(...segs)
    ok('2a DB_VERSION 是数字', Number.isFinite(ver), String(ver))
    ok('2b DB_VERSION === 迁移链最高版本', ver === maxVer, `DB_VERSION=${ver} 链尾=${maxVer}`)
    ok('2c DB_VERSION ≥ 2（freshInstall 之后至少还有一段）', ver >= 2, String(ver))
  }

  // ---------- 3) 🔴 core.ts 必须调用每一段（漏接线 = 老用户升不上来） ----------
  {
    const segs = [...MIG_SRC.matchAll(/export\s+(?:async\s+)?function\s+(migrateV\d+toV\d+)\s*\(/g)].map(m => m[1])
    const notCalled = segs.filter(n => !new RegExp('\\b' + n + '\\s*\\(').test(CORE_SRC))
    ok('3a 每段迁移都被 core.ts 调用', notCalled.length === 0, notCalled.join(','))
    const imported = segs.filter(n => !CORE_SRC.includes(n))
    ok('3b 每段迁移都被 core.ts import', imported.length === 0, imported.join(','))
    ok('3c 全新安装走 migrateFreshInstall', /oldVersion\s*===\s*0[^\n]*migrateFreshInstall/.test(CORE_SRC))
    // 🔴 关键：判断必须写 `oldVersion < N` 而不是 `=== N` ——
    //    用 === 会让「从很老的版本一次升上来」跳过中间所有段（老用户专用 bug）
    const eqForm = [...CORE_SRC.matchAll(/oldVersion\s*===\s*(\d+)(?!\s*\))/g)].map(m => m[1])
    ok('3d 版本判断用 `<`（不是 `===`），否则跨版本升级会跳段', eqForm.length === 0, eqForm.join(','))
    // 顺序：段号在源码里必须递增出现（乱序 = 迁移依赖被破坏）
    const order = [...CORE_SRC.matchAll(/oldVersion\s*<\s*(\d+)/g)].map(m => Number(m[1]))
    const sorted = [...order].sort((a, b) => a - b)
    ok('3e 迁移调用顺序按版本递增', JSON.stringify(order) === JSON.stringify(sorted), order.join(','))
  }

  // ---------- 4) freshInstall 建的 store 与索引（假 db，零依赖） ----------
  {
    const stores: string[] = []
    const indexes: [string, string, boolean][] = []
    const fakeDb = {
      createObjectStore(name: string) {
        stores.push(name)
        return { createIndex: (i: string, _k: string, o?: { unique?: boolean }) => { indexes.push([name, i, !!o?.unique]) } }
      },
    } as unknown as FakeDb
    migrateFreshInstall(fakeDb)
    const need = ['projects', 'volumes', 'chapters', 'formData', 'tableRows', 'cardRecords', 'meta']
    const missed = need.filter(s => !stores.includes(s))
    ok('4a 全新安装建齐基础 store', missed.length === 0, `缺: ${missed.join(',')}`)
    ok('4b tableRows 建了 tabId 索引（#020 起按索引查，不再全表扫）',
      indexes.some(([s, i]) => s === 'tableRows' && i === 'tabId'))
    ok('4c tabId 索引非唯一（同一张表多行）', indexes.some(([s, i, u]) => s === 'tableRows' && i === 'tabId' && !u))
    ok('4d store 名不重复', new Set(stores).size === stores.length, stores.join(','))
  }

  // ---------- 5) 每段迁移的签名形态（防「忘了 await 异步段」） ----------
  {
    // 异步段（用 tx 的）在 core.ts 里必须被 await —— 漏 await 会让后续段在事务未完成时执行
    const asyncSegs = [...MIG_SRC.matchAll(/export\s+async\s+function\s+(migrateV\d+toV\d+)\s*\(/g)].map(m => m[1])
    const notAwaited = asyncSegs.filter(n => {
      const re = new RegExp('(await\\s+)?\\b' + n + '\\s*\\(')
      const m = CORE_SRC.match(re)
      return !m || !m[1]
    })
    ok('5a 每段 async 迁移在 core.ts 里都被 await', notAwaited.length === 0, notAwaited.join(','))
    ok('5b 至少存在一段 async 迁移（否则 5a 无判别力）', asyncSegs.length > 0, String(asyncSegs.length))
    // 接收 tx 的段必须真的拿到 tx（迁移里要写数据）
    const txSegs = [...MIG_SRC.matchAll(/function\s+(migrateV\d+toV\d+)\s*\(\s*(?:db:\s*Vdb,\s*)?tx:\s*Vtx/g)].map(m => m[1])
    const notPassed = txSegs.filter(n => !new RegExp('\\b' + n + '\\s*\\([^)]*tx\\s*\\)').test(CORE_SRC))
    ok('5c 需要 tx 的段在 core.ts 里确实传了 tx', notPassed.length === 0, notPassed.join(','))
  }

  console.log(`\nidbMigrations: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
