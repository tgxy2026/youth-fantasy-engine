// 3.3.4 · C4 端能力契约 · 单测
//
// 盯六件事（都是规划 §6 写死的口径，改判据前先改这里）：
//   ① 三形态各自的能力矩阵与「通道」正确，且**不靠取反猜平台**；
//   ② 「产品策略禁用」与「平台不具备」必须是两个原因码 —— 网页脚本机模型是最典型的例子；
//   ③ 判序：先策略后能力（平台有条件可达也不能越过 P9）；
//   ④ 桥要逐个探：有 store 不等于有 exportPdf，桌面缺 electronBoss 不许退化成「遮挡」；
//   ⑤ 离线三段分开：已加载可编辑 / 冷启动 / 保存落盘，不能由 local-first 推出冷启动可用；
//   ⑥ canDo 对 unsupported / unknown 一律 false，避免「按钮灰了但代码还能跑」。
import fs from 'node:fs'
import path from 'node:path'
import {
  resolveCapabilities, capabilityOf, canDo, isFixableGap, CAPABILITY_LABEL, STATUS_LABEL,
  type CapabilitySignals,
} from '@/lib/app/capabilities'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 桌面安装版：桥齐全、本机模型可用、同步走云盘目录 */
const desktopSignals = (over: Partial<CapabilitySignals> = {}): CapabilitySignals => ({
  web: false, guest: false, cloud: false, desktop: true, portable: false,
  bossMode: 'desktop',
  bridgeStore: true, bridgeNet: true, bridgePdf: true,
  fullscreenApi: false, downloadApi: true, online: true, syncChannel: 'file',
  ...over,
})

/** 网页 · 云端账号：服务端注入 WEB + PORTABLE，同步走服务器 */
const cloudSignals = (over: Partial<CapabilitySignals> = {}): CapabilitySignals => ({
  web: true, guest: false, cloud: true, desktop: false, portable: true,
  bossMode: 'overlay',
  bridgeStore: false, bridgeNet: false, bridgePdf: false,
  fullscreenApi: true, downloadApi: true, online: true, syncChannel: 'server',
  ...over,
})

/** 网页 · 游客：数据在浏览器 IDB，没有账号 */
const guestSignals = (over: Partial<CapabilitySignals> = {}): CapabilitySignals => ({
  web: true, guest: true, cloud: false, desktop: false, portable: false,
  bossMode: 'overlay',
  bridgeStore: false, bridgeNet: false, bridgePdf: false,
  fullscreenApi: true, downloadApi: true, online: true, syncChannel: 'none',
  ...over,
})

