// ============ 依赖漏洞 overrides 防回归闸（纯静态；只读仓库内文件，不碰 node_modules）============
//
// 背景（2026-10-07 · 2.9.0 收尾）：
//   `npm audit` 剩 2 条 high 全在 devDependencies 的传递依赖里，npm 自身只能靠「降 electron-builder
//   到 26.5.0」来修（不可取 ⇒ 那 8 条 moderate 挂账等 27.x）。这 2 条 high 是**同 major 内有修复版**
//   的，所以用 package.json 的 `overrides` 精确顶上去：
//     · brace-expansion  ≤1.1.20 → ^1.1.21（GHSA-q2hr-2g5m-vwhr / -qhr7-859c-m2p7 / -6j4f-fj2g-mc7p）
//     · http-cache-semantics ≤4.2.0 → ^4.3.0（GHSA-ch52-4w7c-c8xp）
//
// 这条闸守四件事（都是**真踩过的坑**，不是假想）：
//   ① 这两个 overrides 还在（有人 `npm audit fix --force` 或手工清 overrides 就会掉）；
//   ② 树里**不许再有** ≤1.1.20 的 brace-expansion / ≤4.2.0 的 http-cache-semantics；
//   ③ 🔴 **2.x / 5.x 的 brace-expansion 必须仍在** —— 它们是 minimatch@5/9/10 的依赖，
//      若有人图省事写一个**全局裸名**覆盖（`"brace-expansion": "^1.1.21"`）把整棵树压平成 1.x，
//      minimatch@9/10 会拿到不满足自身 `^2.0.0`/`^5.0.0` 的包 ⇒ 构建链静默/炸裂。
//      ⇒ 因此本闸**同时禁止** overrides 里出现 brace-expansion 的全局裸名键。
//   ④ electron-builder 没被「降级修复」回去（≥ 26.15.0）。
//
// 为什么读 lock 而不 require：不装依赖也能跑（A 批保持零 IO）；lock 是仓库内文件、结果确定。
import * as fs from 'fs'
import * as path from 'path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 仓库根（单测可能从仓库根或 tests/ 起跑） */
function repoRoot(): string {
  for (const c of [process.cwd(), path.join(process.cwd(), '..')]) {
    if (fs.existsSync(path.join(c, 'package.json')) && fs.existsSync(path.join(c, 'package-lock.json'))) return c
  }
  return ''
}

type Sem = [number, number, number]
function sem(v: string): Sem {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
}
/** a < b */
function lt(a: Sem, b: Sem): boolean {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] }
  return false
}

function main() {
  const root = repoRoot()
  ok('定位仓库根（含 package.json 与 package-lock.json）', !!root, 'cwd=' + process.cwd())
  if (!root) { console.log(`\n通过 ${pass} / 失败 ${fail}`); process.exit(1) }

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const ov = pkg.overrides || {}

  // ---- ① overrides 四条仍在 ----
  ok('① overrides 保留了 http-cache-semantics: ^4.3.0', ov['http-cache-semantics'] === '^4.3.0', JSON.stringify(ov['http-cache-semantics']))
  const parents = ['@eslint/config-array', '@eslint/eslintrc', 'eslint']
  const missing = parents.filter(p => ov[p]?.['brace-expansion'] !== '^1.1.21')
  ok('① overrides 对三个 eslint 系父包都钉了 brace-expansion: ^1.1.21', missing.length === 0, '缺: ' + missing.join(', '))

  // ---- ③ 反向守卫：禁止 brace-expansion 的全局裸名覆盖 ----
  //   （嵌套只穿透一层，所以必须逐父包写；一旦有人改成裸名就会压平 2.x/5.x）
  const bareKeys = Object.keys(ov).filter(k => k === 'brace-expansion' || k.startsWith('brace-expansion@'))
  ok('③ 未使用 brace-expansion 的全局/版本限定裸名覆盖（会压平 2.x/5.x）', bareKeys.length === 0, bareKeys.join(', '))

  // ---- ②/③ 扫 lock 里的实际解析结果 ----
  const entries = Object.entries(lock.packages || {}) as Array<[string, any]>
  // ⚠️ 排除 `@types/*`：那是纯类型声明包（无运行时代码），`@types/http-cache-semantics` 是另一个包，
  //    与运行时通告无关 —— 早先按包名后缀匹配时被它误报过一条。
  const isReal = ([k]: [string, any]) => !/node_modules\/@types\//.test(k)
  const be = entries.filter(([k]) => /(^|\/)brace-expansion$/.test(k) && isReal([k, null]))
  const hcs = entries.filter(([k]) => /(^|\/)http-cache-semantics$/.test(k) && isReal([k, null]))

  ok('lock 里能读到 brace-expansion 条目', be.length > 0, String(be.length))
  ok('lock 里能读到 http-cache-semantics 条目', hcs.length > 0, String(hcs.length))

  // ② 不得残留受影响版本
  const beBad = be.filter(([, v]) => { const s = sem(v.version); return s[0] === 1 && lt(s, [1, 1, 21]) })
    .map(([k, v]) => `${k}@${v.version}`)
  ok('② lock 里无 brace-expansion ≤1.1.20', beBad.length === 0, beBad.join(', '))

  const hcsBad = hcs.filter(([, v]) => lt(sem(v.version), [4, 3, 0]))
    .map(([k, v]) => `${k}@${v.version}`)
  ok('② lock 里无 http-cache-semantics ≤4.2.0', hcsBad.length === 0, hcsBad.join(', '))

  // ③ 2.x / 5.x 仍在（minimatch@5/9/10 需要它们）
  const be2x = be.filter(([, v]) => sem(v.version)[0] === 2)
  const be5x = be.filter(([, v]) => sem(v.version)[0] >= 5)
  ok('③ 2.x 的 brace-expansion 仍在（minimatch@9 等需要）', be2x.length > 0, be.map(([k, v]) => `${k}@${v.version}`).join(', '))
  ok('③ 5.x 的 brace-expansion 仍在（minimatch@10 等需要）', be5x.length > 0, '')

  // ④ electron-builder 未被降级
  const eb = entries.find(([k]) => k === 'node_modules/electron-builder')
  const ebVer = eb ? sem((eb[1] as any).version) : ([0, 0, 0] as Sem)
  ok('④ electron-builder ≥ 26.15.0（没被「降级修复」回去）', ebVer[0] > 26 || (ebVer[0] === 26 && (ebVer[1] > 15 || (ebVer[1] === 15 && ebVer[2] >= 0))), eb ? (eb[1] as any).version : '未找到')

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
