// 便携（U 盘单文件）版打包脚本
// 用法：npm run build:portable
// 产物：release/novel-studio-<版本号>/  （整个文件夹拷到 U 盘即可使用，版本取自 package.json）
import { build } from 'vite'
import { copyFileSync, mkdirSync, readdirSync, renameSync, statSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const outDir = resolve(`release/novel-studio-${version}`)

await build({ configFile: 'vite.config.portable.ts' })

// index.html → novel-studio.html（START.bat 固定引用该 ASCII 文件名）
renameSync(resolve(outDir, 'index.html'), resolve(outDir, 'novel-studio.html'))

// 附带启动器与使用说明（逐文件复制，避免 cpSync 递归拷贝在受限环境被拦截）
mkdirSync(outDir, { recursive: true })
for (const f of readdirSync('portable-assets')) {
  copyFileSync(`portable-assets/${f}`, `${outDir}/${f}`)
}

const sizeMB = (statSync(resolve(outDir, 'novel-studio.html')).size / 1024 / 1024).toFixed(2)
console.log(`\n便携版打包完成 → ${outDir}/（应用体积 ${sizeMB} MB）`)
console.log('将整个文件夹拷贝到 U 盘即可使用：双击 START.bat 启动。')