function main() {
  // ——— ① 桌面形态 ———
  {
    const m = resolveCapabilities(desktopSignals())
    ok('桌面：老板键走窗口隐藏（electron-ipc）',
      m['boss-key'].status === 'supported' && m['boss-key'].channel === 'electron-ipc'
      && canDo(m['boss-key'], 'hide-window'))
    ok('桌面：PDF 走主进程直接落盘', m['pdf-export'].status === 'supported' && m['pdf-export'].channel === 'electron-ipc')
    ok('桌面：本机模型可用（不是策略禁用）',
      m['local-model'].status === 'supported' && m['local-model'].reason === 'ok')
    ok('桌面：断网冷启动可用（数据在本机文件）', m['offline-cold-start'].status === 'supported')
    ok('桌面：选过同步目录即支持跨设备，通道是云盘文件',
      m['cloud-sync'].status === 'supported' && m['cloud-sync'].channel === 'file-share')
    ok('桌面：未选同步目录时是 unknown/unverified，不能报 supported',
      resolveCapabilities(desktopSignals({ syncChannel: 'none' }))['cloud-sync'].status === 'unknown')
  }

  // ——— ② 网页云端：策略 vs 平台，是两回事 ———
  {
    const m = resolveCapabilities(cloudSignals())
    ok('网页云端：本机模型是 policy-blocked（策略不给，不是平台没有）',
      m['local-model'].status === 'unsupported' && m['local-model'].reason === 'policy-blocked')
    ok('网页云端：本机模型的说明里明确写「网页版不提供」且给替代出口',
      /网页版不提供/.test(m['local-model'].detail) && /桌面版 \/ 便携版/.test(m['local-model'].detail))
    ok('网页云端：同步走服务器', m['cloud-sync'].status === 'supported' && m['cloud-sync'].channel === 'server-http')
    ok('网页云端：老板键只有遮挡，且状态是 conditional（要页面有焦点）',
      m['boss-key'].status === 'conditional' && m['boss-key'].channel === 'browser-api'
      && m['boss-key'].fallback === 'focus-page')
    ok('网页云端：断网冷启动需要联网（不承诺离线冷启动）',
      m['offline-cold-start'].status === 'conditional' && m['offline-cold-start'].reason === 'needs-online')
    ok('网页云端：断网时保存是 conditional/needs-online，回退是恢复后重试',
      (() => {
        const c = resolveCapabilities(cloudSignals({ online: false }))['durable-save']
        return c.status === 'conditional' && c.reason === 'needs-online' && c.fallback === 'retry-when-online'
      })())
    ok('网页云端：联网时保存是 supported', m['durable-save'].status === 'supported')
  }

  // ——— ③ 游客：没有账号就没有跨设备 ———
  {
    const m = resolveCapabilities(guestSignals())
    ok('游客：跨设备同步是 needs-account（可修的缺口，不是"平台不支持"）',
      m['cloud-sync'].status === 'unsupported' && m['cloud-sync'].reason === 'needs-account'
      && isFixableGap(m['cloud-sync'].reason))
    ok('游客：本地数据断网也能冷启动', m['offline-cold-start'].status === 'supported'
      && m['offline-cold-start'].channel === 'local-store')
    ok('游客：页面已加载仍可编辑（与能否落盘分开）', m['offline-edit'].status === 'supported')
    ok('游客：本机模型同样是 policy-blocked', m['local-model'].reason === 'policy-blocked')
  }

  // ——— ④ 桥要逐个探，不许一颗子推全局 ———
  {
    const oldShell = resolveCapabilities(desktopSignals({ bossMode: 'unsupported' }))
    ok('桌面旧 preload 缺 electronBoss：老板键 unsupported，**不许**退化成遮挡',
      oldShell['boss-key'].status === 'unsupported' && oldShell['boss-key'].channel === 'none')

    const noPdf = resolveCapabilities(desktopSignals({ bridgeStore: true, bridgePdf: false }))
    ok('有 store 但没有 exportPdf：PDF 不能报 supported',
      noPdf['pdf-export'].status !== 'supported')
  }

  // ——— ⑤ 全屏：有 API 只是「有条件」，没 API 才是不支持且必须给专注模式 ———
  {
    ok('有 Fullscreen API：conditional（API 存在不等于本次获准）',
      capabilityOf('fullscreen', cloudSignals()).status === 'conditional')
    const noApi = capabilityOf('fullscreen', cloudSignals({ fullscreenApi: false }))
    ok('无 Fullscreen API：unsupported + 回退专注模式',
      noApi.status === 'unsupported' && noApi.fallback === 'focus-mode')
    ok('无 API 的说明写「专注模式」且明说它不等于全屏',
      /专注模式/.test(noApi.detail) && /不等同全屏|不等于全屏|不隐藏地址栏/.test(noApi.detail))
  }

  // ——— ⑥ canDo 闸住未确认与不支持 ———
  {
    const m = resolveCapabilities(cloudSignals())
    ok('canDo：unsupported 一律 false', !canDo(m['local-model'], 'use-for-generation'))
    ok('canDo：unknown 一律 false',
      !canDo(capabilityOf('pdf-export', cloudSignals()), 'export-pdf'))
    ok('canDo：supported 且动作在清单里才 true', canDo(m['durable-save'], 'save'))
    ok('canDo：supported 但动作不在清单里也 false', !canDo(m['durable-save'], 'export-pdf'))
  }

  // ——— ⑦ 账本完整性：九项能力都有标签与真话 ———
  {
    const ids = Object.keys(resolveCapabilities(desktopSignals())) as (keyof ReturnType<typeof resolveCapabilities>)[]
    ok('九项能力齐全（规划 §6 至少覆盖的那几类）', ids.length === 9)
    ok('每项都有中文标签', ids.every(id => !!CAPABILITY_LABEL[id]))
    ok('每项都有非空说明（不允许界面出现空白原因）',
      ids.every(id => resolveCapabilities(desktopSignals())[id].detail.trim().length > 8))
    ok('四态都有中文标签', STATUS_LABEL.supported === '支持' && STATUS_LABEL.unknown === '待确认')
    ok('策略禁用不属于「可修」缺口（避免提示去换浏览器）', !isFixableGap('policy-blocked'))
    ok('平台不具备也不属于「可修」缺口', !isFixableGap('platform-missing'))
  }

  // ——— ⑧ 消费者一致：入口 / 设置 / 手册消费同一份解析（3.3.4 · P1 接入）———
  {
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
    const hook = read('src/lib/app/useCapabilities.ts')
    const panel = read('src/components/app/CapabilityPanel.tsx')
    const guide = read('src/components/app/GuidePage.tsx')
    const boss = read('src/components/app/BossKeySettings.tsx')

    ok('消费层唯一入口：useCapabilities = readCapabilitySignals + resolveCapabilities',
      /readCapabilitySignals/.test(hook) && /resolveCapabilities/.test(hook))
    ok('🔴 消费层不新写平台判断（不许 import WEB / DESKTOP 自己算）',
      !/from '@\/lib\/app\/platform'/.test(hook) && !/from '@\/lib\/app\/desktop'/.test(hook))
    ok('📖 手册页接入能力面板', /CapabilityPanel/.test(guide))
    ok('面板文案取 CAPABILITY_LABEL / STATUS_LABEL / REASON_LABEL，不写第二版说明',
      /CAPABILITY_LABEL/.test(panel) && /STATUS_LABEL/.test(panel) && /REASON_LABEL/.test(panel))
    ok('面板覆盖九项能力（少一项就是手册漏了某一项）',
      (panel.match(/'(?:fullscreen|pdf-export|file-download|boss-key|durable-save|offline-edit|offline-cold-start|cloud-sync|local-model)'/g) ?? []).length >= 9)
    ok('面板不用 detail 之外的话术，也不发请求（只读探测）',
      /cap\.detail/.test(panel) && !/fetch\(|axios|new WebSocket/.test(panel))
    ok('设置页老板键消费矩阵的状态与原因',
      /caps\['boss-key'\]/.test(boss) && /STATUS_LABEL/.test(boss) && /REASON_LABEL/.test(boss))
    ok('🔴 设置页不再自己写「不支持」这类结论句（结论一律来自矩阵）',
      !/当前形态没有窗口隐藏或页面遮挡能力/.test(boss))
  }

  // ——— ⑨ C2：全屏入口与打印页（3.3.4 · P3）———
  {
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
    const fsApi = read('src/lib/app/browserFullscreen.ts')
    const hook = read('src/lib/app/useAppFullscreen.ts')
    const sidebar = read('src/components/app/Sidebar.tsx')
    const print = read('src/lib/audit/printPage.ts')
    const dialog = read('src/components/audit/EvidenceExportDialog.tsx')
    const look = read('src/lib/help/articles/look.ts')

    ok('桌面全屏已接：矩阵不再写「本版接入 / not-implemented」',
      resolveCapabilities(desktopSignals())['fullscreen'].status === 'supported'
      && resolveCapabilities(desktopSignals())['fullscreen'].reason === 'ok')
    ok('浏览器全屏仍是「有条件」（API 存在 ≠ 本次获准）',
      resolveCapabilities(cloudSignals())['fullscreen'].status === 'conditional')

    // 只查**代码**，不查注释：注释里点名 Safari / iOS 是在交代现实，不是平台判断表
    const fsCode = fsApi.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    ok('🔴 浏览器全屏不按平台名硬编码（代码里不出现 Safari / iOS 判断）',
      !/Safari|iOS|iPad/.test(fsCode))
    ok('全屏状态由事件校准（fullscreenchange + fullscreenerror）',
      /fullscreenchange/.test(fsApi) && /fullscreenerror/.test(fsApi))
    ok('请求失败有明确结果（denied / unsupported），不乐观显示已全屏',
      /'denied'/.test(fsApi) && /'unsupported'/.test(fsApi))
    ok('全屏根取 documentElement（浮层都挂在 body 下，替换成编辑区会让菜单消失）',
      /documentElement/.test(fsApi))
    ok('界面唯一状态来源：Sidebar 用 useAppFullscreen（不再自己读窗口桥）',
      /useAppFullscreen/.test(sidebar) && !/electronWindow/.test(sidebar))
    ok('hook 组合两条通道（桌面窗口桥 / 浏览器 API），不新增平台判断表',
      /toggleFullscreen/.test(hook) && /enterBrowserFullscreen/.test(hook) && !/from '@\/lib\/app\/platform'/.test(hook))
    ok('被拒 / 无 API 时给反馈（不是点了没反应）',
      /showToast\(/.test(sidebar) && /专注模式/.test(sidebar))

    ok('打印页只接受本机生成的自包含 HTML 并直接写入（无 Blob URL 生命周期坑）',
      /document\.write/.test(print) && !/createObjectURL/.test(print))
    ok('🔴 打印页断开 opener（不持有可操作原窗口的通道）', /w\.opener = null/.test(print))
    ok('弹窗被拦时退回下载 HTML（有回退路径）',
      /downloadBlob/.test(dialog) && /拦住了打印窗口/.test(dialog))
    ok('🔴 网页 / 便携不再谎报「已保存 PDF」，按钮写「打印 / 另存 PDF」',
      /打印 \/ 另存 PDF/.test(dialog) && !/网页版无法直接存 PDF/.test(dialog))

    ok('手册与界面同口径：网页 / 便携也走 Fullscreen API、被拒会提示',
      /Fullscreen API/.test(look) && !/网页版没有窗口桥接，不显示这一项/.test(look))
    ok('手册改了内容 ⇒ revision / verifiedAgainst / reviewedAt 同步',
      /revision: 2/.test(look) && /verifiedAgainst: '3\.3\.4'/.test(look) && /reviewedAt: '2026-11-02'/.test(look))
  }

  console.log(`\n▶ capabilities: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
