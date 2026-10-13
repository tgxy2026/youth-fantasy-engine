// ============ 便携版免安装运行时构建（scripts/build-portable-server.mjs）============
//
// 【它是什么】把 `scripts/portable-server.mjs` 与 **Node 运行时**打包成**单个可执行文件**，
//   让便携版作者**双击即用、本机无需安装 Node**。
//
// 【为什么需要它】便携版的定义是「**免安装使用**」：解压即用、数据随盘走、不写设备。
//   而便携服务是数据落盘的**唯一通道**（浏览器里的 JS 写不了应用目录，见 portable-server.mjs
//   顶部说明），它必须有个 JS 运行时。Node SEA（Single Executable Application）把运行时与
//   脚本合成一个 exe —— 这就是「不装依赖也能用」的正解。
//   （对比：把 Node 安装包塞进 zip 再「唤醒安装程序」——那要管理员权限、写注册表、公司电脑
//     可能被策略拒绝、换台电脑还得再装一遍 ⇒ 那已经不是便携版了。）
//
// 【三步法】
//   ① esbuild 把 ESM 服务打成单文件 CJS（服务只用 node: 内置模块，无第三方依赖）
//   ② `node --experimental-sea-config` 生成 SEA blob（把脚本内嵌进运行时）
//   ③ 写图标/版本信息 → 注入 blob → 产出 exe
//
// 🔴 【两条必须守住的约束（2026-10-13 实测得出，别改回去）】
//   1. **顺序：先写资源、再注入 blob。** 反了资源写不进去 —— 注入后 PE 会多出一个 section。
//   2. **写资源用 resedit（纯 JS），不要用 rcedit.exe。** 实测从 Node 进程 spawn `rcedit.exe`
//      会 **EBUSY**（本机沙箱限制，经 cmd / bash 中转同样失败）；而 `resedit` 是 electron-builder
//      自带的纯 JS PE 资源编辑器（已是本项目依赖），**零外部进程、跨平台一致**，
//      还顺带避开 rcedit 的「路径含中文即失败」那个坑（桌面版主 exe 当年就是被它坑过）。
//
// 【用法】
//   node scripts/build-portable-server.mjs                      # 版本号取 package.json
//   node scripts/build-portable-server.mjs --version 3.0.3
//   node scripts/build-portable-server.mjs --out <路径>
//
// 【退出码】
//   0 = 成功；2 = 需要**外部执行一步**（脚本已打印现成命令），见下。
//
// 【为什么会有退出码 2】
//   第 ② 步要 spawn `node` 自身。个别受限环境（如某些沙箱）会拦截 Node 创建子进程并返回
//   EBUSY。此时脚本会打印一条可直接复制的命令；**执行完再重跑本脚本**，它会自动跳过已生成的
//   blob 继续第 ③ 步。（与桌面版 `build-desktop.mjs` 的「EXIT=2 属设计如此」同一惯例。）
//
// 【产物】
//   release/便携版运行时/青春幻想引擎-便携版.exe   ← 免安装运行时（组装进便携版 zip）
//   release/便携版运行时/build-report.json         ← 构建报告（体积 / 版本 / 时间戳）

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

// SEA 的哨兵熔丝：Node 官方常量，**所有 Node 版本一致**（用于 postject 定位注入点）
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
// 中间产物目录（build/ 下，已被 gitignore 覆盖不到的用 release/；这里放 release 内避免污染源码）
const WORK_DIR = path.join(root, 'release', '便携版运行时', '.sea-build')
const OUT_DIR = path.join(root, 'release', '便携版运行时')

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = { version: pkg.version, out: '' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') out.version = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
  }
  return out
}
const ARGS = parseArgs(process.argv.slice(2))

const isWin = process.platform === 'win32'
const exeName = isWin ? '青春幻想引擎-便携版.exe' : '青春幻想引擎-便携版'
const OUT_EXE = ARGS.out ? path.resolve(ARGS.out) : path.join(OUT_DIR, exeName)

function log(...a) { console.log('[build:portable-server]', ...a) }
function fail(msg, code = 1) { console.error('[build:portable-server] ❌', msg); process.exit(code) }

