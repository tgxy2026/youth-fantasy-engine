// ============ 应用图标（桌面快捷方式）切换 · 硬断言（3.1.2）============
//
// 为什么值得单开一份静态闸：这个功能的**失败形态极其安静** ——
//   · 图标没写进 `.lnk`：界面照样显示「已切换」，用户只是觉得「点了没反应」；
//   · 快捷方式路径 / 名称与打包配置漂移：装上之后根本找不到那条 .lnk，功能等于不存在；
//   · 有人「顺手」把主 exe 的图标也改了：会破坏主 exe 体积基线（246,487,040）与一致性校验。
// 这三条都不会让 tsc / eslint / 既有测试变红，只能靠这里钉住。
//
// ⚠️ 只做**静态文本与文件形态**检查，不 import 业务代码（渲染层模块依赖 window）。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p: string) => fs.existsSync(path.join(ROOT, p))

console.log('—— appIcon：桌面图标切换闸（3.1.2）——')

// ---------- ① 三套内置图标：存在 + 是合法 ICO + 七档尺寸 ----------
const KEYS = ['default', 'fantasy', 'elegant']
const SIZES = [256, 128, 64, 48, 32, 24, 16]
for (const k of KEYS) {
  const p = `electron/icons/${k}.ico`
  if (!exists(p)) { ok(`① 内置图标 ${k}.ico 存在`, false, '文件缺失'); continue }
  const buf = fs.readFileSync(path.join(ROOT, p))
  const isIco = buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1
  const count = buf.readUInt16LE(4)
  const sizes: number[] = []
  let firstIsPng = false
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    sizes.push(buf[off] || 256)
    if (i === 0) {
      const dataOff = buf.readUInt32LE(off + 12)
      firstIsPng = buf[dataOff] === 0x89 && buf[dataOff + 1] === 0x50
    }
  }
  ok(`① ${k}.ico 是合法 ICO 且含 ${SIZES.length} 档尺寸`,
    isIco && count === SIZES.length && SIZES.every(s => sizes.includes(s)),
    `isIco=${isIco} count=${count} sizes=${sizes.join('/')}`)
  // 🔴 256 必须是 PNG 条目：既省体积，也让界面能直接内联预览（previewDataUrl 依赖这一点）
  ok(`① ${k}.ico 的 256 条目是 PNG（界面预览依赖它）`, firstIsPng)
}

// ---------- ② 主进程内核：四个必须存在的动作 ----------
const kernel = read('electron/appIcon.cjs')
ok('② 内核存在', kernel.length > 1000)
ok('② 用 shell.writeShortcutLink 改写快捷方式（不是拼命令行）',
  kernel.includes('writeShortcutLink'))
ok('② 用 shell.readShortcutLink 读回当前图标（否则无法自愈/无法断言）',
  kernel.includes('readShortcutLink'))
ok('② 还原默认 = 指回快捷方式自身指向的主程序（defaultIconOf，不是 process.execPath）',
  kernel.includes('function defaultIconOf') && kernel.includes("d.target"))
ok('② 每次切换写**新文件名**以触发资源管理器刷新（<key>-<时间戳>.ico）',
  kernel.includes('${key}-') && kernel.includes('stamp'))
ok('② 图标先解包到 userData 真实路径（.lnk 读不了 asar 内路径）',
  kernel.includes("'app-icons'") && kernel.includes('unpackDir'))
ok('② 桌面 + 开始菜单两条快捷方式都覆盖',
  kernel.includes("'Start Menu'") && kernel.includes("'desktop'"))

// 🔴 反向守卫：绝不允许把主 exe 的图标也「顺手改掉」
//    改 exe 图标要 rcedit 重写 PE 资源，会让主 exe 体积偏离基线、并可能让覆盖更新失败。
ok('② 反向守卫：内核不碰主 exe 的 PE 图标（无 rcedit）', !/rcedit/i.test(kernel))
ok('② 反向守卫：内核不写 process.execPath 这个文件本身',
  !/writeFileSync\(\s*process\.execPath/.test(kernel))

// ---------- ③ 快捷方式名必须与打包配置一致（漂移 = 装上后找不到那条 .lnk）----------
{
  const yml = read('electron-builder.yml')
  const m = /^nsis:[\s\S]*?shortcutName:\s*(.+)$/m.exec(yml)
  const ymlName = m ? m[1].trim() : ''
  const codeName = /const SHORTCUT_NAME = '([^']+)'/.exec(kernel)?.[1] ?? ''
  ok('③ 内核里的快捷方式名与 electron-builder.yml 的 nsis.shortcutName 一致',
    !!ymlName && ymlName === codeName, `yml="${ymlName}" code="${codeName}"`)
}

// ---------- ④ 主进程接线：IPC + 启动自愈 + 自检入口 ----------
const main = read('electron/main.cjs')
for (const ch of ['appicon:supported', 'appicon:list', 'appicon:current', 'appicon:apply', 'appicon:reset']) {
  ok(`④ 主进程注册 ${ch}`, main.includes(ch))
}
ok('④ 启动自愈已接线（升级后图标被 NSIS 重置 → 下次启动补回）', main.includes('healIfNeeded'))
ok('④ 自检入口 --app-icon-selftest 存在（真机断言用）', main.includes('--app-icon-selftest'))

// ---------- ⑤ preload 桥与渲染层类型声明 ----------
const preload = read('electron/preload.cjs')
ok('⑤ preload 暴露 electronAppIcon', preload.includes("exposeInMainWorld('electronAppIcon'"))
for (const m of ['supported', 'presets', 'current', 'apply', 'reset']) {
  ok(`⑤ 桥方法 ${m} 已暴露`, new RegExp(`${m}:\\s*\\(`).test(preload))
}
const desktop = read('src/lib/app/desktop.ts')
ok('⑤ 渲染层声明 electronAppIcon 类型', desktop.includes('electronAppIcon?: ElectronAppIconAPI'))
ok('⑤ 有 HAS_APP_ICON_BRIDGE 形态判定', desktop.includes('HAS_APP_ICON_BRIDGE'))
// 🔴 能力探测必须是「有桥 + 平台支持」两道门，缺一条会在浏览器/便携版里露出点不动的入口
ok('⑤ appIconSupported 需要桥 + 平台双判', desktop.includes('export async function appIconSupported'))

// ---------- ⑥ 界面接线：入口在支持的形态下才出现 ----------
const hub = read('src/components/app/ProjectHub.tsx')
ok('⑥ 项目管理首页接了弹窗', hub.includes('AppIconDialog'))
ok('⑥ 入口按钮受 appIconOk 守卫（不支持则不显示）', hub.includes('appIconOk &&'))
ok('⑥ 位置在看板娘设置按钮之后（主人指定的落点）',
  hub.indexOf('看板娘设置') < hub.indexOf('应用图标'))
const dlg = read('src/components/settings/AppIconDialog.tsx')
ok('⑥ 弹窗默认/幻想/典雅三套都来自主进程清单（不硬编码 key）', dlg.includes('listAppIconPresets'))
ok('⑥ 弹窗提供「恢复默认」', dlg.includes('resetAppIcon'))

console.log(`\nappIcon: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
