import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
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
      if (!file.endsWith('/src/lib/env.ts')) return null
      if (!code.includes('__APP_VERSION__')) return null
      return { code: code.replace(/__APP_VERSION__/g, JSON.stringify(version)), map: null }
    },
  }
}

export default defineConfig(() => ({
  plugins: [react(), injectAppVersion(appVersion)],
  // 相对路径：桌面（Electron）版通过 file:// 加载 dist/index.html，绝对路径会解析到磁盘根目录
  // （对 dev server 无影响）
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
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },
}))