// ---------- 前置检查 ----------
// 🔴 base 运行时＝**正在跑本脚本的这个 node**（`process.execPath`）。
//    这样「构建用的 Node 版本」与「产物内嵌的 Node 版本」天然一致，不会出现版本错配。
//    ⇒ 升 Node 时只需换构建机的 Node，无需改本脚本（同 build-desktop.mjs 的动态推导口径）。
const NODE_EXE = process.execPath
if (!/node(\.exe)?$/i.test(path.basename(NODE_EXE))) {
  fail(`当前运行时不是 node（${NODE_EXE}），无法作为 SEA base。请用 node 跑本脚本。`)
}
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 20) {
  fail(`SEA 需要 Node 20.6+，当前 ${process.version}。请升级构建机的 Node。`)
}
const ICON = path.join(root, 'build', 'icon.ico')
if (!existsSync(ICON)) fail(`找不到图标：${ICON}`)
const ENTRY = path.join(root, 'scripts', 'portable-server.mjs')
if (!existsSync(ENTRY)) fail(`找不到便携服务：${ENTRY}`)

mkdirSync(WORK_DIR, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

const BUNDLE = path.join(WORK_DIR, 'sea-entry.cjs')
const SEA_CONFIG = path.join(WORK_DIR, 'sea-config.json')
const SEA_BLOB = path.join(WORK_DIR, 'sea-prep.blob')

// ---------- ① esbuild：ESM 服务 → 单文件 CJS ----------
log('① esbuild 打包便携服务 → sea-entry.cjs')
{
  const esbuild = require('esbuild')
  esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',        // SEA 的入口必须是 CJS（Node 22 的 SEA 尚不支持 ESM 入口）
    target: `node${nodeMajor}`,
    outfile: BUNDLE,
    // 源码里 `import.meta.url` 有 try/catch 回退到 process.execPath（SEA 下取 exe 自身路径），
    // 故这里 CJS 化导致的空 import.meta 是**预期且已处理**的，静音掉免得每次构建都刷警告。
    logOverride: { 'empty-import-meta': 'silent' },
    logLevel: 'warning',
  })
}

// ---------- ② 生成 SEA blob ----------
log('② 生成 SEA blob')
writeFileSync(SEA_CONFIG, JSON.stringify({
  main: BUNDLE,
  output: SEA_BLOB,
  disableExperimentalSEAWarning: true,
}, null, 2))

// blob 比 config 新 ⇒ 认为已生成（支持「外部先生成 blob、再重跑本脚本」的分步流程）
const blobFresh = existsSync(SEA_BLOB)
  && statSync(SEA_BLOB).mtimeMs >= statSync(SEA_CONFIG).mtimeMs
if (blobFresh) {
  log('   已存在最新 blob，跳过生成')
} else {
  const r = spawnSync(NODE_EXE, ['--experimental-sea-config', SEA_CONFIG], {
    cwd: root, stdio: 'inherit', shell: false,
  })
  if (r.error || r.status !== 0) {
    // 🔴 受限环境（Node 无法创建子进程）⇒ 打印现成命令，退出码 2 表示「差一步」。
    console.error('')
    console.error('[build:portable-server] ⚠️ 无法自动执行 SEA blob 生成（本机可能限制了 Node 创建子进程）。')
    console.error('    请手动执行下面这一条，然后**重跑本脚本**（它会自动跳过这一步）：')
    console.error('')
    console.error(`      node --experimental-sea-config "${SEA_CONFIG}"`)
    console.error('')
    process.exit(2)
  }
}

// ---------- ③a 复制运行时并移除数字签名 ----------
// 官方 node.exe 带签名；改资源/注入后签名必然失效，留着只会让 postject 报
// 「signature seems corrupted」的警告 ⇒ 先干净地摘掉（纯 JS 操作 PE 头）。
log('③ 复制运行时并移除数字签名')
{
  const b = Buffer.from(readFileSync(NODE_EXE))
  const peOff = b.readUInt32LE(0x3C)
  const magic = b.readUInt16LE(peOff + 24)
  const optOff = peOff + 24
  const dirOff = optOff + (magic === 0x20B ? 112 : 96)  // PE32+ 用 112，PE32 用 96
  const certOff = b.readUInt32LE(dirOff + 4 * 8)
  const certSize = b.readUInt32LE(dirOff + 4 * 8 + 4)
  if (certSize > 0 && certOff > 0 && certOff < b.length) {
    b.writeUInt32LE(0, dirOff + 4 * 8)      // 清空 Certificate Table 目录项
    b.writeUInt32LE(0, dirOff + 4 * 8 + 4)
    writeFileSync(OUT_EXE, b.subarray(0, certOff))
    log(`   已摘除签名（${b.length} → ${certOff} 字节）`)
  } else {
    writeFileSync(OUT_EXE, b)
    log('   base 无签名，直接复制')
  }
}

