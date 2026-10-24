// ============ 网页版 · 多标签页互斥提示（WEB-02 的前半部分） ============
//
// 【要解决什么】网页版的数据是「整库读入内存 → 改动 → 全量写回」，
// 同一个账号在两个标签页里同时编辑，后保存的会整体覆盖前一个，**先写的内容静默丢失**。
// 桌面版靠单进程独占文件天然没有这个问题，网页版没有这层保护。
//
// 【为什么只做「提示」而不做「锁」】真正的互斥需要服务端版本号（`revision` + `If-Match`）——
// 那是跨设备也能生效的方案，但要动前端整条保存链路。
// 同浏览器多标签页这一半，用 BroadcastChannel 探测就够了：**不拦人，只把风险摆到眼前**。
// 强行禁止写会让「我就是要开两个窗口对照着看」的用户没法用，那反而更糟。
//
// 【为什么不写进 React】App.tsx 有四处 early-return 分支各自渲染横幅，逐个加容易漏；
// 而这里用原生 DOM 挂一条 fixed 浮层，不占布局、不依赖任何组件树，也不会影响桌面版与便携版
// （非网页版在第一行就返回了）。
import { WEB } from '@/lib/app/platform'
import { PORTABLE } from '@/lib/storage/fileBackend'

const CHANNEL = 'yfe-web-tab-guard'

/** 同一浏览器里打开过多个标签页后，本次会话内不再重复提示 */
let dismissed = false
let bannerEl: HTMLDivElement | null = null

function showBanner() {
  if (dismissed || bannerEl || typeof document === 'undefined') return

  const wrap = document.createElement('div')
  wrap.id = 'yfe-tab-guard'
  // 内联样式而非 tailwind 类：本文件是 .ts，不经过 JSX/class 扫描，用类名可能被裁掉。
  // 🔴 颜色一律走主题 CSS 变量（`rgb(var(--amber))` 等），**不写裸十六进制** ——
  //    项目闸 ⑨ 要求色值单一真源（docs/结构护栏），硬编码还顺带让暗/亮主题下配色错位。
  wrap.setAttribute('style', [
    'position:fixed',
    'top:12px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:80',
    'display:flex',
    'align-items:center',
    'gap:10px',
    // 🔴 `vw` **不随 `<html>` 的 zoom 缩放**：界面缩放设到 132% 时，写 `100vw` 的元素
    //    实际会占 132vw，右侧被视口裁掉（这条与 `foldVh()` 同一口径，2026-10-21 六维审计抓出）。
    //    留白那 32px 不必折 —— 放大一点只是更松，不折 vw 才会溢出。
    'max-width:calc(100vw / var(--ui-zoom, 1) - 32px)',
    'padding:8px 14px',
    'border-radius:999px',
    'background:rgb(var(--ink-950) / .94)',
    'border:1px solid rgb(var(--amber) / .5)',
    'color:rgb(var(--amber-soft))',
    'font-size:12.5px',
    'line-height:1.5',
    'box-shadow:0 8px 28px -10px rgba(0,0,0,.7)',
    "font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
  ].join(';'))

  const text = document.createElement('span')
  /**
   * 🔴 3.2.3 · R4（并发实测后按方案 A 落文案）：实测已确认「两标签同账号 ⇒ 后保存的整库覆盖先保存的，
   *    先写的内容静默消失，服务端没有版本判据」（见 docs/3.2.3-R4云端并发实测-2026-10-24.md）。
   *    旧文案只说"会互相覆盖"，没说清**整库**、也没给动作建议；作者点掉「知道了」继续写就真丢了。
   *    现在写清三件事：整库保存、后写的吃掉先写的、应当只留一个窗口。
   */
  text.textContent = '检测到另一个窗口也在用这个账号：两边都是整库保存，后保存的会覆盖先保存的，先写的内容会丢失。建议只留一个窗口编辑。'
  text.setAttribute('style', 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis')

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '知道了'
  closeBtn.setAttribute('style', 'background:none;border:0;color:rgb(var(--amber));cursor:pointer;font-size:12.5px;padding:0 2px;white-space:nowrap;text-decoration:underline;text-underline-offset:2px')
  closeBtn.addEventListener('click', () => {
    dismissed = true
    wrap.remove()
    bannerEl = null
  })

  wrap.appendChild(text)
  wrap.appendChild(closeBtn)
  document.body.appendChild(wrap)
  bannerEl = wrap
}

/**
 * 安装多标签页探测。**网页版与便携版生效**，桌面版调用它是空操作。
 *
 * 🔴 2026-10-18 三端兼容专项审计（concurrency/portable 运行单元）：便携版同样是
 * 「浏览器多标签 + 整库读入内存」，两个标签页互相覆盖的风险与网页版完全一致，
 * 原先只在 WEB 装是审计发现的覆盖缺口 —— 现扩展到便携版（桌面版单进程独占，仍不需要）。
 * 建议在 `main.tsx` 渲染 React 之前调用一次。
 */
export function installWebTabGuard(): void {
  if (!WEB && !PORTABLE) return
  if (typeof BroadcastChannel === 'undefined') return

  const selfId = Math.random().toString(36).slice(2)
  let ch: BroadcastChannel
  try {
    ch = new BroadcastChannel(CHANNEL)
  } catch {
    return // 隐私模式 / 老浏览器可能直接抛错
  }

  ch.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { type?: string; from?: string } | null
    if (!m || typeof m !== 'object' || m.from === selfId) return
    if (m.type === 'hello') {
      // 有新窗口打开：自己也要提示（两边都提示，才不会「谁先开谁不知道」）
      showBanner()
      try { ch.postMessage({ type: 'here', from: selfId }) } catch { /* 通道已关 */ }
    } else if (m.type === 'here') {
      showBanner()
    }
  }

  // 主动打招呼：已有窗口回 `here`，于是本窗口知道「我不是唯一一个」
  try { ch.postMessage({ type: 'hello', from: selfId }) } catch { /* 略 */ }

  // 页面卸载时关掉通道（BroadcastChannel 不关会影响 bfcache）
  window.addEventListener('pagehide', () => {
    try { ch.close() } catch { /* 略 */ }
  })
}
