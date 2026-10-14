// ============ 下载 Node 运行时安装包（供便携版内置）============
//
// 【它是什么】把 Node.js 的**安装包**下到 `release/portable-assets/`，
//   供 `build-portable-pkg.mjs` 内置进「含 Node 运行时」版便携 zip。
//
// 【为什么要它】
//   Windows 版便携包是**免安装**的（Node 运行时已内嵌进 exe）⇒ Windows 用户不需要装 Node。
//   但 macOS / Linux 的便携包**仍要走系统 Node**（SEA 二进制跨平台要重新签名，见 memory
//   里 2026-10-13 的记录），于是那些平台的用户第一步就是「装 Node」。
//   把安装包塞进压缩包，用户就不用另外去官网找、也不用额外下一次 —— 解压即可双击安装。
//
// 【默认只下 macOS 包】因为唯一"必须装 Node"的平台就是 macOS（Windows 已免安装）。
//   需要 Windows 的 msi（给 exe 被安全软件拦下的回退路径）时加 `--win`。
//
// 🔴 版本必须与便携版内嵌的运行时**同源**：默认取**当前构建机的 node 版本**
//    （便携 exe 就是用 `process.execPath` 打的，两者一致才不会"装的 node 比内嵌的老/新"）。
//
// 【用法】
//   node scripts/fetch-node-installer.mjs              # 只下 macOS 版（.pkg）
//   node scripts/fetch-node-installer.mjs --win        # 额外下 Windows 版（.msi）
//   node scripts/fetch-node-installer.mjs --version 22.22.2
//
// 幂等：目标文件已存在且大于 1MB 就跳过（中断的半成品会被重新下）。

import { createWriteStream } from 'node:fs'
import { mkdirSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = path.join(root, 'release', 'portable-assets')

function parseArgs(argv) {
  const out = { win: false, version: '' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--win') out.win = true
    else if (argv[i] === '--version') out.version = argv[++i]
  }
  return out
}
const ARGS = parseArgs(process.argv.slice(2))

const log = (...a) => console.log('[fetch-node]', ...a)

/** 目标清单：macOS 是 universal 包（Intel + Apple Silicon 通吃），一个文件覆盖两种 Mac */
const TARGETS = [
  { url: v => `https://nodejs.org/dist/v${v}/node-v${v}.pkg`, file: v => `node-v${v}.pkg`, label: 'macOS' },
  ...(ARGS.win ? [{ url: v => `https://nodejs.org/dist/v${v}/node-v${v}-x64.msi`, file: v => `node-v${v}-x64.msi`, label: 'Windows' }] : []),
]

// 版本：命令行 > 当前 node（与内嵌运行时同源） > package.json
const VERSION = ARGS.version
  || process.versions.node
  || JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version

mkdirSync(OUT_DIR, { recursive: true })
log(`目标版本：v${VERSION}　输出目录：${OUT_DIR}`)

async function download(url, dest) {
  log(`  下载 ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} —— 请检查版本号是否存在于 nodejs.org`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1024 * 1024) {
    throw new Error(`文件只有 ${buf.length} 字节，多半下到了错误页；请检查 URL`)
  }
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(dest)
    ws.on('error', reject)
    ws.on('finish', resolve)
    ws.end(buf)
  })
  return buf.length
}

let ok = 0
for (const t of TARGETS) {
  const dest = path.join(OUT_DIR, t.file(VERSION))
  const existing = (() => { try { return statSync(dest).size } catch { return 0 } })()
  if (existing > 1024 * 1024) {
    log(`  ✅ ${t.label}：已存在（${(existing / 1048576).toFixed(1)} MB），跳过 —— 删掉该文件可强制重下`)
    ok++
    continue
  }
  try {
    const size = await download(t.url(VERSION), dest)
    log(`  ✅ ${t.label}：${(size / 1048576).toFixed(1)} MB → ${path.basename(dest)}`)
    ok++
  } catch (e) {
    log(`  ❌ ${t.label} 失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

log('')
log(ok === TARGETS.length
  ? `全部完成（${ok}/${TARGETS.length}）。接下来跑：npm run build:portable-pkg`
  : `完成 ${ok}/${TARGETS.length} —— 便携版会照常打包，只是不含内置的 Node 安装包。`)
if (ok === 0) process.exit(1)
