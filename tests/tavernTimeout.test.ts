// ============ 酒馆模式 · 请求超时「跟随设置」防回归闸（纯静态，零 IO）============
//
// 背景（2026-10-07 六维审计「未做五项」推进）：
//   酒馆控制面板一直有「请求超时 timeoutSec」（默认 300s），但 summarize / revise / report /
//   world / story / script / draft / import / daily / interview 十个文件里 13 处**硬编码**
//   了 `timeoutMs: CHAT_TIMEOUT_MS`（180s 常量）⇒ **用户在面板上调了完全不起作用**。
//   已统一改为 `timeoutMsOf(await getTavernSettings())`（engine.ts 三处原本就走 `timeoutMsOf(st)`）。
//
// 这条闸守的就是**别再改回去**：
//   ① tavern 目录不得再出现 `CHAT_TIMEOUT_MS`（那是主应用常量，酒馆必须走设置）；
//   ② 每一处 `timeoutMs:` 的值必须直接取自 `timeoutMsOf(...)`（不许写死数字、不许写常量）；
//   ③ `timeoutMsOf()` 的实现语义不得变（max(5, sec) * 1000）—— 有人把下限去掉会让 0 值直接失效。
//
// 为什么用「读源码」而不是「跑函数」：这是 A 批结构闸，刻意保持零 IO（不 import settings ⇒
//   不拉 db / IDB）。行为侧的「默认 300 秒」由 `tavernSettings.test.ts` 守。
import * as fs from 'fs'
import * as path from 'path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 定位 src/lib/tavern（单测可能从仓库根或 tests/ 起跑） */
function tavernDir(): string {
  for (const c of [
    path.join(process.cwd(), 'src', 'lib', 'tavern'),
    path.join(process.cwd(), '..', 'src', 'lib', 'tavern'),
  ]) if (fs.existsSync(c)) return c
  return ''
}

function main() {
  const dir = tavernDir()
  ok('找到 src/lib/tavern 目录', !!dir, 'cwd=' + process.cwd())
  if (!dir) { console.log(`\n通过 ${pass} / 失败 ${fail}`); process.exit(1) }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'))
  ok('tavern 目录下有 .ts 文件', files.length > 0, String(files.length))

  const hardcoded: string[] = []      // ① 硬编码常量
  const notFromSettings: string[] = [] // ② timeoutMs 不来自 timeoutMsOf
  let timeoutSites = 0

  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    src.split(/\r?\n/).forEach((line, i) => {
      const at = `${f}:${i + 1}`
      if (line.includes('CHAT_TIMEOUT_MS')) hardcoded.push(at)
      // 只认「timeoutMs: <值>」这种传参（比 `timeoutMs` 更严，避免误报注释/类型名）
      const m = line.match(/timeoutMs:\s*(.+)$/)
      if (!m) return
      timeoutSites++
      if (!m[1].trim().startsWith('timeoutMsOf(')) notFromSettings.push(`${at} → ${m[1].trim().slice(0, 60)}`)
    })
  }

  ok('① tavern 目录不含 CHAT_TIMEOUT_MS（超时必须走设置）', hardcoded.length === 0, hardcoded.join(', '))
  ok('② 每处 timeoutMs 都取自 timeoutMsOf()', notFromSettings.length === 0, notFromSettings.join(' | '))
  // 接入点计数：当前 16 处（engine 3 + summarize 4 + 其余 9）。只设下限，防「被整段删掉」。
  ok('③ timeoutMs 接入点 ≥ 13（当前 16）', timeoutSites >= 13, String(timeoutSites))

  // ④ timeoutMsOf 实现语义（源码扫描；settings.ts 是唯一真源）
  const settingsSrc = fs.readFileSync(path.join(dir, 'settings.ts'), 'utf8')
  const impl = settingsSrc.match(/export function timeoutMsOf\([\s\S]{0,160}?\n\}/)
  ok('④ 找到 timeoutMsOf 实现', !!impl)
  if (impl) {
    const body = impl[0].replace(/\s+/g, ' ')
    ok('④ timeoutMsOf = max(5, timeoutSec) * 1000（下限 5s 不得去掉）', /Math\.max\(\s*5\s*,\s*s\.common\.timeoutSec\s*\)\s*\*\s*1000/.test(body), body)
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
