// 清理打包残留：
//   ① release/desktop-out-*（electron-builder 中间产物，非交付物）
//   ② dist_bak_*（构建前把旧 dist 改名避让 safe-delete 留下的备份，纯残留）
// 用法：node scripts/cleanup-residual.mjs
//
// 为什么需要单独一个脚本：
//   app.asar 常被安全软件（如电脑管家实时防护）占用句柄，打包刚结束时删不掉，
//   报「正由另一进程使用」。重启电脑后防护不再持有句柄，此时运行本脚本即可彻底清干净。
//   若仍有个别文件被占用，脚本会如实报告而不是假装成功——下次重启再跑一次即可。
//
// 保护项（绝不删除）：
//   release/eb-cache      electron-builder 缓存（106MB，删了下次打包要重新联网下载）
//   release/youth-fantasy-engine-* 便携版交付物
//   release/桌面安装版      桌面版交付物
//   dist                  `npm run preview` 要读它，不是残留
import { readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'release')

// ① release/desktop-out-*：只认这个前缀，其它目录一律不动（白名单式，避免误伤交付物）
const targets = existsSync(releaseDir)
  ? readdirSync(releaseDir)
    .filter((n) => n.startsWith('desktop-out-'))
    .map((n) => join(releaseDir, n))
  : []

// ② dist_bak_*（在项目根）：build-desktop.mjs 每次构建前把旧 dist 改名到这里，
//    之前没有任何脚本清它 → 逐轮堆积（老大 2026-09-19 发现两个共 15MB 后要求清掉）。
//    🔴 它是**构建当次**的避让备份，构建结束后就没有用途了，所以并入本脚本一起清。
const distBak = readdirSync(root)
  .filter((n) => n.startsWith('dist_bak_'))
  .map((n) => join(root, n))
  .filter((p) => {
    try { return statSync(p).isDirectory() } catch { return false }
  })

const all = [...targets, ...distBak]

if (all.length === 0) {
  console.log('没有残留（desktop-out-* / dist_bak_* 都没有），工作区很干净。')
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

for (const t of all) {
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
