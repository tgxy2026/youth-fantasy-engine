// ============ 便携版打包（scripts/build-portable-pkg.mjs · 2026-10-14 改写）============
//
// 【它是什么】把便携版打成**两个按平台区分的 zip**：
//   · `青春幻想引擎-便携版-<版本>-Windows.zip`     —— 含 启动.bat
//   · `青春幻想引擎-便携版-<版本>-macOS-Linux.zip`  —— 含 启动.sh
//   两个包的应用本体（dist/ + scripts/portable-server.mjs + 使用说明）完全一样，
//   **只是启动脚本不同**（Windows 用 .bat，mac / linux 用 .sh）—— 所以不合并成一个包，
//   免得 Windows 用户目录里躺着一个用不到的 .sh（反之亦然）。
//
// 🔴 【本轮改动（2026-10-14 · 主人决定）】
//   1. **放弃单文件 exe**：恢复成「node + scripts/portable-server.mjs」的脚本启动形式
//      （主人原话：后续维护起来太麻烦了）。`scripts/build-portable-server.mjs` 已随之删除
//      （踩坑结论见 `memory/2026-10-13.md`）。故本脚本不再产出/依赖任何 exe。
//   2. **不再内置 Node 安装包**：因为 macOS 的 .pkg 有 84MB 且压缩率仅 99%，
//      内置会让整包超过 100MB，**两个开源仓库（Gitee / GitHub）都传不上去**。
//      改为在使用说明里给下载地址（官方 + 国内镜像）。
//   3. **release/ 只要最终交付物**：组装在临时目录进行，打完 zip 立即删，
//      所以 release/ 下不会残留「便携版-<版本>/」这类中间目录。
//      ⇒ 与桌面版安装包一起，release/ 最终只有两三个文件。
//
// 【为什么要自己写 zip 写入器，而不用外部工具】
//   🔴 本项目踩过两次 zip 的编码坑：
//      · `Compress-Archive` 会写出**反斜杠条目名**，且非 ASCII 名按 GBK 落盘 ⇒ 跨机器乱码；
//      · 外部 7za 依赖 electron-builder 缓存目录，**换台机器路径就变**，不可复现。
//   ⇒ 纯 Node 实现（zlib 内置）：零外部进程、跨平台一致，
//      并且能**显式**把 UTF-8 标志位（general purpose bit 11）写对 —— 中文条目名的关键。
//
// 【用法】
//   node scripts/build-portable-pkg.mjs                  # 版本号取 package.json，产出两个 zip
//   node scripts/build-portable-pkg.mjs --version 3.0.3
//   node scripts/build-portable-pkg.mjs --keep-build     # 调试：保留 release/.portable-build 临时目录
//
// 【产物】（直接落在 release/ 根下）
//   release/青春幻想引擎-便携版-<版本>-Windows.zip
//   release/青春幻想引擎-便携版-<版本>-macOS-Linux.zip

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, copyFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

function parseArgs(argv) {
  const out = { version: pkg.version, keepBuild: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') out.version = argv[++i]
    else if (argv[i] === '--keep-build') out.keepBuild = true
  }
  return out
}
const ARGS = parseArgs(process.argv.slice(2))

const log = (...a) => console.log('[build:portable-pkg]', ...a)
function fail(msg) { console.error('[build:portable-pkg] ❌', msg); process.exit(1) }

const PORTABLE_SRC = path.join(root, 'portable')
const DIST_DIR = path.join(root, 'dist')
const OUT_DIR = path.join(root, 'release')
/** 组装用的临时目录（在 release 下但打成点开头，且用完即删，不会被当成交付物） */
const BUILD_TMP = path.join(OUT_DIR, '.portable-build')
// 构建中途失败/中断时也清临时目录；--keep-build 是唯一保留它的显式方式。
process.on('exit', () => {
  if (!ARGS.keepBuild) {
    try { rmSync(BUILD_TMP, { recursive: true, force: true }) } catch { /* 退出清理 best-effort */ }
  }
})

/** 使用说明的文件名（2026-10-14 起改成「安装前必读」） */
const README_NAME = '使用说明-安装前必读.txt'

/**
 * 两个平台的差异：**只差启动脚本**。
 * 其余（dist / portable-server.mjs / 使用说明）完全一致。
 */
const VARIANTS = [
  {
    id: 'Windows',
    zipName: `青春幻想引擎-便携版-${ARGS.version}-Windows.zip`,
    scripts: ['启动.bat'],
    launcher: '双击「启动.bat」',
  },
  {
    id: 'macOS-Linux',
    zipName: `青春幻想引擎-便携版-${ARGS.version}-macOS-Linux.zip`,
    scripts: ['启动.sh'],
    launcher: '终端里执行 bash 启动.sh',
  },
]

// ---------- 前置检查 ----------
if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
  fail(`未找到前端产物：${DIST_DIR}/index.html\n  请先执行：npm run build:portable`)
}
for (const f of ['scripts/portable-server.mjs', README_NAME]) {
  if (!existsSync(path.join(PORTABLE_SRC, f)) && !existsSync(path.join(root, f))) {
    fail(`缺少 ${f} —— 应位于 portable/（说明与启动脚本）或仓库根（服务脚本）`)
  }
}

