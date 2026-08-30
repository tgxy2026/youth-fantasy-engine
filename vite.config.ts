import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
// 版本取自 package.json，避免标题/版本号写死导致升级后不一致
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // 相对路径：桌面（Electron）版通过 file:// 加载 dist/index.html，绝对路径会解析到磁盘根目录
  // （对 dev server 与便携单文件版无影响）
  base: './',
  define: {
    // 便携（U 盘单文件）版本标记：网页/开发模式恒为 false，便携构建在 vite.config.portable.ts 中注入 true
    __PORTABLE__: 'false',
    // 网页体验版标记：仅 vite.config.web.ts 注入 true。
    // dev（本机浏览器）与桌面（Electron）均为 false —— 二者都不走邀请制、不走 AI 反代、不自动连云端。
    __WEB__: 'false',
    // 版本号：开发模式显示「开发版」（避免反复改号）；构建（桌面/网页封装）时注入 package.json 真实版本号
    __APP_VERSION__: JSON.stringify(mode === 'development' ? '开发版' : appVersion),
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
