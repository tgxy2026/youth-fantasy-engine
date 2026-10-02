// electron-builder 钩子：给主 exe 补上图标与版本元数据
//
// 🔴🔴 为什么必须挂在 afterAllArtifactBuild（不能是 afterPack）—— 2026-10-02 · 2.7.1 轮实测：
//   2.7.1 封装时本钩子（当时挂 afterPack）日志报「✅ 元数据与图标写入成功（第 1/12 次）」，
//   但验收查 PE 里「青春幻想引擎开发组」= false、版本串 = false，体积 180,849,664
//   （比基线 181,097,984 少 248,320 —— 差值正是图标资源），**打包日志一切正常，看不出来**。
//   手工用同样参数重跑 rcedit 却一次成功、体积精确回到基线 ⇒ rcedit 与参数都没问题，
//   真因是 **electron-builder 24.13.3 在 afterPack 之后、NSIS 之前还会再写一次主 exe**
//   （exe 的 mtime 比 after-pack 日志晚 5 秒），把刚写好的元数据**整体覆盖回默认值**。
//   `signAndEditExecutable: false` 只关掉它改「资源」那步，**关不掉它重写文件本身**。
//   ⇒ 写入时机必须晚于那一步：afterAllArtifactBuild 在所有产物（含 NSIS）都打完之后才触发。
//   ⚠️ 但此时安装包里封的仍是「被覆盖成默认元数据」的 exe ⇒ 还需重打一次安装包
//      （见 scripts/build-desktop.mjs 的说明）。
//
// 🔴🔴 第二个改动：**加写后校验**（原来只看 stderr 有没有 "Fatal error" 就当成功）。
//   本机 rcedit 存在「exit 0、无 Fatal error、但资源根本没写进去」的情形 ——
//   不校验就会像 2.7.1 那样报一句「✅ 成功」然后把坏产物放行。
//   现在每次尝试后都**把 exe 读回来查字符串**，查不到就当这次失败、重试。
//
// ⚠️ rcedit 失败时**退出码仍为 0**，唯一可靠信号是 stderr 里的 "Fatal error" 或下面的写后校验。
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const RCEDIT_FATAL = /Fatal error/i
const MAX_ATTEMPTS = 12
const RETRY_DELAY_MS = 400

/** 同步等待（钩子里是同步流程，避免引入 async 调度不确定性） */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 环境不支持则忽略 */
  }
}

/**
 * 写后校验：把 exe 读回来，确认这些字符串真的进了 PE 资源（UTF-16LE）。
 * 🔴 这是本轮新增的关键防线 —— 光看 rcedit 的退出码/stderr 会漏掉「静默没写」。
 */
function verifyWritten(exePath, expectStrings) {
  let buf
  try {
    buf = fs.readFileSync(exePath)
  } catch {
    return { ok: false, reason: `读不回 exe（${exePath}）` }
  }
  for (const s of expectStrings) {
    if (!s) continue
    if (!buf.includes(Buffer.from(s, 'utf16le'))) {
      return { ok: false, reason: `资源里找不到「${s}」` }
    }
  }
  return { ok: true, size: buf.length }
}

/** 定位 rcedit：优先复用 electron-builder 缓存里的那份（与打包用的是同一个二进制） */
function findRcedit() {
  const roots = []
  if (process.env.ELECTRON_BUILDER_CACHE) {
    roots.push(path.join(process.env.ELECTRON_BUILDER_CACHE, 'winCodeSign'))
  }
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign'))
  }
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    let subs = []
    try {
      subs = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const sub of subs) {
      for (const bin of ['rcedit-x64.exe', 'rcedit-ia32.exe']) {
        const p = path.join(root, sub, bin)
        if (fs.existsSync(p)) return p
      }
    }
  }
  return null
}

/**
 * afterAllArtifactBuild 钩子主函数。
 *
 * 🔴 该钩子的上下文**与 afterPack 完全不同**（2026-10-02 实测确认）：
 *   afterPack  给的是 `{ electronPlatformName, appOutDir, packager }`
 *   afterAllArtifactBuild 给的是 **`buildResult`** = `{ artifactPaths, platformToTargets, configuration }`
 *   —— **没有 `packager`、没有 `appOutDir`**。照抄 afterPack 的取法会直接拿到 undefined。
 *   ⇒ productName 从 `configuration` 取，win-unpacked 目录从 `artifactPaths[0]` 反推。
 */
