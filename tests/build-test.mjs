// 通用测试打包器：node tests/build-test.mjs <入口名（不带扩展名）>
// 把 db.ts 的 ./portable 与 ./desktop 替换为内存桩后打包运行
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
  define: { __PORTABLE__: 'true', __APP_VERSION__: '"test"' },
  plugins: [{
    name: 'stub-stores',
    setup(b) {
      b.onResolve({ filter: /^\.\/portable$/ }, () => ({ path: path.join(here, 'mock-portable.ts') }))
      b.onResolve({ filter: /^\.\/desktop$/ }, () => ({ path: path.join(here, 'mock-desktop.ts') }))
      b.onResolve({ filter: /^\.\/mock-memory$/ }, () => ({ path: path.join(here, 'mock-memory.ts') }))
    },
  }],
})

await import(pathToFileURL(path.join(here, `.${outName}.mjs`)).href)