// ---------- ③b resedit 写图标与版本信息（纯 JS，先于注入）----------
log('③ 写入图标与版本信息（resedit）')
{
  const ResEdit = require('resedit')
  const exe = ResEdit.NtExecutable.from(readFileSync(OUT_EXE), { ignoreCert: true })
  const res = ResEdit.NtExecutableResource.from(exe)

  // 版本信息：中英两种语言块都写（中文 Windows 读 2052、其他读 1033，各取所需）
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0]
  if (!vi) fail('PE 里找不到版本信息资源，无法写入版本信息')
  const strings = {
    ProductName: '青春幻想引擎',
    FileDescription: '青春幻想引擎 便携版',
    CompanyName: '青春幻想引擎开发组',
    InternalName: '青春幻想引擎',
    OriginalFilename: exeName,
    LegalCopyright: '青春幻想引擎开发组',
  }
  for (const lang of [{ lang: 1033, codepage: 1200 }, { lang: 2052, codepage: 1200 }]) {
    vi.setStringValues(lang, strings)
  }
  // 版本号四段式：package.json 的 "3.0.2" → 3.0.2.0
  const seg = String(ARGS.version).split('.').map(n => Number(n) || 0)
  vi.setFileVersion(seg[0] ?? 0, seg[1] ?? 0, seg[2] ?? 0, seg[3] ?? 0)
  vi.setProductVersion(seg[0] ?? 0, seg[1] ?? 0, seg[2] ?? 0, seg[3] ?? 0)
  vi.outputToResourceEntries(res.entries)

  // 图标：替换 1 号图标组（Electron/node 的可执行文件默认都有）
  const iconFile = ResEdit.Data.IconFile.from(readFileSync(ICON))
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries, 1, 1033, iconFile.icons.map(i => i.data),
  )

  res.outputResource(exe)
  writeFileSync(OUT_EXE, Buffer.from(exe.generate()))
  log(`   已写入（体积 ${statSync(OUT_EXE).size} 字节）`)
}

// ---------- ③c postject 注入 SEA blob（纯 JS API，后于写资源）----------
log('③ 注入 SEA blob（postject）')
{
  const { inject } = require('postject')
  await inject(OUT_EXE, 'NODE_SEA_BLOB', readFileSync(SEA_BLOB), { sentinelFuse: SENTINEL_FUSE })
}

// ---------- 校验 ----------
const finalBytes = readFileSync(OUT_EXE)
const checks = [
  ['公司名（青春幻想引擎开发组）', finalBytes.includes(Buffer.from('青春幻想引擎开发组', 'utf16le'))],
  ['产品描述（青春幻想引擎 便携版）', finalBytes.includes(Buffer.from('青春幻想引擎 便携版', 'utf16le'))],
  ['版本号（' + ARGS.version + '.0）', finalBytes.includes(Buffer.from(`${ARGS.version}.0`, 'utf16le'))],
  ['SEA 内嵌脚本', finalBytes.includes(Buffer.from('portable-data', 'utf8'))],
]
let allOk = true
for (const [name, ok] of checks) {
  log(`   ${ok ? '✅' : '❌'} ${name}`)
  if (!ok) allOk = false
}

const report = {
  version: ARGS.version,
  builtAt: new Date().toISOString(),
  baseRuntime: path.basename(NODE_EXE),
  baseRuntimeVersion: process.version,
  exeBytes: finalBytes.length,
  exeMB: Number((finalBytes.length / 1024 / 1024).toFixed(2)),
  outPath: OUT_EXE,
  checksPassed: allOk,
}
writeFileSync(path.join(OUT_DIR, 'build-report.json'), JSON.stringify(report, null, 2))

log('')
log('==================================================')
log(`  便携版免安装运行时构建完成`)
log(`  产物：${OUT_EXE}`)
log(`  体积：${report.exeMB} MB（内嵌 ${report.baseRuntimeVersion} 运行时）`)
log(`  版本：${ARGS.version}`)
log('==================================================')
if (!allOk) fail('产物校验未全部通过，请检查上面的 ❌ 项')