async function afterAllArtifactBuild(context) {
  const configuration = (context && context.configuration) || {}
  const artifactPaths = (context && context.artifactPaths) || []

  // 只处理 Windows 产物（本项目只出桌面版）
  const platforms = Object.keys((context && context.platformToTargets) || {})
  if (platforms.length && !platforms.includes('win32')) {
    console.log(`[after-pack] 平台为 ${platforms.join(',')}，跳过（只处理 win32）`)
    return
  }

  const productName = configuration.productName || '青春幻想引擎'
  // win-unpacked 目录 = 任一产物（Setup.exe）所在目录；产物在 <output>/ 下，故取其父目录
  const setupPath = artifactPaths.find(p => String(p).toLowerCase().endsWith('.exe'))
  const outDir = setupPath ? path.dirname(setupPath) : path.join(process.cwd(), 'release')
  const exePath = path.join(outDir, 'win-unpacked', `${productName}.exe`)

  if (!fs.existsSync(exePath)) {
    console.warn(`[after-pack] 未找到主 exe：${exePath}，跳过元数据写入`)
    return
  }

  const rcedit = findRcedit()
  if (!rcedit) {
    console.warn('[after-pack] ⚠️ 未找到 rcedit，跳过元数据写入（主 exe 将保留 Electron 默认图标/版本信息）')
    return
  }

  // 图标先复制到纯 ASCII 临时路径：rcedit 对含非 ASCII 的路径偶发失败
  const projectDir = configuration.projectDir || process.cwd()
  let iconPath = path.join(projectDir, 'build', 'icon.ico')
  let tmpIcon = ''
  try {
    if (fs.existsSync(iconPath)) {
      tmpIcon = path.join(os.tmpdir(), `yfe-icon-${process.pid}.ico`)
      fs.copyFileSync(iconPath, tmpIcon)
      iconPath = tmpIcon
    }
  } catch {
    /* 复制失败则用原路径 */
  }

  // 版本号：优先取配置里的，取不到就读 package.json（configuration.version 未必存在）
  let version = configuration.version
  if (!version) {
    try {
      version = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).version
    } catch {
      version = '0.0.0'
    }
  }
  const args = [
    exePath,
    '--set-version-string', 'FileDescription', productName,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'LegalCopyright', configuration.copyright || '',
    '--set-version-string', 'InternalName', productName,
    '--set-version-string', 'CompanyName', '青春幻想引擎开发组',
    '--set-file-version', version,
    '--set-product-version', `${version}.0`,
    '--set-icon', iconPath,
  ]

  // 写后校验必须能查到的串：公司名（= 开发组）、产品名、版本号。
  // 🔴 少了这层校验，rcedit 的「exit 0 且无 Fatal error」会被当成成功，把默认元数据的坏 exe 放行。
  // ⚠️ 本项目 electron-builder.yml **没配 companyName**，故固定用验收基准的「青春幻想引擎开发组」——
  //    若这里改成从配置取（会是空串），expectStrings 就少一项、校验形同虚设。
  const expectStrings = ['青春幻想引擎开发组', productName, version].filter(Boolean)

  console.log(`[after-pack] 写入主 exe 元数据与图标：${path.basename(exePath)}（${expectStrings.join(' / ')}）`)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = spawnSync(rcedit, args, { encoding: 'utf8', windowsHide: true })
    const stderr = `${r.stderr || ''}${r.stdout || ''}${r.error ? r.error.message : ''}`
    const fatal = RCEDIT_FATAL.test(stderr)

    /**
     * 🔴🔴 判据**只看写后校验**，退出码与 stderr 一律不作为判据（2026-10-02 实测）。
     *
     * 本环境里 `spawnSync(rcedit, …)` 会返回 `{ status: null, error: { code: 'EBUSY' } }` ——
     * 即**父进程被系统拦成 EBUSY、拿不到子进程退出码**，但 **rcedit 实际已经执行完毕、
     * 资源也真的写进 exe 了**。此时若按旧判据（stderr 里没有 "Fatal error" 就当成功、
     * 或反过来把 null 当失败去重试），就会：
     *   · 旧版（只看 stderr）→ 误判成功（其实可能真没写进去，2.7.1 首轮就是这种坏产物）；
     *   · 现在这样把 EBUSY 当失败 → 明明写成功了却报「补写失败」。
     *
     * ⇒ 唯一可靠信号是**把 exe 读回来查那几串字符串**（PE 资源里是 UTF-16LE）。
     *    写进去了就是成功，写不进去才重试；EBUSY / status=null 一律忽略。
     */
    const v = verifyWritten(exePath, expectStrings)
    if (v.ok) {
      const note = r.status === null ? '（rcedit 启动返回 EBUSY，但写后校验通过 —— 以 PE 实际内容为准）' : ''
      console.log(
        `[after-pack] ✅ 元数据与图标写入成功（第 ${attempt}/${MAX_ATTEMPTS} 次尝试，写后校验通过，体积 ${v.size} 字节）${note}`,
      )
      if (tmpIcon) {
        try {
          fs.unlinkSync(tmpIcon)
        } catch {
          /* 清理失败无碍 */
        }
      }
      return
    }

    const why = fatal ? `rcedit 报错：${stderr.trim().slice(0, 120)}` : `写后校验未通过：${v.reason}`
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[after-pack] 第 ${attempt} 次未成功（${why}），${RETRY_DELAY_MS}ms 后重试...`)
      sleepSync(RETRY_DELAY_MS)
    } else {
      console.warn(`[after-pack] ⚠️ 连续 ${MAX_ATTEMPTS} 次未成功（${why}），主 exe 仍是默认图标/版本信息。`)
    }
  }
}

module.exports = afterAllArtifactBuild
module.exports.default = afterAllArtifactBuild
