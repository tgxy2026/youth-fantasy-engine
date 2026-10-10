import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// 版本取自 package.json，避免标题/版本号写死导致升级后不一致
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

/**
 * ⚠️ dev 下 `define` 不会替换源码里的 `__APP_VERSION__`（2026-09-02 实测：vite dev 返回的
 * portable.ts 模块中该标识符**原样保留**，于是版本恒走 `typeof __APP_VERSION__ === 'undefined'`
 * 兜底分支，界面显示「开发版」）；而 `vite build` 会正常替换并常量折叠掉兜底。
 * 后果是对外文案（关于页「当前版本 vX.Y.Z」、侧栏、项目中心）在 dev 下无法核对。
 * 这里用一个极小的 transform 插件补上 dev 的替换，使 dev 与构建显示一致，
 * 且版本号仍只来自 package.json 一处（不必在 env.ts 里再硬编码一份）。
 */
function injectAppVersion(version: string) {
  return {
    name: 'inject-app-version',
    transform(code: string, id: string) {
      const file = id.split('?')[0].replace(/\\/g, '/')
      // ⚠️ 3.0 目录整理（G3）把 env.ts 从 `src/lib/` 挪到 `src/lib/app/`，此处必须同步，
      // 否则 dev 下 `__APP_VERSION__` 不再被替换、对外文案退回「开发版」（静默，不报错）。
      if (!file.endsWith('/src/lib/app/env.ts')) return null
      if (!code.includes('__APP_VERSION__')) return null
      return { code: code.replace(/__APP_VERSION__/g, JSON.stringify(version)), map: null }
    },
  }
}

/**
 * dev 下把 `127.0.0.1:5199` **归一化**到 `localhost:5199`。
 *
 * 【为什么需要它】浏览器只看「协议 + 主机名 + 端口」这三个字符串来判断是否同一个网站，
 * **不会**推断「localhost 和 127.0.0.1 是同一台机器」。于是同一个 server、同一个端口，
 * 却是两个 origin，而同源策略给每个 origin **各存一份 IndexedDB / localStorage**：
 * 在 127.0.0.1 注入的测试数据，回 localhost 预览时一份都看不到（实测代价）。
 * 这里把 127.0.0.1 的文档请求 302 到 localhost，从此只存在一个 origin、一份库。
 *
 * ⚠️ 只在 dev 生效（`configureServer`）；构建产物与 Electron 桌面版完全不受影响。
 * ⚠️ `configureServer` 里**直接** `use` 的是**前置**中间件（返回一个函数才是后置）——
 *    必须在 Vite 内部中间件之前拦下请求，否则 HTML 已经发出去了，重定向无从谈起。
 * ⚠️ 局域网 IP（手机调试）不受影响：只匹配 `127.0.0.1`。
 */
function normalizeDevHost(): Plugin {
  return {
    name: 'normalize-dev-host',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const host = String(req.headers.host || '')
        if (/^127\.0\.0\.1(:\d+)?$/.test(host)) {
          const port = host.includes(':') ? host.split(':')[1] : '5199'
          res.writeHead(302, { Location: `http://localhost:${port}${req.url || '/'}` })
          res.end()
          return
        }
        next()
      })
    },
  }
}

export default defineConfig(() => ({
  plugins: [react(), injectAppVersion(appVersion), normalizeDevHost()],
  // 相对路径：桌面（Electron）版通过 file:// 加载 dist/index.html，绝对路径会解析到磁盘根目录
  // （对 dev server 无影响）
  // 路径别名 `@` → `src/`（2026-10-10 · 目录结构优化 G0）。
  // 【为什么加】目录整理要搬文件：相对路径下每搬一处都要重算「到每个被引者的路径」，
  //   而且**引用方**也得跟着改（那才是大头）。别名让「一个文件怎么 import」与它自己的位置无关，
  //   搬迁只需改「谁引用了它」这一侧，也消除了「相对路径算错」这整类错误。
  // 🔴 改别名须同步四处：本文件 resolve.alias ／ tsconfig.json 的 paths ／
  //   tests/build-test.mjs 的 esbuild alias ／ tests/importCycles.test.ts 的依赖图解析。
  //   （importCycles 原先**只认相对路径**，漏同步会让依赖图变空、闸「全绿但什么都没查」——
  //    它现有的 `totalEdges > 200` 自检会响亮报错，别再删那条。）
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  base: './',
  define: {
    // 版本号：dev 与构建统一取 package.json 真实版本号（唯一真源）。
    // 2026-09-02 前 dev 模式显示「开发版」（本意为避免反复改号），但副作用是对外文案
    // —— 关于页「当前版本 vX.Y.Z」、侧栏、项目中心、便携版标题 —— 在 dev 下全部核对不了，
    // 只能等到封装后才发现对不对。改回真实号，dev 即可直接核对对外文案。
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5199,
    host: true,
    // 交付物/产物目录不参与源码热更新监视：封装桌面版时 release/ 会凭空多出数千个
    // Chromium 解压文件，若不忽略会冲垮文件监视器（EBADF）导致 dev 服务器崩溃
    watch: {
      ignored: ['**/node_modules/**', '**/dist/**', '**/release/**']
    }
  },
  build: {
    // 把 react / react-dom 拆成独立厂商包，避免全部压进首屏主包触发 >500KB 警告；
    // 同时给一个略宽松的告警阈值作为兜底（告警本身不影响产物可用性）
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // ⚠️ vite 8 内核已换成 rolldown，它**只接受函数形式**的 manualChunks。
        //    旧的对象写法（`{ 'react-vendor': ['react','react-dom'] }`）会直接构建失败：
        //    `TypeError: manualChunks is not a function`（2026-10-07 实测）。
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/](?:react|react-dom)[\\/]/.test(id)) return 'react-vendor'
        },
      },
    },
  },
}))
