// 通用测试打包器：node tests/build-test.mjs <入口名（不带扩展名）>
// 把 db.ts 的 ./portable 与 ./desktop 替换为内存桩后打包运行
import { build } from '../node_modules/esbuild/lib/main.js'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = process.argv[2]
if (!entry) { console.error('用法: node tests/build-test.mjs <入口名>'); process.exit(1) }

await build({
  entryPoints: [path.join(here, `${entry}.test.ts`)],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.join(here, `.${entry}.mjs`),
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

await import(pathToFileURL(path.join(here, `.${entry}.mjs`)).href)
