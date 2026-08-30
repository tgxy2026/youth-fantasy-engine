import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// 网页体验版构建配置（与便携/桌面构建完全独立，不改动后两者）：
// - 不定义 __PORTABLE__（此处显式 false），__DESKTOP__ 不定义 → 运行时探测为 false
//   → db.ts 自动走 idbOps（浏览器 IndexedDB），数据零服务端持久化
// - 输出到 dist-web/，base 用相对路径，可直接丢到任意静态托管 / 子路径
// - 版本号注入真实 package.json 版本
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __PORTABLE__: 'false',
    // 网页体验版专属标记：仅此构建为 true。
    // 邀请门禁 / AI 反代 / 云端同步 / 网页工具条一律以此为准，
    // 不再靠 `!PORTABLE && !DESKTOP` 反推 —— 否则纯浏览器 dev 会被误判成网页版而被邀请码拦下。
    __WEB__: 'true',
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },
})
