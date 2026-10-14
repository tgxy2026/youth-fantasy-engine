// ============ 便携版组装与打包（scripts/build-portable-pkg.mjs）============
//
// 【它是什么】把便携版的全套文件组装成一个可直接分发的 zip：
//   ① 免安装运行时（`青春幻想引擎-便携版.exe`，由 build-portable-server.mjs 产出）
//   ② 前端产物 `dist/`
//   ③ 本地服务源码 `scripts/portable-server.mjs`（保留 —— exe 被安全软件拦下时 bat 会回退到它）
//   ④ 启动脚本 + 使用说明
//
// 【为什么要自己写 zip 写入器，而不用外部工具】
//   🔴 本项目踩过两次 zip 的编码坑（见 memory/2026-08/09 与 3.0.2 发布记录）：
//      · `Compress-Archive` 会写出**反斜杠条目名**，且非 ASCII 名按 GBK 落盘 ⇒ 跨机器乱码；
//      · 外部 7za 依赖 electron-builder 缓存目录，**换台机器路径就变**，不可复现。
//   ⇒ 改为**纯 Node 实现**（zlib 是内置的）：零外部进程、跨平台一致，
//      并且能**显式**把 UTF-8 标志位（general purpose bit 11）写对 —— 这是中文条目名的关键。
//
// 【用法】
//   node scripts/build-portable-pkg.mjs                 # 版本号取 package.json；**默认产出两个 zip**
//   node scripts/build-portable-pkg.mjs --version 3.0.3
//   node scripts/build-portable-pkg.mjs --no-zip        # 只组装目录，不压缩（调试用）
//   node scripts/build-portable-pkg.mjs --no-node       # 跳过「含 Node 运行时」版，只出标准 zip
//
// 【产物】
//   release/便携版-<版本>/                        ← 组装好的分发包目录（**标准版、不含 Node 安装包**）
//   release/桌面安装版/青春幻想引擎-便携版-<版本>.zip                 ← 标准版交付物（约 39MB）
//   release/桌面安装版/青春幻想引擎-便携版-<版本>-含Node运行时.zip     ← 含 Node 安装包的交付物（约 122MB）
//   release/便携版-<版本>.zip-report.json          ← 打包报告（条目数 / 体积 / 编码校验）
//
// 【为什么默认产出两个 zip】
//   Windows 版是**免安装**的（Node 已内嵌进 exe）⇒ 给 Windows 用户一个 39MB 的小包就够；
//   而 macOS / Linux 仍需用户自备 Node，把安装包内置进去能让那些平台的用户"解压即装"。
//   但 macOS 的 .pkg 有 84MB 且压缩率仅 99% —— 若合成一个包，所有 Windows 用户都要白多下 83MB。
//   ⇒ 拆成两个：标准版（默认下载）+ 含Node版（mac 用户 / 需要回退路径的用户下载）。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, copyFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

function parseArgs(argv) {
  const out = { version: pkg.version, zip: true, withNode: true }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') out.version = argv[++i]
    else if (argv[i] === '--no-zip') out.zip = false
    else if (argv[i] === '--no-node') out.withNode = false
  }
  return out
}
const ARGS = parseArgs(process.argv.slice(2))

function log(...a) { console.log('[build:portable-pkg]', ...a) }
function fail(msg) { console.error('[build:portable-pkg] ❌', msg); process.exit(1) }

const PORTABLE_SRC = path.join(root, 'portable')
const DIST_DIR = path.join(root, 'dist')
const RUNTIME_EXE = path.join(root, 'release', '便携版运行时', '青春幻想引擎-便携版.exe')
const PKG_DIR = path.join(root, 'release', `便携版-${ARGS.version}`)
const ZIP_DIR = path.join(root, 'release', '桌面安装版')
const ZIP_PATH = path.join(ZIP_DIR, `青春幻想引擎-便携版-${ARGS.version}.zip`)
const ZIP_WITH_NODE_PATH = path.join(ZIP_DIR, `青春幻想引擎-便携版-${ARGS.version}-含Node运行时.zip`)
/** Node 安装包放置目录（由 fetch-node-installer.mjs 下载填充） */
const ASSETS_DIR = path.join(root, 'release', 'portable-assets')
/** 组装包内的子目录名（中文名，用户一眼看懂） */
const NODE_SUBDIR = 'Node运行时安装包'

