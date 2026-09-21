// electron-builder afterPack 钩子：补偿 rcedit 的间歇性失败
//
// 背景：本机 electron-builder 内置的 rcedit（winCodeSign 2.6.0 / 2019 版）在写入主 exe
// 的版本资源时会**随机**报 `Fatal error: Unable to commit changes`（实测成功率约 1/3~3/3 之间浮动，
// 与沙箱、文件占用、路径中英文均无关；推测为安全软件对 PE 资源写入的间歇性拦截）。
// electron-builder 自己重试 3 次就放弃并**继续打包**，于是产物能装能用，但主 exe 的
// 图标与版本信息是 Electron 默认值 —— 看最后一行"打包完成"根本发现不了。
//
// 本钩子在 pack 完成（win-unpacked 已生成）、NSIS 打包之前补跑 rcedit，
// 反复重试并校验，确保图标与元数据真正落进 exe。
//
// ⚠️ rcedit 失败时**退出码仍为 0**，唯一可靠信号是 stderr 里的 "Fatal error" —— 别只看退出码。
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

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const info = context.packager.appInfo
  const productName = info.productName
  const exePath = path.join(context.appOutDir, `${productName}.exe`)
  if (!fs.existsSync(exePath)) {
    console.log(`[after-pack] 未找到主 exe：${exePath}，跳过元数据补偿`)
    return
  }

  const rcedit = findRcedit()
  if (!rcedit) {
    console.warn('[after-pack] ⚠️ 未找到 rcedit，跳过元数据补偿（主 exe 将保留 Electron 默认图标/版本信息）')
    return
  }

  // 图标先复制到纯 ASCII 临时路径：rcedit 对含非 ASCII 的路径偶发失败
  let iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico')
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

  const version = info.version
  const args = [
    exePath,
    '--set-version-string', 'FileDescription', productName,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'LegalCopyright', info.copyright || '',
    '--set-version-string', 'InternalName', productName,
    '--set-version-string', 'CompanyName', info.companyName || '',
    '--set-file-version', version,
    '--set-product-version', `${version}.0`,
    '--set-icon', iconPath,
  ]

  console.log(`[after-pack] 补偿主 exe 元数据与图标：${path.basename(exePath)}`)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = spawnSync(rcedit, args, { encoding: 'utf8', windowsHide: true })
    const stderr = `${r.stderr || ''}${r.stdout || ''}${r.error ? r.error.message : ''}`

    if (!RCEDIT_FATAL.test(stderr)) {
      console.log(`[after-pack] ✅ 元数据与图标写入成功（第 ${attempt}/${MAX_ATTEMPTS} 次尝试）`)
      if (tmpIcon) {
        try {
          fs.unlinkSync(tmpIcon)
        } catch {
          /* 清理失败无碍 */
        }
      }
      return
    }

    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[after-pack] 第 ${attempt} 次写入被拒（${stderr.trim()}），${RETRY_DELAY_MS}ms 后重试...`)
      sleepSync(RETRY_DELAY_MS)
    }
  }

  // 不让打包整体失败：产物仍可用，只是图标/版本信息为默认值
  console.warn(
    `[after-pack] ⚠️ rcedit 连续 ${MAX_ATTEMPTS} 次失败，主 exe 将保留 Electron 默认图标与版本信息。` +
      '（安装包仍可正常使用；如需修正请重跑一次打包）',
  )
}

module.exports = afterPack
module.exports.default = afterPack
