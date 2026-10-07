// ============ 主应用「请求超时」设置（2.9.0）· 行为与防回归 ============
//
// 背景：`aiTasks/**` 约 50 处 `timeoutMs: CHAT_TIMEOUT_MS` 此前吃的是 180s 硬编码常量 ——
// 慢模型（本地大模型首次加载 / 长结构化任务）只能干等或失败，而界面上**没有任何可调项**。
// 2.9.0 补上「模型设置 → 模型配置 → 请求超时」（存储键 `aiRequestTimeoutSec`，默认 300 秒）。
//
// 🔴 实现关键：`CHAT_TIMEOUT_MS` 由 `const` 改为**模块级 `let`**（同本文件提示词默认值的范式），
//    设置变更时由 `setChatTimeoutMs` 改写它 —— **ES module 的 import 是活绑定**，
//    故那 50 处调用点**一行都不用改**即自动跟随。本测试守的就是这条链别被改回常量/写死数字。
import * as fs from 'fs'
import * as path from 'path'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import {
  CHAT_TIMEOUT_MS, setChatTimeoutMs,
  AI_TIMEOUT_MIN_SEC, AI_TIMEOUT_MAX_SEC, AI_TIMEOUT_DEFAULT_SEC,
} from '../src/lib/aiCore/core'
import { loadAiTimeoutSec, saveAiTimeoutSec } from '../src/lib/aiCore/session'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const K = 'aiRequestTimeoutSec'

async function main() {
  __resetMockStores()

  // ---------- 1) 出厂值与边界关系 ----------
  ok('出厂兜底 = 180 秒（原硬编码值，未设置时用它）', CHAT_TIMEOUT_MS === 180_000, String(CHAT_TIMEOUT_MS))
  ok('下限 < 默认 < 上限', AI_TIMEOUT_MIN_SEC < AI_TIMEOUT_DEFAULT_SEC && AI_TIMEOUT_DEFAULT_SEC < AI_TIMEOUT_MAX_SEC,
    `${AI_TIMEOUT_MIN_SEC} / ${AI_TIMEOUT_DEFAULT_SEC} / ${AI_TIMEOUT_MAX_SEC}`)
  ok('默认 300 秒（与酒馆 timeoutSec 对齐）', AI_TIMEOUT_DEFAULT_SEC === 300, String(AI_TIMEOUT_DEFAULT_SEC))

  // ---------- 2) setter：改值 / 钳位 / 非法忽略 ----------
  setChatTimeoutMs(300 * 1000)
  ok('setter 生效（300s → 300000ms）', CHAT_TIMEOUT_MS === 300_000, String(CHAT_TIMEOUT_MS))

  setChatTimeoutMs(1_000)
  ok(`低于下限钳到 ${AI_TIMEOUT_MIN_SEC}s`, CHAT_TIMEOUT_MS === AI_TIMEOUT_MIN_SEC * 1000, String(CHAT_TIMEOUT_MS))

  setChatTimeoutMs(10_000_000)
  ok(`高于上限钳到 ${AI_TIMEOUT_MAX_SEC}s`, CHAT_TIMEOUT_MS === AI_TIMEOUT_MAX_SEC * 1000, String(CHAT_TIMEOUT_MS))

  setChatTimeoutMs(300 * 1000)
  setChatTimeoutMs(Number.NaN)
  ok('非法值（NaN）忽略、保留原值', CHAT_TIMEOUT_MS === 300_000, String(CHAT_TIMEOUT_MS))

  // ---------- 3) 落库往返 + 立即生效 ----------
  ok('saveAiTimeoutSec 返回钳位后的值', (await saveAiTimeoutSec(120)) === 120)
  ok('落库后读回一致', (await loadAiTimeoutSec()) === 120, String(await loadAiTimeoutSec()))
  ok('🔴 落库即生效（不必重启 / 不必换库）', CHAT_TIMEOUT_MS === 120_000, String(CHAT_TIMEOUT_MS))

  ok('save 越界钳到下限', (await saveAiTimeoutSec(5)) === AI_TIMEOUT_MIN_SEC, String(await loadAiTimeoutSec()))
  ok('save 越界钳到上限', (await saveAiTimeoutSec(99_999)) === AI_TIMEOUT_MAX_SEC, String(await loadAiTimeoutSec()))

  // 坏数据一律退回默认（绝不抛、绝不把 NaN 变成超时）
  await db.setMeta(K, 'abc')
  ok('库里是坏值 → 退回默认', (await loadAiTimeoutSec()) === AI_TIMEOUT_DEFAULT_SEC, String(await loadAiTimeoutSec()))
  await db.setMeta(K, null)
  ok('库里是 null → 退回默认', (await loadAiTimeoutSec()) === AI_TIMEOUT_DEFAULT_SEC, String(await loadAiTimeoutSec()))

  // ---------- 4) 静态：调用点不得绕过统一变量 ----------
  {
    const dirs = ['src/lib/aiTasks', 'src/lib/aiCore']
    const hits: string[] = []
    let scanned = 0
    for (const d of dirs) {
      const dir = path.join(process.cwd(), d)
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ts'))) {
        scanned++
        const src = fs.readFileSync(path.join(dir, f), 'utf8')
        src.split(/\r?\n/).forEach((l, i) => {
          if (/timeoutMs:\s*[0-9]/.test(l)) hits.push(`${d}/${f}:${i + 1}`)
        })
      }
    }
    ok('扫描到 aiTasks/aiCore 源文件', scanned > 0, String(scanned))
    ok('没有写死的 `timeoutMs: <数字>`（必须走 CHAT_TIMEOUT_MS / opts.timeoutMs）',
      hits.length === 0, hits.join(', '))
  }

  // ---------- 5) 静态：CHAT_TIMEOUT_MS 必须是 let（否则 import 不再是活绑定，50 处会吃旧值） ----------
  {
    const corePath = path.join(process.cwd(), 'src', 'lib', 'aiCore', 'core.ts')
    const src = fs.existsSync(corePath) ? fs.readFileSync(corePath, 'utf8') : ''
    ok('core.ts 存在', !!src)
    ok('🔴 `export let CHAT_TIMEOUT_MS`（活绑定前提；改回 const 则设置不生效）',
      /export let CHAT_TIMEOUT_MS\s*=/.test(src))
    // 设置键名唯一（session.ts 与测试用同一个字符串）
    const sessPath = path.join(process.cwd(), 'src', 'lib', 'aiCore', 'session.ts')
    const sess = fs.existsSync(sessPath) ? fs.readFileSync(sessPath, 'utf8') : ''
    ok(`session.ts 用同一存储键 '${K}'`, sess.includes(`'${K}'`))
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
