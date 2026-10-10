// 通用测试打包器：node tests/build-test.mjs <入口名（不带扩展名）>
// 把 db.ts 的 ./desktop 替换为内存桩后打包运行
import { build } from '../node_modules/esbuild/lib/main.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = process.argv[2]
if (!entry) { console.error('用法: node tests/build-test.mjs <入口名>'); process.exit(1) }

// 入口名可以直接带 .ts（如 live-tavern.ts）—— 用于**手动运行**的脚本：
// 它们不叫 *.test.ts，所以不会被 run-all.mjs 自动纳入（避免联网实弹测试混进全量回归）。
// 优先找 <entry>.test.ts（回归用例），找不到再找 <entry>.ts（手动脚本）
const entryFile = [`${entry}.test.ts`, `${entry}.ts`].find(f => fs.existsSync(path.join(here, f)))
  ?? `${entry}.test.ts`
const outName = entryFile.replace(/\.ts$/, '')

await build({
  entryPoints: [path.join(here, entryFile)],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.join(here, `.${outName}.mjs`),
  // 单独跑时保留 info（看得见产物体积/耗时）；被 run-all.mjs 批量调用时置 quiet，避免横幅刷屏
  logLevel: process.env.YFE_TEST_QUIET ? 'warning' : 'info',
  define: { __APP_VERSION__: '"test"' },
  // 路径别名 @ → src（与 vite.config.ts / tsconfig.json 三处一致；漏了测试会解析失败）
  alias: { '@': path.join(here, '..', 'src') },
  plugins: [{
    name: 'stub-stores',
    setup(b) {
      // ⚠️ filter 必须同时认 './desktop' 与 '../desktop'：2026-09-19 起 src/lib/db.ts 只是门面，
      // 真正的存储代码在 src/lib/db/ 下（相对路径更深一层）。只写成 /^\.\/desktop$/ 会漏桩，
      // 于是测试会去加载真实 Electron 模块 —— 那时是**炸得响**的，不是静默通过。
      // 🔴 2026-10-10（G1 别名化）：specifier 已从相对路径改成 `@/lib/desktop`
      // （`src/lib/db/core.ts` 里那行 `../desktop`），filter 不同步就会**又漏桩** ——
      // 实测后果：69 个用例一起挂 `indexedDB is not defined`。故把 `@/lib/desktop` 一并认。
      b.onResolve({ filter: /^(?:(?:\.\.?\/)+desktop|@\/lib\/desktop)$/ }, () => ({ path: path.join(here, 'mock-desktop.ts') }))
      b.onResolve({ filter: /^\.\/mock-memory$/ }, () => ({ path: path.join(here, 'mock-memory.ts') }))
    },
  }],
})

await import(pathToFileURL(path.join(here, `.${outName}.mjs`)).href)
