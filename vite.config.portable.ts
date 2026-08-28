import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'

// 版本取自 package.json，避免标题/输出目录写死导致升级后不一致
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const PORTABLE_TITLE = `青春幻想引擎 便携版 v${version}`

/**
 * 便携（U 盘单文件）版本构建配置：
 * - 把整个应用内联为单个 HTML 文件，双击即可离线运行，无需 Node / 本地服务器
 * - __PORTABLE__ = true：存储层切换为 U 盘数据文件（File System Access API）
 * - 移除外部 Google Fonts 链接，离线环境下不再阻塞首屏渲染
 */
function stripExternalFonts(): Plugin {
  return {
    name: 'strip-external-fonts',
    transformIndexHtml(html) {
      return html
        .replace(/<link rel="preconnect"[^>]*>\s*/g, '')
        .replace(/<link href="https:\/\/fonts[^>]*>\s*/g, '')
        .replace('<title>青春幻想引擎 · 小说创作工作台</title>', `<title>${PORTABLE_TITLE}</title>`)
    },
  }
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), stripExternalFonts()],
  define: {
    __PORTABLE__: 'true',
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: `release/novel-studio-${version}`,
    emptyOutDir: true,
    chunkSizeWarningLimit: 5000,
  },
})