// ---------- 前置检查 ----------
if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
  fail(`未找到前端产物：${DIST_DIR}\\index.html\n  请先执行：npm run build:portable`)
}
if (!existsSync(RUNTIME_EXE)) {
  fail(
    `未找到免安装运行时：${RUNTIME_EXE}\n` +
    `  请先执行：npm run build:portable-server`,
  )
}

// ---------- ① 组装目录 ----------
log(`① 组装 release/便携版-${ARGS.version}/`)
// 组装前清掉旧目录：免得上一轮的残留文件混进新包（zip 是"快照"，不是增量）
rmSync(PKG_DIR, { recursive: true, force: true })
mkdirSync(PKG_DIR, { recursive: true })

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true })
  let files = 0
  let bytes = 0
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) {
      const r = copyTree(s, d)
      files += r.files
      bytes += r.bytes
    } else {
      const buf = readFileSync(s)
      writeFileSync(d, buf)
      files++
      bytes += buf.length
    }
  }
  return { files, bytes }
}

// 启动脚本 + 使用说明（来自 portable/ 源目录）
for (const name of ['启动.bat', '启动.sh', '使用说明.txt']) {
  const s = path.join(PORTABLE_SRC, name)
  if (!existsSync(s)) fail(`缺少 ${name}（应在 portable/ 目录里）`)
  writeFileSync(path.join(PKG_DIR, name), readFileSync(s))
}
// 本地服务源码（回退路径用；也是"这套东西是什么"的可读凭证）
mkdirSync(path.join(PKG_DIR, 'scripts'), { recursive: true })
writeFileSync(
  path.join(PKG_DIR, 'scripts', 'portable-server.mjs'),
  readFileSync(path.join(root, 'scripts', 'portable-server.mjs')),
)
// 前端产物
const distStat = copyTree(DIST_DIR, path.join(PKG_DIR, 'dist'))
// 免安装运行时
writeFileSync(path.join(PKG_DIR, path.basename(RUNTIME_EXE)), readFileSync(RUNTIME_EXE))
log(`   dist/ ${distStat.files} 个文件 · ${(distStat.bytes / 1024 / 1024).toFixed(2)} MB`)

// ---------- ② 收集条目 ----------
function walk(dir, base = '') {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel))
    else out.push({ rel, abs: path.join(dir, e.name) })
  }
  return out
}
const entries = walk(PKG_DIR)
log(`② 待打包条目：${entries.length} 个`)
// 注：真正的条目收集在 packAndVerify 里现取（含Node版要多一层安装包目录）

// ---------- ③ 纯 Node zip 写入器 ----------
//
// 只实现我们需要的子集：deflate 压缩、**固定写 UTF-8 标志位**、无 zip64（单包远小于 4GB）。
// 刻意不做目录条目 —— 条目名里的 `/` 已足够让所有解压器建出目录树。
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
/** DOS 日期时间（zip 用的老格式：秒只有 2 秒精度） */
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
    // 压缩没赚到就退回 store（zip 规范允许，且解压器都支持）
    const useDeflate = deflated.length < raw.length
    const data = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0

    // 通用位标记：bit 11 = 0x0800 ⇒ 文件名是 UTF-8（中文条目的关键）
    const flags = 0x0800

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)   // local file header signature
    lh.writeUInt16LE(20, 4)           // version needed to extract (2.0)
    lh.writeUInt16LE(flags, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)           // extra length
    localParts.push(lh, nameBuf, data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)   // central directory header signature
    ch.writeUInt16LE(20, 4)           // version made by
    ch.writeUInt16LE(20, 6)           // version needed
    ch.writeUInt16LE(flags, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(time, 12)
    ch.writeUInt16LE(date, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30)           // extra length
    ch.writeUInt16LE(0, 32)           // comment length
    ch.writeUInt16LE(0, 34)           // disk number start
    ch.writeUInt16LE(0, 36)           // internal attributes
    // external attributes: 普通文件 644。🔴 必须 `>>> 0` ——
    // JS 的 `<<` 是**有符号** 32 位运算，`0o100644 << 16` 会变成负数，writeUInt32LE 直接抛错。
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    ch.writeUInt32LE(offset, 42)      // 相对本 zip 起点的 local header 偏移
    centralParts.push(ch, nameBuf)

    offset += lh.length + nameBuf.length + data.length
  }

  const centralBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)   // end of central directory signature
  eocd.writeUInt16LE(0, 4)            // 本磁盘号
  eocd.writeUInt16LE(0, 6)            // 起始磁盘号
  eocd.writeUInt16LE(files.length, 8) // 本磁盘条目数
  eocd.writeUInt16LE(files.length, 10) // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)           // 注释长度

  return Buffer.concat([...localParts, centralBuf, eocd])
}