// ---------- 组装 ----------
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true })
  let files = 0, bytes = 0
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) { const r = copyTree(s, d); files += r.files; bytes += r.bytes }
    else { copyFileSync(s, d); files++; bytes += statSync(s).size }
  }
  return { files, bytes }
}

/** 收集目录内所有文件（zip 用；相对路径一律用 `/` 分隔） */
function walk(dir, base = '') {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel))
    else out.push({ rel, abs: path.join(dir, e.name) })
  }
  return out
}

// ---------- 纯 Node zip 写入器 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

function buildZip(files) {
  const localParts = []
  const centralParts = []
  let offset = 0
  const now = new Date()
  const { time, date } = dosDateTime(now)

  for (const f of files) {
    const raw = readFileSync(f.abs)
    const nameBuf = Buffer.from(f.rel, 'utf8')   // 🔴 条目名一律 UTF-8
    const crc = crc32(raw)
    const deflated = deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const data = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const flags = 0x0800                        // bit 11 ⇒ 文件名是 UTF-8

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(flags, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    localParts.push(lh, nameBuf, data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(flags, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(time, 12)
    ch.writeUInt16LE(date, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    // external attributes: 普通文件 644。🔴 必须 `>>> 0` ——
    // JS 的 `<<` 是有符号 32 位运算，`0o100644 << 16` 会变成负数，writeUInt32LE 直接抛错。
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    ch.writeUInt32LE(offset, 42)
    centralParts.push(ch, nameBuf)

    offset += lh.length + nameBuf.length + data.length
  }

  const centralBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralBuf, eocd])
}

// ---------- 打包 + 自校验 ----------
function packAndVerify(dir, zipPath, label) {
  log(`压缩 ${label}（纯 Node zip 写入器，UTF-8 条目名）`)
  const t0 = Date.now()
  const zipBuf = buildZip(walk(dir))
  writeFileSync(zipPath, zipBuf)
  log(`   → ${zipPath} · ${(zipBuf.length / 1024 / 1024).toFixed(2)} MB · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  log('   自校验（central directory 逐条验 UTF-8 标志位与条目名）')
  const buf = readFileSync(zipPath)
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocdPos < 0) fail(`${label}：zip 里找不到 EOCD（文件不完整）`)
  const total = buf.readUInt16LE(eocdPos + 10)
  let p = buf.readUInt32LE(eocdPos + 16)
  const bad = []
  const names = []
  let utf8Count = 0, backslash = 0
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) { bad.push(`条目 ${i} 签名错位`); break }
    const flags = buf.readUInt16LE(p + 8)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    names.push(name)
    if (flags & 0x0800) utf8Count++
    else bad.push(`条目「${name}」未标 UTF-8`)
    if (name.includes('\\')) backslash++
    p += 46 + nameLen + extraLen + commentLen
  }
  if (bad.length > 0 || utf8Count !== total || backslash > 0) {
    fail(`${label}：编码校验未通过\n   ${bad.slice(0, 5).join('\n   ')}`)
  }
  log(`   ✅ 条目 ${total} 个 · UTF-8 标志位 ${utf8Count}/${total} · 反斜杠 0`)

  return {
    label, zipPath,
    zipBytes: zipBuf.length,
    zipMB: Number((zipBuf.length / 1024 / 1024).toFixed(2)),
    entries: total,
    hasLauncher: names.filter(n => /^启动\.(bat|sh)$/.test(n)),
  }
}

// ---------- 主流程 ----------
rmSync(BUILD_TMP, { recursive: true, force: true })
mkdirSync(BUILD_TMP, { recursive: true })

const reports = []

for (const v of VARIANTS) {
  const dir = path.join(BUILD_TMP, v.id)
  mkdirSync(dir, { recursive: true })
  // ① 前端产物
  const distStat = copyTree(DIST_DIR, path.join(dir, 'dist'))
  // ② 本地服务源码（回退路径与"这套东西是什么"的可读凭证）
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  copyFileSync(path.join(root, 'scripts', 'portable-server.mjs'), path.join(dir, 'scripts', 'portable-server.mjs'))
  // ③ 本平台的启动脚本
  for (const s of v.scripts) {
    const src = path.join(PORTABLE_SRC, s)
    if (!existsSync(src)) fail(`portable/${s} 不存在`)
    copyFileSync(src, path.join(dir, s))
  }
  // ④ 使用说明
  copyFileSync(path.join(PORTABLE_SRC, README_NAME), path.join(dir, README_NAME))

  log('')
  log(`① ${v.id}：dist/ ${distStat.files} 个文件（${(distStat.bytes / 1024 / 1024).toFixed(2)} MB）`
    + ` · 启动脚本 ${v.scripts.join(' / ')}（${v.launcher}）`)
  log(`② 待打包条目：${walk(dir).length} 个`)

  reports.push(packAndVerify(dir, path.join(OUT_DIR, v.zipName), v.id))
}

// 打完即删：release/ 只留最终交付物。调试时显式 --keep-build 才保留临时目录。
if (ARGS.keepBuild) log(`保留组装目录（debug）：${BUILD_TMP}`)
else rmSync(BUILD_TMP, { recursive: true, force: true })

log('')
log('==================================================')
log(`  便携版打包完成 · ${ARGS.version}`)
for (const r of reports) log(`  ${r.label}：${r.zipMB} MB · ${r.entries} 条目 · ${r.hasLauncher.join(' / ') || '(无启动脚本!)'}`)
log('==================================================')
