// 清理打包残留：release/desktop-out-*（electron-builder 中间产物，非交付物）
// 用法：node scripts/cleanup-residual.mjs
//
// 为什么需要单独一个脚本：
//   app.asar 常被安全软件（如电脑管家实时防护）占用句柄，打包刚结束时删不掉，
//   报「正由另一进程使用」。重启电脑后防护不再持有句柄，此时运行本脚本即可彻底清干净。
//   若仍有个别文件被占用，脚本会如实报告而不是假装成功——下次重启再跑一次即可。
//
// 保护项（绝不删除）：
//   release/eb-cache      electron-builder 缓存（106MB，删了下次打包要重新联网下载）
//   release/novel-studio-* 便携版交付物
//   release/桌面安装版      桌面版交付物
import { readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'release')

if (!existsSync(releaseDir)) {
  console.log('release/ 不存在，无需清理。')
  process.exit(0)
}

// 只认 desktop-out-*，其它目录一律不动（白名单式，避免误伤交付物）
const targets = readdirSync(releaseDir)
  .filter((n) => n.startsWith('desktop-out-'))
  .map((n) => join(releaseDir, n))

if (targets.length === 0) {
  console.log('没有 desktop-out-* 残留，工作区很干净。')
  process.exit(0)
}

function dirSize(p) {
  let total = 0
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) walk(full)
        else total += st.size
      } catch {
        /* 读不到的跳过 */
      }
    }
  }
  walk(p)
  return total
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB'
let freed = 0
const failed = []

for (const t of targets) {
  const size = dirSize(t)
  try {
    rmSync(t, { recursive: true, force: true })
    freed += size
    console.log(`已删除  ${t.replace(root + '\\', '')}  (${mb(size)})`)
  } catch (e) {
    failed.push({ path: t, reason: e.code || e.message })
    console.log(`删不掉  ${t.replace(root + '\\', '')}  (${mb(size)})  → ${e.code || e.message}`)
  }
}

console.log(`\n释放空间：${mb(freed)}`)
if (failed.length > 0) {
  console.log(`\n${failed.length} 项因被占用未能删除——重启电脑后再跑一次本脚本即可。`)
  console.log('（常见占用者：电脑管家等安全软件的实时防护会扫描 Electron 的 app.asar）')
  process.exit(1)
}
console.log('清理完成。')
