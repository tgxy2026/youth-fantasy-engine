// 打包并运行 roundtrip 测试：db.ts 的 ./desktop 替换为内存桩
import { build } from '../node_modules/esbuild/lib/main.js'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

await build({
  entryPoints: [path.join(here, 'roundtrip.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.join(here, '.roundtrip.mjs'),
  logLevel: 'info',
  define: { __APP_VERSION__: '"test"' },
  plugins: [{
    name: 'stub-stores',
    setup(b) {
      b.onResolve({ filter: /^\.\/desktop$/ }, () => ({ path: path.join(here, 'mock-desktop.ts') }))
      b.onResolve({ filter: /^\.\/mock-memory$/ }, () => ({ path: path.join(here, 'mock-memory.ts') }))
    },
  }],
})

await import(pathToFileURL(path.join(here, '.roundtrip.mjs')).href)