// ---------- ④ 压缩 + ⑤ 自校验（两个 zip 复用同一套）----------
/** 打包并自校验；返回报告对象（失败即 fail，不留半成品） */
function packAndVerify(zipPath, label) {
  log(`③ 压缩（${label} · 纯 Node zip 写入器，UTF-8 条目名）`)
  mkdirSync(ZIP_DIR, { recursive: true })
  const t0 = Date.now()
  const zipBuf = buildZip(walk(PKG_DIR))
  writeFileSync(zipPath, zipBuf)
  log(`   → ${zipPath} · ${(zipBuf.length / 1024 / 1024).toFixed(2)} MB · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  log('④ 自校验 zip（central directory 逐条验 UTF-8 标志位与条目名）')
  const buf = readFileSync(zipPath)
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocdPos < 0) fail(`${label}：zip 里找不到 EOCD（文件不完整）`)
  const total = buf.readUInt16LE(eocdPos + 10)
  let p = buf.readUInt32LE(eocdPos + 16)
  const bad = []
  let utf8Count = 0
  let backslash = 0
  const names = []
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
  const okAll = bad.length === 0 && utf8Count === total && backslash === 0
  log(`   条目 ${total} 个 · UTF-8 标志位 ${utf8Count}/${total} · 反斜杠条目 ${backslash}`)
  if (!okAll) fail(`${label}：编码校验未通过\n   ${bad.slice(0, 5).join('\n   ')}`)
  log('   ✅ 编码校验通过')

  return {
    label,
    zipPath,
    zipBytes: statSync(zipPath).size,
    zipMB: Number((statSync(zipPath).size / 1024 / 1024).toFixed(2)),
    entries: total,
    utf8Flagged: utf8Count,
    backslashEntries: backslash,
    containsNodeInstaller: names.some(n => n.startsWith(`${NODE_SUBDIR}/`)),
    nodeInstallerFiles: names.filter(n => n.startsWith(`${NODE_SUBDIR}/`)),
  }
}

const reports = []

// ---------- ④a 标准版 zip（39MB，Windows 用户默认下载这个）----------
if (ARGS.zip) {
  reports.push(packAndVerify(ZIP_PATH, '标准版'))
}

// ---------- ④b 含 Node 运行时版（macOS / Linux 用户下载这个）----------
// 🔴 做法是「往同一个组装目录里临时加一层、打完再撤」，避免为它再复制一整份 93MB 的目录。
//    撤掉的目的是让 release/便携版-<版本>/ 始终保持标准版形态（可直接给人拷贝/测试）。
if (ARGS.zip && ARGS.withNode) {
  const installers = existsSync(ASSETS_DIR)
    ? readdirSync(ASSETS_DIR).filter(f => /\.(pkg|msi)$/i.test(f))
    : []
  if (installers.length === 0) {
    log('')
    log(`   ℹ️ 未发现 Node 安装包（${ASSETS_DIR}），跳过「含Node运行时」版。`)
    log(`      需要它的话先跑：node scripts/fetch-node-installer.mjs`)
  } else {
    const nodeDir = path.join(PKG_DIR, NODE_SUBDIR)
    mkdirSync(nodeDir, { recursive: true })
    for (const f of installers) {
      copyFileSync(path.join(ASSETS_DIR, f), path.join(nodeDir, f))
      log(`   内置安装包：${f}（${(statSync(path.join(nodeDir, f)).size / 1048576).toFixed(1)} MB）`)
    }
    reports.push(packAndVerify(ZIP_WITH_NODE_PATH, '含Node运行时版'))
    // 撤掉，保持组装目录是标准版形态
    rmSync(nodeDir, { recursive: true, force: true })
  }
}

writeFileSync(
  path.join(root, 'release', `便携版-${ARGS.version}.zip-report.json`),
  JSON.stringify({
    version: ARGS.version,
    builtAt: new Date().toISOString(),
    pkgDir: PKG_DIR,
    zips: reports,
  }, null, 2),
)

log('')
log('==================================================')
log(`  便携版组装完成 · ${ARGS.version}`)
log(`  目录：${PKG_DIR}`)
for (const r of reports) {
  log(`  ${r.label}：${r.zipMB} MB · ${r.entries} 条目${r.containsNodeInstaller ? ` · 含 Node 安装包 ${r.nodeInstallerFiles.length} 个` : ''}`)
  log(`     ${r.zipPath}`)
}
log('==================================================')
